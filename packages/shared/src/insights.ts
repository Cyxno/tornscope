/**
 * Personal insights (2.0) — the shared vocabulary for TornScope's
 * deterministic insight engine.
 *
 * An insight ALWAYS compares two measured periods from stored history
 * (baseline vs current), carries its evidence window and sample size, and
 * states a confidence. Rules live in @tornscope/analytics (pure, tested);
 * this module only fixes the shape and the curated kind registry so the API,
 * worker and UI share one contract.
 *
 * Design invariants:
 * - Reproducible: same stored data + same `now` ⇒ same insights.
 * - Honest: below sample-size or significance thresholds a rule emits
 *   NOTHING — absence of an insight is a feature, not a failure.
 * - No causal claims: wording describes observed differences, never why.
 */

export const INSIGHT_PRIORITIES = ["high", "normal", "low"] as const;
export type InsightPriority = (typeof INSIGHT_PRIORITIES)[number];

/** Coarse grouping for the insights page — mirrors the nav's analytics domains. */
export const INSIGHT_CATEGORIES = ["economy", "training", "travel", "substances", "record", "system"] as const;
export type InsightCategory = (typeof INSIGHT_CATEGORIES)[number];

export const INSIGHT_CONFIDENCES = ["high", "medium", "low"] as const;
export type InsightConfidence = (typeof INSIGHT_CONFIDENCES)[number];

/**
 * The curated kind registry. Each kind is emitted by exactly one rule; ids
 * are stable and double as the first half of a dedupe key. Adding a kind is
 * additive — never repurpose an existing id.
 */
export const INSIGHT_KINDS = [
  /** Net worth growth changed materially vs the prior comparable period. */
  "networth_growth_shift",
  /** Current period income materially above/below the baseline period. */
  "income_shift",
  /** Current period true spending materially above the baseline. */
  "spending_spike",
  /** Travel profit per day materially above/below the 30-day baseline. */
  "travel_profit_shift",
  /** Rehab spend at/near its long-period high. */
  "rehab_spend_high",
  /** Xanax usage rate changed materially. */
  "xanax_usage_shift",
  /** Training gain per energy vs the 30-day baseline (efficiencyBaseline). */
  "training_efficiency_shift",
  /** A new personal record was set (best day/week for a tracked metric). */
  "personal_record",
  /** The largest wealth contributor category changed. */
  "wealth_contributor_shift",
  /** Energy sat at cap for an unusually long time (potential regen loss). */
  "energy_capped_elevated",
  /** Biggest single-day income in the tracked window. */
  "best_income_day",
  /** Highest net worth ever recorded. */
  "networth_record",
] as const;

export type InsightKind = (typeof INSIGHT_KINDS)[number];

export interface InsightKindMeta {
  kind: InsightKind;
  label: string;
  category: InsightCategory;
  /** Which lookback the rule works over (informational, for filters). */
  typicalWindowDays: number;
}

/** Curated metadata per kind — the UI's grouping/filter source of truth. */
export const INSIGHT_KIND_META: Record<InsightKind, InsightKindMeta> = {
  networth_growth_shift: { kind: "networth_growth_shift", label: "Net worth growth", category: "economy", typicalWindowDays: 60 },
  income_shift: { kind: "income_shift", label: "Income level", category: "economy", typicalWindowDays: 37 },
  spending_spike: { kind: "spending_spike", label: "Spending", category: "economy", typicalWindowDays: 37 },
  travel_profit_shift: { kind: "travel_profit_shift", label: "Travel profit", category: "travel", typicalWindowDays: 37 },
  rehab_spend_high: { kind: "rehab_spend_high", label: "Rehab spend", category: "substances", typicalWindowDays: 90 },
  xanax_usage_shift: { kind: "xanax_usage_shift", label: "Xanax usage", category: "substances", typicalWindowDays: 37 },
  training_efficiency_shift: { kind: "training_efficiency_shift", label: "Training efficiency", category: "training", typicalWindowDays: 37 },
  personal_record: { kind: "personal_record", label: "Personal records", category: "record", typicalWindowDays: 7 },
  wealth_contributor_shift: { kind: "wealth_contributor_shift", label: "Wealth mix", category: "economy", typicalWindowDays: 30 },
  energy_capped_elevated: { kind: "energy_capped_elevated", label: "Energy at cap", category: "training", typicalWindowDays: 7 },
  best_income_day: { kind: "best_income_day", label: "Best income day", category: "record", typicalWindowDays: 90 },
  networth_record: { kind: "networth_record", label: "Net worth record", category: "record", typicalWindowDays: 30 },
};

/** The measured comparison every insight is built on. */
export interface InsightComparison {
  /** What is being compared, e.g. "daily income", "gain per energy". */
  metric: string;
  baselineLabel: string;
  /** Baseline period value (already normalized per-day/per-session where applicable). */
  baselineValue: number;
  currentValue: number;
  /** Signed delta in the metric's own unit. */
  delta: number;
  /** Signed percentage vs |baseline|; null when baseline is 0. */
  deltaPct: number | null;
  unit: "money" | "stat" | "energy" | "hours" | "count" | "ratio";
}

export interface InsightEvidence {
  /** Evidence window of the CURRENT period (unix seconds). */
  from: number;
  to: number;
  /** Sample size backing the comparison (days, sessions, events…). */
  sampleSize: number;
  /** Baseline window length in days (for copy: "vs your 30-day average"). */
  baselineDays: number;
}

/**
 * One derived insight. `dedupeKey` is stable per (kind, evidence identity) so
 * notifications and dismissal survive re-computation.
 */
export interface Insight {
  /** `${kind}:${identity}` — stable across recomputes. */
  id: string;
  kind: InsightKind;
  category: InsightCategory;
  priority: InsightPriority;
  /** Title WITHOUT sensitive amounts (safe for notifications). */
  title: string;
  /** One-sentence observed comparison — never a causal claim. */
  detail: string;
  /** Richer detail including amounts — only shown when sensitive details are on. */
  sensitiveDetail: string | null;
  comparison: InsightComparison;
  evidence: InsightEvidence;
  confidence: InsightConfidence;
  /** Best-known provenance of the underlying figures ("inferred" for session-derived rules). */
  provenance: "exact" | "derived" | "estimated" | "inferred";
  dedupeKey: string;
  /** When the current period ended (unix seconds) — sort/feed key. */
  occurredAt: number;
  /** In-app destination. */
  clickPath: string;
}

export interface InsightsResponse {
  insights: Insight[];
  /** Kinds the engine looks for (registry mirror for filters). */
  kinds: InsightKindMeta[];
  /** True when history coverage is too short for most rules. */
  insufficientHistory: boolean;
}

/** Priority order for feeds (high first). */
export const INSIGHT_PRIORITY_ORDER: Record<InsightPriority, number> = { high: 0, normal: 1, low: 2 };

/* -------------------------------------------------------------------------- */
/* Zod contract (mirrors the types above)                                      */
/* -------------------------------------------------------------------------- */

import { z } from "zod";

export const InsightSchema = z.object({
  id: z.string(),
  kind: z.enum(INSIGHT_KINDS),
  category: z.enum(INSIGHT_CATEGORIES),
  priority: z.enum(INSIGHT_PRIORITIES),
  title: z.string(),
  detail: z.string(),
  sensitiveDetail: z.string().nullable(),
  comparison: z.object({
    metric: z.string(),
    baselineLabel: z.string(),
    baselineValue: z.number(),
    currentValue: z.number(),
    delta: z.number(),
    deltaPct: z.number().nullable(),
    unit: z.enum(["money", "stat", "energy", "hours", "count", "ratio"]),
  }),
  evidence: z.object({ from: z.number(), to: z.number(), sampleSize: z.number(), baselineDays: z.number() }),
  confidence: z.enum(INSIGHT_CONFIDENCES),
  provenance: z.enum(["exact", "derived", "estimated", "inferred"]),
  dedupeKey: z.string(),
  occurredAt: z.number(),
  clickPath: z.string(),
});

export const InsightsResponseSchema = z.object({
  insights: z.array(InsightSchema),
  kinds: z.array(
    z.object({
      kind: z.enum(INSIGHT_KINDS),
      label: z.string(),
      category: z.enum(INSIGHT_CATEGORIES),
      typicalWindowDays: z.number(),
    })
  ),
  insufficientHistory: z.boolean(),
});
