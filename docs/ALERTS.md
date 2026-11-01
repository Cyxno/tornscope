# Proactive Alerts (2.9.0)

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
          - stored data (OCs, net-worth snapshots, sync states)
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

## Trigger semantics (evaluator contract)

Every evaluator is a pure function in `packages/shared/src/alerts.ts`; the
worker only wires persisted state. Rules store their evaluator working state
in `AlertRule.lastState` (previous observation + episode markers).

- **First observation = baseline.** A newly created/enabled rule NEVER fires
  for conditions that were already true (spec 7.3).
- **Stale gap → re-baseline.** If the previous observation is older than the
  trigger's gap bound (12h for the MVP), no transition is fabricated across
  it. This covers extended downtime, failed syncs and imported history.
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
- **`net_worth_drop`** `{"pct":5,"window_hours":24}`: compares the persisted
  `NetworthSnapshot` closest to the window boundary (accepted within a 3h
  tolerance — snapshots do not land exactly on boundaries) against the latest
  snapshot (rejected as stale beyond 12h). Zero/negative/missing baselines are
  never interpreted as a loss. One firing per baseline episode; re-arms only
  after recovery above the threshold or a new baseline.
- **`sync_failure` / `sync_recovery`**: grouped operational alerts from the
  SAME failing-set definition as the push system producer (status=failed with
  ≥2 consecutive errors, capability denials excluded). Only the SET DIFFERENCE
  versus the previous observation alerts — pre-existing failures stay silent.

## Delivery policy

- **Cooldowns** are per rule (`cooldownMinutes`): repeats are blocked; a NEW
  episode after expiry fires again. `lastFiredAt` updates only when a delivery
  is actually committed — never on mere evaluation, never for suppressed ones.
- **Quiet hours** are per rule, `{"start":"23:00","end":"07:00","tz":"Europe/Amsterdam"}`
  (IANA zone, DST-safe, midnight-crossing; start == end = full-day quiet).
  Inside the window the alert is SUPPRESSED WITH A RECORD (status
  `suppressed` in the inbox), never silently discarded.
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

## Delivery guarantees and scaling limits (accepted for the MVP)

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
~9 inbox rows (mixed statuses). The engine never evaluates demo profiles, so
demo data can never produce a real Discord request.

## Version note

This feature lands as the **2.9.0** candidate: semantically a minor feature
release (new user-facing subsystem + additive migration). Per the release
checklist, the version bump itself happens in the release-engineering commit
("version bump + changelog"), not in the feature commit.
