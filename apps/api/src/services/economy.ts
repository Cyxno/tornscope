import {
  autoInterval,
  kpiAvailabilityFromConfidence,
  resolveDateRange,
  worstConfidence,
  worstKpiAvailability,
  type DateRangeInput,
  type EconomySummaryResponse,
  type KpiAvailability,
  type KpiValue,
  type MoneyCategory,
  type SyncResource,
} from "@tornscope/shared";
import {
  aggregateConversions,
  aggregateMoneyEvents,
  aggregateMoneySemantics,
  aggregateConsumption,
  buildCashReceivedBreakdown,
  buildCashSpentBreakdown,
  buildWalletBridge,
  calculateTravelProfit,
  classifyReconciliation,
  deriveBankInterest,
  explainedRatio,
  majorMoneyMovements,
  type ConsumptionEventLike,
  type ReconciliationQuality,
} from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, isOcPayoutRow, loadMarketPrices } from "@tornscope/database";
import { getNetworthPeriodForRange } from "./networth.js";
import { loadAvailabilityContext, sectionAvailability } from "./availability.js";
import { resourceConfidence } from "./confidence.js";
import { buildEconomyIntelligence } from "./economyIntelligence.js";

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
 * Economy view: the financial lenses, cleanly separated and related, NOT
 * additive (cash net + economic net + conversion net ≠ net worth change).
 *
 * A. Cash Flow — only real cash movements (purchases, sales, fees, payouts).
 * B. Economic Effect — true income/expense: value gained or lost. Asset
 *    conversions are excluded; derived bank interest is included; principal
 *    returns are not.
 * C. Conversions — cash exchanged for assets (bank, stocks, items, points,
 *    faction vault). Value changes form, it is not gained or lost.
 * D. Wallet — reconciliation: opening cash + recorded inflows − recorded
 *    outflows = expected closing, compared against the actual closing wallet.
 *    The residual is always surfaced with an explicit quality grade.
 * E. Consumption — value of items used up (estimated, never cash P&L).
 * F. Networth — official Torn snapshot delta with category deltas; a wealth
 *    movement, never "profit". `explanation` maps recorded/estimated
 *    contributors onto it and reports what remains unexplained.
 *
 * Query budget (documented, roadmap #6 phase 21): one bounded MoneyEvent
 * fetch + one unknown-row count + consumption + travel events/items + one
 * market-price map + the networth anchor set + two wallet anchor snapshots +
 * sale payload rows + the non-cash gains pair — all issued in two batched
 * waves; no per-row queries anywhere.
 */
export async function getEconomySummary(userId: string, rangeInput: DateRangeInput): Promise<EconomySummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const availCtx = await loadAvailabilityContext(userId);
  const from = new Date(range.from * 1000);
  const to = new Date(range.to * 1000);

  // Hard row caps (roadmap #8): the aggregate math is order-independent, so
  // a pathological history cannot turn "preset=all" into an unbounded
  // full-history load. Caps sit far above any real ledger (a heavy trader
  // generates ~50k money rows/year). When a cap is HIT the aggregates cover
  // the EARLIEST events and the money confidence downgrades to
  // partial/analysis_truncated — truncation is disclosed, never silent.
  // Env-injectable so tests can exercise the truncated path cheaply.
  const cap = (raw: string | undefined, fallback: number): number => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 100 ? Math.round(parsed) : fallback;
  };
  const ECONOMY_MAX_MONEY_ROWS = cap(process.env.ECONOMY_MAX_MONEY_ROWS, 250_000);
  const ECONOMY_MAX_AUX_ROWS = cap(process.env.ECONOMY_MAX_AUX_ROWS, 100_000);
  const [moneyRows, unknownCount, consumptionRows, travelEvents, travelItems, marketPrices, nwPeriod, walletStart, walletEnd, ocRows, saleRows] =
    await Promise.all([
      db.moneyEvent.findMany({
        where: { userId, occurredAt: { gte: from, lte: to } },
        orderBy: { occurredAt: "asc" },
        take: ECONOMY_MAX_MONEY_ROWS,
        // No metadata here: the raw payload is only needed for valuing SOLD
        // inventory and detecting OC payouts, which get their own targeted
        // queries below. Loading it for every row shipped the full raw log
        // JSONB on every Economy view.
        select: { id: true, occurredAt: true, category: true, subcategory: true, direction: true, amount: true, description: true },
      }),
      db.moneyEvent.count({ where: { userId, direction: "unknown", occurredAt: { gte: from, lte: to } } }),
      db.consumptionEvent.findMany({
        where: { userId, occurredAt: { gte: from, lte: to } },
        take: ECONOMY_MAX_AUX_ROWS,
        select: { occurredAt: true, category: true, quantity: true, totalValue: true, valuationMethod: true },
      }),
      db.travelEvent.findMany({
        where: { userId, departedAt: { gte: new Date((range.from - 7 * 86_400) * 1000), lte: to } },
        take: ECONOMY_MAX_AUX_ROWS,
        select: { id: true, destination: true, departedAt: true, returnedAt: true, durationSeconds: true },
      }),
      db.travelItemEvent.findMany({
        where: { userId, occurredAt: { gte: new Date((range.from - 7 * 86_400) * 1000), lte: to } },
        take: ECONOMY_MAX_AUX_ROWS,
        select: { id: true, travelEventId: true, itemId: true, itemName: true, category: true, quantity: true, unitCost: true, totalCost: true },
      }),
      loadMarketPrices(db),
      getNetworthPeriodForRange(userId, range.from, range.to),
      // Wallet reconciliation anchors: closest snapshot at/before each end.
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
      // OC payouts: faction income rows carry the scenario probe in metadata.
      db.moneyEvent.findMany({
        where: { userId, occurredAt: { gte: from, lte: to }, category: "faction", direction: "income" },
        take: ECONOMY_MAX_AUX_ROWS,
        select: { id: true, amount: true, metadata: true },
      }),
      // Sale valuation needs the raw payloads of the (few) sale rows only.
      db.moneyEvent.findMany({
        where: { userId, occurredAt: { gte: from, lte: to }, category: { in: [...SALE_CATEGORIES] }, direction: "income" },
        take: ECONOMY_MAX_AUX_ROWS,
        select: { category: true, direction: true, amount: true, metadata: true },
      }),
    ]);
  // Truncation disclosure (roadmap #9 remediation): hitting a cap means the
  // aggregates below cover only the earliest events of the requested range.
  const economyTruncated =
    moneyRows.length >= ECONOMY_MAX_MONEY_ROWS ||
    consumptionRows.length >= ECONOMY_MAX_AUX_ROWS ||
    ocRows.length >= ECONOMY_MAX_AUX_ROWS ||
    saleRows.length >= ECONOMY_MAX_AUX_ROWS;

  const ocRowIds = new Set(
    ocRows.filter((r) => isOcPayoutRow({ category: "faction", direction: "income", metadata: r.metadata })).map((r) => r.id)
  );

  // Dataset confidence — the same central derivation Overview uses, so the
  // two endpoints can no longer disagree about the same underlying state.
  const rangeForConfidence = { from: range.from, to: range.to };
  const moneyBaseConfidence = resourceConfidence(availCtx, "money_logs" as SyncResource, { range: rangeForConfidence });
  // A truncated analysis is partial BY DEFINITION — disclosed, never silent
  // (roadmap #9 remediation, phase 60–63).
  const cashFlowConfidence = economyTruncated
    ? { ...moneyBaseConfidence, confidence: "partial" as const, reason: "analysis_truncated" as const }
    : moneyBaseConfidence;
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
    // Faction income with OC scenario metadata credits the FACTION MEMBER
    // BALANCE, never the wallet — kept out of wallet flows below.
    ocPayout: ocRowIds.has(r.id),
  }));
  const flow = aggregateMoneyEvents(moneyEvents, range.from, range.to, autoInterval(range));
  const semantics = aggregateMoneySemantics(moneyEvents, range.from, range.to);
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

  /* --------------------------- wallet reconciliation ---------------------- */
  const openingWallet = walletStart ? bigintToNumber(walletStart.wallet) : null;
  const closingWallet = walletEnd ? bigintToNumber(walletEnd.wallet) : null;
  const factionBalanceCredits = ocRows.reduce((sum, r) => (ocRowIds.has(r.id) ? sum + (bigintToNumber(r.amount) ?? 0) : sum), 0);
  const wallet = buildWalletBridge(
    moneyEvents
      .filter((e) => !e.ocPayout)
      .map((e) => ({ amount: e.amount, direction: e.direction, category: String(e.category) })),
    openingWallet,
    closingWallet,
    factionBalanceCredits
  );
  // Known coverage gaps cap the reconciliation grade at "partial": a perfect
  // residual over a partial history is luck, not proof.
  const coverageGap =
    cashFlowConfidence.confidence !== "complete" ||
    cashFlowConfidence.coverage.hasKnownGaps ||
    (cashFlowConfidence.coverage.from !== null && cashFlowConfidence.coverage.from > range.from);
  const quality: ReconciliationQuality = classifyReconciliation({
    openingWallet,
    closingWallet,
    residual: wallet.unreconciled,
    inflows: wallet.walletInflow,
    outflows: wallet.walletOutflow,
    coverageGap,
  });
  const walletConfidence = worstConfidence([cashFlowConfidence, networthConfidence]) ?? cashFlowConfidence;

  /* ----------------------------- economic effect -------------------------- */
  // Bank interest is DERIVED from invest/withdraw pairs — principal returns
  // are never income. Incomplete splits (principal predating history) lower
  // the availability instead of fabricating a figure.
  const bank = deriveBankInterest(moneyEvents, range.from, range.to);
  const economicIncome = semantics.trueIncome + bank.interestIncome;
  const economicExpenses = semantics.trueExpense;
  const economicAvailability: KpiAvailability = worstKpiAvailability(cashAvailability, bank.complete ? "ok" : "incomplete");
  const economicKpi = (value: number, provenance: "exact" | "derived"): KpiValue => ({
    value: cashAvailability === "unavailable" ? null : value,
    provenance,
    availability: economicAvailability,
  });
  const received = buildCashReceivedBreakdown(moneyEvents);
  const spent = buildCashSpentBreakdown(moneyEvents);
  const economicEffect: EconomySummaryResponse["economicEffect"] = {
    income: economicKpi(economicIncome, bank.interestIncome > 0 ? "derived" : "exact"),
    expenses: economicKpi(economicExpenses, "exact"),
    net: {
      value: cashAvailability === "unavailable" ? null : economicIncome - economicExpenses,
      provenance: bank.interestIncome > 0 ? "derived" : "exact",
      availability: economicAvailability,
    },
    interestIncome: bank.interestIncome,
    interestComplete: bank.complete,
    incomeCategories: [
      ...received.earned.rows.map((r) => ({ key: r.key, label: r.label, total: r.amount, provenance: "exact" as const })),
      ...(bank.interestIncome > 0
        ? [{ key: "bank_interest", label: "Bank interest (derived from invest/withdraw pairs)", total: bank.interestIncome, provenance: "derived" as const }]
        : []),
    ],
    expenseCategories: spent.expenses.rows.map((r) => ({ key: r.key, label: r.label, total: r.amount, provenance: "exact" as const })),
    confidence: cashFlowConfidence,
  };

  /* ------------------------------- conversions ---------------------------- */
  const conversionsAgg = aggregateConversions(moneyEvents, range.from, range.to);
  const conversionKpi = (value: number): KpiValue => ({
    value: cashAvailability === "unavailable" ? null : value,
    provenance: "exact",
    availability: cashAvailability,
  });
  const conversions: EconomySummaryResponse["conversions"] = {
    cashIntoAssets: conversionKpi(conversionsAgg.cashIntoAssets),
    assetsIntoCash: conversionKpi(conversionsAgg.assetsIntoCash),
    netCashEffect: conversionKpi(conversionsAgg.netCashEffect),
    bankTransfers: conversionsAgg.bankTransfers,
    byPair: conversionsAgg.byPair,
    confidence: cashFlowConfidence,
  };

  /* ----------------------------- consumption ------------------------------ */
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

  /* --------------------------------- travel ------------------------------- */
  const trips = buildTrips(travelEvents, travelItems, marketPrices);
  const travel = calculateTravelProfit(trips, range.from, range.to);
  // Value-level truth on top of dataset confidence: a null estimated profit
  // (unknown item valuations) is incomplete, never a confirmed figure.
  const travelAvailability: KpiAvailability = worstKpiAvailability(
    kpiAvailabilityFromConfidence(travelConfidence),
    travel.trips === 0 ? "unavailable" : travel.estimatedProfit === null ? "incomplete" : "ok"
  );

  /* ------------------------- net worth explanation ------------------------ */
  // Contributors: official snapshot category deltas first (recorded), then
  // estimated economic effects, then what recorded activity cannot explain.
  // Estimated figures are NEVER summed into the official delta.
  const contributors: EconomySummaryResponse["explanation"]["contributors"] = nwPeriod.byCategory
    .filter((c) => c.change !== 0)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .map((c) => ({
      key: `nw_${c.key}`,
      label: c.label,
      value: c.change,
      provenance: "derived" as const,
      certainty: "recorded" as const,
      source: "Official Torn net worth snapshots",
    }));
  if (travel.estimatedProfit !== null && travel.estimatedProfit !== 0) {
    contributors.push({
      key: "travel",
      label: "Travel activity (estimated economic effect)",
      value: travel.estimatedProfit,
      provenance: "estimated",
      certainty: "estimated",
      source: "Current Torn catalog valuations",
    });
  }
  if (consumption.totalValue !== null && consumption.totalValue !== 0) {
    contributors.push({
      key: "consumption",
      label: "Consumed items (estimated accessible value)",
      value: -consumption.totalValue,
      provenance: "estimated",
      certainty: "estimated",
      source: "Torn catalog valuations at use time",
    });
  }
  const nwDelta = nwPeriod.change;
  const estimatedNet = (travel.estimatedProfit ?? 0) + (consumption.totalValue !== null ? -consumption.totalValue : 0);
  const netWorthUnexplained = nwDelta !== null ? nwDelta - (wallet.walletInflow - wallet.walletOutflow) - estimatedNet : null;
  contributors.push({
    key: "nw_residual",
    label: "Not explained by recorded activity",
    value: netWorthUnexplained,
    provenance: "derived",
    certainty: "unexplained",
    source: "Includes market repricing, inventory revaluation and activity outside available history",
  });

  return {
    range: { from: range.from, to: range.to, interval: autoInterval(range) },
    generatedAt: Math.floor(Date.now() / 1000),
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
    economicEffect,
    conversions,
    wallet: {
      openingWallet,
      closingWallet,
      expectedClosingWallet: wallet.expectedEndingCash,
      recordedInflows: wallet.walletInflow,
      recordedOutflows: wallet.walletOutflow,
      recordedNet: wallet.walletInflow - wallet.walletOutflow,
      residual: wallet.unreconciled,
      quality,
      explainedRatio: explainedRatio(wallet.unreconciled, openingWallet, closingWallet),
      openingSnapshotAt: walletStart ? Math.floor(walletStart.capturedAt.getTime() / 1000) : null,
      closingSnapshotAt: walletEnd ? Math.floor(walletEnd.capturedAt.getTime() / 1000) : null,
      factionBalanceCredits: wallet.factionBalanceCredits,
      confidence: walletConfidence,
    },
    explanation: {
      contributors,
      walletUnexplained: wallet.unreconciled,
      netWorthUnexplained,
      quality,
    },
    majorMovements: majorMoneyMovements(moneyEvents, range.from, range.to),
    series: {
      flow: flow.flowSeries,
      cumulativeNet: flow.cumulativeNetSeries,
    },
    sales: {
      cashReceived: sold.cashReceived,
      inventoryValueRemoved: sold.inventoryValueRemoved,
      economicResult: salesEconomicResult,
      provenance: sold.inventoryValueRemoved !== null ? "estimated" : "unavailable",
    },    nonCashGains: {
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
    intelligence: await buildEconomyIntelligence(userId, range.from, range.to),
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
