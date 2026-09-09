import { autoInterval, kpiAvailabilityFromConfidence, resolveDateRange, worstKpiAvailability, type DateRangeInput, type EconomySummaryResponse, type KpiAvailability, type MoneyCategory, type SyncResource } from "@tornscope/shared";
import { aggregateMoneyEvents, aggregateMoneySemantics, aggregateConsumption, calculateTravelProfit, type ConsumptionEventLike } from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, loadMarketPrices } from "@tornscope/database";
import { getNetworthPeriodForRange } from "./networth.js";
import { loadAvailabilityContext, sectionAvailability } from "./availability.js";
import { resourceConfidence } from "./confidence.js";

/** Sale categories whose proceeds are asset conversions, not earnings. */
const SALE_CATEGORIES = new Set(["bazaar", "items", "trading", "auction"]);

/**
 * Value the inventory removed by item SALES. Torn's sale logs carry the exact
 * item ids/quantities (metadata.data.items); catalog market prices give the
 * estimated asset value that left the inventory. The difference against the
 * cash received is the ESTIMATED economic result of selling — never labeled
 * as trading profit, because the acquisition cost basis is unknown.
 */
function valueSoldInventory(
  rows: Array<{ category: string; direction: string; amount: bigint; metadata: unknown }>,
  marketPrices: Map<number, bigint>
): { cashReceived: number; inventoryValueRemoved: number | null; rowsValued: number; rowsTotal: number } {
  let cashReceived = 0;
  let inventoryValue = 0;
  let rowsValued = 0;
  let rowsTotal = 0;
  for (const r of rows) {
    if (!SALE_CATEGORIES.has(r.category) || r.direction !== "income") continue;
    rowsTotal += 1;
    cashReceived += bigintToNumber(r.amount) ?? 0;
    const meta = (r.metadata ?? {}) as { data?: { items?: Array<{ id?: number; qty?: number }> } };
    const items = meta.data?.items;
    if (!Array.isArray(items) || items.length === 0) continue;
    let valued = 0;
    let known = true;
    for (const item of items) {
      const price = typeof item.id === "number" ? marketPrices.get(item.id) : undefined;
      const qty = typeof item.qty === "number" ? item.qty : 0;
      if (price === undefined) {
        known = false;
        continue;
      }
      valued += Number(price) * qty;
    }
    if (known && valued > 0) {
      inventoryValue += valued;
      rowsValued += 1;
    }
  }
  return { cashReceived, inventoryValueRemoved: rowsValued > 0 ? inventoryValue : null, rowsValued, rowsTotal };
}

/** Non-cash wealth gains: item rewards from crimes and organized crimes (est.). */
async function nonCashWealthGains(
  db: ReturnType<typeof getPrismaClient>,
  userId: string,
  from: Date,
  to: Date,
  marketPrices: Map<number, bigint>
): Promise<number | null> {
  const [crimeItems, ocs] = await Promise.all([
    db.crimeEvent.aggregate({
      where: { userId, occurredAt: { gte: from, lte: to }, itemsValue: { not: null } },
      _sum: { itemsValue: true },
    }),
    db.organizedCrime.findMany({
      where: { userId, executedAt: { gte: from, lte: to } },
      select: { rewards: true },
    }),
  ]);
  let total = Number(crimeItems._sum.itemsValue ?? 0n);
  let any = (crimeItems._sum.itemsValue ?? 0n) > 0n;
  for (const oc of ocs) {
    const rewards = (oc.rewards ?? {}) as { items?: Array<{ id?: number; quantity?: number }> };
    if (!Array.isArray(rewards.items)) continue;
    for (const item of rewards.items) {
      const price = typeof item.id === "number" ? marketPrices.get(item.id) : undefined;
      if (price === undefined) continue;
      total += Number(price) * (typeof item.quantity === "number" ? item.quantity : 1);
      any = true;
    }
  }
  return any ? total : null;
}

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
  const availCtx = await loadAvailabilityContext(userId);
  const from = new Date(range.from * 1000);
  const to = new Date(range.to * 1000);

  const [moneyRows, unknownCount, consumptionRows, travelEvents, travelItems, marketPrices, nwPeriod] = await Promise.all([
    db.moneyEvent.findMany({
      where: { userId, occurredAt: { gte: from, lte: to } },
      // No metadata here: the raw payload is only needed for valuing SOLD
      // inventory, which gets its own targeted query below. Loading it for
      // every row shipped the full raw log JSONB on every Economy view.
      select: { id: true, occurredAt: true, category: true, subcategory: true, direction: true, amount: true, description: true },
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
  ]);

  // Dataset confidence — the same central derivation Overview uses, so the
  // two endpoints can no longer disagree about the same underlying state.
  const rangeForConfidence = { from: range.from, to: range.to };
  const cashFlowConfidence = resourceConfidence(availCtx, "money_logs" as SyncResource, { range: rangeForConfidence });
  const consumptionConfidence = resourceConfidence(availCtx, "drugs" as SyncResource, { range: rangeForConfidence });
  const networthConfidence = resourceConfidence(availCtx, "networth" as SyncResource);
  const travelConfidence = resourceConfidence(availCtx, "travel" as SyncResource, { range: rangeForConfidence });

  const moneyEvents = moneyRows.map((r) => ({
    id: r.id,
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    category: r.category,
    subcategory: r.subcategory,
    direction: r.direction as "income" | "expense" | "neutral" | "unknown",
    amount: bigintToNumber(r.amount) ?? 0,
    description: r.description,
  }));
  const flow = aggregateMoneyEvents(moneyEvents, range.from, range.to, autoInterval(range));
  const semantics = aggregateMoneySemantics(moneyEvents, range.from, range.to);
  // Sale valuation needs the raw payloads of the (few) sale rows only.
  const saleRows = await db.moneyEvent.findMany({
    where: { userId, occurredAt: { gte: from, lte: to }, category: { in: [...SALE_CATEGORIES] }, direction: "income" },
    select: { category: true, direction: true, amount: true, metadata: true },
  });
  const sold = valueSoldInventory(saleRows, marketPrices);
  const salesEconomicResult = sold.inventoryValueRemoved !== null ? sold.cashReceived - sold.inventoryValueRemoved : null;
  const nonCash = await nonCashWealthGains(db, userId, from, to, marketPrices);
  const cashAvailability: KpiAvailability = (() => {
    let availability = kpiAvailabilityFromConfidence(cashFlowConfidence);
    if (unknownCount > 0) availability = worstKpiAvailability(availability, "incomplete");
    // Proven coverage + zero rows = a confirmed zero; anything less keeps
    // empty money sets from masquerading as $0.
    if (moneyRows.length === 0 && availability === "ok" && cashFlowConfidence.confidence !== "complete") {
      availability = "unavailable";
    }
    return availability;
  })();

  const consumptionEvents: ConsumptionEventLike[] = consumptionRows.map((r) => ({
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    category: r.category,
    quantity: r.quantity,
    totalValue: r.totalValue !== null ? Number(r.totalValue) : null,
    valuationMethod: r.valuationMethod,
  }));
  const consumption = aggregateConsumption(consumptionEvents, range.from, range.to);
  const consumptionAvailability: KpiAvailability = worstKpiAvailability(
    kpiAvailabilityFromConfidence(consumptionConfidence),
    consumption.uses === 0 ? "unavailable" : consumption.valueUnknownCount > 0 ? "incomplete" : "ok"
  );
  const drugValue = consumption.byCategory.find((c) => c.category === "drug")?.totalValue ?? null;

  const trips = buildTrips(travelEvents, travelItems, marketPrices);
  const travel = calculateTravelProfit(trips, range.from, range.to);
  // Value-level truth on top of dataset confidence: a null estimated profit
  // (unknown item valuations) is incomplete, never a confirmed figure.
  const travelAvailability: KpiAvailability = worstKpiAvailability(
    kpiAvailabilityFromConfidence(travelConfidence),
    travel.trips === 0 ? "unavailable" : travel.estimatedProfit === null ? "incomplete" : "ok"
  );

  return {
    range: { from: range.from, to: range.to, interval: autoInterval(range) },
    availability: {
      cashFlow: sectionAvailability(availCtx, "money_cash_flow", "money_logs"),
      walletBridge: sectionAvailability(availCtx, "wallet_bridge", "money_logs"),
      networth: sectionAvailability(availCtx, "networth_history", "networth"),
    },
    cashFlow: {
      income: { value: cashAvailability === "unavailable" ? null : flow.totalIncome, provenance: "exact", availability: cashAvailability },
      expenses: { value: cashAvailability === "unavailable" ? null : flow.totalExpenses, provenance: "exact", availability: cashAvailability },
      netCashFlow: { value: cashAvailability === "unavailable" ? null : flow.netProfit, provenance: "exact", availability: cashAvailability },
      unclassifiedCount: unknownCount,
      incomeByCategory: flow.incomeByCategory.map((c) => ({ category: c.category as MoneyCategory, total: c.total })),
      expensesByCategory: flow.expensesByCategory.map((c) => ({ category: c.category as MoneyCategory, total: c.total })),
      // Earned vs converted: inflow/outflow split by economic meaning.
      trueIncome: semantics.trueIncome,
      trueExpense: semantics.trueExpense,
      assetInflow: semantics.assetInflow,
      assetOutflow: semantics.assetOutflow,
    },
    sales: {
      cashReceived: sold.cashReceived,
      inventoryValueRemoved: sold.inventoryValueRemoved,
      economicResult: salesEconomicResult,
      provenance: sold.inventoryValueRemoved !== null ? "estimated" : "unavailable",
    },
    nonCashGains: {
      value: nonCash,
      provenance: nonCash !== null ? "estimated" : "unavailable",
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
      change: {
        value: nwPeriod.change,
        provenance: "exact",
        availability: worstKpiAvailability(kpiAvailabilityFromConfidence(networthConfidence), nwPeriod.coverage === "none" ? "unavailable" : "ok"),
      },
      changePct: nwPeriod.changePct,
      coverage: nwPeriod.coverage,
      baselineAt: nwPeriod.baseline?.capturedAt ?? null,
      trackedFrom: nwPeriod.trackedFrom,
      byCategory: nwPeriod.byCategory,
      trackingSince: nwPeriod.trackedFrom,
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
    confidence: {
      cashFlow: cashFlowConfidence,
      consumption: consumptionConfidence,
      networth: networthConfidence,
      travel: travelConfidence,
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

export function buildTrips(
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
