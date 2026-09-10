import {
  autoInterval,
  kpiAvailabilityFromConfidence,
  resolveDateRange,
  worstKpiAvailability,
  type DashboardResponse,
  type DateRangeInput,
  type KpiAvailability,
  type SyncResource,
} from "@tornscope/shared";
import {
  aggregateCombatStats,
  aggregateCrimeStats,
  aggregateMoneyEvents,
  aggregateMoneySemantics,
  buildCashReceivedBreakdown,
  buildWalletBridge,
  calculateDrugStats,
  calculateRehabStats,
  calculateTravelProfit,
  buildDailyTravelProfit,
} from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, isOcPayoutRow, loadMarketPrices } from "@tornscope/database";
import { getLatestNetworth, getNetworthPeriodForRange } from "./networth.js";
import { loadAvailabilityContext } from "./availability.js";
import { resourceConfidence } from "./confidence.js";

/**
 * Overview dashboard: KPIs + widget series in one query pass.
 *
 * Every KPI carries an availability state so the UI can honor the
 * zero-vs-unknown contract: a $0 is only displayed when it is a confirmed
 * zero; missing/backfilling/unparsed data renders as —, Importing or
 * Incomplete instead.
 *
 * All flow KPIs (income, expenses, net cash flow, networth change, consumed
 * value, travel profit) follow the SELECTED global range — labels are built
 * by the UI from the same range preset.
 */
export async function getDashboard(userId: string, rangeInput: DateRangeInput): Promise<DashboardResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const from = new Date(range.from * 1000);
  const to = new Date(range.to * 1000);

  const [latestNw, moneyRows, unknownMoneyRows, travelEvents, travelItems, travelTransitions, drugRows, consumptionRows, crimeRows, combatRows, rehabRows, rehabCandidates, timelineCount, timelineRows, marketPrices, confidenceCtx] = await Promise.all([
    getLatestNetworth(userId),
    db.moneyEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      select: { id: true, occurredAt: true, category: true, subcategory: true, direction: true, amount: true, description: true, source: true, metadata: true },
    }),
    db.moneyEvent.count({ where: { userId, direction: "unknown", occurredAt: { gte: from, lte: to } } }),
    db.travelEvent.findMany({
      where: { userId, departedAt: { gte: new Date((range.from - 7 * 86_400) * 1000), lte: to } },
      select: { id: true, destination: true, departedAt: true, returnedAt: true, durationSeconds: true },
    }),
    db.travelItemEvent.findMany({
      where: { userId, occurredAt: { gte: new Date((range.from - 7 * 86_400) * 1000), lte: to } },
      select: { id: true, travelEventId: true, itemId: true, itemName: true, category: true, quantity: true, unitCost: true, totalCost: true },
    }),
    db.travelTransition.count({ where: { userId, occurredAt: { gte: from, lte: to }, type: { not: "ITEM_PURCHASE" } } }),
    db.drugEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      select: { occurredAt: true, drugItemId: true, drugName: true, outcome: true },
    }),
    db.consumptionEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      select: { occurredAt: true, category: true, quantity: true, totalValue: true },
    }),
    db.crimeEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      select: { occurredAt: true, success: true, moneyDelta: true, itemsValue: true },
    }),
    db.combatEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      select: { occurredAt: true, direction: true, result: true },
    }),
    db.rehabEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      select: { occurredAt: true, cost: true, rehabPercent: true },
    }),
    // Rehab candidate logs in range: raw evidence that rehab happened but
    // produced no structured event would make the $0 misleading.
    db.timelineEvent.count({
      where: {
        userId,
        type: "log",
        occurredAt: { gte: from, lte: to },
        OR: [{ title: { contains: "rehab", mode: "insensitive" } }, { category: { contains: "rehab", mode: "insensitive" } }],
      },
    }),
    db.timelineEvent.count({ where: { userId, type: "log", occurredAt: { gte: from, lte: to } } }),
    db.timelineEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 12,
      select: { id: true, occurredAt: true, type: true, title: true, description: true, amount: true },
    }),
    loadMarketPrices(db),
    loadAvailabilityContext(userId),
  ]);

  // Dataset confidence per Overview card — derived centrally from capabilities
  // + sync state + coverage, never re-invented per card.
  const rangeForConfidence = { from: range.from, to: range.to };
  const cashFlowConfidence = resourceConfidence(confidenceCtx, "money_logs", { range: rangeForConfidence });
  const drugsConfidence = resourceConfidence(confidenceCtx, "drugs", { range: rangeForConfidence });
  const travelConfidence = resourceConfidence(confidenceCtx, "travel", { range: rangeForConfidence });
  const rehabConfidence = resourceConfidence(confidenceCtx, "rehab", { range: rangeForConfidence });
  const networthConfidence = resourceConfidence(confidenceCtx, "networth");

  const lastSync = Array.from(confidenceCtx.states.values()).reduce<number | null>((acc, s) => {
    const t = s.lastSuccessAt ? Math.floor(s.lastSuccessAt.getTime() / 1000) : null;
    return t !== null && (acc === null || t > acc) ? t : acc;
  }, null);

  const moneyEvents = moneyRows.map((r) => ({
    id: r.id,
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    category: r.category,
    subcategory: r.subcategory,
    direction: r.direction as "income" | "expense" | "neutral" | "unknown",
    amount: bigintToNumber(r.amount) ?? 0,
    description: r.description,
    source: r.source,
    // Faction income carrying OC scenario metadata = an OC payout credited
    // to the FACTION MEMBER BALANCE (earned, but never wallet cash).
    ocPayout: isOcPayoutRow(r),
  }));
  const agg = aggregateMoneyEvents(moneyEvents, range.from, range.to, autoInterval(range));
  const fin = aggregateMoneySemantics(moneyEvents, range.from, range.to);

  const trips = buildTripsForDashboard(travelEvents, travelItems, marketPrices);
  const travel = calculateTravelProfit(trips, range.from, range.to);
  const travelInRange = trips.filter((t) => t.departedAt >= range.from && t.departedAt <= range.to);

  const priceMap = new Map<number, number>([...marketPrices].map(([k, v]) => ([k, Number(v)])));
  const drugs = calculateDrugStats(
    drugRows.map((r) => ({
      occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
      drugItemId: r.drugItemId,
      drugName: r.drugName,
      outcome: r.outcome as "success" | "overdose",
    })),
    priceMap,
    range.from,
    range.to,
    "day"
  );

  // Consumed value (items used up) over the selected range — deliberately
  // separate from the cash flow aggregate above.
  const consumedTotal = consumptionRows.reduce<number>((sum, r) => sum + (r.totalValue !== null ? Number(r.totalValue) : 0), 0);
  const consumedUnknown = consumptionRows.filter((r) => r.totalValue === null).length;

  const rehab = calculateRehabStats(
    rehabRows.map((r) => ({
      occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
      cost: bigintToNumber(r.cost),
      rehabPercent: r.rehabPercent,
    })),
    range.from,
    range.to
  );

  const [nwSeriesRows, nwPeriod] = await Promise.all([
    db.networthSnapshot.findMany({
      where: { userId, capturedAt: { gte: from, lte: to } },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, total: true },
    }),
    getNetworthPeriodForRange(userId, range.from, range.to),
  ]);
  // Wallet bridge endpoints: first snapshot at/before the range start and the
  // latest snapshot at/before the range end.
  const [walletStart, walletEnd] = await Promise.all([
    db.networthSnapshot.findFirst({
      where: { userId, capturedAt: { lte: from } },
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true, wallet: true },
    }),
    db.networthSnapshot.findFirst({
      where: { userId, capturedAt: { lte: to } },
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true, wallet: true },
    }),
  ]);
  // OC payouts are credited to the FACTION MEMBER BALANCE, never the wallet
  // (verified against live faction-balance snapshots: the balance rises by
  // the payout amount while the wallet does not move). They must stay out of
  // wallet flows or the bridge reports a phantom unreconciled gap of exactly
  // the payout. They remain income in the P&L — the money is owned, just not
  // wallet cash (Extended Wealth tracks the balance).
  const factionBalanceCredits = moneyRows.reduce((sum, r) => (isOcPayoutRow(r) ? sum + (bigintToNumber(r.amount) ?? 0) : sum), 0);
  const wallet = buildWalletBridge(
    moneyRows
      .filter((r) => !isOcPayoutRow(r))
      .map((r) => ({ amount: bigintToNumber(r.amount) ?? 0, direction: r.direction as "income" | "expense" | "neutral" | "unknown", category: r.category })),
    walletStart ? bigintToNumber(walletStart.wallet) : null,
    walletEnd ? bigintToNumber(walletEnd.wallet) : null,
    factionBalanceCredits
  );

  // --- availability per KPI = dataset confidence ⊕ value-level evidence ---
  // Dataset layer (confidence): can this range be trusted at all? Central
  // derivation — replaces the old per-endpoint "importing" heuristics that
  // used to diverge between Overview and Economy.
  // Value layer: unparseable rows / absent source evidence make a specific
  // figure provisional even when the dataset itself is healthy.
  const moneyAvailability: KpiAvailability = (() => {
    let availability = kpiAvailabilityFromConfidence(cashFlowConfidence);
    if (unknownMoneyRows > 0) availability = worstKpiAvailability(availability, "incomplete");
    // With PROVEN coverage an empty money set is a confirmed zero. Without
    // that proof, an empty set and a missing dataset are indistinguishable —
    // keep the log-activity evidence check for exactly that residual case.
    if (moneyRows.length === 0 && availability === "ok" && cashFlowConfidence.confidence !== "complete" && timelineCount === 0) {
      availability = "unavailable";
    }
    return availability;
  })();
  const rehabAvailability: KpiAvailability = worstKpiAvailability(
    kpiAvailabilityFromConfidence(rehabConfidence),
    rehabRows.length > 0 || rehabCandidates === 0 ? "ok" : "incomplete"
  );
  const drugsAvailability: KpiAvailability = worstKpiAvailability(
    kpiAvailabilityFromConfidence(drugsConfidence),
    drugRows.length > 0 ? "ok" : timelineCount === 0 ? "unavailable" : "incomplete"
  );
  const travelAvailability: KpiAvailability = worstKpiAvailability(
    kpiAvailabilityFromConfidence(travelConfidence),
    travelInRange.length > 0
      ? "ok"
      : travelTransitions === 0 && timelineCount === 0
        ? "unavailable"
        : "incomplete"
  );
  const networthChangeAvailability: KpiAvailability = worstKpiAvailability(
    kpiAvailabilityFromConfidence(networthConfidence),
    nwPeriod.coverage === "none" ? "unavailable" : "ok"
  );
  const consumptionAvailability: KpiAvailability = worstKpiAvailability(
    kpiAvailabilityFromConfidence(drugsConfidence),
    consumptionRows.length > 0 ? (consumedUnknown > 0 ? "incomplete" : "ok") : drugsAvailability === "ok" ? "ok" : drugsAvailability
  );

  // Faction summary: latest completed/ongoing ranked war + personal payouts.
  const accountRow = await db.tornAccount.findUnique({ where: { userId }, select: { factionId: true, tornId: true } });
  // Extended wealth: withdrawable faction member balance (the owner's own row
  // of the latest faction-balance snapshot). Torn's official net worth does
  // NOT include it — it is reported separately, never merged into netWorth.
  let factionBalance: { money: number | null; capturedAt: number | null } | null = null;
  if (accountRow) {
    const snap = await db.factionBalanceSnapshot.findFirst({ where: { userId }, orderBy: { capturedAt: "desc" }, select: { members: true, capturedAt: true } });
    const members = Array.isArray(snap?.members) ? (snap!.members as Array<{ id?: number; money?: number | null }>) : [];
    const mine = accountRow.tornId !== null ? members.find((m) => m.id === accountRow.tornId) : undefined;
    if (snap && mine && typeof mine.money === "number") {
      factionBalance = { money: mine.money, capturedAt: Math.floor(snap.capturedAt.getTime() / 1000) };
    }
  }
  let factionSummary: DashboardResponse["faction"] = null;
  if (accountRow?.factionId) {
    const [lastWar, factionNameRow, myPayoutRows] = await Promise.all([
      db.rankedWar.findFirst({ where: { factionId: accountRow.factionId }, orderBy: { startedAt: "desc" }, select: { opponentName: true, endedAt: true, winnerFactionId: true, factionId: true } }),
      db.faction.findUnique({ where: { id: accountRow.factionId }, select: { name: true } }),
      db.moneyEvent.findMany({
        where: { userId, category: "faction", direction: "income", occurredAt: { gte: from, lte: to } },
        select: { amount: true, metadata: true },
      }),
    ]);
    // "My payouts" here = faction income NOT carrying OC scenario metadata
    // (those are exact OC payouts, never ranked-war payouts) — see Faction
    // → Finance for the labeled breakdown.
    const myPayouts = myPayoutRows.reduce((sum, r) => {
      const meta = (r.metadata ?? {}) as { data?: { scenario?: string } };
      return meta.data?.scenario ? sum : sum + (bigintToNumber(r.amount) ?? 0);
    }, 0);
    factionSummary = {
      name: factionNameRow?.name ?? null,
      lastWar: lastWar
        ? {
            opponentName: lastWar.opponentName,
            result:
              lastWar.endedAt === null
                ? "ongoing"
                : lastWar.winnerFactionId === null
                  ? "draw"
                  : lastWar.winnerFactionId === lastWar.factionId
                    ? "win"
                    : "loss",
            endedAt: lastWar.endedAt ? Math.floor(lastWar.endedAt.getTime() / 1000) : null,
          }
        : null,
      myPayouts,
    };
  }

  return {
    range: { from: range.from, to: range.to, interval: autoInterval(range) },
    netWorth: { value: latestNw?.total ?? null, provenance: "exact", availability: latestNw ? "ok" : "unavailable" },
    cash: { value: latestNw?.cash ?? null, provenance: "exact", availability: latestNw ? "ok" : "unavailable" },
    extendedWealth: {
      value: latestNw?.total != null && factionBalance?.money != null ? latestNw.total + factionBalance.money : null,
      factionBalance: factionBalance?.money ?? null,
      factionBalanceCapturedAt: factionBalance?.capturedAt ?? null,
    },
    income: {
      value: moneyAvailability === "unavailable" ? null : agg.totalIncome,
      provenance: "derived",
      availability: moneyAvailability,
    },
    expenses: {
      value: moneyAvailability === "unavailable" ? null : agg.totalExpenses,
      provenance: "derived",
      availability: moneyAvailability,
    },
    netCashFlow: {
      value: moneyAvailability === "unavailable" ? null : agg.netProfit,
      provenance: "derived",
      availability: moneyAvailability,
    },
    networthChange: {
      value: nwPeriod.change,
      provenance: "exact",
      availability: networthChangeAvailability,
    },
    networthChangePct: nwPeriod.changePct,
    networthCoverage: nwPeriod.coverage,
    networthTrackingSince: nwPeriod.trackedFrom,
    financial: {
      cashInflow: {
        value: moneyAvailability === "unavailable" ? null : fin.cashInflow,
        provenance: "derived",
        availability: moneyAvailability,
      },
      cashOutflow: {
        value: moneyAvailability === "unavailable" ? null : fin.cashOutflow,
        provenance: "derived",
        availability: moneyAvailability,
      },
      trueIncome: fin.trueIncome,
      trueExpense: fin.trueExpense,
      assetSales: fin.assetInflow,
      assetPurchases: fin.assetOutflow,
      unknownValue: fin.unknownValue,
      bankTransfers: fin.bankTransfers,
      // Receiving-side breakdown (earned vs asset sales vs other) with
      // explicit labels; rows reconcile exactly to cashInflow.value.
      cashReceived:
        moneyAvailability === "unavailable"
          ? null
          : buildCashReceivedBreakdown(moneyEvents.map(({ category, direction, amount, ocPayout }) => ({ category, direction, amount, ocPayout }))),
      // Snapshot delta only — includes price moves and asset movement, so it
      // is labeled Net Worth Change, never profit or economic gain.
      economicGain: {
        value: nwPeriod.change,
        provenance: "exact",
        availability: nwPeriod.coverage === "none" ? "unavailable" : nwPeriod.coverage === "partial" ? "incomplete" : "ok",
      },
      netWorthMeasuredFrom: nwPeriod.baseline?.capturedAt ?? nwPeriod.trackedFrom ?? null,
      netWorthMeasuredTo: nwPeriod.current?.capturedAt ?? null,
    },
    wallet: {
      startingCash: wallet.startingCash,
      actualEndingCash: wallet.actualEndingCash,
      expectedEndingCash: wallet.expectedEndingCash,
      walletInflow: wallet.walletInflow,
      walletOutflow: wallet.walletOutflow,
      bankDeposits: wallet.bankDeposits,
      bankWithdrawals: wallet.bankWithdrawals,
      factionBalanceCredits: wallet.factionBalanceCredits,
      unreconciled: wallet.unreconciled,
      coverage: wallet.coverage,
      startingSnapshotAt: walletStart ? Math.floor(walletStart.capturedAt.getTime() / 1000) : null,
      endingSnapshotAt: walletEnd ? Math.floor(walletEnd.capturedAt.getTime() / 1000) : null,
    },
    faction: factionSummary,
    crimes:
      crimeRows.length > 0
        ? (() => {
            const stats = aggregateCrimeStats(
              crimeRows.map((r) => ({
                occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
                crimeName: null,
                success: r.success,
                nerveUsed: null,
                moneyDelta: bigintToNumber(r.moneyDelta),
                itemsValue: bigintToNumber(r.itemsValue),
                jailSeconds: null,
              })),
              range.from,
              range.to
            );
            return { attempts: stats.attempts, successRate: stats.successRate, totalValue: stats.totalEstimatedValue };
          })()
        : null,
    combat:
      combatRows.length > 0
        ? (() => {
            const stats = aggregateCombatStats(
              combatRows.map((r) => ({
                occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
                direction: r.direction as "outgoing" | "incoming",
                opponentId: null,
                opponentName: null,
                result: r.result,
                respectDelta: null,
              })),
              range.from,
              range.to
            );
            return { attacksMade: stats.attacksMade, wins: stats.wins, outgoingWins: stats.outgoingWins, incomingDefended: stats.incomingDefended };
          })()
        : null,
    consumedValue: {
      value: consumedTotal,
      provenance: "estimated",
      availability: consumptionAvailability,
    },
    travelProfit: {
      value: travel.estimatedProfit,
      provenance: "estimated",
      availability: travelAvailability,
    },
    drugsUsed: { value: drugs.totalUses, provenance: "exact", availability: drugsAvailability },
    rehabSpend: { value: rehab.totalSpend, provenance: rehab.provenance, availability: rehabAvailability },
    networthSeries: nwSeriesRows.map((r) => ({ t: Math.floor(r.capturedAt.getTime() / 1000), total: bigintToNumber(r.total) ?? 0 })),
    incomeByCategory: agg.incomeByCategory.map((c) => ({ category: c.category as DashboardResponse["incomeByCategory"][number]["category"], total: c.total })),
    expensesByCategory: agg.expensesByCategory.map((c) => ({ category: c.category as DashboardResponse["expensesByCategory"][number]["category"], total: c.total })),
    travelProfitSeries: buildDailyTravelProfit(trips, range.from, range.to),    drugUseSeries: drugs.dailySeries,
    recentTimeline: timelineRows.map((r) => ({
      id: r.id,
      occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
      type: r.type,
      title: r.title,
      description: r.description,
      amount: bigintToNumber(r.amount),
    })),
    lastSyncAt: lastSync,
    confidence: {
      cashFlow: cashFlowConfidence,
      drugs: drugsConfidence,
      travelProfit: travelConfidence,
      rehab: rehabConfidence,
      networth: networthConfidence,
    },
  };
}

interface TripForDashboard {
  id: string;
  destination: string;
  departedAt: number;
  returnedAt: number | null;
  durationSeconds: number | null;
  items: Array<{ id: string; itemId: number; itemName: string | null; category: string; quantity: number; unitCost: number; totalCost: number; estimatedUnitValue: number | null }>;
}

/**
 * Trips are stored assembled (travel worker / renormalize). This only joins
 * their DB-linked purchases — no read-time fabrication.
 */
function buildTripsForDashboard(
  events: Array<{ id: string; destination: string; departedAt: Date; returnedAt: Date | null; durationSeconds: number | null }>,
  items: Array<{ id: string; travelEventId: string | null; itemId: number; itemName: string | null; category: string; quantity: number; unitCost: bigint; totalCost: bigint }>,
  marketPrices: Map<number, bigint>
): TripForDashboard[] {
  const itemsByTrip = new Map<string, TripForDashboard["items"]>();
  for (const r of items) {
    const item = {
      id: r.id,
      itemId: r.itemId,
      itemName: r.itemName,
      category: r.category,
      quantity: r.quantity,
      unitCost: bigintToNumber(r.unitCost) ?? 0,
      totalCost: bigintToNumber(r.totalCost) ?? 0,
      estimatedUnitValue: marketPrices.get(r.itemId) !== undefined ? Number(marketPrices.get(r.itemId)) : null,
    };
    if (r.travelEventId) {
      const list = itemsByTrip.get(r.travelEventId) ?? [];
      list.push(item);
      itemsByTrip.set(r.travelEventId, list);
    }
  }

  return events.map((e) => ({
    id: e.id,
    destination: e.destination,
    departedAt: Math.floor(e.departedAt.getTime() / 1000),
    returnedAt: e.returnedAt ? Math.floor(e.returnedAt.getTime() / 1000) : null,
    durationSeconds: e.durationSeconds,
    items: itemsByTrip.get(e.id) ?? [],
  }));
}
