# Proactive Alerts (2.9.0 engine, 2.10.0 catalog)

Alert rules, a Discord webhook channel and an in-app inbox — a second,
user-CONFIGURABLE alert surface next to the push notification engine
(docs/NOTIFICATIONS.md), which stays the fixed-registry, browser-push system.

## Architecture

```
scheduler tick (60s, existing worker)
  → evaluateAlerts()            apps/worker/src/alerts/engine.ts
      accounts with enabled rules (demo profiles NEVER evaluated)
      → build state ONCE per account
          - live Torn observation (one /user call, shared cadence with the
            push engine, gated by in-memory next-eligible timestamps)
          - stored data (OCs, net-worth snapshots, sync states, goals,
            drug events, bars/stat snapshots)
      → per-rule evaluator (pure, packages/shared/src/alerts.ts)
      → commitAlert(): cooldown + quiet-hours policy, ONE transaction per
        logical alert → AlertDelivery (in-app inbox row AND the logical
        alert; (userId, dedupeKey) unique = idempotency) + one
        AlertChannelDelivery per enabled channel (pending)
  → dispatchDueAlertDeliveries()  apps/worker/src/alerts/dispatch.ts
      Discord POST outside the transaction; bounded retries with backoff;
      rate-limits honor Discord's retry_after
```

`ALERTS_ENABLED=false` stops evaluation and dispatch without touching the
sync pipeline; existing pending deliveries are retained, never deleted.

A **snoozed** rule (`AlertRule.snoozedUntil`, set from the inbox per trigger
type) is skipped by the evaluator entirely: its working state is not
advanced and nothing fires until the snooze expires. Snoozing never loses
a transition — the state machines below re-baseline or resume honestly.

## Trigger semantics (evaluator contract)

Every evaluator is a pure function in `packages/shared/src/alerts.ts`; the
worker only wires persisted state. Rules store their evaluator working state
in `AlertRule.lastState` (previous observation + episode markers).

- **First observation = baseline.** A newly created/enabled rule NEVER fires
  for conditions that were already true (spec 7.3).
- **Stale gap → re-baseline.** If the previous observation is older than the
  trigger's gap bound (12h), no transition is fabricated across it. This
  covers extended downtime, failed syncs and imported history.
- **Failed observation → baseline untouched.** A failed live Torn fetch keeps
  the previous `lastState`; nothing advances and nothing fires.
- **State-transition triggers** (`cooldown_ready`, `education_done`,
  `bank_matured`, `travel_landed`): fire when the timer was STILL ACTIVE at
  the previous observation and is ready now (with a 120s grace). An
  already-expired timer never fires retroactively. `cooldown_ready` selects
  its kinds via config `{"cooldowns":["drug","booster","medical"]}`.
- **`oc_ready`**: fires for the user's OCs whose `readyAt` passed strictly
  AFTER the previous observation (a genuine became-available transition, never
  a backlog).

## Incident / episode model (formal, 2.10.0)

The catalog declares a **dedupe scope** per trigger. Scopes are implemented
by the dedupeKey shape plus the working state in `AlertRule.lastState`; the
(userId, dedupeKey) unique constraint makes every replay idempotent.

- **Incident** — one alert per distinct real-world event. Identity = the
  event's own timestamp/end (`banksoon:<maturityEnd>`, `oc:<id>` readiness,
  `odspike:<overdoseTs>`). The same event never alerts twice, even across
  worker restarts (`sync_*` uses the incident stamp, audit F1).
- **Episode** — one alert while a condition stays open; it re-arms only
  after a documented close. Identity = the episode anchor (a baseline
  snapshot id for the drawdown/drop triggers, the cluster start for
  `rehab_advice`, the comparison snapshot for `training_stagnation`).
  **Episode closing** is deliberately conservative: only a valid comparison
  showing recovery closes it (value back above the threshold, an observed
  stat gain, a clean window). Data-quality failures (missing/stale
  snapshots, sync outage) keep the episode open — fresh data returning must
  never re-alert the same decline (audit F2).
- **Per-day** — at most one alert per calendar day (`bar_capped`), tracked
  by UTC day key in `lastState.cappedFiredDay`.

The **delivery ledger explains every outcome**: `suppressed` = quiet hours
(with the window in the row), `failed` = bounded retries exhausted (with the
error category), `pending` = queued/external still in flight, `sent` =
delivered in-app. Nothing is ever silently dropped.

## Trigger catalog (2.10.0)

Every trigger: category, severity, dedupe scope, confidence label of the
fact it claims, default-enabled suggestion. Config keys are validated by
Zod on create AND update; defaults fill after validation.

| Trigger | Category | Severity | Scope | Confidence | Default | Source data |
|---|---|---|---|---|---|---|
| `cooldown_ready` | health | info | per-incident | exact | on | live timers |
| `oc_ready` | combat | info | per-incident | exact | on | OrganizedCrime |
| `education_done` | progression | info | per-incident | exact | on | live timers |
| `bank_matured` | economy | info | per-incident | exact | on | live timers |
| `travel_landed` | travel | info | per-incident | exact | on | live timers |
| `net_worth_drop` | economy | warning | per-episode | exact | on | NetworthSnapshot |
| `sync_failure` / `sync_recovery` | operational | warning / info | per-incident | exact | on | SyncState |
| `networth_drawdown` | economy | warning | per-episode | exact | on | NetworthSnapshot, 7d baseline |
| `bar_capped` | health | info | per-day | exact | off | live fullAt / BarsSnapshot (happy) |
| `bank_maturity_soon` | economy | info | per-incident | exact | on | live timers |
| `oc_almost_ready` | combat | info | per-incident | exact | on | OrganizedCrime |
| `goal_milestone` | progression | info | per-episode | derived | on | Goal + latest stored value |
| `rehab_advice` | health | warning | per-episode | **inferred** | on | DrugEvent volume proxy |
| `drug_overdose_spike` | health | critical | per-incident | exact | on | DrugEvent vs personal baseline |
| `training_stagnation` | progression | info | per-episode | derived | off | PersonalStatSnapshot |

Notes on honest semantics:

- **`rehab_advice`** — Torn publishes no addiction meter. The trigger counts
  stored drug events inside a window and is labeled *inferred*; the alert
  copy says it is a volume proxy, not a medical reading.
- **`drug_overdose_spike`** — the absolute count alone never justifies the
  word "spike". The window volume must EXCEED double the personal baseline
  rate (overdoses/day across `baseline_days` before the window). Without a
  usable baseline (< 3 events) no spike is claimed at all.
- **`training_stagnation`** — hourly snapshot deltas cannot separate gym
  gains from job/company stat points; the alert copy says so. "No gain over
  N days" — individual training sessions are not stored, so the trigger
  compares stored snapshot totals, never a fabricated session count.
- **Imminent triggers** (`bank_maturity_soon`, `oc_almost_ready`) alert on
  the current state crossing a horizon, not on an edge — so there is no
  first-observation baseline deferral (a rule created 2h before a maturity
  must still warn). Idempotency comes from the per-event endSec dedupe.
- **Episode namespace isolation** — `net_worth_drop` and `networth_drawdown`
  share the comparison logic but use distinct episode prefixes (`nwdrop:` /
  `nwdrawdown:`): the same baseline must never let one trigger suppress the
  other's episode.
- **Not in the catalog: `stocks_benefit`.** TornScope deliberately stores no
  stock-holdings history (docs/STOCKS.md), so no honest deterministic
  implementation exists. It ships when a holdings snapshot exists — never as
  a live-API claim.

## Provenance and the "—" convention

Every draft carries a provenance object, persisted on `AlertDelivery.provenance`:

- `confidence` — `exact` (Torn-provided verbatim), `derived` (computed from
  exact data), `estimated` (bounded internal estimate), `inferred`
  (indirect proxy — the alert copy must say so).
- `sources` — the stored resources the evaluation read (e.g.
  `NetworthSnapshot`, `DrugEvent`, `SyncState`). Never live-API optimization
  claims: alerts derive from stored history.
- `window` — the observed period (unix seconds) when the alert has one.
- `note` — honest caveats shown verbatim in the UI.

Unavailable data renders **"—", never 0**. Zero/negative baselines are never
interpreted as a 100% loss; a missing comparison renders unavailable, not
zero gain. The parameterized test in `packages/shared/tests/alerts-2.10.test.ts`
pins this guarantee across the whole catalog.

## Adding a new trigger

1. Add the id to `ALERT_TRIGGER_IDS` and a config schema (Zod, `.strict()`)
   in `packages/shared/src/alerts.ts`; register the meta (category, severity,
   dedupeScope, confidenceLabel, defaultEnabled, clickPath, gap bound).
2. Implement the evaluator as a pure function there — explicit inputs, a
   machine-readable `reason` for every non-eligible path, and the
   first-observation / stale-gap / failed-observation contract.
3. Wire the worker case in `apps/worker/src/alerts/engine.ts`: lazy stored
   inputs shared per account, a state slice in `AlertRule.lastState` for the
   dedupe/episode identity, and a mandatory provenance object on the draft.
4. Add tests: happy path, every `reason` path, the dedupe scope (replay must
   be idempotent), and a fake-zero case.
5. Extend the catalog table above and the registry contract test.

## Delivery policy

- **Cooldowns** are per rule (`cooldownMinutes`): repeats are blocked; a NEW
  episode after expiry fires again. `lastFiredAt` updates only when a delivery
  is actually committed — never on mere evaluation, never for suppressed ones.
- **Quiet hours** are per rule, `{"start":"23:00","end":"07:00","tz":"Europe/Amsterdam"}`
  (IANA zone, DST-safe, midnight-crossing; start == end = full-day quiet).
  Inside the window the alert is SUPPRESSED WITH A RECORD (status
  `suppressed` in the inbox), never silently discarded.
- **Snooze** (`AlertRule.snoozedUntil`, from the inbox per trigger type)
  pauses evaluation of that rule without touching its state.
- **In-app inbox**: one row per logical alert. External Discord states are
  separate rows (`AlertChannelDelivery`) shown per channel.
- **Discord delivery**: webhook URLs are validated structurally (HTTPS, only
  official Discord webhook hosts, exact path shape — SSRF guard), encrypted
  at rest (AES-256-GCM, same master key as Torn API keys), never returned by
  the API (masked preview only) and never logged. Redirects are refused.
  Transient failures retry with exponential backoff + jitter (bounded 6h);
  rate limits honor Discord's `retry_after`. After
  `ALERT_DELIVERY_MAX_RETRIES` the row is marked `failed` WITH its error
  category — the logical alert stays in the inbox.
- **Test notification** (`POST /api/alerts/channels/:id/test`): the same
  sender, clearly labeled as a test, no rule state or cooldown touched;
  `verifiedAt` updates only after Discord accepted.

## UI surfaces

- `/alerts` lives under **Intelligence** (2.10.0 nav move): inbox with
  category/severity filters, acknowledge (read), snooze per trigger type, a
  per-trigger activity timeline, and a provenance panel per alert.
- Command Center feed: unread alerts enter the attention feed with the
  highest precedence (alert > cooldown > goal-milestone > insight, then the
  existing priority/deadline ordering).

## Delivery guarantees and scaling limits (accepted)

- **Discord delivery is AT-LEAST-ONCE, not exactly-once.** The Discord HTTP
  request happens outside the database transaction: if the worker crashes
  between Discord accepting a message (2xx) and the `sent` status write, the
  row stays `pending` and the next dispatch pass sends the message again.
  Webhooks carry no idempotency key, so this cannot be fully excluded at the
  source. The database-level dedupe (one logical alert per episode) is
  unaffected.
- **Dispatch assumes ONE active worker.** The dispatch pass has no row claim
  (no `FOR UPDATE SKIP LOCKED` / status transition). This is safe with the
  shipped single-worker Compose topology (BullMQ scheduler concurrency 1);
  running MULTIPLE worker containers concurrently would let two passes
  process the same pending row and duplicate sends. Add a claim step before
  scaling the worker horizontally.
- A disabled Discord channel pauses its queued deliveries (rows stay
  `pending` and resume when the channel is re-enabled); deleting the channel
  cascades its delivery rows. A webhook whose stored ciphertext cannot be
  decrypted under the configured key is marked `failed` with error kind
  `unreadable_target` — remove and re-add the channel. An invalid
  `API_KEY_ENCRYPTION_KEY` aborts the dispatch pass with a single error; its
  pending rows are retained and resume once the key is fixed.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALERTS_ENABLED` | `true` | Master switch; `false` stops evaluation + dispatch, sync unaffected |
| `DISCORD_WEBHOOK_TIMEOUT_MS` | `8000` | Webhook HTTP timeout (clamped 1000–30000) |
| `ALERT_DELIVERY_MAX_RETRIES` | `5` | Transient-failure retries per delivery (clamped 0–10) before the row is marked failed |

## Demo mode

The demo seed creates demo alert rules, one fake-target Discord channel and
inbox rows (mixed statuses). The engine never evaluates demo profiles, so
demo data can never produce a real Discord request.

## Version note

The engine landed in **2.9.0** (MVP + audit fixes F1–F4); the catalog,
provenance, episodes documentation and UI integration land in **2.10.0**.
Per the release checklist, the version bump itself happens in the
release-engineering commit ("version bump + changelog"), not in the feature
commit.
