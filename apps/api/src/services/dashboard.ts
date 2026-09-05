import {
  autoInterval,
  resolveDateRange,
  type DashboardResponse,
  type DateRangeInput,
  type KpiAvailability,
} from "@tornscope/shared";
import {
  aggregateMoneyEvents,
  calculateDrugStats,
  calculateRehabStats,
  calculateTravelProfit,
} from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, loadMarketPrices } from "@tornscope/database";
import { getLatestNetworth } from "./networth.js";

/**
 * Overview dashboard: KPIs + widget series in one query pass.
 *
 * Every KPI carries an availability state so the UI can honor the
 * zero-vs-unknown contract: a $0 is only displayed when it is a confirmed
 * zero; missing/backfilling/unparsed data renders as —, Importing or
 * Incomplete instead.
 */
export async function getDashboard(userId: string, rangeInput: DateRangeInput): Promise<DashboardResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const from = new Date(range.from * 1000);
  const to = new Date(range.to * 1000);
  // Fixed 30-day window for the overview KPI row (independent of the range).
  const nowSec = Math.floor(Date.now() / 1000);
  const now30From = nowSec - 30 * 86_400;

  const [latestNw, moneyRows, unknownMoneyRows, money30Rows, unknownMoney30, travelEvents, travelItems, travelTransitions, drugRows, rehabRows, rehabCandidates, timelineCount, timeline30Count, timelineRows, marketPrices, syncStates] = await Promise.all([
    getLatestNetworth(userId),
    db.moneyEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      select: { id: true, occurredAt: true, category: true, subcategory: true, direction: true, amount: true, description: true, source: true },
    }),
    db.moneyEvent.count({ where: { userId, direction: "unknown", occurredAt: { gte: from, lte: to } } }),
    // The 30-day KPI window is independent of the selected range.
    db.moneyEvent.findMany({
      where: { userId, occurredAt: { gte: new Date((now30From) * 1000) } },
      select: { occurredAt: true, direction: true, amount: true },
    }),
    db.moneyEvent.count({
      where: { userId, direction: "unknown", occurredAt: { gte: new Date(now30From * 1000) } },
    }),
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
    db.timelineEvent.count({ where: { userId, type: "log", occurredAt: { gte: new Date(now30From * 1000) } } }),
    db.timelineEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 12,
      select: { id: true, occurredAt: true, type: true, title: true, description: true, amount: true },
    }),
    loadMarketPrices(db),
    db.syncState.findMany({ where: { userId }, select: { resource: true, status: true, lastSuccessAt: true } }),
  ]);

  // Backfill in progress for the log-derived domains → values may still change.
  const importing = syncStates.some(
    (s) => ["money_logs", "travel", "rehab", "drugs", "events"].includes(s.resource) && s.status === "running"
  );
  const lastSync = syncStates.reduce<number | null>((acc, s) => {
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
  }));
  const agg = aggregateMoneyEvents(moneyEvents, range.from, range.to, autoInterval(range));

  const money30 = aggregateMoneyEvents(
    money30Rows.map((r) => ({
      id: "kpi",
      occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
      category: "other",
      direction: r.direction as "income" | "expense" | "neutral" | "unknown",
      amount: bigintToNumber(r.amount) ?? 0,
    })),
    now30From,
    nowSec,
    "day"
  );

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
  const rehab = calculateRehabStats(
    rehabRows.map((r) => ({
      occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
      cost: bigintToNumber(r.cost),
      rehabPercent: r.rehabPercent,
    })),
    range.from,
    range.to
  );

  const nwSeries = await db.networthSnapshot.findMany({
    where: { userId, capturedAt: { gte: from, lte: to } },
    orderBy: { capturedAt: "asc" },
    select: { capturedAt: true, total: true },
  });

  // --- availability per KPI (importing wins; then data evidence) ---
  const moneyAvailability: KpiAvailability =
    unknownMoney30 > 0 ? "incomplete" : money30.totalIncome === 0 && money30.totalExpenses === 0 && timeline30Count === 0 ? "unavailable" : importing ? "importing" : "ok";
  const rehabAvailability: KpiAvailability =
    rehabRows.length > 0 || rehabCandidates === 0 ? (importing ? "importing" : "ok") : "incomplete";
  const drugsAvailability: KpiAvailability =
    drugRows.length > 0 ? (importing ? "importing" : "ok") : timelineCount === 0 ? "unavailable" : "incomplete";
  const travelAvailability: KpiAvailability =
    travelInRange.length > 0
      ? importing
        ? "importing"
        : "ok"
      : travelTransitions === 0 && timelineCount === 0
        ? "unavailable"
        : "incomplete";

  return {
    range: { from: range.from, to: range.to, interval: autoInterval(range) },
    netWorth: { value: latestNw?.total ?? null, provenance: "exact", availability: latestNw ? "ok" : "unavailable" },
    cash: { value: latestNw?.cash ?? null, provenance: "exact", availability: latestNw ? "ok" : "unavailable" },
    income30d: {
      value: moneyAvailability === "unavailable" ? null : money30.totalIncome,
      provenance: "derived",
      availability: moneyAvailability,
    },
    expenses30d: {
      value: moneyAvailability === "unavailable" ? null : money30.totalExpenses,
      provenance: "derived",
      availability: moneyAvailability,
    },
    netGain30d: {
      value: moneyAvailability === "unavailable" ? null : money30.netProfit,
      provenance: "derived",
      availability: moneyAvailability,
    },
    travelProfit: {
      value: travel.estimatedProfit,
      provenance: "estimated",
      availability: travelAvailability,
    },
    drugsUsed: { value: drugs.totalUses, provenance: "exact", availability: drugsAvailability },
    rehabSpend: { value: rehab.totalSpend, provenance: rehab.provenance, availability: rehabAvailability },
    networthSeries: nwSeries.map((r) => ({ t: Math.floor(r.capturedAt.getTime() / 1000), total: bigintToNumber(r.total) ?? 0 })),
    incomeByCategory: agg.incomeByCategory.map((c) => ({ category: c.category as DashboardResponse["incomeByCategory"][number]["category"], total: c.total })),
    expensesByCategory: agg.expensesByCategory.map((c) => ({ category: c.category as DashboardResponse["expensesByCategory"][number]["category"], total: c.total })),
    travelProfitSeries: buildDailyTravelProfit(trips, range.from, range.to),
    drugUseSeries: drugs.dailySeries,
    recentTimeline: timelineRows.map((r) => ({
      id: r.id,
      occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
      type: r.type,
      title: r.title,
      description: r.description,
      amount: bigintToNumber(r.amount),
    })),
    lastSyncAt: lastSync,
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

function buildDailyTravelProfit(trips: TripForDashboard[], from: number, to: number): Array<{ t: number; profit: number }> {
  const byDay = new Map<number, number>();
  for (const trip of trips) {
    if (trip.departedAt < from || trip.departedAt > to) continue;
    const d = new Date(trip.departedAt * 1000);
    const day = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
    let profit = 0;
    for (const item of trip.items) {
      const unitValue = item.estimatedUnitValue ?? null;
      profit += unitValue !== null ? unitValue * item.quantity - item.totalCost : -item.totalCost;
    }
    byDay.set(day, (byDay.get(day) ?? 0) + profit);
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([t, p]) => ({ t, profit: p }));
}
