import type { Projection, ProjectionConfidence, ProjectionInsufficientReason, ProjectionLookbackDays } from "@tornscope/shared";
import { PROJECTION_POLICY, type ProjectionPoint } from "./projection.js";

/**
 * EMPIRICAL COMPOUNDING — battle-stat goal projection (semantic audit 2.0;
 * reclassified in 2.0.2). This is an EMPIRICAL PROJECTION, not a mechanistic
 * Torn gym simulator: it extrapolates the player's OBSERVED relative growth
 * pattern, honestly labeled as such everywhere user-facing copy exists.
 *
 * WHY NOT LINEAR: absolute gain per day is the wrong shape for a stat goal —
 * gains move with the current stat and the training environment, so a target
 * that is a multiple of the current stat cannot be honestly divided by a
 * frozen gain/day figure.
 *
 * MODEL (empirical, no invented constants): recent history gives a daily
 * RELATIVE growth rate, and the model assumes that rate roughly persists
 * (`recent_conditions_assumed` — the load-bearing assumption, stated in the
 * UI). It:
 *
 *   1. CALIBRATES the daily relative rate r on the player's OWN history —
 *      a least-squares fit of ln(stat) over the lookback window. This is
 *      CALIBRATED ON OBSERVED CONDITIONS: happiness, gym, faction upgrades,
 *      education, company specials, temporary books/perks, energy/day and
 *      training behaviour are all inside the number as recently experienced.
 *      They are NOT modeled separately and NOT claimed as modeled.
 *   2. SIMULATES forward iteratively: stat(t+1) = stat(t) × e^r — gains are
 *      computed at the grown stat, so the projection includes the observed
 *      scaling behavior instead of freezing today's absolute gain.
 *   3. QUANTIFIES uncertainty as the slope's standard error (r ± se),
 *      propagated to an ETA range [fastest, slowest] with a regime-change
 *      floor (−8%/+15%): the calibration cannot speak for future regime
 *      changes (book wearing off, Steadfast/faction/education/company
 *      changes, happiness or training-frequency shifts, gym unlocks).
 *   4. CAPS confidence: projection confidence = min(statistical fit
 *      confidence, horizon confidence, MODEL_CONFIDENCE_CAP = "medium").
 *      A perfect historical fit proves the FIT was clean, never that the
 *      future obeys it — for an empirical model, "high" is unreachable.
 *
 * NOT MODELLED (and therefore never claimed): future gym unlocks, gym-dot
 * progression, and any of the modifier changes above. Temporary boost
 * regimes (books, extreme happy-jump periods) are not auto-detected — the
 * confidence cap and range carry that uncertainty instead. No official
 * gym-formula simulator is faked on top of parameters TornScope does not
 * reliably have.
 */

const DAY = 86_400;

export const STAT_PROJECTION_POLICY = {
  /** Fewer points than this in the window → insufficient_history. */
  MIN_POINTS: 5,
  /** Fewer full days spanned than this → insufficient_history. */
  MIN_SPAN_DAYS: 5,
  /** ln-fit R² below this reads as noise → too_volatile (no ETA). */
  MIN_R2: 0.3,
  /** R² at/above this (with a meaningful horizon) → high confidence. */
  HIGH_R2: 0.7,
  /** Points below this cap confidence at medium. */
  HIGH_MIN_POINTS: 20,
  /** Span (days) below this fraction of the lookback caps high confidence. */
  HIGH_MIN_SPAN_FRACTION: 0.7,
  /** ETA beyond this many days degrades confidence one step. */
  HORIZON_DEGRADE_DAYS: 365,
  /** ETA beyond this many days is withheld entirely. */
  HORIZON_MAX_DAYS: 5 * 365,
  /** High confidence requires the ETA to be nearer than this. */
  HIGH_MAX_ETA_DAYS: 365,
  /** ETA beyond this many days reads as low confidence. */
  LOW_MIN_ETA_DAYS: 730,
  /** Smallest calibration slope that counts as growth (per day). */
  MIN_DAILY_RATE: 1e-6,
  /**
   * Minimum ratio target/current for the range to stay meaningful — a goal
   * a hair above the current stat is dominated by day-to-day noise.
   */
  MIN_TARGET_RATIO: 1.02,
  /** Regime-change floor: a non-high-confidence ETA range is never tighter
   *  than -8%/+15% around the central estimate (future gym unlocks and
   *  modifier changes are not modelled — the fit cannot speak for them). */
  RANGE_FLOOR_FRACTION: 0.08,
  RANGE_CEIL_FRACTION: 0.15,
  /**
   * MODEL confidence cap for this EMPIRICAL projection. Recent conditions
   * are assumed to persist (recent_conditions_assumed) while future gym
   * unlocks and modifier changes are unknown — so even a statistically
   * perfect calibration never states "high" confidence or a single exact
   * date for a stat goal.
   */
  CONFIDENCE_CAP: "medium",
} as const;

const CONFIDENCE_RANK: Record<ProjectionConfidence, number> = { high: 0, medium: 1, low: 2, insufficient: 3 };

/** The WORST (most conservative) of the given confidence levels. */
export function minConfidence(...values: ProjectionConfidence[]): ProjectionConfidence {
  return values.reduce((a, b) => (CONFIDENCE_RANK[b] > CONFIDENCE_RANK[a] ? b : a));
}

/** Result of a forward growth simulation (also the audit/proof surface). */
export interface StatGrowthSimulation {
  /** Simulated stat after each day (index 0 = today's value). */
  values: number[];
  /** Gain contributed by each simulated day (values[i] − values[i−1]). */
  dailyGains: number[];
}

/**
 * Iteratively grow `current` by the daily relative rate `r` for `days` days.
 * Each day's gain is computed AT THE GROWN STAT — this is the behavior that
 * distinguishes the model from linear extrapolation and matches Torn's
 * stat scaling under stable conditions.
 */
export function simulateStatGrowth(current: number, r: number, days: number): StatGrowthSimulation {
  const values: number[] = [current];
  const dailyGains: number[] = [];
  const factor = Math.exp(r);
  for (let day = 1; day <= days; day++) {
    const next = values[values.length - 1]! * factor;
    dailyGains.push(next - values[values.length - 1]!);
    values.push(next);
  }
  return { values, dailyGains };
}

function spanOf(ordered: ReadonlyArray<ProjectionPoint>): number {
  return Math.max(1, (ordered[ordered.length - 1]!.t - ordered[0]!.t) / 86_400);
}

/** OLS on (day, ln(value)) → daily log-growth rate, its standard error, R². */
function logLinearFit(points: ReadonlyArray<ProjectionPoint>): { r: number; se: number; r2: number } | null {
  const n = points.length;
  if (n < 3) return null;
  const t0 = points[0]!.t;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of points) {
    if (p.value <= 0 || !Number.isFinite(p.value)) return null; // ln undefined
    xs.push((p.t - t0) / DAY);
    ys.push(Math.log(p.value));
  }
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  if (sxx === 0) return null;
  const r = sxy / sxx;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = my + r * (xs[i]! - mx);
    ssTot += (ys[i]! - my) ** 2;
    ssRes += (ys[i]! - predicted) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  // Standard error of the slope from residual variance (df = n−2; n ≥ 3 → ≥1).
  const se = n > 2 && sxx > 0 ? Math.sqrt(ssRes / (n - 2) / sxx) : Number.POSITIVE_INFINITY;
  return { r, se, r2 };
}

function insufficient(
  reason: ProjectionInsufficientReason,
  confidence: ProjectionConfidence,
  lookbackDays: ProjectionLookbackDays,
  window: Projection["window"],
  observed: number | null
): Projection {
  return {
    etaAt: null,
    velocityPerDay: null,
    slopePerDay: null,
    fitR2: null,
    lookbackDays,
    confidence,
    insufficientReason: reason,
    window,
    provenance: "derived",
    model: "relative_compounding",
    etaRangeDays: null,
    observedChangePerDay: observed,
  };
}

function etaProjection(
  etaDaysCentral: number,
  etaDaysFast: number,
  etaDaysSlow: number,
  confidence: ProjectionConfidence,
  lookbackDays: ProjectionLookbackDays,
  window: Projection["window"],
  observed: number | null,
  r2: number,
  now: number
): Projection {
  return {
    etaAt: Math.round(now + etaDaysCentral * DAY),
    velocityPerDay: null, // not meaningful for a compounding model
    slopePerDay: null, // the linear slope is deliberately NOT reported
    fitR2: r2,
    lookbackDays,
    confidence,
    insufficientReason: null,
    window,
    provenance: "derived",
    model: "relative_compounding",
    etaRangeDays: confidence === "high" ? null : { minDays: Math.round(etaDaysFast), maxDays: Math.round(etaDaysSlow) },
    observedChangePerDay: observed,
  };
}

/**
 * Project a battle-stat goal: when does `target` get reached if the player's
 * OBSERVED relative growth rate (calibrated over the lookback) continues
 * under CURRENT conditions. Withholds the ETA whenever the calibration is
 * thin, noisy, receding, or the horizon makes a precise date dishonest.
 */
export function projectStatGoal(
  points: ReadonlyArray<ProjectionPoint>,
  target: number,
  now: number,
  lookbackDays: ProjectionLookbackDays
): Projection {
  const windowStart = now - lookbackDays * DAY;
  const inWindow = points.filter((p) => p.t >= windowStart && p.t <= now && Number.isFinite(p.value) && p.value > 0);
  const window: Projection["window"] = {
    from: inWindow.length > 0 ? inWindow[0]!.t : null,
    to: inWindow.length > 0 ? inWindow[inWindow.length - 1]!.t : null,
    points: inWindow.length,
  };
  const ordered = [...inWindow].sort((a, b) => a.t - b.t);
  // DESCRIPTIVE observed change: endpoint-based per-day. (The median daily
  // delta reads ~0 on Torn's step-shaped stat series — flat days between
  // gains — which would co-display as "0/day" next to a live ETA.)
  const observed = inWindow.length >= 2 ? (ordered[ordered.length - 1]!.value - ordered[0]!.value) / Math.max(1, spanOf(ordered)) : null;

  if (ordered.length === 0) return insufficient("insufficient_history", "insufficient", lookbackDays, window, observed);
  const current = ordered[ordered.length - 1]!.value;
  if (current >= target) return insufficient("target_reached", "high", lookbackDays, window, observed);
  if (ordered.length < STAT_PROJECTION_POLICY.MIN_POINTS) {
    return insufficient("insufficient_history", "insufficient", lookbackDays, window, observed);
  }
  const spanDays = (ordered[ordered.length - 1]!.t - ordered[0]!.t) / DAY;
  if (spanDays < STAT_PROJECTION_POLICY.MIN_SPAN_DAYS) {
    return insufficient("insufficient_history", "insufficient", lookbackDays, window, observed);
  }
  if (target / current < STAT_PROJECTION_POLICY.MIN_TARGET_RATIO) {
    return insufficient("no_positive_trend", "low", lookbackDays, window, observed);
  }
  // Consistency gate: the calibration anchor must actually END above its
  // start. Stat series are step-shaped (flat between gains), so the OLS
  // slope can read positive from jumps while the window itself went
  // nowhere — extrapolating that would contradict the co-displayed
  // observed growth.
  const first = ordered[0]!.value;
  if (current <= first) {
    return insufficient("no_positive_trend", "low", lookbackDays, window, observed);
  }

  const fit = logLinearFit(ordered);
  if (fit === null || fit.r <= STAT_PROJECTION_POLICY.MIN_DAILY_RATE) {
    return insufficient("no_positive_trend", fit && fit.r2 !== null && fit.r2 !== undefined ? "low" : "insufficient", lookbackDays, window, observed);
  }
  if (fit.r2 < STAT_PROJECTION_POLICY.MIN_R2) {
    return insufficient("too_volatile", "low", lookbackDays, window, observed);
  }

  // Iterative forward simulation at the central, fast and slow calibration.
  const remaining = Math.log(target / current); // total log-growth needed
  const centralDays = remaining / fit.r;
  const horizon = STAT_PROJECTION_POLICY.HORIZON_MAX_DAYS;
  if (centralDays > horizon) {
    return insufficient("beyond_horizon", fit.r2 >= STAT_PROJECTION_POLICY.HIGH_R2 ? "medium" : "low", lookbackDays, window, observed);
  }

  // Uncertainty: slope ± its standard error (bounded so the slow arm stays a
  // positive rate; the fast arm is the honest lower ETA bound).
  const rFast = Math.min(fit.r + fit.se, fit.r * 3); // fastest completion
  const rSlow = Math.max(fit.r - fit.se, STAT_PROJECTION_POLICY.MIN_DAILY_RATE, fit.r / 3);
  const daysFast = remaining / rFast;
  const daysSlow = rSlow > 0 ? remaining / rSlow : horizon;

  // Confidence: fit quality + sample + span + horizon distance.
  // Confidence = min(statistical fit, horizon, MODEL cap). fitR2 measures
  // how clean the historical log-fit was — NOT how trustworthy the future
  // is. For an empirical model that assumes recent_conditions_assumed, a
  // perfect fit never justifies "high".
  let fitConfidence: ProjectionConfidence;
  if (
    fit.r2 >= STAT_PROJECTION_POLICY.HIGH_R2 &&
    ordered.length >= STAT_PROJECTION_POLICY.HIGH_MIN_POINTS &&
    spanDays >= lookbackDays * STAT_PROJECTION_POLICY.HIGH_MIN_SPAN_FRACTION &&
    centralDays <= STAT_PROJECTION_POLICY.HIGH_MAX_ETA_DAYS
  ) {
    fitConfidence = "high";
  } else if (centralDays > STAT_PROJECTION_POLICY.LOW_MIN_ETA_DAYS || ordered.length < STAT_PROJECTION_POLICY.MIN_POINTS + 2) {
    fitConfidence = "low";
  } else {
    fitConfidence = "medium";
  }
  const confidence = minConfidence(fitConfidence, STAT_PROJECTION_POLICY.CONFIDENCE_CAP);

  // Range is the honest presentation at medium/low confidence; a single
  // date is only stated when the calibration was strong AND the horizon short.
  const clampedSlow = Math.min(daysSlow, horizon);

  // Regime-change floor: the calibration says nothing about FUTURE gym
  // unlocks, modifier changes or activity shifts — none of which TornScope
  // can model. A medium/low-confidence range therefore never presents
  // tighter than −8%/+15% around the central estimate, no matter how clean
  // the historical fit was.
  const minDays = Math.min(daysFast, centralDays * (1 - STAT_PROJECTION_POLICY.RANGE_FLOOR_FRACTION));
  const maxDays = Math.max(clampedSlow, centralDays * (1 + STAT_PROJECTION_POLICY.RANGE_CEIL_FRACTION));

  return etaProjection(centralDays, Math.max(1, minDays), Math.max(2, maxDays), confidence, lookbackDays, window, observed, fit.r2, now);
}
