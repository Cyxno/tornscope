import { autoInterval, resolveDateRange, type DateRangeInput, type EconomySummaryResponse, type KpiAvailability, type MoneyCategory } from "@tornscope/shared";
import { aggregateMoneyEvents, aggregateConsumption, calculateTravelProfit, type ConsumptionEventLike } from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, loadMarketPrices } from "@tornscope/database";
import { getNetworthPeriodForRange } from "./networth.js";

/**
 * Economy view: the three financial concepts, cleanly separated.
 *
 * A. Cash Flow — only real cash movements (purchases, sales, fees, payouts).
 * B. Consumption — value of items used up (drugs, boosters, medical, happy
 *    items, energy, candy, other consumables). A Xanax bought for 840,000 is
 *    a -840,000 cash flow at purchase; the later use is consumption with zero
 *    additional cash movement. The two are never summed into one "profit".
 * C. Networth — difference between Torn networth snapshots (exact), with the
 *    Torn-provided category breakdown. Inventory appreciation lands here,
 *    never in cash income.
 *
 * Plus the estimated travel profit as its own clearly-labeled figure.
 */
export async function getEconomySummary(userId: string, rangeInput: DateRangeInput): Promise<EconomySummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const from = new Date(range.from * 1000);
  const to = new Date(range.to * 1000);

  const [moneyRows, unknownCount, consumptionRows, travelEvents, travelItems, marketPrices, nwPeriod, syncStates] = await Promise.all([
    db.moneyEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      select: { id: true, occurredAt: true, category: true, subcategory: true, direction: true, amount: true },
    }),
    db.moneyEvent.count({ where: { userId, direction: "unknown", occurredAt: { gte: from, lte: to } } }),
    db.consumptionEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      select: { occurredAt: true, category: true, quantity: true, totalValue: true, valuationMethod: true },
    }),
    db.travelEvent.findMany({
      where: { userId, departedAt: { gte: new Date((range.from - 7 * 86_400) * 1000), lte: to } },
      select: { id: true, destination: true, departedAt: true, returnedAt: true, durationSeconds: true },
    }),
    db.travelItemEvent.findMany({
      where: { userId, occurredAt: { gte: new Date((range.from - 7 * 86_400) * 1000), lte: to } },
      select: { id: true, travelEventId: true, itemId: true, itemName: true, category: true, quantity: true, unitCost: true, totalCost: true },
    }),
    loadMarketPrices(db),
    getNetworthPeriodForRange(userId, range.from, range.to),
    db.syncState.findMany({ where: { userId }, select: { resource: true, status: true } }),
  ]);

  const importing = syncStates.some((s) => ["money_logs", "drugs", "travel"].includes(s.resource) && s.status === "running");

  const moneyEvents = moneyRows.map((r) => ({
    id: r.id,
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    category: r.category,
    subcategory: r.subcategory,
    direction: r.direction as "income" | "expense" | "neutral" | "unknown",
    amount: bigintToNumber(r.amount) ?? 0,
  }));
  const flow = aggregateMoneyEvents(moneyEvents, range.from, range.to, autoInterval(range));
  const cashAvailability: KpiAvailability =
    unknownCount > 0 ? "incomplete" : moneyRows.length === 0 ? "unavailable" : importing ? "importing" : "ok";

  const consumptionEvents: ConsumptionEventLike[] = consumptionRows.map((r) => ({
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    category: r.category,
    quantity: r.quantity,
    totalValue: r.totalValue !== null ? Number(r.totalValue) : null,
    valuationMethod: r.valuationMethod,
  }));
  const consumption = aggregateConsumption(consumptionEvents, range.from, range.to);
  const consumptionAvailability: KpiAvailability =
    consumption.uses === 0 ? (importing ? "importing" : "unavailable") : consumption.valueUnknownCount > 0 ? "incomplete" : "ok";
  const drugValue = consumption.byCategory.find((c) => c.category === "drug")?.totalValue ?? null;

  const trips = buildTrips(travelEvents, travelItems, marketPrices);
  const travel = calculateTravelProfit(trips, range.from, range.to);
  const travelAvailability: KpiAvailability = travel.trips > 0 ? "ok" : "unavailable";

  return {
    range: { from: range.from, to: range.to, interval: autoInterval(range) },
    cashFlow: {
      income: { value: cashAvailability === "unavailable" ? null : flow.totalIncome, provenance: "exact", availability: cashAvailability },
      expenses: { value: cashAvailability === "unavailable" ? null : flow.totalExpenses, provenance: "exact", availability: cashAvailability },
      netCashFlow: { value: cashAvailability === "unavailable" ? null : flow.netProfit, provenance: "exact", availability: cashAvailability },
      unclassifiedCount: unknownCount,
      incomeByCategory: flow.incomeByCategory.map((c) => ({ category: c.category as MoneyCategory, total: c.total })),
      expensesByCategory: flow.expensesByCategory.map((c) => ({ category: c.category as MoneyCategory, total: c.total })),
    },
    consumption: {
      uses: consumption.uses,
      totalValue: { value: consumption.totalValue, provenance: "estimated", availability: consumptionAvailability },
      valueUnknownCount: consumption.valueUnknownCount,
      drugValue,
      byCategory: consumption.byCategory.map((c) => ({
        category: c.category,
        uses: c.uses,
        totalValue: c.totalValue,
        valueUnknownCount: c.valueUnknownCount,
      })),
    },
    networth: {
      current: { value: nwPeriod.current?.total ?? null, provenance: "exact", availability: nwPeriod.current ? "ok" : "unavailable" },
      currentAt: nwPeriod.current?.capturedAt ?? null,
      baseline: nwPeriod.baseline?.total ?? null,
      change: { value: nwPeriod.change, provenance: "exact", availability: nwPeriod.coverage === "none" ? "unavailable" : "ok" },
      changePct: nwPeriod.changePct,
      coverage: nwPeriod.coverage,
      baselineAt: nwPeriod.baseline?.capturedAt ?? null,
      trackedFrom: nwPeriod.trackedFrom,
      byCategory: nwPeriod.byCategory,
    },
    travel: {
      estimatedProfit: { value: travel.estimatedProfit, provenance: "estimated", availability: travelAvailability },
      profitPerHour: {
        value: travel.averageProfitPerHour,
        provenance: "estimated",
        availability: travel.trips > 0 ? (travel.averageProfitPerHour === null ? "incomplete" : "ok") : "unavailable",
      },
      trips: travel.trips,
    },
  };
}

/* -------------------------------------------------------------------------- */

interface EconomyTrip {
  id: string;
  destination: string;
  departedAt: number;
  returnedAt: number | null;
  durationSeconds: number | null;
  items: Array<{ id: string; itemId: number; itemName: string | null; category: string; quantity: number; unitCost: number; totalCost: number; estimatedUnitValue: number | null }>;
}

function buildTrips(
  events: Array<{ id: string; destination: string; departedAt: Date; returnedAt: Date | null; durationSeconds: number | null }>,
  items: Array<{ id: string; travelEventId: string | null; itemId: number; itemName: string | null; category: string; quantity: number; unitCost: bigint; totalCost: bigint }>,
  marketPrices: Map<number, bigint>
): EconomyTrip[] {
  const itemsByTrip = new Map<string, EconomyTrip["items"]>();
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
