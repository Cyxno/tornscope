import type { Insight, InsightCategory, InsightComparison, InsightEvidence, InsightsResponse } from "@tornscope/shared";
import {
  formatDecimal,
  formatMoneyCompact,
  formatNumberCompact,
  humanLabel,
  INSIGHT_KIND_META,
  INSIGHT_PRIORITY_ORDER,
  type InsightKind,
} from "@tornscope/shared";
import { confidenceChip, type ConfidenceChip } from "./goals-view.js";

/**
 * Pure presentation helpers for the Insights page. Every insight compares two
 * measured periods, so the page renders the comparison, its evidence window
 * and its confidence — all unit-aware, all through the shared formatters.
 * Copy and grouping live here so raw kind/category codes never reach markup.
 */

export { confidenceChip, type ConfidenceChip };

/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

export const CATEGORY_LABELS: Record<InsightCategory, string> = {
  economy: "Economy",
  training: "Training",
  travel: "Travel",
  substances: "Substances",
  record: "Records",
  system: "System",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as InsightCategory] ?? humanLabel(category);
}

/** Kind label from the response registry, falling back to the shared curated registry. */
export function kindLabel(kind: string, kinds: InsightsResponse["kinds"]): string {
  return kinds.find((k) => k.kind === kind)?.label ?? INSIGHT_KIND_META[kind as InsightKind]?.label ?? humanLabel(kind);
}

/* -------------------------------------------------------------------------- */
/* Comparison formatting — per unit, honest signs                              */
/* -------------------------------------------------------------------------- */

/** Unit-aware compact value: money via the shared money helper, hours/ratio humanized. */
export function formatComparisonValue(value: number, unit: InsightComparison["unit"]): string {
  if (Number.isNaN(value)) return "—";
  switch (unit) {
    case "money":
      return formatMoneyCompact(value);
    case "hours":
      return `${formatDecimal(value, 1)}h`;
    case "ratio":
      return `${formatDecimal(value, 2)}×`;
    case "count":
      return Math.round(value).toLocaleString("en-US");
    case "stat":
    case "energy":
      return formatNumberCompact(value);
  }
}

/** Signed delta in the metric's own unit, e.g. "+$532.1k" / "-8.1h". */
export function formatComparisonDelta(delta: number, unit: InsightComparison["unit"]): string {
  if (Number.isNaN(delta)) return "—";
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  return `${sign}${formatComparisonValue(Math.abs(delta), unit)}`;
}

/** Signed percentage vs baseline; null stays null (baseline was 0 — no fake %). */
export function formatDeltaPct(deltaPct: number | null | undefined): string | null {
  if (deltaPct === null || deltaPct === undefined || Number.isNaN(deltaPct)) return null;
  const sign = deltaPct > 0 ? "+" : "";
  return `${sign}${Math.round(deltaPct)}%`;
}

export interface ComparisonParts {
  baseline: string;
  current: string;
  delta: string;
  pct: string | null;
}

export function comparisonParts(c: InsightComparison): ComparisonParts {
  return {
    baseline: formatComparisonValue(c.baselineValue, c.unit),
    current: formatComparisonValue(c.currentValue, c.unit),
    delta: formatComparisonDelta(c.delta, c.unit),
    pct: formatDeltaPct(c.deltaPct),
  };
}

/* -------------------------------------------------------------------------- */
/* Evidence line — human dates, window vs baseline, sample size                */
/* -------------------------------------------------------------------------- */

/** "20-09-2026 – 27-09-2026 · 7-day window vs 30-day baseline · sample: 7". */
export function evidenceLine(e: InsightEvidence, fmtDate: (ts: number | null | undefined) => string): string {
  const windowDays = Math.max(1, Math.round((e.to - e.from) / 86_400));
  return `${fmtDate(e.from)} – ${fmtDate(e.to)} · ${windowDays}-day window vs ${e.baselineDays}-day baseline · sample: ${e.sampleSize}`;
}

/* -------------------------------------------------------------------------- */
/* Feed shaping                                                                */
/* -------------------------------------------------------------------------- */

/** Priority first (high → low), then newest. */
export function sortInsights(insights: Insight[]): Insight[] {
  return [...insights].sort(
    (a, b) => INSIGHT_PRIORITY_ORDER[a.priority] - INSIGHT_PRIORITY_ORDER[b.priority] || b.occurredAt - a.occurredAt
  );
}

export interface CategoryChip {
  /** "all" for the reset chip, otherwise the category code. */
  category: string;
  label: string;
  count: number;
}

/** Filter chips from the kinds registry (what the engine looks for), counts from the feed. */
export function categoryChips(insights: Insight[], kinds: InsightsResponse["kinds"]): CategoryChip[] {
  const counts = new Map<string, number>();
  for (const insight of insights) counts.set(insight.category, (counts.get(insight.category) ?? 0) + 1);
  const order: string[] = [];
  for (const meta of kinds) if (!order.includes(meta.category)) order.push(meta.category);
  return [
    { category: "all", label: "All", count: insights.length },
    ...order.map((category) => ({ category, label: categoryLabel(category), count: counts.get(category) ?? 0 })),
  ];
}

/** "Open Economy" — resolved against the app's own nav model; null when unknown. */
export function clickPathLabel(path: string, items: ReadonlyArray<{ href: string; label: string }>): string | null {
  const hit = items.find((item) => item.href === path || path.startsWith(`${item.href}/`));
  return hit ? `Open ${hit.label}` : null;
}
