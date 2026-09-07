import {
  resolveDateRange,
  type DateRangeInput,
  type DrugsSummaryResponse,
} from "@tornscope/shared";
import { calculateDrugStats, calculateRehabStats } from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, loadMarketPrices } from "@tornscope/database";
import { liveAvailability, loadAvailabilityContext, sectionAvailability } from "./availability.js";

/** Xanax item id in the Torn catalog (authoritative name match at runtime). */
async function resolveXanaxItemId(db: ReturnType<typeof getPrismaClient>): Promise<number | null> {
  const row = await db.tornItemCatalog.findFirst({ where: { name: { equals: "Xanax", mode: "insensitive" } }, select: { itemId: true } });
  return row?.itemId ?? null;
}

/**
 * Funding split for Xanax uses. Three-way, evidence-based:
 * - Sponsored detected: a faction armory news event for THIS player + item
 *   at (near) the same timestamp — armory uses land in the personal log at
 *   the exact second the armory news records them (verified live).
 * - Personal detected: matched FIFO to a PERSONAL PURCHASE record (item sale
 *   logs carry exact item ids — a use counts as personal only then).
 * - Unknown funding: everything else — player gifts and uses that cannot be
 *   traced to any supply record. Never silently assumed personal.
 * War timing alone is never treated as sponsorship.
 */
export function splitXanaxFunding(
  uses: Array<{ occurredAt: number }>,
  sponsoredSupply: number[],
  unknownSupply: number[],
  purchasedSupply: number[] = [],
  matchWindowSeconds = 14 * 86_400,
  sponsoredToleranceSeconds = 300
): { personal: number; factionSponsored: number; unknownFunded: number } {
  const sponsored = [...sponsoredSupply].sort((a, b) => a - b);
  const unknown = [...unknownSupply].sort((a, b) => a - b);
  const purchased = [...purchasedSupply].sort((a, b) => a - b);
  let factionSponsored = 0;
  let personal = 0;
  for (const use of [...uses].sort((a, b) => a.occurredAt - b.occurredAt)) {
    const sIdx = sponsored.findIndex((t) => Math.abs(use.occurredAt - t) <= sponsoredToleranceSeconds);
    if (sIdx !== -1) {
      sponsored.splice(sIdx, 1);
      factionSponsored += 1;
      continue;
    }
    const uIdx = unknown.findIndex((t) => t <= use.occurredAt && use.occurredAt - t <= matchWindowSeconds);
    if (uIdx !== -1) {
      // A gift is a detected external source — but not a personal purchase.
      unknown.splice(uIdx, 1);
      continue;
    }
    const pIdx = purchased.findIndex((t) => t <= use.occurredAt && use.occurredAt - t <= matchWindowSeconds);
    if (pIdx !== -1) {
      purchased.splice(pIdx, 1);
      personal += 1;
    }
    // Unmatched uses fall into Unknown funding (returned as the remainder).
  }
  return { personal, factionSponsored, unknownFunded: uses.length - factionSponsored - personal };
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
      select: { occurredAt: true, rehabPercent: true, cost: true },
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

  // ---- Xanax per day + funding --------------------------------------------
  const xanaxUses = drugEvents.filter((e) => e.drugName?.toLowerCase() === "xanax" || (xanaxItemId !== null && e.drugItemId === xanaxItemId));
  const trackingStart = earliestDrug ? Math.floor(earliestDrug.occurredAt.getTime() / 1000) : null;
  const coverageStart = trackingStart !== null ? Math.max(range.from, trackingStart) : range.from;
  const coveredDays = Math.max(1, Math.ceil((Math.min(range.to, Math.floor(Date.now() / 1000)) - coverageStart) / 86_400));
  const coverage: "full" | "partial" | "unavailable" =
    drugEvents.length === 0 ? "unavailable" : trackingStart !== null && trackingStart > range.from ? "partial" : "full";
  const xanaxPerDay = xanaxUses.length > 0 ? xanaxUses.length / coveredDays : null;

  const [supplyLogs, purchaseRows, armoryEvents, earliestArmory] = await Promise.all([
    db.timelineEvent.findMany({
      where: {
        userId,
        occurredAt: { gte: new Date((coverageStart - 30 * 86_400) * 1000), lte: new Date(range.to * 1000) },
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
            occurredAt: { gte: new Date((coverageStart - 30 * 86_400) * 1000), lte: new Date(range.to * 1000) },
            metadata: { path: ["data", "items"], array_contains: [{ id: xanaxItemId }] },
          },
          select: { occurredAt: true, metadata: true },
        })
      : Promise.resolve([] as Array<{ occurredAt: Date; metadata: unknown }>),
    xanaxItemId !== null
      ? db.factionArmoryEvent.findMany({
          where: { userId, itemId: xanaxItemId, action: "used" },
          select: { memberId: true, occurredAt: true, quantity: true },
          orderBy: { occurredAt: "asc" },
        })
      : Promise.resolve([] as Array<{ memberId: number | null; occurredAt: Date; quantity: number }>),
    db.factionArmoryEvent.findFirst({ where: { userId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
  ]);
  const sponsoredSupply: number[] = [];
  const unknownSupply: number[] = [];
  for (const log of supplyLogs) {
    const meta = JSON.stringify(log.metadata ?? {});
    const mentionsXanax = meta.includes('"206"') || /xanax/i.test(meta) || /xanax/i.test(log.title);
    if (!mentionsXanax) continue;
    if (/^faction/i.test(log.title)) sponsoredSupply.push(Math.floor(log.occurredAt.getTime() / 1000));
    else if (/sent .* from /i.test(log.title)) unknownSupply.push(Math.floor(log.occurredAt.getTime() / 1000));
  }
  const purchasedSupply: number[] = [];
  for (const row of purchaseRows) {
    const meta = (row.metadata ?? {}) as { data?: { items?: Array<{ id?: number; qty?: number }> } };
    const qty = (meta.data?.items ?? []).filter((i) => i.id === xanaxItemId).reduce((s, i) => s + (typeof i.qty === "number" ? i.qty : 1), 0);
    for (let i = 0; i < qty; i += 1) purchasedSupply.push(Math.floor(row.occurredAt.getTime() / 1000));
  }
  const owner = await db.tornAccount.findUnique({ where: { userId }, select: { tornId: true } });
  const armorySupply: number[] = [];
  for (const e of armoryEvents) {
    // Only this member's armory usage counts as their sponsored supply.
    if (owner?.tornId !== null && owner?.tornId !== undefined && e.memberId !== null && e.memberId !== owner.tornId) continue;
    for (let i = 0; i < e.quantity; i += 1) armorySupply.push(Math.floor(e.occurredAt.getTime() / 1000));
  }
  const funding = splitXanaxFunding(
    xanaxUses.map((u) => ({ occurredAt: u.occurredAt })),
    armorySupply,
    unknownSupply,
    purchasedSupply
  );
  const armoryHistory = {
    available: armoryEvents.length > 0,
    events: armoryEvents.length,
    earliestAt: earliestArmory ? Math.floor(earliestArmory.occurredAt.getTime() / 1000) : null,
  };

  // ---- Rehab ---------------------------------------------------------------
  const rehabEvents = rehabRows.map((r) => ({
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    cost: bigintToNumber(r.cost),
    rehabPercent: r.rehabPercent,
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
      personal: funding.personal,
      factionSponsored: funding.factionSponsored,
      unknownFunded: funding.unknownFunded,
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
      trips: rehab.trips,
      sessions: rehab.sessions,
      averageSessionsPerTrip: rehab.averageSessionsPerTrip !== null ? Math.round(rehab.averageSessionsPerTrip * 10) / 10 : null,
      averageCostPerSession: { value: rehab.averageCostPerSession, provenance: rehab.provenance },
      averageCostPerTrip: { value: rehab.averageCostPerTrip, provenance: rehab.provenance },
      latestAt: rehab.latestAt,
      averageSpend: { value: rehab.averageSpend, provenance: rehab.provenance },
      tripTrend: rehab.tripClusters
        .slice()
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((t) => ({ startedAt: t.startedAt, sessions: t.sessions, cost: t.cost })),
      recent: rehab.history.slice(0, 10).map((h) => ({
        occurredAt: h.occurredAt,
        rehabPercent: h.rehabPercent,
        cost: h.cost,
      })),
    },
  };
}
