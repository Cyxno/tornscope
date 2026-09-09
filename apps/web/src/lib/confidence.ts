import type { ConfidenceCoverageDto, ConfidenceReasonDto, DataConfidenceMetaDto } from "@tornscope/shared";

/**
 * Central, localization-ready copy for data confidence states and machine
 * reason codes. UI components render from this module only — raw reason
 * codes are never displayed and no page hand-writes confidence strings.
 */

export const CONFIDENCE_LABELS: Record<DataConfidenceMetaDto["confidence"], string> = {
  complete: "Complete",
  partial: "Partial",
  stale_permission: "Stale",
  unavailable: "Unavailable",
};

/** One-line explanation per machine reason code (tooltip/popover copy). */
export const CONFIDENCE_REASON_COPY: Record<ConfidenceReasonDto, string> = {
  missing_permission: "Your API key does not include the permission needed for this data.",
  historical_permission_lost: "Historical data is retained, but your current API key no longer allows this resource to refresh.",
  never_synced: "This resource has not completed its first sync yet.",
  backfill_in_progress: "Historical data is still being imported — values may change until it finishes.",
  sync_incomplete: "The historical sync has not fully covered this period yet.",
  sync_error: "The last sync attempt failed. Existing history is still shown.",
  range_before_coverage: "TornScope was not collecting history for the start of this period yet.",
  source_unavailable: "The Torn API returned no data for this resource.",
  day_in_progress: "This day has not ended yet, so the summary cannot claim end-of-day completeness.",
};

const COVERAGE_COPY = {
  complete: "Data for this range is fully synced.",
  partial: "Some data for this period may be missing.",
  stale_permission: "Historical data is shown, but it is no longer refreshing.",
  unavailable: "No data is available for this period.",
} as const;

/** Full tooltip text: state meaning + specific reason (+ freshness). */
export function confidenceTitle(meta: DataConfidenceMetaDto | null | undefined, refreshedLabel?: string): string | undefined {
  if (!meta || meta.confidence === "complete") return undefined;
  const parts: string[] = [COVERAGE_COPY[meta.confidence]];
  if (meta.reason) parts.push(CONFIDENCE_REASON_COPY[meta.reason]);
  if (refreshedLabel) parts.push(refreshedLabel);
  return parts.join(" ");
}

/** "Coverage 04-2026 → 09-2026" style line for tooltips (null-safe). */
export function coverageTitle(coverage: ConfidenceCoverageDto | null | undefined, formatDate: (ts: number | null) => string): string | undefined {
  if (!coverage || (coverage.from === null && coverage.to === null)) return undefined;
  return `Coverage ${formatDate(coverage.from)} → ${formatDate(coverage.to)}`;
}
