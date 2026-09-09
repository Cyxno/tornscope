# Sync Reliability & Incident Visibility

How TornScope v0.2 answers *"is the sync loop actually working?"* — and what
it does on its own when it is not. This is roadmap item #3 (v0.2), built on
top of the [Data Confidence](DATA-CONFIDENCE.md) foundation (item #1).

---

## The two vocabularies (never merged)

| Question | Vocabulary | Where |
|---|---|---|
| "Can I trust the stored data?" | Data confidence: `complete / partial / stale_permission / unavailable` | `packages/shared/src/confidence.ts` |
| "Is the refresh loop working?" | Operational state: `caught_up / running / backfilling / delayed / retrying / degraded / failed / parked / stale_running / never_run` | `packages/shared/src/sync-health.ts` |

The two are separate enums with separate derivations. Valid and common
combinations:

- **Retrying · Complete** — the latest refresh attempt failed transiently, but
  the stored history is fully trustworthy and an automatic retry is scheduled.
- **Parked · Stale** — the key lost a permission; history is retained and
  usable, but nothing is refreshing (`stale_permission`).
- **Delayed · Partial** — the run is overdue; coverage is intact so far.

A transient operational failure must never force confidence to degrade when
coverage is intact — and vice versa: parked resources keep their historical
data visible.

## Where the model lives

- **Derivation:** `deriveSyncOperationalState(facts, now)` in
  `packages/shared/src/sync-health.ts` — pure, batch-friendly, the ONLY place
  state rules exist. The API derives; the frontend only maps codes to copy.
- **Tolerance policy:** `SYNC_HEALTH_POLICY` in the same file — the single
  source of truth for the stale threshold, delay grace, degraded threshold and
  incident window. The worker (claim, scheduler), API and UI all read it.
- **Copy maps:** `apps/web/src/lib/syncHealth.ts` (mirrors `confidence.ts`).
  Raw codes (`stale_running`, `rate_limited`, …) are never rendered.

## Operational states

Derived in this precedence (first match wins):

1. **`parked`** — `status = capability_denied`: the key cannot access the
   resource at all. Re-checked every `CAPABILITY_RECHECK_SECONDS` (6 h).
   Severity: warning.
2. **`never_run`** — no attempt has ever been made. Severity: info.
3. **`stale_running`** — DB says `running` but the liveness heartbeat is older
   than `RUNNING_STALE_AFTER_SECONDS` (15 min). The run is an orphan
   (worker crash/restart); the scheduler re-enqueues it automatically within a
   minute. Severity escalates to error at 4× the threshold (recovery itself
   is then broken).
4. **`running` / `backfilling`** — actively claimed with a fresh heartbeat.
   `backfilling` means the first import (never succeeded yet). Severity: info.
5. **`degraded`** — repeated failures (`errorCount >= 3`, reset on success) or
   the run completes while backing categories keep failing
   (`category_failure`). Severity: warning.
6. **`retrying`** — last attempt failed transiently and the scheduled retry
   (`nextRunAt`, failure ladder ≤ 10 min) is still pending. Severity: info —
   this is the system working as designed.
7. **`failed`** — the last attempt failed AND its retry is overdue beyond the
   grace window. Severity: error.
8. **`delayed`** — idle, but `nextRunAt` is overdue beyond the grace window
   (nothing is retrying — the loop itself stalled). Severity: warning.
9. **`caught_up`** — last run succeeded, next run on schedule. Severity: info.

Every verdict carries: `reason` (machine code), `since`, `overdueBySeconds`
where relevant, `retryAt` for retrying, `recoverable`, and `severity`
(`info / warning / error`) used only for display prioritization.

### Delayed / overdue tolerance

A resource is **not** flagged late by seconds — short overshoots are normal
queueing (the scheduler ticks every 60 s; jobs run one at a time):

```
grace(frequencySeconds) = max(5 min, min(frequencySeconds, 30 min))
delayed  when  now > nextRunAt + grace
```

So a 10-minute resource tolerates ~20 min between runs, an hourly resource
~90 min. The same grace separates `retrying` from `failed`.

### Heartbeat semantics (stale running)

`SyncState.lastHeartbeatAt` is written ONLY by `claimResource` and
`progressResource` — never by generic bookkeeping (which auto-touches
`updatedAt` and historically masked dead workers). Liveness is time-based:
`progressResource` refreshes the heartbeat on every progress report, even
zero-record pages, so a long quiet re-walk never reads as a dead worker.
The scheduler's orphan detection and the operational derivation use the SAME
shared threshold — there are no duplicated stale constants.

## Retry / backoff model

BullMQ runs every job with `attempts: 1` **by design** (a sync must never
auto-hammer the Torn API). Retries are schedule-level:

| Failure | Retry schedule |
|---|---|
| Failed run | `nextRunAt = now + min(frequency, 10 min)` |
| Failed category (walk resources) | ladder 1 m → 5 m → 15 m → 30 m → 1 h cap |
| `access_denied` (runtime) / parked capability | 6 h re-check |
| Torn 429 / transient inside a request | in-client: 4 retries, exp backoff (1.5 s base, +2 s if rate-limited, ≤ 30 % jitter) |

Failures map to machine reason codes (stored in `SyncState.lastErrorKind`,
cleared on success): `rate_limited`, `timeout`, `upstream_error`,
`network_error`, `capability_denied`, `key_invalid`, `worker_interrupted`,
`category_failure`, `unknown_error`. Timeout is distinguished from generic
network failure via the torn-api client's `TornNetworkError.timedOut` flag.
Rate-limited resources read as `retrying`/`delayed` — never hard-failed —
because the retry ladder always schedules the next attempt.

Raw error prose stays in `SyncState.errorMessage` (server-side debugging aid,
shown truncated in the UI row only for failure states); it is never converted
into a code and no stack traces or secrets are exposed.

## Incidents (derived, no new tables)

The user should see "Money logs had 3 sync problems today, but recovered
automatically" without server access. Incidents are derived from the EXISTING
`SyncRun` history by `deriveResourceIncidents(runs, now)`:

- Consecutive failed runs collapse into ONE episode (start, end, failure
  count, worst reason).
- A later success closes the episode and marks it `autoRecovered`.
- One failure recovered = **info**; repeated recovered failures or an open
  streak = **warning**; 3+ unrecovered failures = **error**.
- Runtime capability denials surface as permission incidents.
- Scheduler orphan recovery writes a `recovered` SyncRun row (started at the
  dead run's start, reason `worker_interrupted`) — stale-worker incidents are
  visible without any new schema.

Each resource row in `/api/sync/health` carries `recentIncidents` (max 5,
24 h window) and compact `metrics` (24 h success rate, average run duration,
failure and recovery counts).

## Self-healing

What the system does automatically — always scoped to `userId + resource`,
always idempotent:

- **Orphan recovery:** scheduler re-enqueues a run whose heartbeat is stale;
  `claimResource` marks the dead run failed (`worker_interrupted`) and the new
  run replays safely from the untouched cursor.
- **Capability re-check:** parked resources are re-checked on the 6 h interval
  and unlock immediately when the key gains the permission.
- **Enqueue-first scheduling:** `nextRunAt` advances only after a successful
  queue add — a failed add leaves the resource due for the next tick.
- **Cursor safety:** cursors advance only after data is persisted; recovery
  and manual retries NEVER reset them (insertion dedup makes replay safe).

What self-healing deliberately does NOT do: reset cursors, delete history,
wipe queues globally, or rebuild resource history.

## Manual "Retry now"

Per-resource safe retry on Sync Status (`POST /api/sync/retry`):

- refuses `running` / `stale-running` resources (automatic recovery is already
  handling those) and `parked` resources (retrying without the permission
  cannot help — the UI hides the button there),
- keeps a 30 s cooldown even on the force path,
- never touches cursors or history, never duplicates runs (the claim lock
  guards overlap).

The legacy "Sync now" (60 s cooldown) and "Restart backfill" (5 min cooldown,
explicit cursor reset with confirmation) actions are unchanged.

## API surface

`GET /api/sync/health` per resource now exposes (in addition to the existing
`phase` and confidence):

```
operational:      { state, reason, since, overdueBySeconds, retryAt, recoverable, severity }
lastErrorKind:    machine reason of the last failure (null after success)
recentIncidents:  [{ kind, severity, reason, startedAt, endedAt, autoRecovered, failureCount }]
metrics:          { successRate24h, failures24h, avgDurationMs24h, recoveries24h }
```

All facts are gathered in batches (states, categories via one parallel pass,
48 h of run history in a single query) — no N+1, no per-row Redis reads.

## Database changes

One expand-only, upgrade-safe migration:
`20260909130000_sync_state_last_error_kind` adds the nullable
`SyncState.lastErrorKind` column. No destructive changes; incidents reuse
`SyncRun` (new `recovered` status value, written by the scheduler only).

## Worker restart behavior (the money_logs bug class)

1. resource starts → heartbeat written
2. worker dies/restarts → DB stays `running`
3. stale threshold passes → UI shows `stale_running` (warning)
4. scheduler detects the orphan, writes the `recovered` incident row, re-enqueues
5. claim succeeds (heartbeat liveness, not `updatedAt`) — cursor/history intact
6. run completes → state back to `caught_up`, incident shows auto-recovered

Tested by `apps/worker/tests/sync-reliability.test.ts`,
`apps/worker/tests/stale-recovery.test.ts`, and a controlled dev-stack chaos
simulation (worker killed mid-run).

## Isolation

One broken resource cannot block others: per-user and per-resource try/catch
in the scheduler, claim-lock overlap protection, and one-job-at-a-time
processing means a failing resource delays (visible as `delayed`) but never
corrupts unrelated resources.

## Developer guidance

- Adding a new operational state or reason? Update
  `packages/shared/src/sync-health.ts` (enum + derivation), the copy maps in
  `apps/web/src/lib/syncHealth.ts`, the zod contract in `contracts.ts`, and
  the derivation matrix tests. Nothing else.
- Never derive operational states in the frontend or duplicate the policy
  constants — import `SYNC_HEALTH_POLICY`.
- Keep reason codes backed by real failure paths; no speculative codes.
