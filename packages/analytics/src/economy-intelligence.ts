import { aggregateMoneySemantics, classifyMoneySemantics, type MoneyEventLike } from "./money.js";
import type { NetworthSnapshotFields } from "./networth.js";
import { calculateNetworthPeriodChange } from "./networth.js";
import { observedTrend, type ObservedTrend } from "./projection.js";
import { startOfDay } from "./series.js";
import { buildDailyTravelProfit, type TravelTripLike } from "./travel.js";

/**
 * Economy intelligence (2.0) — wealth velocity, trend projection, wealth
 * attribution and personal financial records, all over stored snapshots and
 * the money ledger.
 *
 * The wealth-first philosophy is inherited, never re-derived:
 * - cash moved into items/stocks/bank is a CONVERSION, not a loss —
 *   attribution splits earned income, true spending and the residual asset
 *   movement instead of counting flows;
 * - the residual (asset appreciation + any non-ledger movement) is reported
 *   as its own derived figure with its coverage, never folded into income;
 * - every aggregate is mutually exclusive, so nothing is double counted.
 */

const DAY = 86_400;

export interface EconomyIntelligenceInputs {
  now: number;
  /** Full net worth snapshots (attribution needs the category columns). */
  networthSnapshots: ReadonlyArray<NetworthSnapshotFields>;
  /** Money ledger covering the largest window the caller wants attributed. */
  moneyEvents: ReadonlyArray<MoneyEventLike>;
  /** Assembled trips (records only). */
  travelTrips: ReadonlyArray<TravelTripLike>;
}

/* -------------------------------------------------------------------------- */
/* Wealth velocity                                                             */
/* -------------------------------------------------------------------------- */

export interface WealthVelocityEntry {
  lookbackDays: number;
  /** Signed change over the window (null without a valid baseline). */
  change: number | null;
  /** Signed per-day rate over the window (null without a valid baseline). */
  velocityPerDay: number | null;
  /** full | partial | none — identical semantics to networth period change. */
  coverage: "full" | "partial" | "none";
  trend: ObservedTrend;
}

function valueAtOrBefore(sorted: ReadonlyArray<NetworthSnapshotFields>, ts: number): NetworthSnapshotFields | null {
  let best: NetworthSnapshotFields | null = null;
  for (const s of sorted) {
    if (s.capturedAt <= ts && (best === null || s.capturedAt >= best.capturedAt)) best = s;
  }
  return best;
}

/** Velocity over each lookback from real snapshots. Pure. */
export function buildWealthVelocity(snapshots: ReadonlyArray<NetworthSnapshotFields>, now: number, lookbacks: ReadonlyArray<number> = [7, 30, 90]): WealthVelocityEntry[] {
  const sorted = [...snapshots].sort((a, b) => a.capturedAt - b.capturedAt);
  return lookbacks.map((lookbackDays) => {
    const from = now - lookbackDays * DAY;
    const latest = sorted.length > 0 ? sorted[sorted.length - 1]! : null;
    const trend = observedTrend(sorted.map((s) => ({ t: s.capturedAt, value: s.total })), now, lookbackDays);
    if (!latest) {
      return { lookbackDays, change: null, velocityPerDay: null, coverage: "none" as const, trend };
    }
    // Baseline = closest snapshot at-or-before the window start; when tracking
    // began inside the window, the earliest in-window snapshot serves with
    // "partial" coverage (identical semantics to networth period change).
    const baseline = valueAtOrBefore(sorted, from) ?? sorted.find((s) => s.capturedAt >= from && s.capturedAt <= now) ?? null;
    if (!baseline || baseline.capturedAt === latest.capturedAt) {
      return { lookbackDays, change: null, velocityPerDay: null, coverage: "none" as const, trend };
    }
    const change = latest.total - baseline.total;
    const spanDays = Math.max(1, (latest.capturedAt - baseline.capturedAt) / DAY);
    const coverage: "full" | "partial" = baseline.capturedAt <= from ? "full" : "partial";
    return { lookbackDays, change, velocityPerDay: change / spanDays, coverage, trend };
  });
}

/* -------------------------------------------------------------------------- */
/* Wealth projection                                                           */
/* -------------------------------------------------------------------------- */

export interface WealthProjection {
  /** Current total (latest snapshot). */
  current: number | null;
  /** Projected total in `horizonDays` at the 30-day median velocity. */
  projectedIn30d: number | null;
  velocityPerDay: number | null;
  /** Trend confidence over the projection lookback. */
  confidence: ObservedTrend["confidence"];
  lookbackDays: number;
  horizonDays: number;
  provenance: "derived";
}

/**
 * "Where is the 30-day trend heading" — a straight-line PROJECTION, never a
 * prediction: withholds the number unless the trend confidence clears "low".
 */
export function buildWealthProjection(snapshots: ReadonlyArray<NetworthSnapshotFields>, now: number, lookbackDays = 30, horizonDays = 30): WealthProjection {
  const sorted = [...snapshots].sort((a, b) => a.capturedAt - b.capturedAt);
  const current = sorted.length > 0 ? sorted[sorted.length - 1]!.total : null;
  const trend = observedTrend(sorted.map((s) => ({ t: s.capturedAt, value: s.total })), now, lookbackDays);
  const usable = current !== null && trend.velocityPerDay !== null && (trend.confidence === "medium" || trend.confidence === "high");
  return {
    current,
    projectedIn30d: usable ? current! + trend.velocityPerDay! * horizonDays : null,
    velocityPerDay: trend.velocityPerDay,
    confidence: trend.confidence,
    lookbackDays,
    horizonDays,
    provenance: "derived",
  };
}

/* -------------------------------------------------------------------------- */
/* Wealth attribution                                                          */
/* -------------------------------------------------------------------------- */

export interface WealthAttribution {
  from: number;
  to: number;
  /** Earned/received money (true income semantics). */
  earnedIncome: number;
  /** Consumed/lost money (true expense semantics). */
  spending: number;
  /** Cash raised selling assets (not income). */
  assetSales: number;
  /** Cash spent acquiring assets (not a loss). */
  assetPurchases: number;
  /** Official net worth change over the window (null without baseline). */
  netWorthChange: number | null;
  /**
   * Net worth change minus ledger-known flows: asset appreciation, market
   * drift and any movement without a ledger row. Derived residual — reported
   * separately, never folded into income.
   */
  unexplainedMovement: number | null;
  /** 'full' requires a net worth baseline at/before `from`. */
  netWorthCoverage: "full" | "partial" | "none";
  /** Share of ledger magnitude that could not be classified (0..1). */
  unknownShare: number;
  provenance: "derived";
}

/**
 * Attribute the window's wealth movement. Partitions are mutually exclusive
 * by construction (semantics classification), and the residual is computed
 * exactly once against the official net worth delta.
 */
export function buildWealthAttribution(inputs: { moneyEvents: ReadonlyArray<MoneyEventLike>; networthSnapshots: ReadonlyArray<NetworthSnapshotFields> }, from: number, to: number): WealthAttribution {
  const semantics = aggregateMoneySemantics(inputs.moneyEvents, from, to);
  const nw = calculateNetworthPeriodChange(inputs.networthSnapshots, from, to);
  const magnitude = semantics.trueIncome + semantics.trueExpense + semantics.assetInflow + semantics.assetOutflow;
  const unknownShare = magnitude > 0 ? semantics.unknownValue / magnitude : 0;
  const ledgerNet = semantics.trueIncome - semantics.trueExpense;
  const netWorthCoverage = nw.coverage;
  const unexplainedMovement = nw.change !== null ? nw.change - ledgerNet : null;
  return {
    from,
    to,
    earnedIncome: semantics.trueIncome,
    spending: semantics.trueExpense,
    assetSales: semantics.assetInflow,
    assetPurchases: semantics.assetOutflow,
    netWorthChange: nw.change,
    unexplainedMovement,
    netWorthCoverage,
    unknownShare,
    provenance: "derived",
  };
}

/* -------------------------------------------------------------------------- */
/* Personal financial records                                                  */
/* -------------------------------------------------------------------------- */

export interface FinancialRecord {
  value: number;
  /** When the record was set (unix seconds; day start for day records). */
  at: number;
  provenance: "exact" | "estimated";
}

export interface FinancialRecords {
  highestNetWorth: FinancialRecord | null;
  highestWalletBalance: FinancialRecord | null;
  bestIncomeDay: FinancialRecord | null;
  largestExpenseDay: FinancialRecord | null;
  highestDailyWealthGrowth: FinancialRecord | null;
  mostProfitableTravelDay: FinancialRecord | null;
}

/**
 * All-time (within the provided rows) extremes. Every record carries the
 * timestamp it was set so the UI can say "since when". Records are computed
 * from the rows the caller passes — typically the full stored history
 * (bounded by the query, not by this function).
 */
export function buildFinancialRecords(inputs: { networthSnapshots: ReadonlyArray<NetworthSnapshotFields>; moneyEvents: ReadonlyArray<MoneyEventLike>; travelTrips: ReadonlyArray<TravelTripLike> }): FinancialRecords {
  const { networthSnapshots, moneyEvents, travelTrips } = inputs;

  let highestNetWorth: FinancialRecord | null = null;
  let highestWalletBalance: FinancialRecord | null = null;
  for (const s of networthSnapshots) {
    if (highestNetWorth === null || s.total > highestNetWorth.value) highestNetWorth = { value: s.total, at: s.capturedAt, provenance: "exact" };
    if (s.wallet > (highestWalletBalance?.value ?? -1)) highestWalletBalance = { value: s.wallet, at: s.capturedAt, provenance: "exact" };
  }

  // Day-aggregated true income/expense (semantics — conversions never count).
  const incomeByDay = new Map<number, number>();
  const expenseByDay = new Map<number, number>();
  for (const event of moneyEvents) {
    if (event.amount === 0) continue;
    const kind = classifyMoneySemantics(event);
    const day = startOfDay(event.occurredAt);
    if (kind === "true_income") incomeByDay.set(day, (incomeByDay.get(day) ?? 0) + Math.abs(event.amount));
    else if (kind === "true_expense") expenseByDay.set(day, (expenseByDay.get(day) ?? 0) + Math.abs(event.amount));
  }
  const maxOf = (map: Map<number, number>): FinancialRecord | null => {
    let best: FinancialRecord | null = null;
    for (const [day, value] of map) {
      if (best === null || value > best.value) best = { value, at: day, provenance: "exact" };
    }
    return best;
  };
  const bestIncomeDay = maxOf(incomeByDay);
  const largestExpenseDay = maxOf(expenseByDay);

  // Highest day-over-day wealth growth from consecutive snapshots.
  let highestDailyWealthGrowth: FinancialRecord | null = null;
  const sorted = [...networthSnapshots].sort((a, b) => a.capturedAt - b.capturedAt);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const growth = cur.total - prev.total;
    if (highestDailyWealthGrowth === null || growth > highestDailyWealthGrowth.value) {
      highestDailyWealthGrowth = { value: growth, at: cur.capturedAt, provenance: "exact" };
    }
  }

  // Most profitable travel day (estimated resale where the catalog allows).
  let mostProfitableTravelDay: FinancialRecord | null = null;
  for (const dayPoint of buildDailyTravelProfit(travelTrips, 0, Number.MAX_SAFE_INTEGER)) {
    if (dayPoint.profit <= 0) continue;
    if (mostProfitableTravelDay === null || dayPoint.profit > mostProfitableTravelDay.value) {
      mostProfitableTravelDay = { value: dayPoint.profit, at: dayPoint.t, provenance: "estimated" };
    }
  }

  return { highestNetWorth, highestWalletBalance, bestIncomeDay, largestExpenseDay, highestDailyWealthGrowth, mostProfitableTravelDay };
}
