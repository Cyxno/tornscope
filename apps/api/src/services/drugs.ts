import {
  resolveDateRange,
  type DateRangeInput,
  type DrugsSummaryResponse,
} from "@tornscope/shared";
import { calculateDrugStats, calculateRehabStats, classifyXanaxFunding, type XanaxAcquisition } from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, loadMarketPrices } from "@tornscope/database";
import { liveAvailability, loadAvailabilityContext, sectionAvailability } from "./availability.js";

/** Xanax item id in the Torn catalog (authoritative name match at runtime). */
async function resolveXanaxItemId(db: ReturnType<typeof getPrismaClient>): Promise<number | null> {
  const row = await db.tornItemCatalog.findFirst({ where: { name: { equals: "Xanax", mode: "insensitive" } }, select: { itemId: true } });
  return row?.itemId ?? null;
}

/** Drug use + rehab analytics. Drug costs are estimated from market prices. */
export async function getDrugsSummary(userId: string, rangeInput: DateRangeInput, drugFilter: string[] | null): Promise<DrugsSummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const availCtx = await loadAvailabilityContext(userId);

  const [drugRows, rehabRows, marketPrices, xanaxItemId, earliestDrug] = await Promise.all([
    db.drugEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true, drugItemId: true, drugName: true, outcome: true },
    }),
    db.rehabEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true, rehabPercent: true, cost: true, sessions: true },
    }),
    loadMarketPrices(db),
    resolveXanaxItemId(db),
    db.drugEvent.findFirst({ where: { userId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
  ]);

  const drugEvents = drugRows.map((r) => ({
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    drugItemId: r.drugItemId,
    drugName: r.drugName,
    outcome: r.outcome as "success" | "overdose",
  }));
  const priceMap = new Map<number, number>([...marketPrices].map(([k, v]) => [k, Number(v)]));

  const stats = calculateDrugStats(drugEvents, priceMap, range.from, range.to, "day", drugFilter ? new Set(drugFilter) : null);

  // ---- Xanax per day + provenance-aware funding ledger ---------------------
  const xanaxUses = drugEvents.filter((e) => e.drugName?.toLowerCase() === "xanax" || (xanaxItemId !== null && e.drugItemId === xanaxItemId));
  const trackingStart = earliestDrug ? Math.floor(earliestDrug.occurredAt.getTime() / 1000) : null;
  const coverageStart = trackingStart !== null ? Math.max(range.from, trackingStart) : range.from;
  const coveredDays = Math.max(1, Math.ceil((Math.min(range.to, Math.floor(Date.now() / 1000)) - coverageStart) / 86_400));
  const coverage: "full" | "partial" | "unavailable" =
    drugEvents.length === 0 ? "unavailable" : trackingStart !== null && trackingStart > range.from ? "partial" : "full";
  const xanaxPerDay = xanaxUses.length > 0 ? xanaxUses.length / coveredDays : null;

  // Ledger inputs are gathered across the FULL recorded history (only capped
  // at the range end): acquisitions before the range feed opening stock, and
  // provenance must never change just because the UI range changed.
  const [supplyLogs, purchaseRows, travelPurchaseRows, armoryRows, earliestArmory, owner] = await Promise.all([
    db.timelineEvent.findMany({
      where: {
        userId,
        occurredAt: { lte: new Date(range.to * 1000) },
        OR: [
          { title: { contains: "loan item", mode: "insensitive" } },
          { title: { contains: "armory", mode: "insensitive" } },
          { title: { contains: "xanax", mode: "insensitive" } },
        ],
      },
      select: { occurredAt: true, title: true, metadata: true },
    }),
    xanaxItemId !== null
      ? db.moneyEvent.findMany({
          where: {
            userId,
            direction: "expense",
            category: { in: ["bazaar", "items", "trading"] },
            occurredAt: { lte: new Date(range.to * 1000) },
            metadata: { path: ["data", "items"], array_contains: [{ id: xanaxItemId }] },
          },
          select: { occurredAt: true, metadata: true },
        })
      : Promise.resolve([] as Array<{ occurredAt: Date; metadata: unknown }>),
    xanaxItemId !== null
      ? db.travelItemEvent.findMany({
          where: { userId, itemId: xanaxItemId, occurredAt: { lte: new Date(range.to * 1000) } },
          select: { occurredAt: true, quantity: true },
        })
      : Promise.resolve([] as Array<{ occurredAt: Date; quantity: number }>),
    xanaxItemId !== null
      ? db.factionArmoryEvent.findMany({
          where: { userId, itemId: xanaxItemId, action: { in: ["used", "lent", "gave"] } },
          select: { memberId: true, action: true, occurredAt: true, quantity: true },
          orderBy: { occurredAt: "asc" },
        })
      : Promise.resolve([] as Array<{ memberId: number | null; action: string; occurredAt: Date; quantity: number }>),
    db.factionArmoryEvent.findFirst({ where: { userId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    db.tornAccount.findUnique({ where: { userId }, select: { tornId: true } }),
  ]);

  const isOwnerRow = (memberId: number | null): boolean =>
    owner?.tornId === null || owner?.tornId === undefined || memberId === null || memberId === owner.tornId;

  const acquisitions: XanaxAcquisition[] = [];
  // Personal purchases: money logs carry exact item ids (bazaar/item market/
  // trades). Every unit is one acquisition event in the ledger.
  for (const row of purchaseRows) {
    const meta = (row.metadata ?? {}) as { data?: { items?: Array<{ id?: number; qty?: number }> } };
    const qty = (meta.data?.items ?? []).filter((i) => i.id === xanaxItemId).reduce((s, i) => s + (typeof i.qty === "number" ? i.qty : 1), 0);
    if (qty > 0) acquisitions.push({ occurredAt: Math.floor(row.occurredAt.getTime() / 1000), units: qty, source: "personal_purchase" });
  }
  // Travel purchases: Xanax bought abroad is a first-class acquisition record
  // with exact quantity (never double-counted — money logs for abroad buys
  // use the "travel" category, not bazaar/items/trading).
  for (const row of travelPurchaseRows) {
    if (row.quantity > 0) acquisitions.push({ occurredAt: Math.floor(row.occurredAt.getTime() / 1000), units: row.quantity, source: "travel_purchase" });
  }
  // Gifts: explicit evidence of an external (non-personal, non-faction) source.
  for (const log of supplyLogs) {
    const meta = JSON.stringify(log.metadata ?? {});
    const mentionsXanax = meta.includes(`"${xanaxItemId}"`) || /xanax/i.test(meta) || /xanax/i.test(log.title);
    if (!mentionsXanax) continue;
    if (/^faction/i.test(log.title)) continue; // armory table is the authoritative faction source
    if (/sent .* from /i.test(log.title)) acquisitions.push({ occurredAt: Math.floor(log.occurredAt.getTime() / 1000), units: 1, source: "gift" });
  }
  // Faction armory withdrawals to THIS member (lent/gave) are faction-source
  // acquisitions; "used" actions are use-time sponsorship evidence.
  const armoryUseTimes: number[] = [];
  for (const e of armoryRows) {
    if (!isOwnerRow(e.memberId)) continue;
    const t = Math.floor(e.occurredAt.getTime() / 1000);
    if (e.action === "used") {
      for (let i = 0; i < e.quantity; i += 1) armoryUseTimes.push(t);
    } else if (e.quantity > 0) {
      acquisitions.push({ occurredAt: t, units: e.quantity, source: "faction_armory" });
    }
  }
  // Uses before the selected range: prove possession and consume the
  // pre-range stock so opening inventory is real, not assumed.
  const preRangeUseRows =
    xanaxUses.length > 0
      ? await db.drugEvent.findMany({
          where: {
            userId,
            occurredAt: { lt: new Date(range.from * 1000) },
            OR: [{ drugName: { equals: "Xanax", mode: "insensitive" } }, ...(xanaxItemId !== null ? [{ drugItemId: xanaxItemId }] : [])],
          },
          select: { occurredAt: true },
        })
      : [];
  const funding = classifyXanaxFunding({
    uses: xanaxUses.map((u) => ({ occurredAt: u.occurredAt })),
    acquisitions,
    preRangeUses: preRangeUseRows.map((r) => ({ occurredAt: Math.floor(r.occurredAt.getTime() / 1000) })),
    armoryUseTimes,
    rangeFrom: range.from,
  });
  const armoryHistory = {
    available: armoryRows.length > 0,
    events: armoryRows.filter((e) => e.action === "used" && isOwnerRow(e.memberId)).length,
    earliestAt: earliestArmory ? Math.floor(earliestArmory.occurredAt.getTime() / 1000) : null,
  };

  // Per-bucket ESTIMATED VALUES at the current catalog market price. These
  // are consumption values, NOT personal spend: faction-sponsored Xanax has
  // a personal cost of $0 regardless of its market value, and opening
  // inventory has no acquisition cost in the ledger.
  const xanaxPrice = xanaxItemId !== null ? priceMap.get(xanaxItemId) ?? null : null;
  const xanaxValues = {
    unitPrice: xanaxPrice,
    consumption: xanaxPrice !== null ? xanaxPrice * xanaxUses.length : null,
    factionSponsored: xanaxPrice !== null ? xanaxPrice * funding.confirmedFaction : null,
    confirmedPersonal: xanaxPrice !== null ? xanaxPrice * funding.confirmedPersonal : null,
    openingInventory: xanaxPrice !== null ? xanaxPrice * funding.openingInventoryUnknown : null,
  };

  // ---- Rehab ---------------------------------------------------------------
  const rehabEvents = rehabRows.map((r) => ({
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    cost: bigintToNumber(r.cost),
    rehabPercent: r.rehabPercent,
    sessions: r.sessions,
  }));
  const rehab = calculateRehabStats(rehabEvents, range.from, range.to);

  return {
    range: { from: range.from, to: range.to },
    availability: {
      cooldown: liveAvailability(availCtx, "drugs_cooldown"),
      history: sectionAvailability(availCtx, "drugs_history", "drugs"),
      xanaxProvenance: sectionAvailability(availCtx, "drugs_xanax_provenance", "drugs"),
    },
    overall: {
      totalUses: stats.totalUses,
      overdoses: stats.overdoses,
      overdoseRate: stats.overdoseRate,
      estimatedSpend: { value: stats.estimatedSpend, provenance: "estimated" },
      averageCostPerUse: { value: stats.averageCostPerUse, provenance: "estimated" },
      xanaxPerDay: xanaxPerDay !== null ? Math.round(xanaxPerDay * 10) / 10 : null,
      coveredDays: drugEvents.length > 0 ? coveredDays : null,
      coverage,
    },
    xanaxFunding: {
      used: xanaxUses.length,
      // Provenance-aware buckets (evidence-based, range-independent).
      confirmedPersonal: funding.confirmedPersonal,
      confirmedFaction: funding.confirmedFaction,
      confirmedOther: funding.confirmedOther,
      openingInventoryUnknown: funding.openingInventoryUnknown,
      unknown: funding.unknown,
      openingStock: funding.openingStock,
      earliestEvidenceAt: funding.earliestEvidenceAt,
      hasPreRangeEvidence: funding.hasPreRangeEvidence,
      /**
       * Estimated catalog values per bucket — consumption value, never
       * personal spend. The player's personal cash cost of faction-sponsored
       * units is exactly $0.
       */
      values: {
        unitPrice: xanaxValues.unitPrice,
        consumption: xanaxValues.consumption,
        factionSponsored: xanaxValues.factionSponsored,
        confirmedPersonal: xanaxValues.confirmedPersonal,
        openingInventory: xanaxValues.openingInventory,
      },
      // Legacy aggregate view kept for compatibility: `unknownFunded`
      // contains everything that is NOT positively personal/faction.
      personal: funding.confirmedPersonal,
      factionSponsored: funding.confirmedFaction,
      unknownFunded: funding.confirmedOther + funding.openingInventoryUnknown + funding.unknown,
      armoryHistory,
    },
    byDrug: stats.byDrug.map((row) => ({
      drug: row.drug,
      uses: row.uses,
      overdoses: row.overdoses,
      estimatedCost: row.estimatedCost,
      shareOfTotal: row.shareOfTotal,
    })),
    dailySeries: stats.dailySeries,
    rehab: {
      totalSpend: { value: rehab.totalSpend, provenance: rehab.provenance },
      visits: rehab.visits,
      sessions: rehab.sessions,
      sessionsUnavailable: rehab.sessionsUnavailable,
      averageSessionsPerVisit: rehab.averageSessionsPerVisit !== null ? Math.round(rehab.averageSessionsPerVisit * 10) / 10 : null,
      averageCostPerSession: { value: rehab.averageCostPerSession, provenance: rehab.provenance },
      averageCostPerVisit: { value: rehab.averageCostPerVisit, provenance: rehab.provenance },
      latestAt: rehab.latestAt,
      averageSpend: { value: rehab.averageSpend, provenance: rehab.provenance },
      visitTrend: rehab.visitTrend.map((t) => ({ startedAt: t.startedAt, sessions: t.sessions, cost: t.cost, costPerSession: t.costPerSession })),
      recent: rehab.history.slice(0, 10).map((h) => ({
        occurredAt: h.occurredAt,
        rehabPercent: h.rehabPercent,
        cost: h.cost,
      })),
    },
  };
}
