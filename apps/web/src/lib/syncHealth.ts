import type { SyncIncidentDto, SyncOperationalMetaDto, SyncOperationReasonDto, SyncSeverityDto } from "@tornscope/shared";

/**
 * Central, localization-ready copy for operational sync health states and
 * machine reason codes (mirror of confidence.ts). UI components render from
 * this module only — raw state/reason codes are never displayed.
 */

export interface OperationalStyle {
  label: string;
  /** Tailwind classes for the status dot. */
  dot: string;
  /** Tailwind classes for the label text. */
  text: string;
}

export const OPERATIONAL_LABELS: Record<SyncOperationalMetaDto["state"], OperationalStyle> = {
  caught_up: { label: "Caught up", dot: "bg-positive", text: "text-fg-muted" },
  running: { label: "Syncing", dot: "live-dot bg-accent", text: "text-accent" },
  backfilling: { label: "Importing history", dot: "live-dot bg-accent", text: "text-accent" },
  delayed: { label: "Delayed", dot: "bg-warning", text: "text-warning" },
  retrying: { label: "Retrying", dot: "bg-warning", text: "text-warning" },
  degraded: { label: "Degraded", dot: "bg-warning", text: "text-warning" },
  failed: { label: "Failed", dot: "bg-negative", text: "text-negative" },
  parked: { label: "Parked", dot: "bg-warning", text: "text-warning" },
  stale_running: { label: "Stale — recovering", dot: "bg-warning", text: "text-warning" },
  never_run: { label: "Not started", dot: "bg-fg-faint", text: "text-fg-faint" },
};

/** One-line explanation per machine reason code (tooltip copy). */
export const OPERATION_REASON_COPY: Record<SyncOperationReasonDto, string> = {
  none: "The sync loop is working normally.",
  overdue: "The next expected run has not happened yet — the queue may be busy or the worker slowed down.",
  rate_limited: "Torn rate-limited the last sync. It retries automatically with backoff.",
  timeout: "The last sync timed out talking to Torn. It retries automatically.",
  upstream_error: "Torn reported a temporary problem. The sync retries automatically.",
  network_error: "A network problem interrupted the last sync. It retries automatically.",
  capability_denied: "Your API key does not include the permission this resource needs.",
  key_invalid: "The stored API key was rejected by Torn. Re-save your key in Settings.",
  worker_interrupted: "A previous run was interrupted (worker restart). TornScope recovers it automatically.",
  category_failure: "The sync completes, but some log categories keep failing and are retried on their own schedule.",
  repeated_failures: "Several sync attempts in a row failed. TornScope keeps retrying with backoff.",
  unknown_error: "The last sync failed for an unrecognized reason. TornScope keeps retrying.",
};

/** State meaning lines for tooltips (used with the reason copy). */
const STATE_MEANING: Record<SyncOperationalMetaDto["state"], string> = {
  caught_up: "This resource synced successfully and its next run is on schedule.",
  running: "This resource is syncing right now.",
  backfilling: "The first history import for this resource is still running.",
  delayed: "This resource has not run at its expected time — data stops refreshing until it catches up.",
  retrying: "The last attempt failed, but an automatic retry is scheduled.",
  degraded: "This resource keeps having problems. Data may be incomplete until it recovers.",
  failed: "The last attempt failed and its retry is overdue — attention needed.",
  parked: "Syncing is intentionally paused because the key lacks the permission. History is retained.",
  stale_running: "A run appears interrupted; TornScope re-enqueues it automatically within minutes.",
  never_run: "No sync has been attempted for this resource yet.",
};

export function operationalTitle(meta: SyncOperationalMetaDto | null | undefined): string | undefined {
  if (!meta) return undefined;
  const parts = [STATE_MEANING[meta.state]];
  if (meta.reason !== "none") parts.push(OPERATION_REASON_COPY[meta.reason]);
  return parts.join(" ");
}

/** Incident copy — never raw codes, never raw error payloads. */
export const INCIDENT_KIND_COPY: Record<SyncIncidentDto["kind"], string> = {
  sync_failures: "Sync failures",
  stale_recovered: "Recovered stale worker run",
  capability_denied: "Permission denied",
};

export const INCIDENT_REASON_COPY: Record<SyncOperationReasonDto, string> = {
  none: "",
  overdue: "run overdue",
  rate_limited: "rate limited by Torn",
  timeout: "timed out",
  upstream_error: "Torn temporarily unavailable",
  network_error: "network error",
  capability_denied: "permission missing",
  key_invalid: "API key rejected",
  worker_interrupted: "worker interrupted",
  category_failure: "category failures",
  repeated_failures: "repeated failures",
  unknown_error: "unknown error",
};

/** Severity chip copy. */
export const SEVERITY_LABELS: Record<SyncSeverityDto, string> = {
  info: "info",
  warning: "warning",
  error: "error",
};

export const SEVERITY_STYLES: Record<SyncSeverityDto, string> = {
  info: "border-border bg-surface-2 text-fg-muted",
  warning: "border-warning/40 bg-warning/10 text-warning",
  error: "border-negative/40 bg-negative/10 text-negative",
};
