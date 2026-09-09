import {
  dayKeyInZone,
  expenseLabel,
  humanLabel,
  incomeLabel,
  kpiAvailabilityFromConfidence,
  type MoneyDirection,
  resolveDayRange,
  worstConfidence,
  worstKpiAvailability,
  type DailyHighlight,
  type DailySummaryResponse,
  type DataConfidenceMeta,
  type KpiAvailability,
  type KpiValue,
  type NetworthDriver,
  type SummaryCategoryRow,
} from "@tornscope/shared";
import {
  aggregateConsumption,
  aggregateMoneySemantics,
  calculateRehabStats,
  calculateTravelProfit,
  classifyMoneySemantics,
  type ConsumptionEventLike,
} from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, loadMarketPrices } from "@tornscope/database";
import { AppError } from "../errors.js";
import { loadAvailabilityContext } from "./availability.js";
import { resourceConfidence } from "./confidence.js";
import { getNetworthPeriodForRange } from "./networth.js";
import { buildXanaxLedger, resolveXanaxItem } from "./xanaxLedger.js";
import { buildTrips } from "./economy.js";

/**
 * Daily Summary (v0.2 item #2): one trustworthy recap of a calendar day in
 * the user's timezone.
 *
 * Semantics (see docs/DAILY-SUMMARY.md):
 * - Reuses the canonical analytics: aggregateMoneySemantics (cash flow vs
 *   economic effect vs conversions), getNetworthPeriodForRange (official
 *   snapshot delta), calculateTravelProfit (catalog-estimated), aggregateConsumption
   (consumption value), buildXanaxLedger + calculateRehabStats (provenance).
 * - Every section carries its DataConfidenceMeta from the central derivation.
 * - Highlights and net-worth drivers are deterministic rules; no causal
 *   claims — the frontend words them as likely contributors.
 * - An ongoing (today) day is capped at partial with reason day_in_progress.
 */

const MAX_TOP_CATEGORIES = 4;
const LARGE_MOVEMENT_SHARE = 0.2;
const LARGE_MOVEMENT_FLOOR = 50_000;

interface MoneyRowLike {
  occurredAt: Date;
  category: string;
  direction: string;
  amount: bigint;
  metadata: unknown;
}

const sec = (d: Date): number => Math.floor(d.getTime() / 1000);

function kpi(
  value: number | null,
  provenance: KpiValue["provenance"],
  availability: KpiAvailability
): KpiValue {
  return { value, provenance, availability };
}

/** Value-level availability from the dataset plus this figure's own evidence. */
function datasetAvailability(confidence: DataConfidenceMeta): KpiAvailability {
  return kpiAvailabilityFromConfidence(confidence);
}

export async function getDailySummary(
  user: { id: string; timezone: string; isDemo: boolean },
  dateInput: string | undefined
): Promise<DailySummaryResponse> {
  const db = getPrismaClient();
  const userId = user.id;

  let day: ReturnType<typeof resolveDayRange>;
  try {
    day = resolveDayRange(dateInput, user.timezone);
  } catch (err) {
    throw new AppError("invalid_date", (err as Error).message, 400);
  }
  const range = { from: day.from, to: day.to };
  const ctx = await loadAvailabilityContext(userId);

  const [moneyRows, drugRows, consumptionRows, rehabRows, travelEvents, travelItems, marketPrices, xanaxItem, nwPeriod, crimeRows, combatRows, accountEvents] = await Promise.all([
    db.moneyEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      select: { occurredAt: true, category: true, subcategory: true, direction: true, amount: true, metadata: true },
    }),
    db.drugEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      select: { occurredAt: true, drugItemId: true, drugName: true, outcome: true },
    }),
    db.consumptionEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      select: { occurredAt: true, category: true, quantity: true, totalValue: true },
    }),
    db.rehabEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      select: { occurredAt: true, cost: true, sessions: true, rehabPercent: true },
    }),
    // Trips that DEPARTED in the day (same convention as Overview/Travel).
    db.travelEvent.findMany({
      where: { userId, departedAt: { gte: new Date((range.from - 7 * 86_400) * 1000), lte: new Date(range.to * 1000) } },
      select: { id: true, destination: true, departedAt: true, returnedAt: true, durationSeconds: true },
    }),
    db.travelItemEvent.findMany({
      where: { userId, occurredAt: { gte: new Date((range.from - 7 * 86_400) * 1000), lte: new Date(range.to * 1000) } },
      select: { id: true, travelEventId: true, itemId: true, itemName: true, category: true, quantity: true, unitCost: true, totalCost: true },
    }),
    loadMarketPrices(db),
    resolveXanaxItem(db),
    getNetworthPeriodForRange(userId, range.from, range.to),
    db.crimeEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      select: { occurredAt: true, success: true, moneyDelta: true, itemsValue: true },
    }),
    db.combatEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      select: { occurredAt: true, direction: true, result: true },
    }),
    db.timelineEvent.findMany({
      where: { userId, type: "torn_event", occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      orderBy: [{ occurredAt: "asc" }],
      take: 6,
      select: { occurredAt: true, title: true },
    }),
  ]);

  /* ----------------------------- confidence ------------------------------ */
  const moneyConfidence = resourceConfidence(ctx, "money_logs", { range });
  const networthConfidence = resourceConfidence(ctx, "networth");
  const drugsConfidence = resourceConfidence(ctx, "drugs", { range });
  const travelConfidence = resourceConfidence(ctx, "travel", { range });
  const rehabConfidence = resourceConfidence(ctx, "rehab", { range });

  /* ------------------------- money → the three lenses --------------------- */
  const moneyEvents = moneyRows.map((r: MoneyRowLike) => ({
    id: "0",
    occurredAt: sec(r.occurredAt),
    category: r.category,
    subcategory: null,
    direction: r.direction as MoneyDirection,
    amount: bigintToNumber(r.amount) ?? 0,
    description: null,
    // Faction income carrying OC scenario metadata = earned, but credited to
    // the faction member balance — the canonical semantics keep it out of the
    // wallet bridge and split it in the received breakdown.
    ocPayout:
      r.category === "faction" && r.direction === "income"
        ? Boolean(((r.metadata ?? {}) as { data?: { scenario?: string } }).data?.scenario)
        : false,
  }));
  const sem = aggregateMoneySemantics(moneyEvents, range.from, range.to);

  // When does an EMPTY day count as a valid zero?
  // - complete coverage: the walk scanned the day and found nothing → $0.
  // - stale_permission WITH collected history: the day lives inside the
  //   retained dataset, so zero is a real observation (the Stale badge warns
  //   that refreshing stopped). With nothing ever collected, an empty set is
  //   indistinguishable from a missing dataset → unavailable, never $0.
  const emptyDayCountsAsZero = (meta: DataConfidenceMeta, resource: string): boolean =>
    meta.confidence === "complete" ||
    (meta.confidence === "stale_permission" && (ctx.states.get(resource)?.recordsCollected ?? 0) > 0);

  let moneyAvailability = datasetAvailability(moneyConfidence);
  const unknownCount = sem.unknownCount;
  if (unknownCount > 0) moneyAvailability = worstKpiAvailability(moneyAvailability, "incomplete");
  if (moneyRows.length === 0 && moneyAvailability === "ok" && !emptyDayCountsAsZero(moneyConfidence, "money_logs")) {
    moneyAvailability = "unavailable";
  }
  const hasMoneyData = moneyAvailability !== "unavailable";

  const topRows = (rows: Array<{ category: string; total: number }>, labelFor: (c: string) => string): SummaryCategoryRow[] =>
    rows
      .slice(0, MAX_TOP_CATEGORIES)
      .map((r) => ({ category: r.category, label: labelFor(r.category), total: r.total }));

  const cashFlow: DailySummaryResponse["cashFlow"] = {
    received: kpi(hasMoneyData ? sem.cashInflow : null, "exact", moneyAvailability),
    spent: kpi(hasMoneyData ? sem.cashOutflow : null, "exact", moneyAvailability),
    net: kpi(hasMoneyData ? sem.cashInflow - sem.cashOutflow : null, "derived", moneyAvailability),
    topInflow: topRows(sem.inflowByCategory, incomeLabel),
    topOutflow: topRows(sem.outflowByCategory, expenseLabel),
    confidence: moneyConfidence,
  };

  const economicAvailability =
    unknownCount > 0 ? worstKpiAvailability(datasetAvailability(moneyConfidence), "incomplete") : datasetAvailability(moneyConfidence);
  const economicEffect: DailySummaryResponse["economicEffect"] = {
    trueIncome: kpi(hasMoneyData ? sem.trueIncome : null, "exact", economicAvailability),
    trueExpense: kpi(hasMoneyData ? sem.trueExpense : null, "exact", economicAvailability),
    net: kpi(hasMoneyData ? sem.trueIncome - sem.trueExpense : null, "derived", economicAvailability),
    confidence: moneyConfidence,
  };

  // Conversions, per canonical category (authoritative classification).
  const convertInByCat = new Map<string, number>();
  const convertOutByCat = new Map<string, number>();
  for (const event of moneyEvents) {
    if (event.amount === 0 || event.direction === "neutral") continue;
    const kind = classifyMoneySemantics(event);
    if (kind === "asset_in") convertInByCat.set(event.category, (convertInByCat.get(event.category) ?? 0) + Math.abs(event.amount));
    if (kind === "asset_out") convertOutByCat.set(event.category, (convertOutByCat.get(event.category) ?? 0) + Math.abs(event.amount));
  }
  const conversionRows = [
    ...[...convertOutByCat.entries()].sort((a, b) => b[1] - a[1]).map(([category, total]) => ({ category, total, label: expenseLabel(category) })),
    ...[...convertInByCat.entries()].sort((a, b) => b[1] - a[1]).map(([category, total]) => ({ category, total, label: incomeLabel(category) })),
  ].slice(0, MAX_TOP_CATEGORIES) as SummaryCategoryRow[];
  const assetConversions: DailySummaryResponse["assetConversions"] = {
    convertedIn: kpi(hasMoneyData ? sem.assetInflow : null, "exact", moneyAvailability),
    convertedOut: kpi(hasMoneyData ? sem.assetOutflow : null, "exact", moneyAvailability),
    bankTransfers: hasMoneyData ? sem.bankTransfers : 0,
    rows: hasMoneyData ? conversionRows : [],
    confidence: moneyConfidence,
  };

  /* -------------------------------- travel -------------------------------- */
  const trips = buildTrips(travelEvents, travelItems, marketPrices).filter((t) => t.departedAt >= range.from && t.departedAt <= range.to);
  const travel = calculateTravelProfit(trips, range.from, range.to);
  // Phase-10 semantics: no completed trips under PROVEN coverage (complete,
  // or stale with retained history) is a valid zero; without that proof it
  // stays unavailable — never a fabricated 0. A trip with unknown valuations
  // is incomplete.
  let travelAvailability: KpiAvailability;
  if (travel.trips === 0) {
    travelAvailability = emptyDayCountsAsZero(travelConfidence, "travel") ? "ok" : "unavailable";
  } else {
    travelAvailability = travel.estimatedProfit === null ? "incomplete" : "ok";
  }
  travelAvailability = worstKpiAvailability(travelAvailability, datasetAvailability(travelConfidence));
  const travelProfitValue = travelAvailability === "unavailable" ? null : travel.estimatedProfit;

  /* --------------------------- drugs and rehab ---------------------------- */
  const priceMap = new Map<number, number>([...marketPrices].map(([k, v]) => [k, Number(v)]));
  const drugEvents = drugRows.map((r) => ({
    occurredAt: sec(r.occurredAt),
    drugItemId: r.drugItemId,
    drugName: r.drugName,
    outcome: r.outcome as "success" | "overdose",
  }));
  const consumptionEvents: ConsumptionEventLike[] = consumptionRows.map((r) => ({
    occurredAt: sec(r.occurredAt),
    category: r.category,
    quantity: r.quantity,
    totalValue: r.totalValue !== null ? Number(r.totalValue) : null,
  }));
  const consumption = aggregateConsumption(consumptionEvents, range.from, range.to);
  const consumptionAvailability = worstKpiAvailability(
    datasetAvailability(drugsConfidence),
    consumption.uses === 0 ? "unavailable" : consumption.valueUnknownCount > 0 ? "incomplete" : "ok"
  );

  const xanaxItemId = xanaxItem?.itemId ?? null;
  const xanaxUses = drugEvents.filter((e) => e.drugName?.toLowerCase() === "xanax" || (xanaxItemId !== null && e.drugItemId === xanaxItemId));
  const ledger = await buildXanaxLedger(db, userId, { from: range.from, to: range.to, xanaxItemId, xanaxUses, priceMap });
  const funding = ledger.funding;
  const xanaxEstimatedValue = ledger.unitPrice !== null ? ledger.unitPrice * xanaxUses.length : null;

  const rehabEvents = rehabRows.map((r) => ({
    occurredAt: sec(r.occurredAt),
    cost: bigintToNumber(r.cost),
    rehabPercent: r.rehabPercent,
    sessions: r.sessions,
  }));
  const rehab = calculateRehabStats(rehabEvents, range.from, range.to);
  const rehabCostAvailability: KpiAvailability =
    rehab.visits === 0 ? "ok" : rehab.totalSpend === null ? "unavailable" : rehab.sessionsUnavailable > 0 ? "incomplete" : "ok";
  // No visits → $0 is a confirmed zero (clean walk = real quiet day). Visits
  // with unknown costs keep the KNOWN sum but downgrade availability.
  const rehabCost: KpiValue = {
    value: rehab.totalSpend ?? (rehab.visits === 0 ? 0 : null),
    provenance: "exact",
    availability: worstKpiAvailability(datasetAvailability(rehabConfidence), rehabCostAvailability),
  };

  /* ------------------------------- net worth ------------------------------ */
  // When no snapshot pair exists for the day, the networth SECTION is
  // effectively unavailable even if the resource itself syncs fine —
  // surface that in the section meta and let it count as critical.
  const netWorthSection: DataConfidenceMeta =
    nwPeriod.coverage === "none"
      ? { ...networthConfidence, confidence: "unavailable", reason: "source_unavailable" }
      : networthConfidence;

  /* ------------------------------ highlights ------------------------------ */
  const highlights = buildHighlights({
    moneyEvents,
    sem,
    conversionRows,
    netWorth: {
      delta: nwPeriod.change,
      coverage: nwPeriod.coverage,
      startAt: nwPeriod.baseline?.capturedAt ?? null,
    },
    travel,
    consumption,
    xanax: { uses: xanaxUses.length, estimatedValue: xanaxEstimatedValue },
    rehab: { visits: rehab.visits, cost: rehab.totalSpend },
    crimes: crimeRows.map((r) => ({ moneyDelta: bigintToNumber(r.moneyDelta), itemsValue: bigintToNumber(r.itemsValue), success: r.success })),
    combat: combatRows.map((r) => ({ direction: r.direction as "outgoing" | "incoming", result: r.result })),
    accountEvents: accountEvents.map((e) => ({ occurredAt: sec(e.occurredAt), title: e.title })),
    moneyAvailability,
  });

  /* --------------------------- net worth drivers -------------------------- */
  const drivers = buildNetworthDrivers({
    nwPeriod,
    economicNet: hasMoneyData ? sem.trueIncome - sem.trueExpense : null,
    consumptionValue: consumption.uses > 0 ? consumption.totalValue : null,
    travelProfit: travel.trips > 0 ? travel.estimatedProfit : null,
  });

  /* -------------------------- overall confidence -------------------------- */
  // Critical sections: money_logs, networth, drugs, travel. A missing money
  // lens makes the whole summary unavailable; other critical holes degrade
  // it to partial (the summary still exists, with visible holes).
  const critical = worstConfidence([moneyConfidence, netWorthSection, drugsConfidence, travelConfidence])!;
  let overall: DataConfidenceMeta =
    critical.confidence === "unavailable" && moneyConfidence.confidence !== "unavailable"
      ? { ...critical, confidence: "partial" }
      : critical;
  if (day.ongoing) {
    // The day has not ended — end-of-day completeness is unprovable, so cap
    // at partial with the day_in_progress reason (keep coverage/freshness).
    if (overall.confidence === "complete") {
      overall = { ...overall, confidence: "partial", reason: "day_in_progress" };
    } else if (overall.reason === null) {
      overall = { ...overall, reason: "day_in_progress" };
    }
  }

  return {
    date: day.dateKey,
    timezone: user.timezone,
    range: { from: range.from, to: range.to },
    generatedAt: Math.floor(Date.now() / 1000),
    ongoingDay: day.ongoing,
    netWorth: {
      start: nwPeriod.baseline?.total ?? null,
      startAt: nwPeriod.baseline?.capturedAt ?? null,
      end: nwPeriod.current?.total ?? null,
      endAt: nwPeriod.current?.capturedAt ?? null,
      delta: nwPeriod.change,
      changePct: nwPeriod.changePct,
      coverage: nwPeriod.coverage,
      drivers,
      confidence: netWorthSection,
    },
    cashFlow,
    economicEffect,
    assetConversions,
    travel: {
      trips: travel.trips,
      estimatedProfit: kpi(travelProfitValue, "estimated", travelAvailability),
      confidence: travelConfidence,
    },
    drugs: {
      uses: consumption.uses,
      estimatedConsumptionValue: kpi(
        consumption.uses === 0 && consumptionAvailability === "unavailable" ? null : consumption.totalValue,
        "estimated",
        consumptionAvailability
      ),
      valueUnknownCount: consumption.valueUnknownCount,
      xanax: {
        consumed: xanaxUses.length,
        confirmedPersonal: funding.confirmedPersonal,
        confirmedFaction: funding.confirmedFaction,
        confirmedOther: funding.confirmedOther,
        openingInventoryUnknown: funding.openingInventoryUnknown,
        unknown: funding.unknown,
        estimatedValue: xanaxEstimatedValue,
      },
      confidence: drugsConfidence,
    },
    rehab: {
      visits: rehab.visits,
      cost: rehabCost,
      sessionsUnavailable: rehab.sessionsUnavailable,
      confidence: rehabConfidence,
    },
    highlights,
    overallConfidence: overall,
  };
}

/* -------------------------------------------------------------------------- */
/* Deterministic highlights                                                    */
/* -------------------------------------------------------------------------- */

function buildHighlights(input: {
  moneyEvents: Array<{ occurredAt: number; category: string; direction: MoneyDirection; amount: number; ocPayout: boolean }>;
  sem: ReturnType<typeof aggregateMoneySemantics>;
  conversionRows: SummaryCategoryRow[];
  netWorth: { delta: number | null; coverage: "full" | "partial" | "none"; startAt: number | null };
  travel: ReturnType<typeof calculateTravelProfit>;
  consumption: ReturnType<typeof aggregateConsumption>;
  xanax: { uses: number; estimatedValue: number | null };
  rehab: { visits: number; cost: number | null };
  crimes: Array<{ moneyDelta: number | null; itemsValue: number | null; success: boolean }>;
  combat: Array<{ direction: "outgoing" | "incoming"; result: string }>;
  accountEvents: Array<{ occurredAt: number; title: string }>;
  moneyAvailability: KpiAvailability;
}): DailyHighlight[] {
  const collected: Array<DailyHighlight & { priority: number }> = [];
  const { moneyEvents, sem } = input;

  if (input.moneyAvailability !== "unavailable" && moneyEvents.length > 0) {
    // Largest single recorded movements (floor + share of the day's flow —
    // deterministic; a quiet day's $60k outflow still qualifies, a busy
    // day's $40k does not).
    const flowMagnitude = Math.max(sem.cashInflow, sem.cashOutflow);
    const threshold = Math.max(LARGE_MOVEMENT_FLOOR, flowMagnitude * LARGE_MOVEMENT_SHARE);
    const largest = [...moneyEvents].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 2);
    for (const e of largest) {
      if (Math.abs(e.amount) < threshold) continue;
      collected.push({
        kind: e.amount > 0 ? "large_cash_in" : "large_cash_out",
        label: e.amount > 0 ? incomeLabel(e.category) : expenseLabel(e.category),
        amount: e.amount,
        occurredAt: e.occurredAt,
        tone: e.amount > 0 ? "positive" : "negative",
        priority: 3,
      });
    }
    // Largest conversion (bank/stocks/items — movement of value, not spending).
    if (input.conversionRows.length > 0) {
      const top = input.conversionRows[0]!;
      collected.push({
        kind: "asset_conversion",
        label: top.label,
        amount: top.total,
        occurredAt: null,
        tone: "neutral",
        priority: 4,
      });
    }
  }

  if (input.netWorth.coverage !== "none" && input.netWorth.delta !== null && input.netWorth.delta !== 0) {
    collected.push({
      kind: "networth_move",
      label: "Net worth",
      amount: input.netWorth.delta,
      occurredAt: null,
      tone: input.netWorth.delta > 0 ? "positive" : "negative",
      priority: 1,
    });
  }

  if (input.travel.trips > 0) {
    collected.push({
      kind: "travel_profit",
      label: input.travel.trips === 1 ? "Travel" : `${input.travel.trips} trips`,
      amount: input.travel.estimatedProfit,
      occurredAt: null,
      tone: "accent",
      priority: 5,
    });
  }

  if (input.consumption.uses > 0 || input.xanax.uses > 0) {
    collected.push({
      kind: "drug_use",
      label: input.xanax.uses > 0 ? "Xanax" : "Consumables",
      amount: input.xanax.uses > 0 && input.xanax.estimatedValue !== null ? input.xanax.estimatedValue : input.consumption.uses > 0 ? input.consumption.totalValue : null,
      occurredAt: null,
      tone: "neutral",
      priority: 6,
    });
  }

  if (input.rehab.visits > 0) {
    collected.push({
      kind: "rehab",
      label: "Rehab",
      amount: input.rehab.cost,
      occurredAt: null,
      tone: "negative",
      priority: 5,
    });
  }

  if (input.crimes.length > 0) {
    const proceeds = input.crimes.reduce((s, c) => s + (c.moneyDelta ?? 0) + (c.itemsValue ?? 0), 0);
    if (proceeds !== 0) {
      collected.push({
        kind: "crime",
        label: `${input.crimes.length} crime${input.crimes.length === 1 ? "" : "s"}`,
        amount: proceeds,
        occurredAt: null,
        tone: proceeds > 0 ? "positive" : "negative",
        priority: 7,
      });
    }
  }

  const outgoingWins = input.combat.filter((c) => c.direction === "outgoing" && c.result === "Attacked").length;
  if (outgoingWins > 0) {
    collected.push({
      kind: "combat",
      label: `${outgoingWins} win${outgoingWins === 1 ? "" : "s"}`,
      amount: null,
      occurredAt: null,
      tone: "neutral",
      priority: 8,
    });
  }

  for (const event of input.accountEvents.slice(0, 2)) {
    collected.push({
      kind: "account_event",
      label: event.title.length > 80 ? `${event.title.slice(0, 77)}…` : event.title,
      amount: null,
      occurredAt: event.occurredAt,
      tone: "neutral",
      priority: 9,
    });
  }

  if (collected.length === 0) {
    return [{ kind: "quiet_day", label: "Quiet day", amount: null, occurredAt: null, tone: "neutral" }];
  }

  return collected
    .sort((a, b) => a.priority - b.priority || Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0))
    .slice(0, 8)
    .map(({ priority: _priority, ...highlight }) => highlight);
}

/* -------------------------------------------------------------------------- */
/* "Why did net worth move?" — deterministic contributors, never causes        */
/* -------------------------------------------------------------------------- */

function buildNetworthDrivers(input: {
  nwPeriod: Awaited<ReturnType<typeof getNetworthPeriodForRange>>;
  economicNet: number | null;
  consumptionValue: number | null;
  travelProfit: number | null;
}): NetworthDriver[] {
  const { nwPeriod } = input;
  if (nwPeriod.coverage === "none" || nwPeriod.change === null) return [];

  const drivers: NetworthDriver[] = [];
  for (const cat of nwPeriod.byCategory) {
    if (cat.change === null || cat.change === 0) continue;
    const kind: NetworthDriver["kind"] = cat.key === "cash" ? "cash_flow" : cat.key === "banks" ? "bank_move" : "inventory_move";
    drivers.push({
      kind,
      label: cat.label,
      magnitude: cat.change,
      // Snapshot deltas of owned assets reflect price moves too — the
      // movement is recorded, its composition is not fully attributable.
      certainty: kind === "cash_flow" ? "recorded" : "estimated",
    });
  }
  if (input.economicNet !== null && input.economicNet !== 0) {
    drivers.push({ kind: "cash_flow", label: "Recorded net cash flow", magnitude: input.economicNet, certainty: "recorded" });
  }
  if (input.consumptionValue !== null && input.consumptionValue !== 0) {
    drivers.push({ kind: "consumption", label: "Consumed value", magnitude: -input.consumptionValue, certainty: "estimated" });
  }
  if (input.travelProfit !== null && input.travelProfit !== 0) {
    drivers.push({ kind: "travel_profit", label: "Estimated travel profit", magnitude: input.travelProfit, certainty: "estimated" });
  }

  // Honest residual: how much of the snapshot delta the drivers above do NOT
  // explain (price moves, unvalued items, model limits). Only surfaced when
  // it is material relative to the day's movement.
  const explained = drivers.reduce((s, d) => s + (d.magnitude ?? 0), 0);
  const residual = nwPeriod.change - explained;
  const material = Math.abs(residual) > Math.max(10_000, Math.abs(nwPeriod.change) * 0.05);
  drivers.push({
    kind: "residual",
    label: "Not explained by recorded activity",
    magnitude: material ? residual : 0,
    certainty: "unexplained",
  });

  const ranked = drivers
    .filter((d) => d.kind !== "residual")
    .sort((a, b) => Math.abs(b.magnitude ?? 0) - Math.abs(a.magnitude ?? 0))
    .slice(0, 5);
  const residualDriver = drivers.find((d) => d.kind === "residual")!;
  return material ? [...ranked, residualDriver] : ranked;
}

/** Exposed for tests: the canonical label fallbacks used in highlights. */
export const dailySummaryLabels = { incomeLabel, expenseLabel, humanLabel, dayKeyInZone };
