import type { GoalMetricId, GoalMetricUnit, GoalView, GoalsResponse, ProjectionInsufficientReason } from "@tornscope/shared";
import {
  formatMoneyFull,
  formatSignedMoneyCompact,
  formatSignedNumberCompact,
  GOAL_METRICS,
  humanLabel,
} from "@tornscope/shared";

/**
 * Pure presentation helpers for the Goals page — everything a test can pin
 * down without a DOM. Copy lives here so raw machine codes (projection
 * insufficient-reasons) never reach the markup, and money always goes
 * through the shared formatters — never hand-rolled.
 */

/* -------------------------------------------------------------------------- */
/* Why an ETA is withheld — machine codes are never rendered raw               */
/* -------------------------------------------------------------------------- */

export const INSUFFICIENT_REASON_COPY: Record<ProjectionInsufficientReason, string> = {
  insufficient_history: "Not enough history yet",
  no_positive_trend: "No upward trend right now",
  too_volatile: "Too volatile to project",
  beyond_horizon: "Beyond the 5-year horizon",
  target_reached: "Target reached",
};

/** Human copy for a withheld ETA; unknown future codes get a humanized fallback. */
export function insufficientReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "No projection yet";
  return INSUFFICIENT_REASON_COPY[reason as ProjectionInsufficientReason] ?? humanLabel(reason);
}

/* -------------------------------------------------------------------------- */
/* Value formatting — honest absence ("—"), never an invented zero             */
/* -------------------------------------------------------------------------- */

/** Locale whole-number formatting for stat/level values (money uses the shared helpers). */
export function formatLocaleNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

/** One formatter per metric unit; null stays "—" — missing data never renders as 0. */
export function formatGoalValue(value: number | null | undefined, unit: GoalMetricUnit): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return unit === "money" ? formatMoneyFull(value) : formatLocaleNumber(value);
}

/** Observed daily rate, e.g. "+$120.5k/day" — null when the rate is unknown. */
export function formatVelocity(velocityPerDay: number | null | undefined, unit: GoalMetricUnit): string | null {
  if (velocityPerDay === null || velocityPerDay === undefined || Number.isNaN(velocityPerDay)) return null;
  const signed = unit === "money" ? formatSignedMoneyCompact(velocityPerDay) : formatSignedNumberCompact(velocityPerDay);
  return `${signed}/day`;
}

/** 0..100 integer for the progress bar; null stays null (no invented 0%). */
export function progressPct(progress: number | null | undefined): number | null {
  if (progress === null || progress === undefined || Number.isNaN(progress)) return null;
  return Math.min(100, Math.max(0, Math.round(progress * 100)));
}

/* -------------------------------------------------------------------------- */
/* Projection confidence chip — visually matches ConfidenceBadge's convention  */
/* (visible label is the accessible text; the title tooltip is supplemental).  */
/* -------------------------------------------------------------------------- */

export interface ConfidenceChip {
  label: string;
  class: string;
  title: string;
}

export function confidenceChip(confidence: string): ConfidenceChip {
  switch (confidence) {
    case "high":
      return { label: "High confidence", class: "chip-positive", title: "A steady trend over the selected window — the projected date is a solid estimate." };
    case "medium":
      return { label: "Medium confidence", class: "", title: "Some variation in the trend — the projected date can shift." };
    case "low":
      return { label: "Low confidence", class: "chip-warning", title: "A noisy trend — treat the projected date as a rough guide." };
    default:
      return { label: "Not enough data", class: "chip-warning", title: "Not enough steady data to project a date." };
  }
}

/* -------------------------------------------------------------------------- */
/* Metric metadata (with registry fallbacks for unknown response entries)      */
/* -------------------------------------------------------------------------- */

export function metricLabel(metrics: GoalsResponse["metrics"], metricId: string): string {
  return metrics.find((m) => m.id === metricId)?.label ?? GOAL_METRICS[metricId as GoalMetricId]?.label ?? humanLabel(metricId);
}

export function unitForMetric(metrics: GoalsResponse["metrics"], metricId: string): GoalMetricUnit {
  return metrics.find((m) => m.id === metricId)?.unit ?? GOAL_METRICS[metricId as GoalMetricId]?.unit ?? "stat";
}

export function metricDescription(metrics: GoalsResponse["metrics"], metricId: string): string {
  return metrics.find((m) => m.id === metricId)?.description ?? GOAL_METRICS[metricId as GoalMetricId]?.description ?? "";
}

/* -------------------------------------------------------------------------- */
/* Form state shaping                                                          */
/* -------------------------------------------------------------------------- */

/** "2026-10-05" (date input) → unix seconds at that UTC day's end; invalid → null. */
export function targetDateToUnix(dateInput: string): number | null {
  if (!dateInput) return null;
  const ms = Date.parse(`${dateInput}T23:59:59Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Stored unix seconds → the date-input value (UTC day), for edit forms. */
export function unixToTargetDate(ts: number | null | undefined): string {
  if (!ts) return "";
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Blank notes are stored as null, not "". */
export function normalizeNote(note: string): string | null {
  const trimmed = note.trim();
  return trimmed ? trimmed : null;
}

export function targetError(targetInput: string): string | null {
  if (!targetInput.trim() || Number.isNaN(Number(targetInput)) || Number(targetInput) <= 0) {
    return "Enter a target above zero.";
  }
  return null;
}

export function noteError(note: string): string | null {
  return note.length > 280 ? "Notes are capped at 280 characters." : null;
}

/** The first problem with the create form, or null when it can be submitted. */
export function goalDraftError(metric: string, target: string, note: string): string | null {
  if (!metric) return "Pick a metric to track.";
  return targetError(target) ?? noteError(note);
}

/* -------------------------------------------------------------------------- */
/* List shaping                                                                */
/* -------------------------------------------------------------------------- */

/** Active (and achieved) goals first, archived goals in their own quiet group. */
export function splitGoals(goals: GoalView[]): { active: GoalView[]; archived: GoalView[] } {
  const active: GoalView[] = [];
  const archived: GoalView[] = [];
  for (const view of goals) (view.goal.status === "archived" ? archived : active).push(view);
  return { active, archived };
}

/** "as of 4m ago" via the injected relative formatter; empty when no snapshot exists. */
export function asOfLabel(currentValueAt: number | null | undefined, relative: (ts: number | null | undefined) => string): string {
  if (!currentValueAt) return "";
  return `as of ${relative(currentValueAt)}`;
}
