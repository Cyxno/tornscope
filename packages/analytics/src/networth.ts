import type { Provenance } from "@tornscope/shared";

/**
 * Net worth history analytics.
 *
 * Two concepts, never mixed:
 * - Period change: difference between Torn networth SNAPSHOTS (exact,
 *   Torn-provided). Baseline = closest valid snapshot at or before the
 *   period start. When tracking began after the period started there is no
 *   baseline — the result is flagged "partial" (a Tracked period change)
 *   instead of presenting a misleading 0.
 * - Category breakdown: the same two snapshots compared per Torn-provided
 *   category (cash, banks, stocks, items, property, points, company, other).
 *   Inventory appreciation shows up ONLY here — never as cash income.
 */

export interface NetworthPointLike {
  capturedAt: number;
  total: number;
}

export interface NetworthChanges {
  current: number | null;
  change7d: number | null;
  change30d: number | null;
  changeYtd: number | null;
  changeAllTime: number | null;
  firstTrackedAt: number | null;
  provenance: Provenance;
}

const DAY = 86_400;

function valueAtOrBefore<T extends NetworthPointLike>(snapshots: readonly T[], ts: number): T | null {
  let best: T | null = null;
  for (const s of snapshots) {
    if (s.capturedAt <= ts && (best === null || s.capturedAt >= best.capturedAt)) best = s;
  }
  return best;
}

/** Compute period changes from snapshot history (ascending or unordered). */
export function calculateNetworthChanges(
  snapshots: readonly NetworthPointLike[],
  now: number,
  yearStart: number
): NetworthChanges {
  if (snapshots.length === 0) {
    return { current: null, change7d: null, change30d: null, changeYtd: null, changeAllTime: null, firstTrackedAt: null, provenance: "exact" };
  }

  const sorted = [...snapshots].sort((a, b) => a.capturedAt - b.capturedAt);
  const latest = sorted[sorted.length - 1];
  const earliest = sorted[0];
  if (!latest || !earliest) {
    return { current: null, change7d: null, change30d: null, changeYtd: null, changeAllTime: null, firstTrackedAt: null, provenance: "exact" };
  }

  const changeFor = (sinceTs: number): number | null => {
    const base = valueAtOrBefore(sorted, sinceTs);
    return base ? latest.total - base.total : null;
  };

  return {
    current: latest.total,
    change7d: changeFor(now - 7 * DAY),
    change30d: changeFor(now - 30 * DAY),
    changeYtd: changeFor(yearStart),
    changeAllTime: latest.total - earliest.total,
    firstTrackedAt: earliest.capturedAt,
    provenance: "exact",
  };
}

/* -------------------------------------------------------------------------- */
/* Period change + category breakdown                                          */
/* -------------------------------------------------------------------------- */

/** All networth fields needed for the category breakdown (numbers, not BigInt). */
export interface NetworthSnapshotFields extends NetworthPointLike {
  pending: number;
  loans: number;
  unpaidFees: number;
  wallet: number;
  vault: number;
  bookie: number;
  cityBank: number;
  caymanBank: number;
  piggyBank: number;
  inventory: number;
  displayCase: number;
  bazaar: number;
  trades: number;
  itemMarket: number;
  auctionHouse: number;
  enlistedCars: number;
  property: number;
  stockMarket: number;
  company: number;
  points: number;
}

export interface NetworthBreakdownPoint {
  capturedAt: number;
  total: number;
  /** Loans + unpaid fees (stored NEGATIVE in Torn's own breakdown). */
  liabilities: number;
  /** Net total minus liabilities (balance sheet: assets before debts). */
  grossAssets: number;
  /** Wallet + vault + pending. */
  cash: number;
  /** City bank + Cayman bank + piggy bank + bookie. */
  banks: number;
  stocks: number;
  /** Inventory + display case + bazaar + trades + item market + auction house + enlisted cars. */
  items: number;
  property: number;
  points: number;
  company: number;
  /** total minus the known categories (loans, unpaid fees, misc) — reconciles to total. */
  other: number;
}

export interface NetworthCategoryChange {
  key: "cash" | "banks" | "stocks" | "items" | "property" | "points" | "company" | "other";
  label: string;
  current: number;
  baseline: number;
  change: number;
}

export interface NetworthPeriodChange {
  /** Latest snapshot at or before the period end. */
  current: NetworthBreakdownPoint | null;
  /** Closest snapshot at or before the period start (null when tracking started later). */
  baseline: NetworthBreakdownPoint | null;
  change: number | null;
  changePct: number | null;
  /**
   * full    — a snapshot at/before the period start exists (baseline is valid)
   * partial — tracking began after the period started; change spans the
   *           tracked portion only (label: "Tracked period change")
   * none    — not enough history to compute any change
   */
  coverage: "full" | "partial" | "none";
  /** Earliest snapshot in the range — drives "tracked since" wording. */
  trackedFrom: number | null;
  byCategory: NetworthCategoryChange[];
  provenance: Provenance;
}

export const NETWORTH_CATEGORY_LABELS: Record<NetworthCategoryChange["key"], string> = {
  cash: "Cash",
  banks: "Bank",
  stocks: "Stocks",
  // Unambiguous: this is inventory VALUE held, not "items sold" or "items bought".
  items: "Items (inventory value)",
  property: "Property",
  points: "Points",
  company: "Company",
  other: "Other",
};

export interface NetworthSeriesPoint {
  t: number;
  total: number;
}

/**
 * Chronological series of REAL snapshots for the chart. Every stored snapshot
 * appears exactly once with its own capturedAt and its own value — no
 * bucketing that could collapse or repeat values, nothing stretched outside
 * [from, to], nothing replaced with the latest value.
 */
export function buildNetworthSeries(rows: ReadonlyArray<{ capturedAt: number; total: number }>, from: number, to: number): NetworthSeriesPoint[] {
  return rows
    .filter((r) => r.capturedAt >= from && r.capturedAt <= to)
    .map((r) => ({ t: r.capturedAt, total: r.total }))
    .sort((a, b) => a.t - b.t || a.total - b.total);
}

export function toBreakdownPoint(snapshot: NetworthSnapshotFields): NetworthBreakdownPoint {
  // Torn stores loans/unpaid fees as NEGATIVE components and total is NET
  // (verified over the stored archive: total = sum of ALL components).
  // Liabilities are reported as a positive balance-sheet figure; gross
  // assets = net + liabilities. Balance-sheet only — never cashflow.
  const liabilities = -(snapshot.loans + snapshot.unpaidFees) || 0;
  const cash = snapshot.wallet + snapshot.vault + snapshot.pending;
  const banks = snapshot.cityBank + snapshot.caymanBank + snapshot.piggyBank + snapshot.bookie;
  const stocks = snapshot.stockMarket;
  const items =
    snapshot.inventory + snapshot.displayCase + snapshot.bazaar + snapshot.trades + snapshot.itemMarket + snapshot.auctionHouse + snapshot.enlistedCars;
  const known = cash + banks + stocks + items + snapshot.property + snapshot.points + snapshot.company;
  return {
    capturedAt: snapshot.capturedAt,
    total: snapshot.total,
    liabilities,
    grossAssets: snapshot.total + liabilities || 0,
    cash,
    banks,
    stocks,
    items,
    property: snapshot.property,
    points: snapshot.points,
    company: snapshot.company,
    other: snapshot.total - known,
  };
}

/**
 * Networth change over a [from, to] period.
 *
 * The baseline is the closest valid snapshot AT OR BEFORE `from` — never a
 * snapshot inside the period (that would hide part of the change). When
 * tracking began after the period start, coverage is "partial": the change is
 * computed from the first snapshot inside the period and must be labeled a
 * "Tracked period change". With no usable snapshots at all, coverage is
 * "none" and change is null — callers must render that as Insufficient
 * history, never as 0.
 */
export function calculateNetworthPeriodChange(snapshots: readonly NetworthSnapshotFields[], from: number, to: number): NetworthPeriodChange {
  const sorted = [...snapshots].sort((a, b) => a.capturedAt - b.capturedAt);
  const trackedFrom = sorted.length > 0 ? sorted[0]!.capturedAt : null;

  const current = valueAtOrBefore(sorted, to);
  if (!current) {
    return { current: null, baseline: null, change: null, changePct: null, coverage: "none", trackedFrom, byCategory: [], provenance: "exact" };
  }
  const currentPoint = toBreakdownPoint(current);

  const baseline = valueAtOrBefore(sorted, from);
  if (!baseline) {
    // Tracking started after the period began — a Tracked period change over
    // the covered span, measured from the first snapshot inside the period.
    const earliest = sorted.find((s) => s.capturedAt >= from && s.capturedAt <= to);
    if (!earliest || earliest.capturedAt === current.capturedAt) {
      return { current: currentPoint, baseline: null, change: null, changePct: null, coverage: "none", trackedFrom, byCategory: [], provenance: "exact" };
    }
    const earliestPoint = toBreakdownPoint(earliest);
    const change = currentPoint.total - earliestPoint.total;
    const changePct = earliestPoint.total !== 0 ? (change / Math.abs(earliestPoint.total)) * 100 : null;
    const byCategory = (Object.keys(NETWORTH_CATEGORY_LABELS) as NetworthCategoryChange["key"][]).map((key) => ({
      key,
      label: NETWORTH_CATEGORY_LABELS[key],
      current: currentPoint[key],
      baseline: earliestPoint[key],
      change: currentPoint[key] - earliestPoint[key],
    }));
    return { current: currentPoint, baseline: earliestPoint, change, changePct, coverage: "partial", trackedFrom, byCategory, provenance: "exact" };
  }

  const baselinePoint = toBreakdownPoint(baseline);
  const change = currentPoint.total - baselinePoint.total;
  const changePct = baselinePoint.total !== 0 ? (change / Math.abs(baselinePoint.total)) * 100 : null;

  const byCategory = (Object.keys(NETWORTH_CATEGORY_LABELS) as NetworthCategoryChange["key"][]).map((key) => ({
    key,
    label: NETWORTH_CATEGORY_LABELS[key],
    current: currentPoint[key],
    baseline: baselinePoint[key],
    change: currentPoint[key] - baselinePoint[key],
  }));

  return { current: currentPoint, baseline: baselinePoint, change, changePct, coverage: "full", trackedFrom, byCategory, provenance: "exact" };
}


/* -------------------------------------------------------------------------- */
/* Balance-sheet position (2.6.0): gross assets / liabilities / net            */
/* -------------------------------------------------------------------------- */

export interface NetworthPositionLine {
  current: number | null;
  baseline: number | null;
  change: number | null;
}

export interface NetworthPosition {
  net: NetworthPositionLine;
  grossAssets: NetworthPositionLine;
  liabilities: NetworthPositionLine;
  loans: NetworthPositionLine;
  unpaidFees: NetworthPositionLine;
  /** full / partial / none — same semantics as the period change. */
  coverage: "full" | "partial" | "none";
  trackedFrom: number | null;
  provenance: Provenance;
}

/** Balance-sheet position over the period. Liabilities are POSITIVE figures
 *  (how much is owed); net = grossAssets − liabilities. Never cashflow. */
export function calculateNetworthPosition(snapshots: readonly NetworthSnapshotFields[], from: number, to: number): NetworthPosition {
  const sorted = [...snapshots].sort((a, b) => a.capturedAt - b.capturedAt);
  const trackedFrom = sorted.length > 0 ? sorted[0]!.capturedAt : null;
  const line = (pick: (s: NetworthSnapshotFields) => number | null): NetworthPositionLine => ({
    current: null,
    baseline: null,
    change: null,
  });
  const build = (s: NetworthSnapshotFields | undefined) => (s === undefined ? null : s);
  const current = valueAtOrBefore(sorted, to);
  const baseline = valueAtOrBefore(sorted, from);
  let coverage: "full" | "partial" | "none" = "none";
  if (current && baseline && baseline.capturedAt !== current.capturedAt) coverage = "full";
  else if (current) coverage = "partial";
  const effectiveBaseline = baseline ?? sorted.find((s) => s.capturedAt >= from && s.capturedAt <= to);
  const mk = (pick: (s: NetworthSnapshotFields) => number): NetworthPositionLine => ({
    current: current ? pick(current) : null,
    baseline: effectiveBaseline ? pick(effectiveBaseline) : null,
    change: current && effectiveBaseline ? pick(current) - pick(effectiveBaseline) : null,
  });
  void line;
  return {
    net: mk((s) => s.total),
    grossAssets: mk((s) => s.total + -(s.loans + s.unpaidFees)),
    liabilities: mk((s) => -(s.loans + s.unpaidFees) || 0),
    loans: mk((s) => -s.loans || 0),
    unpaidFees: mk((s) => -s.unpaidFees || 0),
    coverage,
    trackedFrom,
    provenance: "exact",
  };
}
