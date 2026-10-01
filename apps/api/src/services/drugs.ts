import {
  resolveDateRange,
  type DateRangeInput,
  type DrugsSummaryResponse,
} from "@tornscope/shared";
import {
  buildDrugStreak,
  buildDrugStreaksByDrug,
  calculateDrugStats,
  calculateRehabDeepStats,
  calculateRehabStats,
} from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, loadMarketPrices } from "@tornscope/database";
import { liveAvailability, loadAvailabilityContext, sectionAvailability } from "./availability.js";
import { buildXanaxLedger, resolveXanaxItem } from "./xanaxLedger.js";

/** Drug use + rehab analytics. Drug costs are estimated from market prices. */
export async function getDrugsSummary(userId: string, rangeInput: DateRangeInput, drugFilter: string[] | null): Promise<DrugsSummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const availCtx = await loadAvailabilityContext(userId);

  const [drugRows, rehabRows, marketPrices, xanaxItem, earliestDrug, streakRows, rehabApRows] = await Promise.all([
    db.drugEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true, drugItemId: true, drugName: true, outcome: true },
    }),
    db.rehabEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true, rehabPercent: true, cost: true, sessions: true, addictionPointsRemoved: true },
    }),
    loadMarketPrices(db),
    resolveXanaxItem(db),
    db.drugEvent.findFirst({ where: { userId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    // Streaks span the full recorded history up to the range end — clipping
    // them to the range start would fabricate resets at arbitrary boundaries.
    db.drugEvent.findMany({
      where: { userId, occurredAt: { lte: new Date(range.to * 1000) } },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true, drugName: true, outcome: true },
    }),
    // AP / cost-per-AP metrics span ALL rehab visits up to the range end.
    db.rehabEvent.findMany({
      where: { userId, occurredAt: { lte: new Date(range.to * 1000) } },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true, cost: true, addictionPointsRemoved: true },
    }),
  ]);

  const xanaxItemId = xanaxItem?.itemId ?? null;
  const xanaxPriceUpdatedAt = xanaxItem?.priceUpdatedAt ?? null;
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
  // Shared with the Daily Summary — one implementation, one semantics.
  const ledger = await buildXanaxLedger(db, userId, { from: range.from, to: range.to, xanaxItemId, xanaxUses, priceMap });
  const funding = ledger.funding;
  const armoryHistory = {
    available: ledger.armoryAvailable,
    events: ledger.armoryEventsToOwner,
    earliestAt: ledger.armoryEarliestAt,
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

  // ---- Streaks (2.1.0): full history up to the range end -------------------
  const streakEvents = streakRows.map((r) => ({
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    drugName: r.drugName,
    outcome: r.outcome as string,
  }));
  const overallStreak = buildDrugStreak(streakEvents);
  const streaksByDrug = buildDrugStreaksByDrug(streakEvents);

  // ---- Rehab ---------------------------------------------------------------
  const rehabEvents = rehabRows.map((r) => ({
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    cost: bigintToNumber(r.cost),
    rehabPercent: r.rehabPercent,
    sessions: r.sessions,
  }));
  const rehab = calculateRehabStats(rehabEvents, range.from, range.to);
  // AP/cost-per-AP and the next-cost estimate span ALL costed rehab visits
  // up to the range end (not just in-range visits).
  const rehabDeep = calculateRehabDeepStats(
    rehabApRows.map((r) => ({
      occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
      cost: bigintToNumber(r.cost),
      rehabPercent: null,
      addictionPointsRemoved: r.addictionPointsRemoved,
    }))
  );

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
      streaks: {
        current: overallStreak.current,
        currentSince: overallStreak.currentSince,
        longest: overallStreak.longest,
        longestFrom: overallStreak.longestFrom,
        longestTo: overallStreak.longestTo,
        lastUseAt: overallStreak.lastUseAt,
        lastOverdoseAt: overallStreak.lastOverdoseAt,
      },
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
        priceUpdatedAt: xanaxPriceUpdatedAt !== null ? Math.floor(xanaxPriceUpdatedAt.getTime() / 1000) : null,
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
    byDrug: stats.byDrug.map((row) => {
      const streak = streaksByDrug.get(row.drug);
      return {
        drug: row.drug,
        uses: row.uses,
        overdoses: row.overdoses,
        estimatedCost: row.estimatedCost,
        shareOfTotal: row.shareOfTotal,
        lastUseAt: streak?.lastUseAt ?? null,
        lastOverdoseAt: streak?.lastOverdoseAt ?? null,
        currentStreak: streak?.current ?? 0,
        longestStreak: streak?.longest ?? 0,
      };
    }),
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
      addictionPointsRemoved: rehabDeep.addictionPointsRemoved,
      addictionPointsKnownVisits: rehabDeep.addictionPointsKnownVisits,
      costPerAddictionPoint: {
        value: rehabDeep.costPerAddictionPoint !== null ? Math.round(rehabDeep.costPerAddictionPoint) : null,
        provenance: "derived" as const,
      },
      estimatedNextCost: {
        value: rehabDeep.estimatedNextCost !== null ? Math.round(rehabDeep.estimatedNextCost) : null,
        provenance: "estimated" as const,
      },
      earliestAt: rehabDeep.earliestAt,
    },
  };
}
