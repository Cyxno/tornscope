/**
 * Generic counter-delta engine (2.6.0).
 *
 * Computes the delta of a cumulative (monotonic) counter over a snapshot
 * series: opening → closing, delta, rate/day and reset detection.
 *
 * Semantics contract (FASE 5):
 * - A DECREASE is never silently treated as real decline: the engine reports
 *   the raw delta AND flags `resetDetected` when the evidence supports a
 *   counter reset (a large drop followed by stability at the lower level).
 *   After a confirmed reset, delta spans only the post-reset regime and
 *   `preResetClosing` keeps the pre-reset value for display.
 * - `null` observations (field absent) never fabricate deltas.
 */

export interface CounterPoint {
  /** Unix seconds. */
  t: number;
  value: number | null;
}

export interface CounterDelta {
  /** First observed value in-range (post-reset when a reset was detected). */
  opening: number | null;
  /** Last observed value in-range. */
  closing: number | null;
  /** closing − opening over the detected regime; never fabricated from gaps. */
  delta: number | null;
  /** delta per tracked day across the covered span (≥1 observation apart). */
  ratePerDay: number | null;
  /** First timestamp of the contributing regime. */
  trackingSince: number | null;
  /** Distinct observation timestamps contributing to this delta. */
  points: number;
  /** A counter reset was detected and delta was computed post-reset. */
  resetDetected: boolean;
  /** Number of observed decreases in-range (regardless of reset verdict). */
  decreases: number;
  /** Last value before a detected reset (display context; null otherwise). */
  preResetClosing: number | null;
}

/** A decrease that drops more than this fraction of the level counts as a
 *  reset CANDIDATE (small dips are ordinary counter corrections). */
const RESET_DROP_FRACTION = 0.5;

export function computeCounterDelta(points: CounterPoint[], range?: { from?: number; to?: number }): CounterDelta {
  const sorted = [...points]
    .filter((p) => p.value !== null && Number.isFinite(p.value))
    .filter((p) => (range?.from === undefined ? true : p.t >= range.from))
    .filter((p) => (range?.to === undefined ? true : p.t <= range.to))
    .sort((a, b) => a.t - b.t) as Array<{ t: number; value: number }>;

  const empty: CounterDelta = {
    opening: null,
    closing: null,
    delta: null,
    ratePerDay: null,
    trackingSince: null,
    points: 0,
    resetDetected: false,
    decreases: 0,
    preResetClosing: null,
  };
  if (sorted.length === 0) return empty;
  if (sorted.length === 1) {
    const only = sorted[0]!;
    return { ...empty, opening: only.value, closing: only.value, trackingSince: only.t, points: 1 };
  }

  let decreases = 0;
  let regimeStart = 0; // index where the contributing regime begins
  let resetDetected = false;
  let preResetClosing: number | null = null;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.value < prev.value) {
      decreases += 1;
      const dropFraction = prev.value === 0 ? 1 : (prev.value - cur.value) / prev.value;
      const isResetCandidate = dropFraction >= RESET_DROP_FRACTION || cur.value === 0;
      if (!isResetCandidate) continue;
      // Confirm: the counter keeps RUNNING from the new level — no further
      // decreases. (A growing counter after a drop is the reset signature.)
      const later = sorted.slice(i + 1);
      const stable = later.every((p) => p.value >= cur.value);
      if (stable || later.length === 0) {
        // Accept the reset: the regime starts at the post-reset observation.
        preResetClosing = prev.value;
        regimeStart = i;
        resetDetected = true;
      }
    }
  }

  const openingPoint = sorted[regimeStart]!;
  const closingPoint = sorted[sorted.length - 1]!;
  const delta = closingPoint.value - openingPoint.value;
  const spanDays = Math.max((closingPoint.t - openingPoint.t) / 86_400, 0);
  const ratePerDay = spanDays >= 0.5 ? delta / spanDays : null;

  return {
    opening: openingPoint.value,
    closing: closingPoint.value,
    delta,
    ratePerDay,
    trackingSince: openingPoint.t,
    points: sorted.length,
    resetDetected,
    decreases,
    preResetClosing,
  };
}

/** True when the series is monotonic non-decreasing over the whole span. */
export function isMonotonic(points: CounterPoint[]): boolean {
  const sorted = [...points].filter((p) => p.value !== null).sort((a, b) => a.t - b.t);
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i]!.value as number) < (sorted[i - 1]!.value as number)) return false;
  }
  return true;
}
