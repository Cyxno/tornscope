/**
 * Personal goals & projections domain (2.0).
 *
 * A goal is "reach value X on metric M by (optionally) date D". Metrics are a
 * small closed registry — every metric maps onto data TornScope ALREADY
 * stores (NetworthSnapshot / PersonalStatSnapshot / UserSnapshot), so a goal
 * never triggers an extra Torn API call.
 *
 * Projections are labeled as projections, never predictions: a projection
 * extrapolates the OBSERVED personal trend over an explicit lookback and
 * carries an explicit confidence. When history is short, noisy or stalled the
 * ETA is withheld entirely (insufficientReason) — "no ETA" is always a
 * first-class outcome, never a fallback to a made-up number.
 */

/* -------------------------------------------------------------------------- */
/* Metric registry                                                             */
/* -------------------------------------------------------------------------- */

export const GOAL_METRIC_IDS = [
  "networth",
  "liquid_wealth",
  "battlestats_total",
  "strength",
  "defense",
  "speed",
  "dexterity",
  "level",
] as const;

export type GoalMetricId = (typeof GOAL_METRIC_IDS)[number];

export type GoalMetricUnit = "money" | "stat" | "level";

export interface GoalMetricMeta {
  id: GoalMetricId;
  label: string;
  unit: GoalMetricUnit;
  /** One-line description for the goal form / registry consumers. */
  description: string;
  /**
   * Data source provenance label — which stored snapshot family the current
   * value reads from. Purely informational (shown as the value's badge).
   */
  source: "networth_snapshot" | "personalstats_snapshot" | "user_snapshot";
}

/**
 * The curated v1 metric set. Deliberately small: each metric must have a
 * reliable stored series with known semantics. "Liquid wealth" is wallet +
 * vault + pending + city/Cayman/piggy bank + bookie balances — money that can
 * act as cash without selling anything (exact NetworthSnapshot columns).
 */
export const GOAL_METRICS: Record<GoalMetricId, GoalMetricMeta> = {
  networth: {
    id: "networth",
    label: "Net worth",
    unit: "money",
    description: "Total net worth as reported by Torn's official snapshot.",
    source: "networth_snapshot",
  },
  liquid_wealth: {
    id: "liquid_wealth",
    label: "Liquid wealth",
    unit: "money",
    description: "Cash you can spend without selling assets: wallet, vault, pending, city/Cayman/piggy bank and bookie balances.",
    source: "networth_snapshot",
  },
  battlestats_total: {
    id: "battlestats_total",
    label: "Total battle stats",
    unit: "stat",
    description: "Strength + defense + speed + dexterity from your personal stats snapshots.",
    source: "personalstats_snapshot",
  },
  strength: {
    id: "strength",
    label: "Strength",
    unit: "stat",
    description: "Strength from your personal stats snapshots.",
    source: "personalstats_snapshot",
  },
  defense: {
    id: "defense",
    label: "Defense",
    unit: "stat",
    description: "Defense from your personal stats snapshots.",
    source: "personalstats_snapshot",
  },
  speed: {
    id: "speed",
    label: "Speed",
    unit: "stat",
    description: "Speed from your personal stats snapshots.",
    source: "personalstats_snapshot",
  },
  dexterity: {
    id: "dexterity",
    label: "Dexterity",
    unit: "stat",
    description: "Dexterity from your personal stats snapshots.",
    source: "personalstats_snapshot",
  },
  level: {
    id: "level",
    label: "Level",
    unit: "level",
    description: "Your Torn level.",
    source: "user_snapshot",
  },
};

/** Money- and stat-valued goals are always "reach at least"; level included. */
export function goalMetricMeta(id: string): GoalMetricMeta | undefined {
  return (GOAL_METRIC_IDS as readonly string[]).includes(id) ? GOAL_METRICS[id as GoalMetricId] : undefined;
}

/* -------------------------------------------------------------------------- */
/* Goal model (API shape — DB stores target as BigInt, API speaks numbers)     */
/* -------------------------------------------------------------------------- */

export const GOAL_STATUSES = ["active", "achieved", "archived"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** A stored goal, as returned by the API (timestamps unix seconds). */
export interface Goal {
  id: string;
  metric: GoalMetricId;
  target: number;
  note: string | null;
  createdAt: number;
  targetDate: number | null;
  status: GoalStatus;
  achievedAt: number | null;
}

/** Validated create/update payload (server enforces the zod schema). */
export interface GoalInput {
  metric: GoalMetricId;
  target: number;
  note?: string | null;
  targetDate?: number | null;
}

/* -------------------------------------------------------------------------- */
/* Projection vocabulary                                                       */
/* -------------------------------------------------------------------------- */

export const PROJECTION_LOOKBACKS = [7, 30, 90] as const;
export type ProjectionLookbackDays = (typeof PROJECTION_LOOKBACKS)[number];
export const DEFAULT_PROJECTION_LOOKBACK: ProjectionLookbackDays = 30;

/**
 * Why an ETA is withheld. The UI maps these to copy — they are never
 * rendered raw, and every reason is a normal, expected state.
 */
export const PROJECTION_INSUFFICIENT_REASONS = [
  /** Fewer than the minimum points/days in the lookback window. */
  "insufficient_history",
  /** Observed trend is flat or moving away from the target. */
  "no_positive_trend",
  /** Trend too noisy to state an ETA honestly. */
  "too_volatile",
  /** Projected completion lies beyond the 5-year sanity horizon. */
  "beyond_horizon",
  /** Current value already meets the target. */
  "target_reached",
  /**
   * The metric's underlying Torn mechanics are not modelled reliably enough
   * to extrapolate at all (LEVEL: TornScope stores no XP/gain mechanics that
   * would justify a forecast). Show the observed history, never a forecast.
   */
  "mechanics_not_modelled",
] as const;

export type ProjectionInsufficientReason = (typeof PROJECTION_INSUFFICIENT_REASONS)[number];

export type ProjectionConfidence = "high" | "medium" | "low" | "insufficient";

/**
 * Which extrapolation model produced the projection — the model must FIT the
 * Torn mechanics of the metric, not merely the stored data shape:
 * - median_delta_linear: robust linear trend (appropriate for wealth where
 *   the stored value IS the quantity being tracked);
 * - relative_compounding: stat-scaling-aware model for battle stats, where
 *   per-train gain scales with the current stat — calibrated on the player's
 *   observed relative growth and simulated iteratively forward;
 * - none: no forecast (withheld or not modelled).
 */
export const PROJECTION_MODELS = ["median_delta_linear", "relative_compounding", "none"] as const;
export type ProjectionModel = (typeof PROJECTION_MODELS)[number];

/**
 * Deterministic trend projection of a series toward a target.
 * `etaAt` is null whenever confidence is insufficient/low or the trend does
 * not support an honest ETA — callers must render the reason, never a guess.
 */
export interface Projection {
  etaAt: number | null;
  /** Robust observed change per day over the lookback (median of daily deltas). */
  velocityPerDay: number | null;
  /** Least-squares slope per day (cross-check; null when < 3 points). */
  slopePerDay: number | null;
  /** Goodness of fit of the least-squares line (0..1; null when undefined). */
  fitR2: number | null;
  lookbackDays: ProjectionLookbackDays;
  confidence: ProjectionConfidence;
  /** Present exactly when etaAt is null — why no ETA is shown. */
  insufficientReason: ProjectionInsufficientReason | null;
  /** Actual window used: first/last point inside it (unix seconds). */
  window: { from: number | null; to: number | null; points: number };
  provenance: "derived";
  /** Which Torn-aware model produced this projection (added post-audit). */
  model: ProjectionModel;
  /**
   * ETA uncertainty window in days [fastest, slowest] — null when no ETA or
   * when the confidence is high enough to state a single date. UI renders a
   * range ("~4–6 months") instead of a precise date whenever present.
   */
  etaRangeDays: { minDays: number; maxDays: number } | null;
  /**
   * DESCRIPTIVE observed change per day over the lookback — for stat goals
   * this is what "Recent growth" may show. Never an input to the ETA when
   * model is relative_compounding (the compounding rate is calibrated on
   * relative growth instead).
   */
  observedChangePerDay: number | null;
}

/* -------------------------------------------------------------------------- */
/* Goal + projection view (single-goal API composition)                        */
/* -------------------------------------------------------------------------- */

/** Progress of one goal including its current value and trend projection. */
export interface GoalView {
  goal: Goal;
  /** Latest stored value for the metric (null when no data has synced yet). */
  currentValue: number | null;
  /** current/target, 0..1 clamped; null when either side is unknown. */
  progress: number | null;
  currentValueAt: number | null;
  projection: Projection;
  /** Capability gate: false when the metric's source has never synced. */
  dataAvailable: boolean;
}

/** Payload for POST/PATCH goal responses (the stored goal). */
export interface GoalMutationResponse {
  goal: Goal;
}

export interface GoalsResponse {
  goals: GoalView[];
  metrics: GoalMetricMeta[];
  defaultLookbackDays: ProjectionLookbackDays;
}

/* -------------------------------------------------------------------------- */
/* Zod contracts (mirroring the types above; Today-module precedent)           */
/* -------------------------------------------------------------------------- */

import { z } from "zod";

export const GoalMetricIdSchema = z.enum(GOAL_METRIC_IDS);
export const GoalStatusSchema = z.enum(GOAL_STATUSES);

export const ProjectionSchema = z.object({
  etaAt: z.number().nullable(),
  velocityPerDay: z.number().nullable(),
  slopePerDay: z.number().nullable(),
  fitR2: z.number().nullable(),
  lookbackDays: z.number(),
  confidence: z.enum(["high", "medium", "low", "insufficient"]),
  insufficientReason: z.enum(PROJECTION_INSUFFICIENT_REASONS).nullable(),
  window: z.object({ from: z.number().nullable(), to: z.number().nullable(), points: z.number() }),
  provenance: z.literal("derived"),
  model: z.enum(PROJECTION_MODELS),
  etaRangeDays: z.object({ minDays: z.number(), maxDays: z.number() }).nullable(),
  observedChangePerDay: z.number().nullable(),
});

export const GoalSchema = z.object({
  id: z.string(),
  metric: GoalMetricIdSchema,
  target: z.number(),
  note: z.string().nullable(),
  createdAt: z.number(),
  targetDate: z.number().nullable(),
  status: GoalStatusSchema,
  achievedAt: z.number().nullable(),
});

export const GoalViewSchema = z.object({
  goal: GoalSchema,
  currentValue: z.number().nullable(),
  currentValueAt: z.number().nullable(),
  progress: z.number().nullable(),
  projection: ProjectionSchema,
  dataAvailable: z.boolean(),
});

export const GoalCreateInputSchema = z.object({
  metric: GoalMetricIdSchema,
  target: z.number().positive(),
  note: z.string().max(280).nullable().optional(),
  targetDate: z.number().int().nullable().optional(),
});

export const GoalUpdateInputSchema = z.object({
  target: z.number().positive().optional(),
  note: z.string().max(280).nullable().optional(),
  targetDate: z.number().int().nullable().optional(),
  /** achieved is server-derived only — clients may set active or archived. */
  status: z.enum(["active", "archived"]).optional(),
});

export const GoalsResponseSchema = z.object({
  goals: z.array(GoalViewSchema),
  metrics: z.array(
    z.object({
      id: GoalMetricIdSchema,
      label: z.string(),
      unit: z.enum(["money", "stat", "level"]),
      description: z.string(),
      source: z.enum(["networth_snapshot", "personalstats_snapshot", "user_snapshot"]),
    })
  ),
  defaultLookbackDays: z.number(),
});
