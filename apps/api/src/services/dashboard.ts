import {
  autoInterval,
  resolveDateRange,
  type DashboardResponse,
  type DateRangeInput,
} from "@tornscope/shared";
import {
  aggregateMoneyEvents,
  calculateDrugStats,
  calculateRehabStats,
  calculateTravelProfit,
} from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, loadMarketPrices } from "@tornscope/database";
import { getLatestNetworth } from "./networth.js";

/** Overview dashboard: KPIs + widget series in one query pass. */
export async function getDashboard(userId: string, rangeInput: DateRangeInput): Promise<DashboardResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const from = new Date(range.from * 1000);
  const to = new Date(range.to * 1000);

  const [latestNw, moneyRows, travelEvents, travelItems, drugRows, rehabRows, timelineRows, marketPrices, lastSync] = await Promise.all([
    getLatestNetworth(userId),
    db.moneyEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      select: { id: true, occurredAt: true, category: true, subcategory: true, direction: true, amount: true, description: true, source: true },
    }),
    db.travelEvent.findMany({
      where: { userId, departedAt: { gte: new Date((range.from - 7 * 86_400) * 1000), lte: to } },
      select: { id: true, destination: true, departedAt: true, returnedAt: true, status: true },
    }),
    db.travelItemEvent.findMany({
      where: { userId, occurredAt: { gte: new Date((range.from - 7 * 86_400) * 1000), lte: to } },
      select: { id: true, itemId: true, itemName: true, category: true, quantity: true, unitCost: true, totalCost: true, occurredAt: true, destination: true },
    }),
    db.drugEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      select: { occurredAt: true, drugItemId: true, drugName: true, outcome: true },
    }),
    db.rehabEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      select: { occurredAt: true, cost: true, rehabPercent: true },
    }),
    db.timelineEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 12,
      select: { id: true, occurredAt: true, type: true, title: true, description: true, amount: true },
    }),
    loadMarketPrices(db),
    db.syncState.findFirst({ where: { userId }, orderBy: { lastSuccessAt: "desc" }, select: { lastSuccessAt: true } }),
  ]);

  const moneyEvents = moneyRows.map((r) => ({
    id: r.id,
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    category: r.category,
    subcategory: r.subcategory,
    direction: r.direction as "income" | "expense" | "neutral",
    amount: bigintToNumber(r.amount) ?? 0,
    description: r.description,
    source: r.source,
  }));
  const agg = aggregateMoneyEvents(moneyEvents, range.from, range.to, autoInterval(range));

  const trips = buildTripsForDashboard(travelEvents, travelItems, marketPrices);
  const travel = calculateTravelProfit(trips, range.from, range.to);

  const priceMap = new Map<number, number>([...marketPrices].map(([k, v]) => [k, Number(v)]));
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

  // 30-day money window for the KPI row (independent of the selected range).
  const nowSec = Math.floor(Date.now() / 1000);
  const money30 = aggregateMoneyEvents(moneyEvents, nowSec - 30 * 86_400, nowSec, "day");

  const nwSeries = await db.networthSnapshot.findMany({
    where: { userId, capturedAt: { gte: from, lte: to } },
    orderBy: { capturedAt: "asc" },
    select: { capturedAt: true, total: true },
  });

  return {
    range: { from: range.from, to: range.to, interval: autoInterval(range) },
    netWorth: { value: latestNw?.total ?? null, provenance: "exact" },
    cash: { value: latestNw?.cash ?? null, provenance: "exact" },
    income30d: { value: money30.totalIncome, provenance: "exact" },
    expenses30d: { value: money30.totalExpenses, provenance: "exact" },
    netGain30d: { value: money30.netProfit, provenance: "exact" },
    travelProfit: { value: travel.estimatedProfit, provenance: "estimated" },
    drugsUsed: { value: drugs.totalUses, provenance: "exact" },
    rehabSpend: { value: rehab.totalSpend, provenance: rehab.provenance },
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
    lastSyncAt: lastSync?.lastSuccessAt ? Math.floor(lastSync.lastSuccessAt.getTime() / 1000) : null,
  };
}

type TripForDashboard = Parameters<typeof calculateTravelProfit>[0][number];

function buildTripsForDashboard(
  events: Array<{ id: string; destination: string; departedAt: Date; returnedAt: Date | null; status: string }>,
  items: Array<{ id: string; itemId: number; itemName: string | null; category: string; quantity: number; unitCost: bigint; totalCost: bigint; occurredAt: Date; destination: string | null }>,
  marketPrices: Map<number, bigint>
): TripForDashboard[] {
  const mappedItems = items.map((r) => ({
    id: r.id,
    itemId: r.itemId,
    itemName: r.itemName,
    category: r.category,
    quantity: r.quantity,
    unitCost: bigintToNumber(r.unitCost) ?? 0,
    totalCost: bigintToNumber(r.totalCost) ?? 0,
    estimatedUnitValue: marketPrices.get(r.itemId) !== undefined ? Number(marketPrices.get(r.itemId)) : null,
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    destination: r.destination,
  }));

  return assembleTripsLocal(
    events.map((e) => ({
      id: e.id,
      destination: e.destination,
      departedAt: Math.floor(e.departedAt.getTime() / 1000),
      arrivedAt: null,
      returnedAt: e.returnedAt ? Math.floor(e.returnedAt.getTime() / 1000) : null,
      status: e.status,
    })),
    mappedItems
  );
}

function assembleTripsLocal(events: Array<{ id: string; destination: string; departedAt: number; arrivedAt: number | null; returnedAt: number | null; status: string }>, items: Array<{ id: string; itemId: number; itemName: string | null; category: string; quantity: number; unitCost: number; totalCost: number; estimatedUnitValue: number | null; occurredAt: number; destination: string | null }>) {
  // Same algorithm as packages/analytics assembleTrips; duplicated here only
  // because the dashboard uses pre-mapped shapes - kept trivially small.
  const departures = events.sort((a, b) => a.departedAt - b.departedAt);
  const trips = departures.map((departure) => ({
    id: departure.id,
    destination: departure.destination,
    departedAt: departure.departedAt,
    returnedAt: departure.returnedAt,
    durationSeconds: null as number | null,
    items: [] as Array<{ id: string; itemId: number; itemName: string | null; category: string; quantity: number; unitCost: number; totalCost: number; estimatedUnitValue: number | null }>,
    open: departure.returnedAt === null,
  }));
  for (const item of items) {
    const trip =
      trips.find((t) => t.destination === item.destination && item.occurredAt >= t.departedAt && (t.returnedAt === null || item.occurredAt <= t.returnedAt + 12 * 3600)) ??
      trips.find((t) => item.occurredAt >= t.departedAt && (t.returnedAt === null || item.occurredAt <= t.returnedAt + 12 * 3600));
    if (trip) trip.items.push(item);
  }
  return trips;
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
