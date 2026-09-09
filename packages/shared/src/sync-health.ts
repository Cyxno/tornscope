/**
 * Operational sync health (v0.2 roadmap item #3).
 *
 * Derives, from real sync bookkeeping, whether the SYNC PIPELINE itself is
 * healthy for a resource: is it keeping up, retrying, delayed, degraded,
 * parked, or has a run been orphaned? This is deliberately a SEPARATE
 * vocabulary from data confidence (confidence.ts): confidence answers "can I
 * trust the stored data", operational health answers "is the refresh loop
 * working". The two are never merged into one enum.
 *
 * All functions are pure: facts in (unix seconds), verdict out. The API
 * gathers facts in batches; the frontend never re-derives states from raw
 * fields — it only maps state/reason codes to localized copy.
 *
 * Retry model note: BullMQ runs every job with attempts=1 (a sync must not
 * auto-hammer the Torn API); retries are SCHEDULE-level — a failed run
 * records the next attempt in `nextRunAt` (failure ladder ≤ 10 min, category
 * ladder ≤ 1 h, capability parking 6 h). "retrying" therefore means a failed
 * run with a scheduled retry, and "failed" means the retry itself is overdue.
 */

export const SYNC_OPERATIONAL_STATES = [
  /** Last run succeeded and the next run is on schedule. */
  "caught_up",
  /** Actively syncing with a fresh heartbeat. */
  "running",
  /** First import still running (never succeeded yet). */
  "backfilling",
  /** Due/expected run is overdue beyond tolerance — nothing is retrying. */
  "delayed",
  /** Last run failed transiently; an automatic retry is scheduled. */
  "retrying",
  /** Repeated failures, or completing with persistent category failures. */
  "degraded",
  /** Last meaningful attempt failed and its retry is overdue. */
  "failed",
  /** Intentionally paused: the key lacks the permission (re-check scheduled). */
  "parked",
  /** DB says running but the heartbeat is stale — orphaned run awaiting recovery. */
  "stale_running",
  /** No sync attempt has ever been made. */
  "never_run",
] as const;

export type SyncOperationalState = (typeof SYNC_OPERATIONAL_STATES)[number];

/**
 * Machine-readable why-codes, backed only by real failure paths:
 * - torn-api error kinds (rate_limited / timeout / upstream_error /
 *   network_error / capability_denied / key_invalid)
 * - orphan recovery (worker_interrupted)
 * - per-category walk failures (category_failure)
 * Everything else is unknown_error. The frontend maps codes to copy —
 * they are never rendered raw.
 */
export const SYNC_OPERATION_REASONS = [
  "none",
  "overdue",
  "rate_limited",
  "timeout",
  "upstream_error",
  "network_error",
  "capability_denied",
  "key_invalid",
  "worker_interrupted",
  "category_failure",
  "repeated_failures",
  "unknown_error",
] as const;

export type SyncOperationReason = (typeof SYNC_OPERATION_REASONS)[number];

export type SyncSeverity = "info" | "warning" | "error";

/** Torn error kinds that map onto operational reasons via tornKindToReason. */
const TORN_KINDS = new Set<string>(["rate_limited", "transient", "network", "access_denied", "key_invalid", "key_paused", "permanent"]);

const REASON_SET = new Set<string>(SYNC_OPERATION_REASONS);

/** Map a Torn API error kind (+ timeout flag) onto an operational reason. */
export function tornKindToReason(kind: string | null | undefined, isTimeout = false): SyncOperationReason {
  if (isTimeout) return "timeout";
  switch (kind) {
    case "rate_limited":
      return "rate_limited";
    case "transient":
    case "permanent":
      return "upstream_error";
    case "network":
      return "network_error";
    case "access_denied":
      return "capability_denied";
    case "key_invalid":
    case "key_paused":
      return "key_invalid";
    default:
      return "unknown_error";
  }
}

/** Resolve a stored lastErrorKind (torn kind OR operational reason) to a reason code. */
function storedKindToReason(kind: string | null | undefined): SyncOperationReason {
  if (!kind) return "unknown_error";
  if (TORN_KINDS.has(kind)) return tornKindToReason(kind);
  if (REASON_SET.has(kind)) return kind as SyncOperationReason;
  return "unknown_error";
}

/* -------------------------------------------------------------------------- */
/* Central tolerance policy                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The ONE place sync-health tolerances live. The worker (claim, scheduler),
 * the API (derivation) and the UI (wording) all read these — no duplicated
 * stale thresholds anywhere else.
 */
export const SYNC_HEALTH_POLICY = {
  /**
   * Liveness: a "running" sync without a heartbeat for this long is an
   * orphan (crashed/restarted worker). The heartbeat is written ONLY by
   * claim and the progress heartbeat, so bookkeeping updates can never mask
   * a dead run.
   */
  RUNNING_STALE_AFTER_SECONDS: 15 * 60,
  /**
   * Cadence-aware delay tolerance: a due run is "delayed" only after
   * nextRunAt + grace. The scheduler ticks every minute and jobs run one at
   * a time, so short overshoots are normal queueing — never flagged.
   * Grace is 5 min at minimum, scales with the cadence, caps at 30 min.
   */
  delayGraceSeconds(frequencySeconds: number): number {
    return Math.max(5 * 60, Math.min(Math.max(frequencySeconds, 60), 30 * 60));
  },
  /**
   * Consecutive failures (sync_state.errorCount, reset on success) before a
   * retrying resource reads as degraded instead of transient.
   */
  DEGRADED_FAILURE_THRESHOLD: 3,
  /**
   * A stale-running orphan left un-recovered this long escalates from
   * warning to error (the scheduler should re-enqueue within a minute of
   * the threshold, so persistence here means recovery itself is broken).
   */
  STALE_RUNNING_ERROR_FACTOR: 4,
  /** How far back incident/run history is summarized (unix seconds). */
  INCIDENT_WINDOW_SECONDS: 24 * 3600,
  /** Max incident episodes returned per resource (payload compactness). */
  MAX_INCIDENTS: 5,
} as const;

/* -------------------------------------------------------------------------- */
/* Derivation inputs / output                                                  */
/* -------------------------------------------------------------------------- */

/** Facts gathered from SyncState (+ category summary) — unix seconds. */
export interface SyncOperationalFacts {
  /** sync_state.status: idle | running | failed | capability_denied. */
  status: string;
  lastAttemptAt: number | null;
  lastStartedAt: number | null;
  /** Liveness heartbeat for the current run (claim + progress writes only). */
  lastHeartbeatAt: number | null;
  lastSuccessAt: number | null;
  nextRunAt: number | null;
  frequencySeconds: number;
  /** Consecutive failures (reset on success) — drives degraded detection. */
  errorCount: number;
  /** Machine reason of the last failure (lastErrorKind column). */
  lastErrorKind: string | null;
  /** Any backing category failed/access_denied (walk resources). */
  hasCategoryProblems: boolean;
}

export interface SyncOperationalMeta {
  state: SyncOperationalState;
  reason: SyncOperationReason;
  /** When the current state began (best known timestamp, unix seconds). */
  since: number | null;
  /** For delayed/failed: how far past due the expected run is. */
  overdueBySeconds: number | null;
  /** For retrying: when the automatic retry is scheduled. */
  retryAt: number | null;
  /** The system can (or will) recover this on its own / via a safe retry. */
  recoverable: boolean;
  severity: SyncSeverity;
}

/**
 * Derive the operational sync state from real facts. Pure; same inputs always
 * yield the same verdict. Precedence (most urgent first):
 *
 * 1. capability_denied          → parked
 * 2. no attempt ever            → never_run
 * 3. running + dead heartbeat   → stale_running (persistent → error severity)
 * 4. running + fresh heartbeat  → running / backfilling (never succeeded yet)
 * 5. failed + errorCount ≥ 3    → degraded (repeated failures)
 * 6. failed + retry scheduled   → retrying
 * 7. failed + retry overdue     → failed
 * 8. idle + category problems   → degraded (category_failure)
 * 9. idle + next run overdue    → delayed
 * 10. otherwise                 → caught_up
 */
export function deriveSyncOperationalState(facts: SyncOperationalFacts, now: number): SyncOperationalMeta {
  const grace = SYNC_HEALTH_POLICY.delayGraceSeconds(facts.frequencySeconds);

  const meta = (partial: Partial<SyncOperationalMeta> & Pick<SyncOperationalMeta, "state">): SyncOperationalMeta => ({
    reason: "none",
    since: facts.lastAttemptAt ?? facts.lastStartedAt ?? null,
    overdueBySeconds: null,
    retryAt: null,
    recoverable: true,
    severity: "info",
    ...partial,
  });

  // 1. Intentionally parked: the key cannot access this resource at all.
  if (facts.status === "capability_denied") {
    return meta({ state: "parked", reason: "capability_denied", severity: "warning" });
  }

  // 2. Nothing has ever been attempted for this resource.
  if (facts.lastAttemptAt === null) {
    return meta({ state: "never_run" });
  }

  // 3+4. Active run — liveness is the heartbeat (claim/progress writes only),
  // with lastStartedAt as the fallback for pre-heartbeat rows.
  if (facts.status === "running") {
    const liveness = facts.lastHeartbeatAt ?? facts.lastStartedAt ?? 0;
    const staleFor = now - liveness;
    if (staleFor >= SYNC_HEALTH_POLICY.RUNNING_STALE_AFTER_SECONDS) {
      return meta({
        state: "stale_running",
        reason: "worker_interrupted",
        since: liveness > 0 && liveness <= now ? liveness : null,
        severity:
          staleFor >= SYNC_HEALTH_POLICY.RUNNING_STALE_AFTER_SECONDS * SYNC_HEALTH_POLICY.STALE_RUNNING_ERROR_FACTOR ? "error" : "warning",
      });
    }
    return meta({ state: facts.lastSuccessAt === null ? "backfilling" : "running", since: facts.lastStartedAt });
  }

  // 5-7. Last attempt failed.
  if (facts.status === "failed") {
    const reason = storedKindToReason(facts.lastErrorKind);

    // Repeated failures: the retry ladder keeps failing — degraded, not a
    // fresh transient blip. (errorCount resets on the next success.)
    if (facts.errorCount >= SYNC_HEALTH_POLICY.DEGRADED_FAILURE_THRESHOLD) {
      return meta({ state: "degraded", reason, severity: "warning", retryAt: facts.nextRunAt });
    }

    // A failed run always schedules a retry (failure ladder ≤ 10 min). While
    // that retry is pending — or only just overdue within grace — the state
    // is "retrying", not a hard failure.
    const base = facts.nextRunAt ?? facts.lastAttemptAt!;
    const overdueBy = now - base;
    if (overdueBy > grace) {
      return meta({ state: "failed", reason, severity: "error", overdueBySeconds: Math.max(0, overdueBy) });
    }
    return meta({ state: "retrying", reason, retryAt: facts.nextRunAt });
  }

  // 8-10. Idle: last attempt succeeded (success resets errorCount to 0).
  if (facts.hasCategoryProblems) {
    return meta({ state: "degraded", reason: "category_failure", severity: "warning" });
  }

  const base = facts.nextRunAt ?? (facts.lastSuccessAt !== null ? facts.lastSuccessAt + facts.frequencySeconds : null);
  if (base !== null && now - base > grace) {
    return meta({
      state: "delayed",
      reason: "overdue",
      severity: "warning",
      since: base,
      overdueBySeconds: Math.max(0, now - base),
    });
  }

  return meta({ state: "caught_up", since: facts.lastSuccessAt });
}

/* -------------------------------------------------------------------------- */
/* Incident derivation (from existing SyncRun history)                         */
/* -------------------------------------------------------------------------- */

/** Minimal SyncRun facts needed for incident derivation (unix seconds). */
export interface SyncRunFact {
  /** success | failed | skipped | recovered */
  status: string;
  startedAt: number;
  finishedAt: number | null;
  /** Machine reason of a failed run (stats.errorKind). */
  errorKind?: string | null;
}

export interface SyncIncident {
  kind: "sync_failures" | "stale_recovered" | "capability_denied";
  severity: SyncSeverity;
  reason: SyncOperationReason;
  startedAt: number;
  /** When the incident ended (last failing run); null while ongoing. */
  endedAt: number | null;
  /** A later successful run (or automatic recovery) closed the incident. */
  autoRecovered: boolean;
  /** Failed/affected runs in the episode. */
  failureCount: number;
}

/**
 * Derive compact incident episodes from a resource's recent run history
 * (ascending by startedAt). Consecutive failed runs collapse into ONE
 * episode, so a resource that failed three times then recovered reads as
 * "3 sync problems · recovered", not three separate alarms.
 *
 * A "recovered" run row is written by the scheduler when it re-enqueues an
 * orphaned run — it becomes a stale_recovered incident (the exact
 * money_logs class of bug, made visible).
 */
export function deriveResourceIncidents(runs: SyncRunFact[], now: number, windowSeconds = SYNC_HEALTH_POLICY.INCIDENT_WINDOW_SECONDS): SyncIncident[] {
  const windowStart = now - windowSeconds;
  const incidents: SyncIncident[] = [];

  interface FailedRun extends SyncRunFact {
    recoveredAfter: boolean;
  }
  let failures: FailedRun[] = [];
  const flushFailures = (): void => {
    if (failures.length === 0) return;
    const count = failures.length;
    const last = failures[count - 1]!;
    const autoRecovered = failures[0]!.recoveredAfter;
    incidents.push({
      kind: "sync_failures",
      severity: !autoRecovered && count >= 3 ? "error" : autoRecovered && count < 3 ? "info" : "warning",
      reason: storedKindToReason(last.errorKind ?? null),
      startedAt: failures[0]!.startedAt,
      endedAt: last.finishedAt,
      autoRecovered,
      failureCount: count,
    });
    failures = [];
  };

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    if (run.status === "success") {
      // A success closes the open failure streak and marks it auto-recovered.
      for (const f of failures) f.recoveredAfter = true;
      flushFailures();
      continue;
    }
    if (run.status === "failed") {
      failures.push({ ...run, recoveredAfter: false });
      continue;
    }
    if (run.status === "recovered") {
      const nextRun = runs[i + 1];
      incidents.push({
        kind: "stale_recovered",
        severity: nextRun?.status === "success" ? "info" : "warning",
        reason: "worker_interrupted",
        startedAt: run.startedAt,
        endedAt: run.finishedAt,
        autoRecovered: true,
        failureCount: 1,
      });
      continue;
    }
    if (run.status === "skipped") {
      // Recorded only for runtime capability denial (busy runs write no row).
      incidents.push({
        kind: "capability_denied",
        severity: "warning",
        reason: "capability_denied",
        startedAt: run.startedAt,
        endedAt: run.finishedAt,
        autoRecovered: false,
        failureCount: 1,
      });
    }
  }
  flushFailures();

  return incidents
    .filter((i) => (i.endedAt ?? now) >= windowStart || i.startedAt >= windowStart)
    .slice(-SYNC_HEALTH_POLICY.MAX_INCIDENTS);
}

/* -------------------------------------------------------------------------- */
/* Lightweight metrics (from the same run history)                             */
/* -------------------------------------------------------------------------- */

export interface SyncRunMetrics {
  /** Successful / terminal runs in the window (null when no runs). */
  successRate24h: number | null;
  failures24h: number;
  /** Mean run duration in ms (null when unknown). */
  avgDurationMs24h: number | null;
  /** Orphan runs the scheduler recovered in the window. */
  recoveries24h: number;
}

/** Summarize run history into compact display metrics. Pure. */
export function summarizeSyncMetrics(runs: SyncRunFact[], now: number, windowSeconds = SYNC_HEALTH_POLICY.INCIDENT_WINDOW_SECONDS): SyncRunMetrics {
  const windowStart = now - windowSeconds;
  const recent = runs.filter((r) => r.startedAt >= windowStart);
  const terminal = recent.filter((r) => r.status === "success" || r.status === "failed");
  const durations = recent
    .filter((r) => r.status !== "recovered")
    .map((r) => (r.finishedAt !== null ? (r.finishedAt - r.startedAt) * 1000 : null))
    .filter((ms): ms is number => ms !== null && ms >= 0);
  return {
    successRate24h: terminal.length > 0 ? terminal.filter((r) => r.status === "success").length / terminal.length : null,
    failures24h: recent.filter((r) => r.status === "failed").length,
    avgDurationMs24h: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    recoveries24h: recent.filter((r) => r.status === "recovered").length,
  };
}
