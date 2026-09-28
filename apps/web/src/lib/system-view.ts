/**
 * System health view derivation (2.0) — the pure logic behind the /system
 * page: service status chips, the sync queue summary, worst-first freshness
 * ordering and humanized error kinds.
 *
 * Same discipline as syncHealth.ts: the page renders from copy tables only —
 * raw machine codes (lastErrorKind, statuses) never reach the screen. Reuses
 * the sync-health vocabulary where it applies (reason codes, resource and
 * operational labels) and adds the system-level extras (service statuses,
 * "torn_api_unreachable").
 *
 * Kept free of runes so the root vitest suite (no Svelte plugin) can unit
 * test it directly.
 */
import type { DataFreshnessEntry, DataFreshnessStatus, SystemHealthResponse } from "@tornscope/shared";
import { DATA_FRESHNESS_SEVERITY, DATA_FRESHNESS_STATUS_LABELS, humanLabel, RESOURCE_LABELS } from "@tornscope/shared";
import { INCIDENT_REASON_COPY, OPERATIONAL_LABELS } from "./syncHealth";

/* -------------------------------------------------------------------------- */
/* Status chips                                                                */
/* -------------------------------------------------------------------------- */

export interface StatusChip {
  /** Human status word — status is conveyed by text, never color alone. */
  label: string;
  /** Chip modifier class combined with the .chip primitive ("" = neutral). */
  chip: string;
}

const SERVICE_STATUS_COPY: Record<string, string> = {
  ok: "Operational",
  degraded: "Degraded",
  unreachable: "Unreachable",
  stale: "Stale",
  unknown: "Unknown",
};

/** Service status → chip (ok→success, unreachable/stale→critical,
 *  degraded→warning, anything else→neutral). Unknown future codes get a
 *  humanized fallback label, never the raw enum. */
export function serviceStatusChip(status: string): StatusChip {
  const label = SERVICE_STATUS_COPY[status] ?? humanLabel(status);
  const chip =
    status === "ok"
      ? "chip-positive"
      : status === "unreachable" || status === "stale"
        ? "chip-negative"
        : status === "degraded"
          ? "chip-warning"
          : "";
  return { label, chip };
}

const SEVERITY_CHIP: Record<"ok" | "warning" | "error", string> = {
  ok: "chip-positive",
  warning: "chip-warning",
  error: "chip-negative",
};

/** Freshness status → chip, using the shared severity vocabulary
 *  (fresh→success, delayed/stale/unavailable→warning, failed→critical). */
export function freshnessChip(status: DataFreshnessStatus): StatusChip {
  return { label: DATA_FRESHNESS_STATUS_LABELS[status], chip: SEVERITY_CHIP[DATA_FRESHNESS_SEVERITY[status]] };
}

/* -------------------------------------------------------------------------- */
/* Ages                                                                        */
/* -------------------------------------------------------------------------- */

/** Relative age for readouts, "2m ago" style (mirrors formatRelative). */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds < 0) return "—";
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** Compact age for tight table cells: "45s", "3m", "2h", "5d". */
export function formatAgeCompact(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds < 0) return "—";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/* -------------------------------------------------------------------------- */
/* Error kinds                                                                 */
/* -------------------------------------------------------------------------- */

/** System-level why-codes that are not sync reason codes. */
const ERROR_KIND_COPY: Record<string, string> = {
  torn_api_unreachable: "Torn API unreachable",
};

/**
 * Human copy for a stored lastErrorKind — raw codes never render. Sync
 * reason codes reuse the sync-health incident copy; anything else falls
 * back to a deterministic human label.
 */
export function humanizeErrorKind(kind: string | null | undefined): string | null {
  if (!kind || kind === "none") return null;
  const explicit = ERROR_KIND_COPY[kind];
  if (explicit) return explicit;
  const incident = INCIDENT_REASON_COPY[kind as keyof typeof INCIDENT_REASON_COPY];
  if (incident) return incident.charAt(0).toUpperCase() + incident.slice(1);
  return humanLabel(kind);
}

/* -------------------------------------------------------------------------- */
/* Services                                                                    */
/* -------------------------------------------------------------------------- */

export interface ServiceRow {
  key: string;
  name: string;
  chip: StatusChip;
  /** Primary detail line (version + sha, heartbeat age, note); null = quiet. */
  detail: string | null;
}

/** The five service rows in display order (API → PostgreSQL → Redis →
 *  Worker → Torn API). Pure; ages derive from the passed facts. */
export function deriveServiceRows(services: SystemHealthResponse["services"]): ServiceRow[] {
  const sha = services.api.gitSha ? services.api.gitSha.slice(0, 7) : null;
  return [
    {
      key: "api",
      name: "API",
      chip: serviceStatusChip(services.api.status),
      detail: [services.api.version, sha].filter(Boolean).join(" · ") || null,
    },
    { key: "database", name: "PostgreSQL", chip: serviceStatusChip(services.database.status), detail: null },
    { key: "redis", name: "Redis", chip: serviceStatusChip(services.redis.status), detail: null },
    {
      key: "worker",
      name: "Worker",
      chip: serviceStatusChip(services.worker.status),
      detail:
        services.worker.heartbeatAgeSeconds !== null ? `Heartbeat ${formatAge(services.worker.heartbeatAgeSeconds)}` : "No heartbeat yet",
    },
    {
      key: "tornApi",
      name: "Torn API",
      chip: serviceStatusChip(services.tornApi.status),
      detail: services.tornApi.note || null,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Sync                                                                        */
/* -------------------------------------------------------------------------- */

export interface FailingResourceRow {
  key: string;
  name: string;
  stateLabel: string;
  stateClass: string;
  /** Humanized last error ("Torn API unreachable"); null when none. */
  errorLabel: string | null;
}

export function deriveFailingResources(failings: SystemHealthResponse["sync"]["failingResources"]): FailingResourceRow[] {
  return failings.map((f) => {
    const operational = OPERATIONAL_LABELS[f.state as keyof typeof OPERATIONAL_LABELS];
    return {
      key: f.resource,
      name: RESOURCE_LABELS[f.resource as keyof typeof RESOURCE_LABELS] ?? humanLabel(f.resource),
      stateLabel: operational?.label ?? humanLabel(f.state),
      stateClass: operational?.text ?? "text-fg-muted",
      errorLabel: humanizeErrorKind(f.lastErrorKind),
    };
  });
}

export interface SyncSummary {
  running: boolean;
  /** One quiet line over the queue counts ("1 running · 2 waiting"). */
  queueLine: string;
  /** "2m ago" age of the oldest outstanding job; null when the queue is clear. */
  oldestOutstanding: string | null;
  /** "2m ago" age of the last successful sync; "never" when none. */
  lastSuccess: string;
  failing: FailingResourceRow[];
}

/** The queue in one line — nonzero counts only, human words over the
 *  machine states ("delayed" reads as "scheduled" — it is deliberate timing,
 *  not a fault). All-zero reads as calm, not as an error. */
export function queueSummary(queue: SystemHealthResponse["sync"]["queue"]): string {
  const parts: string[] = [];
  if (queue.active > 0) parts.push(`${queue.active} running`);
  if (queue.waiting > 0) parts.push(`${queue.waiting} waiting`);
  if (queue.delayed > 0) parts.push(`${queue.delayed} scheduled`);
  if (queue.failed > 0) parts.push(`${queue.failed} failed`);
  return parts.length > 0 ? parts.join(" · ") : "Queue is empty — every job has run.";
}

export function deriveSyncSummary(sync: SystemHealthResponse["sync"], nowSec: number): SyncSummary {
  return {
    running: sync.running,
    queueLine: queueSummary(sync.queue),
    oldestOutstanding:
      sync.queue.oldestOutstandingAt !== null ? formatAge(Math.max(0, nowSec - sync.queue.oldestOutstandingAt)) : null,
    lastSuccess: sync.lastSuccessAt !== null ? formatAge(Math.max(0, nowSec - sync.lastSuccessAt)) : "never",
    failing: deriveFailingResources(sync.failingResources),
  };
}

/* -------------------------------------------------------------------------- */
/* Data freshness                                                              */
/* -------------------------------------------------------------------------- */

/** Display rank, worst first: a broken pipeline outranks a slow one, which
 *  outranks one that has never had data; fresh comes last. */
const FRESHNESS_WORST_FIRST: Record<DataFreshnessStatus, number> = {
  failed: 0,
  stale: 1,
  delayed: 2,
  unavailable: 3,
  fresh: 4,
};

/** Freshness rows sorted worst-first (stable: registry order within a rank). */
export function sortFreshnessWorstFirst(entries: readonly DataFreshnessEntry[]): DataFreshnessEntry[] {
  return [...entries].sort((a, b) => FRESHNESS_WORST_FIRST[a.status] - FRESHNESS_WORST_FIRST[b.status]);
}
