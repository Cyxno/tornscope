import {
  DEFAULT_PROJECTION_LOOKBACK,
  GOAL_METRICS,
  type Goal,
  type GoalMetricId,
  type GoalView,
  type Projection,
  type ProjectionLookbackDays,
} from "@tornscope/shared";
import type { NetworthSnapshotFields } from "./networth.js";
import { medianDailyDelta, projectTowardTarget, type ProjectionPoint } from "./projection.js";
import { projectStatGoal } from "./stat-projection.js";

/**
 * Goal analytics (2.0): read a goal's current value from data TornScope
 * already stores, compute progress, and compose the trend projection.
 * Every fact here comes from stored snapshots — a goal never costs a Torn
 * API call.
 */

export interface GoalFacts {
  /**
   * Net worth snapshots (all stored columns — liquid wealth needs them).
   * Ascending or unordered; dedup is not required.
   */
  networthSnapshots: ReadonlyArray<NetworthSnapshotFields>;
  /** Battlestat series as produced by buildBattlestatSeries (nulls allowed). */
  battlestatSeries: ReadonlyArray<{ t: number; strength: number | null; defense: number | null; speed: number | null; dexterity: number | null; total: number | null }>;
  /** Level history from user snapshots. */
  levelSeries: ReadonlyArray<{ t: number; level: number }>;
}

/** Latest finite value of a series (ascending or unordered input). */
function latestFinite<T>(series: ReadonlyArray<T>, pick: (item: T) => number | null, ts: (item: T) => number): { value: number; at: number } | null {
  let best: { value: number; at: number } | null = null;
  for (const item of series) {
    const v = pick(item);
    if (v === null || !Number.isFinite(v)) continue;
    if (best === null || ts(item) >= best.at) best = { value: v, at: ts(item) };
  }
  return best;
}

/** Liquid wealth: everything that acts as cash without selling assets. */
export function liquidWealth(snapshot: NetworthSnapshotFields): number {
  return snapshot.wallet + snapshot.vault + snapshot.pending + snapshot.cityBank + snapshot.caymanBank + snapshot.piggyBank + snapshot.bookie;
}

/** Latest stored value for a metric, with its snapshot time. */
export function goalCurrentValue(metric: GoalMetricId, facts: GoalFacts): { value: number; at: number } | null {
  switch (metric) {
    case "networth":
      return latestFinite(facts.networthSnapshots, (s) => s.total, (s) => s.capturedAt);
    case "liquid_wealth":
      return latestFinite(facts.networthSnapshots, (s) => liquidWealth(s), (s) => s.capturedAt);
    case "battlestats_total":
      return latestFinite(facts.battlestatSeries, (s) => s.total, (s) => s.t);
    case "strength":
    case "defense":
    case "speed":
    case "dexterity":
      return latestFinite(facts.battlestatSeries, (s) => s[metric], (s) => s.t);
    case "level":
      return latestFinite(facts.levelSeries, (s) => s.level, (s) => s.t);
  }
}

/** The series that drives the metric's trend. */
function goalSeries(metric: GoalMetricId, facts: GoalFacts): ProjectionPoint[] {
  switch (metric) {
    case "networth":
      return facts.networthSnapshots.map((s) => ({ t: s.capturedAt, value: s.total }));
    case "liquid_wealth":
      return facts.networthSnapshots.map((s) => ({ t: s.capturedAt, value: liquidWealth(s) }));
    case "battlestats_total":
      return facts.battlestatSeries.filter((s) => s.total !== null).map((s) => ({ t: s.t, value: s.total as number }));
    case "strength":
    case "defense":
    case "speed":
    case "dexterity":
      return facts.battlestatSeries.filter((s) => s[metric] !== null).map((s) => ({ t: s.t, value: s[metric] as number }));
    case "level":
      return facts.levelSeries.map((s) => ({ t: s.t, value: s.level }));
  }
}

/** Minimal stored-goal shape (Prisma row with BigInt already converted). */
export type GoalLike = Pick<Goal, "id" | "metric" | "target" | "note" | "createdAt" | "targetDate" | "status" | "achievedAt">;

/** A frozen "already reached" projection (achieved goals keep this view). */
function reachedProjection(lookbackDays: ProjectionLookbackDays): Projection {
  return {
    etaAt: null,
    velocityPerDay: null,
    slopePerDay: null,
    fitR2: null,
    lookbackDays,
    confidence: "high",
    insufficientReason: "target_reached",
    window: { from: null, to: null, points: 0 },
    provenance: "derived",
    model: "none",
    etaRangeDays: null,
    observedChangePerDay: null,
  };
}

/**
 * Compose the full single-goal view: current value, progress 0..1 and the
 * trend projection over the requested lookback. An already-achieved goal
 * stays frozen: its projection reports target_reached even if the latest
 * snapshot has since dipped below the target.
 *
 * SEMANTIC ROUTING (2.0 audit — "correct math is not enough"): the model
 * must match the Torn mechanic behind the metric, not just the data shape.
 *
 * - battle stats (total + individual) → relative_compounding: per-train gym
 *   gain scales with the CURRENT stat, so gain/day grows while the stat
 *   grows. Linear remaining/target-divided-by-observed-gain would be a
 *   wrong-mechanic extrapolation. The compounding model calibrates the
 *   player's observed RELATIVE rate and iterates forward (see
 *   stat-projection.ts; calibrated on real history, current conditions
 *   only — gym unlocks are not modelled because TornScope cannot
 *   reliably predict them).
 * - level → NO projection at all. Torn level pacing depends on an XP curve
 *   and activity patterns TornScope does not store; a linear fit of a
 *   step-shaped level history would manufacture an ETA. Observed history
 *   stays visible; the forecast is withheld (mechanics_not_modelled).
 * - net worth / liquid wealth → robust linear (median daily delta with fit
 *   gates): the stored value IS the tracked quantity; the existing
 *   volatility gates, minimum-history gates and horizon degradation carry
 *   the honesty burden here.
 */
export function buildGoalView(goal: GoalLike, facts: GoalFacts, now: number, lookbackDays: ProjectionLookbackDays = DEFAULT_PROJECTION_LOOKBACK): GoalView {
  const current = goalCurrentValue(goal.metric, facts);
  const series = goalSeries(goal.metric, facts);
  const projection: Projection =
    goal.status === "achieved"
      ? reachedProjection(lookbackDays)
      : goal.metric === "level"
        ? insufficientLevelProjection(lookbackDays, series, now)
        : isBattlestatMetric(goal.metric)
          ? projectStatGoal(series, goal.target, now, lookbackDays)
          : projectTowardTarget(series, goal.target, now, lookbackDays, current?.value ?? null);
  const progress = current !== null && goal.target > 0 ? Math.max(0, Math.min(1, current.value / goal.target)) : null;
  return {
    goal: {
      id: goal.id,
      metric: goal.metric,
      target: goal.target,
      note: goal.note,
      createdAt: goal.createdAt,
      targetDate: goal.targetDate,
      status: goal.status,
      achievedAt: goal.achievedAt,
    },
    currentValue: current?.value ?? null,
    currentValueAt: current?.at ?? null,
    progress,
    projection,
    dataAvailable: current !== null,
  };
}

const BATTLESTAT_GOAL_METRICS: ReadonlySet<GoalMetricId> = new Set(["battlestats_total", "strength", "defense", "speed", "dexterity"]);

function isBattlestatMetric(metric: GoalMetricId): boolean {
  return BATTLESTAT_GOAL_METRICS.has(metric);
}

/** Level: observed history only — never a manufactured ETA. */
function insufficientLevelProjection(lookbackDays: ProjectionLookbackDays, series: ProjectionPoint[], now: number): Projection {
  const windowStart = now - lookbackDays * 86_400;
  const inWindow = series.filter((p) => p.t >= windowStart && p.t <= now);
  const observed = medianDailyDelta([...inWindow].sort((a, b) => a.t - b.t));
  return {
    etaAt: null,
    velocityPerDay: null,
    slopePerDay: null,
    fitR2: null,
    lookbackDays,
    confidence: "insufficient",
    insufficientReason: "mechanics_not_modelled",
    window: { from: inWindow[0]?.t ?? null, to: inWindow[inWindow.length - 1]?.t ?? null, points: inWindow.length },
    provenance: "derived",
    model: "none",
    etaRangeDays: null,
    observedChangePerDay: observed,
  };
}

/**
 * Milestone fractions used for goal notifications (2.0): the steps a passing
 * progress bar crosses. 1.0 is achievement (own notification type).
 */
export const GOAL_MILESTONE_FRACTIONS = [0.5, 0.75, 0.9] as const;

/** The highest milestone fraction strictly reached by `progress` (or null). */
export function reachedMilestone(progress: number): number | null {
  let reached: number | null = null;
  for (const m of GOAL_MILESTONE_FRACTIONS) {
    if (progress >= m) reached = m;
  }
  return reached;
}

/** Registry passthrough so consumers never import the registry from two places. */
export const goalMetricRegistry = GOAL_METRICS;
