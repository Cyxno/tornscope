/**
 * Adaptive per-category scheduling policy (pure + testable).
 *
 * Goal: stop paying one API page per category every resource cycle when most
 * categories are quiet for hours or days, without ever risking log loss.
 *
 * Correctness contract (independent of intervals):
 * - every category keeps its own cursor + overlap window; a longer gap only
 *   means the next walk re-fetches a longer span (dedup is idempotent)
 * - manual "Sync Now" and historical backfills ignore nextRunAt entirely
 *
 * Tiers by observed activity (lastActivityAt = last walk that found rows
 * above the category cursor):
 *   hot        activity within HOT_WINDOW        → poll at HOT_FREQUENCY
 *   warm       activity within WARM_WINDOW       → poll at WARM_FREQUENCY
 *   cold       activity within COLD_WINDOW       → poll at COLD_FREQUENCY
 *   very_cold  older / never active              → poll at VERY_COLD_FREQUENCY
 *
 * Decay: consecutiveEmptyRuns stretches the interval gradually (×1 → ×1.5 →
 * ×2 → ×3, capped) so a hot category never jumps straight to 6 h. Promotion
 * is implicit: any new activity refreshes lastActivityAt → hot again.
 *
 * Failures use escalating retry backoff (1m → 5m → 15m → 30m → 1h cap).
 * access_denied retries slowly (6 h) until credentials change.
 */

const MINUTE = 60;
const HOUR = 3600;

export const SCHEDULE_THRESHOLDS = {
  /** Poll interval per tier (seconds). */
  HOT_FREQUENCY: 10 * MINUTE,
  WARM_FREQUENCY: 30 * MINUTE,
  COLD_FREQUENCY: 1 * HOUR,
  VERY_COLD_FREQUENCY: 6 * HOUR,
  /** Activity recency that defines each tier. */
  HOT_WINDOW: 1 * HOUR,
  WARM_WINDOW: 6 * HOUR,
  COLD_WINDOW: 48 * HOUR,
  /** Failed-category retry backoff ladder (seconds, by consecutive failures). */
  RETRY_BACKOFF: [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE],
  RETRY_BACKOFF_CAP: 1 * HOUR,
  /** access_denied retries slowly until credentials change. */
  ACCESS_DENIED_RETRY: 6 * HOUR,
  /** Conservative per-run page budget: optional low-priority categories are
   * skipped once the run reaches this many walked pages. */
  RUN_PAGE_BUDGET: 300,
} as const;

export type CategoryTier = "hot" | "warm" | "cold" | "very_cold" | "retry" | "access_denied";

export interface CategoryScheduleInput {
  /** Net-new rows found by the last walk (above the previous cursor). */
  lastNetNewRecords: number | null;
  /** Last walk that found rows above the category cursor (unix seconds). */
  lastActivityAt: number | null;
  consecutiveEmptyRuns: number;
  status: string;
  now: number;
}

export interface CategoryScheduleDecision {
  tier: CategoryTier;
  nextFrequencySeconds: number;
  nextRunAt: number;
  /** Lower runs earlier: 1 recently active, 2 retry, 3 warm, 4 cold, 5 very cold. */
  priority: number;
}

/** Classify a category by how recently it actually produced rows. */
export function categorizeActivity(lastActivityAt: number | null, now: number): Exclude<CategoryTier, "retry" | "access_denied"> {
  if (lastActivityAt === null) return "very_cold";
  const age = now - lastActivityAt;
  if (age <= SCHEDULE_THRESHOLDS.HOT_WINDOW) return "hot";
  if (age <= SCHEDULE_THRESHOLDS.WARM_WINDOW) return "warm";
  if (age <= SCHEDULE_THRESHOLDS.COLD_WINDOW) return "cold";
  return "very_cold";
}

const TIER_FREQUENCY: Record<"hot" | "warm" | "cold" | "very_cold", number> = {
  hot: SCHEDULE_THRESHOLDS.HOT_FREQUENCY,
  warm: SCHEDULE_THRESHOLDS.WARM_FREQUENCY,
  cold: SCHEDULE_THRESHOLDS.COLD_FREQUENCY,
  very_cold: SCHEDULE_THRESHOLDS.VERY_COLD_FREQUENCY,
};

const TIER_PRIORITY: Record<CategoryTier, number> = {
  hot: 1,
  retry: 2,
  warm: 3,
  cold: 4,
  very_cold: 5,
  access_denied: 5,
};

/** Gradual decay: empty cycles stretch the interval, never a single-jump cliff. */
export function decayMultiplier(consecutiveEmptyRuns: number): number {
  if (consecutiveEmptyRuns <= 2) return 1;
  if (consecutiveEmptyRuns <= 5) return 1.5;
  if (consecutiveEmptyRuns <= 9) return 2;
  return 3;
}

/**
 * Compute the next schedule for one category. Pure: same input, same output.
 */
export function nextCategorySchedule(input: CategoryScheduleInput): CategoryScheduleDecision {
  const { status, now } = input;

  if (status === "access_denied") {
    return { tier: "access_denied", nextFrequencySeconds: SCHEDULE_THRESHOLDS.ACCESS_DENIED_RETRY, nextRunAt: now + SCHEDULE_THRESHOLDS.ACCESS_DENIED_RETRY, priority: TIER_PRIORITY.access_denied };
  }

  if (status === "failed") {
    const step = input.consecutiveEmptyRuns;
    const frequency =
      step < SCHEDULE_THRESHOLDS.RETRY_BACKOFF.length ? SCHEDULE_THRESHOLDS.RETRY_BACKOFF[step]! : SCHEDULE_THRESHOLDS.RETRY_BACKOFF_CAP;
    return { tier: "retry", nextFrequencySeconds: Math.min(frequency, SCHEDULE_THRESHOLDS.RETRY_BACKOFF_CAP), nextRunAt: now + frequency, priority: TIER_PRIORITY.retry };
  }

  const tier = categorizeActivity(input.lastActivityAt, now);
  // Activity within the current cycle: the last walk itself found rows.
  const hadActivityThisRun = (input.lastNetNewRecords ?? 0) > 0;
  const emptyRuns = hadActivityThisRun ? 0 : input.consecutiveEmptyRuns;

  const base = TIER_FREQUENCY[tier];
  // A just-promoted category (activity this run) always stays at base speed
  // so bursts are followed responsively; decay applies after quiet cycles.
  const frequency = hadActivityThisRun ? base : Math.min(Math.round(base * decayMultiplier(emptyRuns)), SCHEDULE_THRESHOLDS.VERY_COLD_FREQUENCY);
  const nextRunAt = now + frequency;
  return { tier, nextFrequencySeconds: frequency, nextRunAt, priority: TIER_PRIORITY[tier] };
}

/** Is a category due for a walk at `now`? (Manual syncs bypass this.) */
export function isCategoryDue(nextRunAt: Date | number | null, now: number): boolean {
  if (nextRunAt === null) return true;
  const ts = nextRunAt instanceof Date ? Math.floor(nextRunAt.getTime() / 1000) : nextRunAt;
  return ts <= now;
}
