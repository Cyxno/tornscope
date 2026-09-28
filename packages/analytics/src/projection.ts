import type { Projection, ProjectionConfidence, ProjectionInsufficientReason, ProjectionLookbackDays } from "@tornscope/shared";

/**
 * Trend projection primitive (2.0).
 *
 * Given a historical series and a target value, estimate when the target is
 * reached — or honestly decline to. The estimator is deliberately
 * conservative:
 *
 * - `velocityPerDay` is the MEDIAN of per-day deltas (robust against single
 *   spike days — one lucky happy jump must not promise an ETA).
 * - `slopePerDay` is the least-squares slope; the two must AGREE IN SIGN and
 *   the fit must not be pure noise (R² gate) or no ETA is produced.
 * - Anything beyond a 5-year horizon is withheld: beyond a certain distance a
 *   "projection" is indistinguishable from a guess.
 *
 * All inputs are plain numbers and unix seconds; the function is pure and
 * deterministic — same series in, same verdict out.
 */

const DAY = 86_400;

/** A single historical observation. */
export interface ProjectionPoint {
  t: number;
  value: number;
}

/** Tunable gates (documented defaults; tests pin the boundaries). */
export const PROJECTION_POLICY = {
  /** Fewer points than this in the window → insufficient_history. */
  MIN_POINTS: 4,
  /** Fewer full days spanned than this → insufficient_history. */
  MIN_SPAN_DAYS: 3,
  /** R² below this reads as noise → too_volatile (no ETA). */
  MIN_R2_FOR_ETA: 0.3,
  /** R² at/above this (with sign agreement) → high confidence. */
  HIGH_R2: 0.7,
  /** |median − slope| must not exceed this fraction of |slope| (sign-agree + magnitude sanity). */
  MAX_METHOD_DIVERGENCE: 0.5,
  /** Projected ETA further than this many days is withheld. */
  HORIZON_DAYS: 5 * 365,
  /** Velocity is exactly 0 (or negative for an increasing target) → no trend. */
} as const;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid]!;
  const upper = sorted.length % 2 === 1 ? lower : sorted[mid - 1]!;
  return (lower + upper) / 2;
}

/**
 * Least-squares slope/intercept + R² over (t, value). t is normalized to days
 * from the first point to keep the slope in units/day and the math stable.
 */
function leastSquares(points: ReadonlyArray<ProjectionPoint>): { slope: number; intercept: number; r2: number } | null {
  const n = points.length;
  if (n < 3) return null;
  const t0 = points[0]!.t;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const x = (p.t - t0) / DAY;
    sx += x;
    sy += p.value;
    sxx += x * x;
    sxy += x * p.value;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  let ssTot = 0;
  let ssRes = 0;
  for (const p of points) {
    const x = (p.t - t0) / DAY;
    const predicted = intercept + slope * x;
    ssTot += (p.value - meanY) ** 2;
    ssRes += (p.value - predicted) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, r2 };
}

/**
 * Project when `target` is reached, based on the trailing `lookbackDays`
 * window of `points` (ascending or unordered; duplicates allowed).
 * Series semantics (monotonicity, noise) are the caller's concern — this
 * module only refuses to extrapolate from insufficient or contradictory data.
 */
export function projectTowardTarget(
  points: ReadonlyArray<ProjectionPoint>,
  target: number,
  now: number,
  lookbackDays: ProjectionLookbackDays,
  currentValue: number | null = null
): Projection {
  const insufficient = (reason: ProjectionInsufficientReason, confidence: ProjectionConfidence, window: Projection["window"], velocity: number | null, fit: { slope: number; r2: number } | null): Projection => ({
    etaAt: null,
    velocityPerDay: velocity,
    slopePerDay: fit ? fit.slope : null,
    fitR2: fit ? fit.r2 : null,
    lookbackDays,
    confidence,
    insufficientReason: reason,
    window,
    provenance: "derived",
  });

  const windowStart = now - lookbackDays * DAY;
  const inWindow = points.filter((p) => p.t >= windowStart && p.t <= now && Number.isFinite(p.value));
  const window: Projection["window"] = {
    from: inWindow.length > 0 ? inWindow[0]!.t : null,
    to: inWindow.length > 0 ? inWindow[inWindow.length - 1]!.t : null,
    points: inWindow.length,
  };

  const current = currentValue ?? (inWindow.length > 0 ? inWindow[inWindow.length - 1]!.value : null);
  if (current === null) {
    return insufficient("insufficient_history", "insufficient", window, null, null);
  }
  if (current >= target) {
    return insufficient("target_reached", "high", window, null, null);
  }
  if (inWindow.length < PROJECTION_POLICY.MIN_POINTS) {
    return insufficient("insufficient_history", "insufficient", window, null, null);
  }
  const ordered = [...inWindow].sort((a, b) => a.t - b.t);
  const spanDays = (ordered[ordered.length - 1]!.t - ordered[0]!.t) / DAY;
  if (spanDays < PROJECTION_POLICY.MIN_SPAN_DAYS) {
    return insufficient("insufficient_history", "insufficient", window, null, null);
  }

  // Median per-day delta: interpolate the series at each whole day inside the
  // window and diff consecutive days. Spikes on a single snapshot then move
  // at most two day-values instead of dominating the estimate.
  const dailyDeltas: number[] = [];
  const firstDay = Math.ceil(ordered[0]!.t / DAY) * DAY;
  const lastDay = Math.floor(ordered[ordered.length - 1]!.t / DAY) * DAY;
  const valueAt = (ts: number): number | null => {
    // Linear interpolation between neighbors (binary search).
    let lo = 0;
    let hi = ordered.length - 1;
    if (ts <= ordered[0]!.t) return ordered[0]!.value;
    if (ts >= ordered[hi]!.t) return ordered[hi]!.value;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ordered[mid]!.t <= ts) lo = mid;
      else hi = mid;
    }
    const a = ordered[lo]!;
    const b = ordered[hi]!;
    const frac = b.t === a.t ? 0 : (ts - a.t) / (b.t - a.t);
    return a.value + (b.value - a.value) * frac;
  };
  for (let day = firstDay + DAY; day <= lastDay; day += DAY) {
    const prev = valueAt(day - DAY);
    const cur = valueAt(day);
    if (prev !== null && cur !== null) dailyDeltas.push(cur - prev);
  }

  const velocity = median(dailyDeltas);
  const fit = leastSquares(ordered);
  const slope = fit ? fit.slope : null;
  const r2 = fit ? fit.r2 : null;

  if (velocity === null || slope === null || velocity <= 0 || slope <= 0) {
    // Flat or receding trend. Velocity itself is still informative.
    return insufficient("no_positive_trend", velocity !== null && slope !== null ? "low" : "insufficient", window, velocity, fit);
  }

  // Method agreement: median and slope must tell the same story. Divergence
  // beyond the policy fraction means the "trend" is driven by outliers.
  const divergence = Math.abs(velocity - slope) / slope;
  const agree = divergence <= PROJECTION_POLICY.MAX_METHOD_DIVERGENCE;

  let confidence: ProjectionConfidence;
  if (!agree || (r2 !== null && r2 < PROJECTION_POLICY.MIN_R2_FOR_ETA)) confidence = "low";
  else if (r2 !== null && r2 >= PROJECTION_POLICY.HIGH_R2) confidence = "high";
  else confidence = "medium";

  if (confidence === "low") {
    return insufficient("too_volatile", "low", window, velocity, fit);
  }

  const remaining = target - current;
  const etaSeconds = remaining / velocity * DAY;
  if (etaSeconds > PROJECTION_POLICY.HORIZON_DAYS * DAY) {
    return insufficient("beyond_horizon", confidence, window, velocity, fit);
  }

  return {
    etaAt: Math.round(now + etaSeconds),
    velocityPerDay: velocity,
    slopePerDay: slope,
    fitR2: r2,
    lookbackDays,
    confidence,
    insufficientReason: null,
    window,
    provenance: "derived",
  };
}

/* -------------------------------------------------------------------------- */
/* Observed trend (no target) — shared by wealth velocity & training intel     */
/* -------------------------------------------------------------------------- */

export interface ObservedTrend {
  /** Median per-day delta over the window (robust). */
  velocityPerDay: number | null;
  /** Least-squares slope per day (null when < 3 points). */
  slopePerDay: number | null;
  fitR2: number | null;
  confidence: ProjectionConfidence;
  /** Points and span actually used. */
  window: { from: number | null; to: number | null; points: number; spanDays: number | null };
}

/**
 * Describe the observed trend of a series over the trailing lookback window
 * — no target, no ETA. Same robustness gates as projectTowardTarget
 * (median vs least-squares agreement, R² gate).
 */
export function observedTrend(points: ReadonlyArray<ProjectionPoint>, now: number, lookbackDays: number): ObservedTrend {
  const windowStart = now - lookbackDays * DAY;
  const inWindow = points.filter((p) => p.t >= windowStart && p.t <= now && Number.isFinite(p.value));
  const ordered = [...inWindow].sort((a, b) => a.t - b.t);
  const window: ObservedTrend["window"] = {
    from: ordered.length > 0 ? ordered[0]!.t : null,
    to: ordered.length > 0 ? ordered[ordered.length - 1]!.t : null,
    points: ordered.length,
    spanDays: ordered.length >= 2 ? (ordered[ordered.length - 1]!.t - ordered[0]!.t) / DAY : null,
  };

  if (ordered.length < PROJECTION_POLICY.MIN_POINTS || (window.spanDays ?? 0) < PROJECTION_POLICY.MIN_SPAN_DAYS) {
    return { velocityPerDay: null, slopePerDay: null, fitR2: null, confidence: "insufficient", window };
  }

  // Median per-day delta via day interpolation (identical to the projector).
  const dailyDeltas: number[] = [];
  const firstDay = Math.ceil(ordered[0]!.t / DAY) * DAY;
  const lastDay = Math.floor(ordered[ordered.length - 1]!.t / DAY) * DAY;
  const valueAt = (ts: number): number => {
    let lo = 0;
    let hi = ordered.length - 1;
    if (ts <= ordered[0]!.t) return ordered[0]!.value;
    if (ts >= ordered[hi]!.t) return ordered[hi]!.value;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ordered[mid]!.t <= ts) lo = mid;
      else hi = mid;
    }
    const a = ordered[lo]!;
    const b = ordered[hi]!;
    const frac = b.t === a.t ? 0 : (ts - a.t) / (b.t - a.t);
    return a.value + (b.value - a.value) * frac;
  };
  for (let day = firstDay + DAY; day <= lastDay; day += DAY) {
    dailyDeltas.push(valueAt(day) - valueAt(day - DAY));
  }
  const velocity = median(dailyDeltas);
  const fit = leastSquares(ordered);
  const slope = fit ? fit.slope : null;
  const r2 = fit ? fit.r2 : null;

  if (velocity === null || slope === null) {
    return { velocityPerDay: velocity, slopePerDay: slope, fitR2: r2, confidence: "insufficient", window };
  }
  const divergence = slope !== 0 ? Math.abs(velocity - slope) / Math.abs(slope) : 0;
  const agree = divergence <= PROJECTION_POLICY.MAX_METHOD_DIVERGENCE;
  if (!agree || (r2 !== null && r2 < PROJECTION_POLICY.MIN_R2_FOR_ETA)) {
    return { velocityPerDay: velocity, slopePerDay: slope, fitR2: r2, confidence: "low", window };
  }
  if (r2 !== null && r2 >= PROJECTION_POLICY.HIGH_R2) {
    return { velocityPerDay: velocity, slopePerDay: slope, fitR2: r2, confidence: "high", window };
  }
  return { velocityPerDay: velocity, slopePerDay: slope, fitR2: r2, confidence: "medium", window };
}
