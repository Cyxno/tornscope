# Notifications

How TornScope's notification platform works: what can notify you, how that is
decided, and how to reason about every delivered, deferred, suppressed or
expired alert. The defining rule is the same as everywhere else in
TornScope: **never invent data, never spam, never silently lose an event**.

## 1. Canonical type registry

Every notification type TornScope can emit is declared exactly once in
`NOTIFICATION_TYPES` (`packages/shared/src/notifications.ts`). Producers,
preferences, quiet-hours policy, the Settings UI and the delivery history all
read semantics from this registry — there is no second place where
notification behavior is configured. Each entry declares:

| Field | Meaning |
|---|---|
| `id` | Stable id; the key stored in the user's preference toggles |
| `label` / `description` | Settings copy — every toggle explains itself |
| `group` | Settings grouping (Torn activity / Travel & timers / Energy & nerve / Account & progression / Economy / System) |
| `defaultEnabled` | Toggle default (noisy or inference-adjacent types default OFF) |
| `urgency` | `critical` / `time_sensitive` / `normal` / `low` (see §3) |
| `quietHours` | `defer` or `suppress` during quiet hours (see §4) |
| `maxDeferralAgeSeconds` | A deferred event older than this expires instead of delivering stale |
| `requires` | Capability key that must not be false for the type to work |
| `clickPath` | Where the notification click lands |
| `provenance` | How the underlying fact is known (`exact` / `derived` / `estimated` / `inferred`) |
| `config` | Inline per-type settings (thresholds, delivery time) |

Legacy preference maps (pre-registry category ids like `cooldowns`,
`hospital_jail`, `energy_nerve`) are normalized at read time by
`normalizeTypeToggles`: each legacy key fans out to the canonical types it
used to cover, explicit new values win, and the old dead `attention` key is
dropped (no producer ever emitted it).

## 2. Supported types

**Torn activity** (exact, from new Timeline rows): `mail`, `items`, `money`,
`trades`, `rentals`, `faction_oc` — classified by `classifyAttentionEvent`
from real stored Torn titles.

**Travel & timers** (exact, live-state transitions from one bounded Torn
`/user` fetch): `travel_arrival`, `hospital_release`, `jail_release`,
`drug_cooldown`, `medical_cooldown`, `booster_cooldown`,
`education_complete`, `bank_matured`, `nerve_full`.

**Energy & nerve** (exact, from fresh 5-minute `BarsSnapshot` data):
`energy_full`, `energy_near_full` (configurable `nearFullThreshold`).
Energy is owned by the bars producer — NOT the live-timer path — with
explicit re-arm hysteresis (fire once per crossing; re-arm only after the
bar drops `ENERGY_FULL_REARM` / `ENERGY_NEAR_REARM` below the threshold).
Nerve stays on the live-timer path: exactly one notification path per bar.
Stale snapshots (> `BARS_MAX_AGE_SECONDS` = 15 min) never drive alerts.

**Account & progression**: `daily_summary_ready` (configurable
`summaryTimeMin`, once per LOCAL day), `progression_milestone` (threshold
crossings with honest crossing windows — "passed 10M between 18:00 and
19:00" — permanently deduped by `progression:<stat>:<threshold>`),
`level_up` (once per level identity), `bank_matured`.

**Economy** (default OFF — thresholds, never spam): `major_cash_movement`
(configurable `cashThreshold`; per-event dedupe `cash:<source>:<sourceRef>`;
item-sale categories are worded as **asset sales — a conversion, not
earnings**), `networth_movement` (configurable `networthThreshold`; official
snapshot delta, explicitly **not a profit figure**; deltas across gaps > 48h
update the cursor silently instead of alarming).

**System**: `sync_degraded` (a resource needs ≥ `SYNC_DEGRADED_MIN_ERRORS`
consecutive failed runs; multiple failures coalesce into ONE grouped
notification — "3 data sources are no longer updating"), `sync_recovered`
(default OFF, once per recovered episode), `capability_lost` (critical —
see §6). System wording is jargon-free by construction
(`syncProblemCopy` / `capabilityLostCopy`): "money_logs worker stale_running"
never ships.

### Intentionally omitted types

- **Refill available** — Torn exposes no refill-availability state or
  cooldown; deriving it from counters would be guesswork.
- **Happy-jump preparation** — inference-based and inherently speculative;
  a wrong "start your jump now" is worse than no push. May return as an
  explicitly-labeled, opt-in, inference-gated type if product evidence
  supports it.
- **In-app notification center / bell** — deliberately not built: push plus
  the Settings delivery ledger cover the need without a second inbox to
  keep honest. The app shell has no dead bell chrome.

## 3. Urgency model

`critical` is reserved for TornScope's own delivery health
(`capability_lost`). Ordinary game events are `time_sensitive` (useful soon:
travel, cooldowns, energy), `normal` (deferrable: mail, milestones, summary,
economy) or `low` (informational, default OFF: sync recovery). Nothing
business-as-usual is critical, so nothing business-as-usual wakes you up
unless you enabled it and it is not quiet hours.

## 4. Quiet hours & deferral

Quiet hours are stored as minutes-since-local-midnight in the **user's
timezone** (`User.timezone`; overnight ranges like 22:30 → 07:30 supported;
`nextWallClockOccurrence` resolves the true end instant DST-safely).

The decision is centralized in `decideQuietHours`:

- **Outside quiet hours** → deliver immediately.
- **Inside quiet hours**:
  - `critical` + `bypassCritical` preference (default **true**) → deliver.
  - `critical` + bypass disabled → **suppressed**, reason `quiet_hours`.
  - `defer` types → the event is **parked, not dropped**: status `deferred`
    with `deliverAt` = quiet end and `expiresAt` = occurredAt +
    `maxDeferralAgeSeconds`.
- **Explicit user actions** (the test push) are never deferred — nothing
  about them can be stale.

When quiet hours end the worker flushes due deferred events. An event whose
`expiresAt` has passed is marked `expired` (reason `expired`) instead of
delivered — an "energy full" from 23:40 is useless at 07:30 and is never
sent as if new. Quiet hours no longer silently destroy events: everything
that happens to them is visible in the delivery history.

## 5. Dedupe, rate limits, coalescing

- **Profile-level**: `NotificationEvent.userId + dedupeKey` is UNIQUE — the
  same logical event can never exist twice, no matter how many devices,
  ticks, restarts or re-evaluations occur. Keys are deterministic per type
  (e.g. `travelLandsAt:ended:<end>`, `cash:<source>:<sourceRef>`,
  `progression:<stat>:<threshold>`, `daily-summary:<localDate>`), never
  message text.
- **Device-level**: `NotificationDelivery.subscriptionId + eventKey +
  notificationType` is UNIQUE — restarts and retries cannot double-push to
  one device.
- **State transitions, not polling**: producers fire on crossings
  (active → ready, below → above threshold, healthy → failed, armed →
  triggered) with first-observation suppression (a producer's first run for
  a profile initializes its `NotificationState.systemState` slice silently —
  linking a profile or restarting the worker never floods).
- **Coalescing**: simultaneous sync failures become one grouped
  notification; new failures later join as a fresh episode.
- **Age guards**: source events older than `SOURCE_MAX_AGE_SECONDS` (6h) or
  the activation boundary (`enabledAt`) are never notified; imported history
  can never present itself as new.

## 6. Capability loss semantics

Access loss (`capability_denied` / `access_denied` / `key_invalid` /
`key_paused`) is CRITICAL urgency and worded honestly: "…stopped syncing.
Your existing history is **retained**; new data is no longer collected."
It is never called "sync failed", it bypasses quiet hours only when the user
allows critical bypass, and it fires once per loss episode per resource set.

## 7. Delivery lifecycle & reasons

Event statuses: `pending` → `deferred` / `delivered` / `failed` /
`suppressed` / `expired`. Delivery statuses: `pending` → `sent` / `failed`
(bounded retry) / `invalid_subscription`. "sent" means the push service
**accepted** the payload — browser-level display is never claimed.

Machine reasons (`DELIVERY_REASONS`) with friendly labels
(`DELIVERY_REASON_LABELS`): `quiet_hours`, `disabled_by_user`,
`missing_capability`, `insufficient_confidence`, `duplicate`, `rate_limited`,
`expired`, `demo_suppressed`, `invalid_subscription`, `device_disabled`,
`stale_event`, `unsupported_browser`. A type disabled by the user records
nothing (the user decided); every other non-delivery is recorded with its
reason and is visible in Settings → Recent deliveries with a per-row
disclosure (body, provenance, per-device outcomes).

## 8. Retry & invalid subscriptions

Transient push failures retry with bounded backoff
(`RETRY_BACKOFF_MINUTES` = 5 / 25 / 125 minutes, attempts capped). 404/410
responses revoke the subscription immediately (status
`invalid_subscription`), stop all retries, and the dead endpoint is purged
by maintenance after 30 days. Endpoints failing the structural guard
(`checkPushEndpoint`: HTTPS-only, port 443, no credentials, private-range
literal IPs and internal hostnames) are revoked, never POSTed. At subscribe
time the guard is defense-in-depth: structural validation **plus** a DNS
resolution check (`assertPublicEndpoint`) that refuses endpoints resolving
to non-public addresses.

## 9. Privacy model

- Payloads carry title/body/click-target only — no API keys, no raw Torn
  payloads, no internal diagnostics, no identifiers beyond the tag used for
  browser-side grouping.
- `sensitiveDetails` (default OFF) controls whether bodies may contain
  amounts/senders/item names; default bodies stay generic on lock screens.
- The delivery history never exposes endpoint URLs; devices render as
  coarse user-agent labels.
- Multi-user: every query is userId-scoped; a subscription is re-bound to
  the session that proves ownership; the shared demo profile accepts no
  mutations.

## 10. Demo mode

Demo profiles are never evaluated by the notification worker and the global
demo guard blocks all notification mutations, so a demo session can never
emit a real push. The demo seed writes a small synthetic ledger (delivered,
expired, suppressed, test) to a pair of clearly-labeled demo devices so the
Settings UI can be explored safely.

## 11. API

- `GET /api/notifications` — status: devices + resolved preferences
  (toggles normalized to canonical type ids, `bypassCritical`, `typeConfig`
  resolved with defaults).
- `POST /api/notifications/preferences` — partial update: toggles,
  sensitiveDetails, quiet hours, `bypassCritical`, `typeConfig`
  (`TypeConfigSchema`-validated, merged over stored values).
- `GET /api/notifications/history` — the 50 most recent logical events with
  per-device delivery outcomes (user-scoped).
- `POST /api/notifications/subscribe` / `unsubscribe` /
  `disable-device` — device lifecycle (rate-limited: 20/10min per IP).
- `POST /api/notifications/test` — real pipeline, this device only,
  5/min per user, labeled "TornScope test", recorded in the ledger.
- `GET /api/notifications/vapid-public-key` — browser subscription bootstrap.

## 12. Device model

Preferences (toggles, thresholds, quiet hours) are **profile-level**; push
enablement and subscriptions are **device-level**. One logical event = one
event row; delivery = one attempt per active subscribed device. The Settings
device list shows each registration (coarse label, created date) and allows
revoking any of them; the current browser identifies itself by its endpoint.

## 13. Service worker

`apps/web/static/sw.js` handles `push` (JSON payload with graceful
fallback, icon/badge, renotify) and `notificationclick` (focus an existing
TornScope tab and navigate to the payload's `url`, else open a new window).
The click target comes only from the payload TornScope composed — no
arbitrary URL injection surface. There is deliberately no offline cache.

## 14. Retention & observability

Maintenance (daily, canonical scheduler/maintenance path) purges delivery
ledger rows and revoked subscriptions after 30 days and logical events after
90 days. Observability is aggregate-only: the worker logs a per-tick summary
(users evaluated, failures); no private payload browsing exists anywhere.

## 15. Known limitations

- Push delivery proves acceptance by the push service, not display on a
  lock screen (Web Push has no read receipts).
- Rate limiting is in-memory per process (single-node deployment); the
  documented horizontal-scaling caveat applies.
- The worker evaluates stored data at most every 120s — "energy full" can
  lag a bars snapshot by up to ~2 minutes plus collection cadence.
- Nerve notifications still require the live-timer fetch (nerve is not in
  stored bar snapshots).
- The current-device identification query parameter (endpoint in the GET
  URL) is a known trade-off documented in the audit; it never appears in
  logs or the ledger.
- Demo devices point at an unresolvable `.example` host by design; they
  never receive anything.
