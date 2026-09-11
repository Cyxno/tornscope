# Roadmap — v0.2.0 "Public Beta 2"

- **Planned version:** 0.2.0 (Public Beta 2)
- **Status:** Under Development (branch: [`develop`](../tree/develop), deployed to the private dev/staging environment — see [ENVIRONMENTS.md](ENVIRONMENTS.md))
- **Scope note:** scope may change during beta testing; items move between sections or get deferred as real usage teaches us more. No speculative features outside this list.

## Release goal

Make the numbers trustworthy and the day legible.

v0.1.x answers "what happened" with raw history. v0.2.0 answers two more
questions: **how complete is this data?** (confidence/coverage) and
**how did today go?** (Daily Summary). Everything else in this roadmap serves
one of those two, or keeps the release safe to ship (sync reliability,
migration safety).

## Scope

- In: data confidence layer, Daily Summary, sync reliability, onboarding/capability clarity, safe v0.2 database upgrade, and the Should/Nice items below.
- Out of scope for 0.2.0: new data sources beyond the Torn API, multi-user accounts/permissions, public API, mobile apps, non-Torn games.

---

## MUST HAVE

### 1. Data confidence / coverage layer — *issue: `feat(v0.2): data confidence & coverage layer`* · labels: `v0.2` `analytics` `enhancement`

**Status: Complete (foundation).** Shared confidence states, provenance, central
derivation, coverage + last-refreshed metadata, capability-loss retention and
the zero-vs-unavailable contract are implemented and deployed to the dev stack
— see [DATA-CONFIDENCE.md](DATA-CONFIDENCE.md). Every resource carries
confidence via Sync Status; Overview, Economy and Sync Status carry it in the
UI; the remaining analytics pages adopt the model incrementally as part of #2
(Daily Summary builds directly on it) and #10.

Per resource and per page, always show how complete and how fresh the data is:
`complete` / `partial` / `stale_permission` / `unavailable`, a last-refreshed
timestamp, visible historical gaps, and a clear distinction between confirmed,
estimated and unavailable values. **Unavailable data must never render as zero.**

Acceptance criteria:
- [x] Every analytics page and resource carries a status + last-refreshed indicator. *(every resource via Sync Status; Overview/Economy/Sync in the UI — remaining pages adopt with #2/#10)*
- [x] Historical gaps are visibly marked, not silently interpolated.
- [x] Estimated values are labeled as estimated; unavailable values are labeled, never shown as 0.
- [x] `stale_permission` is distinguishable from a sync failure (e.g. key lost access vs job broke).

### 2. Daily Summary — *issue: `feat(v0.2): daily summary page`* · labels: `v0.2` `analytics` `enhancement`

**Status: Complete.** Implemented on `develop`, deployed to the dev stack —
see [DAILY-SUMMARY.md](DAILY-SUMMARY.md).

One page answering "how did today go": daily earned, daily spent, asset
conversions, net worth delta, estimated travel profit, drug consumption and
value, major account events — with an explanation of important net-worth
changes where possible. Depends on the confidence layer (1) for labeling.

Acceptance criteria:
- [x] All listed metrics render for a day (with correct empty states).
- [x] Net-worth deltas explain major drivers where the data allows.
- [x] Estimated components (travel profit) are labeled estimated; conversions are not double-counted as income/expense.
- [x] Works for Limited-capability profiles with graceful degradation (see 4).

### 3. Sync reliability — *issue: `feat(v0.2): sync reliability, recovery & incident visibility`* · labels: `v0.2` `reliability`

**Status: Complete.** Implemented on `develop`, deployed to the dev stack —
see [SYNC-RELIABILITY.md](SYNC-RELIABILITY.md). Central operational health
model (caught_up/running/backfilling/delayed/retrying/degraded/failed/parked/
stale_running/never_run), heartbeat-based stale detection with automatic
orphan recovery, visible retry/backoff reasons, derived incident history and
a safe per-resource "Retry now" — all deliberately separate from data
confidence.

No resource may remain silently "Syncing". Stale job recovery across all
resources, visible retry/backoff state, degraded/delayed/stale sync states,
and per-resource incident/history visibility.

Acceptance criteria:
- [x] A stuck resource is detected (heartbeat-based) and recovered or surfaced as failed — never stuck in "running" forever. *(proven by a dev-stack chaos test: worker killed mid-run → `stale_running` surfaced → scheduler recovered it, cursor/history intact)*
- [x] Retry/backoff state is visible in the sync UI. *(retrying/failed states with machine reason + retry time/overdue, e.g. "timed out · retry in 1m")*
- [x] Sync states include degraded/delayed/stale, not just running/ok/failed.
- [x] Per-resource incident history is viewable without server access. *(recent-issues expander on Sync Status: "Recovered stale worker run · worker interrupted · auto-recovered" + 24h metrics)*

### 4. Onboarding / capabilities improvements — *issue: `feat(v0.2): onboarding & key capability clarity`* · labels: `v0.2` `enhancement` `ux`

**Status: Complete.** Implemented on `develop`, deployed to the dev stack.
The welcome flow shows a feature-by-feature Limited-vs-Full consequence
matrix generated from `FEATURE_REQUIREMENTS` before any key is entered, plus
an honest historical-loss warning ("log-window history not collected before
it ages out can never be recovered; upgrading later does not guarantee a
full backfill") with a per-resource "What can be recovered later?"
disclosure. Validation detects custom capability sets and names them; the
initial sync reports real per-resource stages with a staged summary
("N of M resources ready") and progressive readiness into the app; Settings
shows the capability mode, at-a-glance availability counts and a per-feature
missing-permission matrix. Key replacement previews capability gain/loss
before storing anything.

Acceptance criteria:
- [x] Capability selection explains per-feature consequences before the user picks.
- [x] Settings shows which features the current key enables.
- [x] Initial sync shows real progress per resource (ties into 3).
- [x] Choosing Limited (or a partial key) warns clearly that the skipped history cannot be recovered later.

### 5. v0.2 database upgrade safety — *issue: `chore(v0.2): database upgrade safety for 0.2.x`* · labels: `v0.2` `database`

**Status: Complete.** The entire production 0.1.x → 0.2.0 schema delta is one
expand-only migration (`20260909130000_sync_state_last_error_kind` — nullable
`SyncState.lastErrorKind`, no data touched), verified against a restored copy
of the real production database on 2026-09-10: migrations apply cleanly, a
second `migrate deploy` is a no-op, and no table lost rows (only the
`_prisma_migrations` bookkeeping row is added). Clean install from an empty
database passes, `prisma validate` passes, and the upgraded copy serves
DB+Redis "ok" to the API. The rehearsal script now enforces idempotence and
prints a PASS verdict; `packages/database/tests/migration-safety.test.ts`
guards the classification (future destructive migrations must be allow-listed
with a compatibility plan or the suite fails). See
[DATABASE-MIGRATIONS.md](DATABASE-MIGRATIONS.md) and
[V0.2-UPGRADE-CHECKLIST.md](V0.2-UPGRADE-CHECKLIST.md).

Acceptance criteria:
- [x] Every 0.2 schema change has a committed migration; no manual schema edits.
- [x] `scripts/rehearse-prod-upgrade.sh --from-prod` passes on a recent production backup.
- [x] Upgrade from the current 0.1.x production DB and clean install both succeed.
- [x] No migration drops/renames data without a documented compatibility path.

---

## SHOULD HAVE

### 6. Economy analytics improvements — *issue: `feat(v0.2): economy analytics refinements`* · labels: `v0.2` `analytics`

**Status: Complete.** Implemented on `develop`, deployed to the dev stack —
see [ECONOMY-ANALYTICS.md](ECONOMY-ANALYTICS.md).

Stronger cashflow vs asset-conversion distinction, better wallet
reconciliation, better "why did my net worth move?" analysis, clearer
confirmed-vs-estimated values. Related: 1, 2.

Acceptance criteria:
- [x] Cash movement, asset conversions, economic effect and net worth are first-class, separate lenses (related, never additive).
- [x] Bank principal/interest semantics: interest is derived from invest/withdraw pairs; principal return is never income; unattributable splits degrade availability instead of fabricating.
- [x] Bazaar/item sales are cash inflow + conversion — profit is never fabricated; value differences are labeled estimated.
- [x] Purchases (items, stocks, points, bank deposits) are conversions, never automatic expenses (consumptive classifications excepted: gym, rehab, upkeep, rent).
- [x] Wallet reconciliation with opening/recorded/expected/actual/residual and quality grades (exact / small_residual / partial / unreconciled / unavailable); residual always surfaced.
- [x] Net worth explanation: official category deltas as recorded drivers, estimated contributors labeled, unexplained residual reported; NW delta never called profit.
- [x] Confirmed vs estimated is clear (provenance + confidence on every major section); unavailable never becomes zero.
- [x] Major movement detection across all semantic roles with adaptive thresholds.
- [x] `/api/economy` is one coherent batched payload (no N+1); demo and Limited profiles supported.
- [x] Economy UI redesigned as a lens workspace (editorial summary, four lenses, reconciliation rail); mobile/tablet/desktop verified, keyboard-accessible lens switcher.
- [x] Full test matrix (39 new tests; 864 total pass) and docs.

### 7. Notification improvements — *issue: `feat(v0.2): notification settings & delivery improvements`* · labels: `v0.2` `notifications` `enhancement`

**Status: Complete.** Implemented on `develop`, deployed to the dev stack —
see [NOTIFICATIONS.md](NOTIFICATIONS.md).

The notification platform was rebuilt around a canonical type registry with
an explicit urgency model, honest quiet hours, and a delivery ledger that
explains itself:

- Canonical registry: every type declared once (id, urgency, quiet-hours
  behavior, deferral expiry, capability requirement, provenance, dedupe
  strategy, inline config); legacy preference keys normalized transparently;
  the dead `attention` toggle removed.
- Quiet hours (user timezone, DST-safe, overnight windows) now DEFER
  non-critical notifications instead of silently dropping them; deferred
  events expire when they would be stale rather than delivering useless
  morning alerts; critical is reserved for TornScope's own access-loss
  alert with a user-controlled bypass.
- Dedupe at two levels (profile-level logical event + per-device ledger
  unique constraints), state-transition producers with first-observation
  suppression and age guards, grouped sync-failure notifications, and
  bounded retry with backoff; 404/410 revoke invalid subscriptions.
- New producers: energy full/near-full (fresh bars snapshots, re-arm
  hysteresis), sync degraded/recovered, capability lost, progression
  milestones (crossing-window wording), level ups, daily summary ready,
  major cash movement and net-worth movement (threshold-configurable,
  conversion-safe wording). Refill-available and happy-jump pushes were
  audited and intentionally omitted (see docs).
- Settings rebuilt as grouped per-type toggles with inline thresholds,
  quiet-hours policy UI, device management, a rate-labeled test push, and
  a delivery history ledger with machine reasons in friendly language.
- Additive migration only (documented in DATABASE-MIGRATIONS.md); demo mode
  shows a synthetic ledger and can never emit a real push.

- [x] Source/behavior audit preceded implementation (engine, ledger, SW, security)
- [x] Canonical registry; no scatter; no dead toggles
- [x] Quiet hours respect User.timezone; noncritical queue + expiry proven
- [x] Dedupe/rate-limit/multi-device matrices green (engine suite, 28 tests)
- [x] Delivery history + suppression/deferral reasons user-visible
- [x] Test notification (rate-limited, device-scoped, ledger-recorded)
- [x] Invalid-subscription cleanup + bounded retries verified
- [x] Privacy: no endpoints/keys in payloads, ledger, or history; isolation tested
- [x] Capability/confidence gating; Limited keys degrade per type
- [x] Demo-safe; additive migration documented; full gates green

### 8. Hosted-instance hardening — *issue: `chore(v0.2): hosted-instance abuse & health hardening`* · labels: `v0.2` `security`

**Status: Complete.** Implemented on `develop`, deployed to the dev stack —
see [HOSTED-SECURITY.md](HOSTED-SECURITY.md) and
[HOSTED-DEPLOYMENT.md](HOSTED-DEPLOYMENT.md).

Full public-beta hardening pass: threat model documented; external attack
surface audited route-by-route (zero IDOR found — identity is always
session-derived); rate-limit denials unified to 429 + Retry-After (were
400); unmetered writes bounded (demo-view, sync actions, notification
writes); heavy analytics given hard row caps (economy/money/progression);
custom epochs bounded (absurd ranges are clean 400s); free-text filters and
ids length-capped; per-profile session cap + env-tunable hosted limits;
push-endpoint URLs stripped from access logs; `cache-control: private,
no-store` + `x-request-id` on every API response (proxy-forwarded); abuse
engagements logged (aggregate, throttled); app containers sandboxed
(no-new-privileges, cap-drop ALL, read-only rootfs, tmpfs /tmp);
`User.role` default fails safe; dependency audit assessed (1 high confined
to the Prisma CLI migrate container); 9-test security regression matrix
added alongside the existing suites.

- [x] Threat model + attack surface inventory documented
- [x] Expensive endpoints bounded and rate-limited; 429 signaling proven
- [x] Session/profile/device limits implemented and tested
- [x] CSRF/origin/CORS/trust-proxy verified with regression coverage
- [x] Isolation matrix green; secrets/redaction audit clean
- [x] Private API cache isolation + security headers asserted
- [x] Compose sandboxing consistent across all three variants
- [x] Hosted docs shipped; production untouched


justified, operational health visibility without exposing user data.

### 9. Release/dev workflow hardening — *issue: `chore(v0.2): release & dev workflow hardening`* · labels: `v0.2` `enhancement`
CI requirements on main/develop, a release checklist, a migration rehearsal
checklist, backup/restore verification, and a single source of truth for the
displayed version/environment (builds on the existing `PUBLIC_ENV_LABEL`
marker — see [ENVIRONMENTS.md](ENVIRONMENTS.md)).

---

## NICE TO HAVE

### 10. UX polish — *issue: `feat(v0.2): UX consistency & state polish`* · labels: `v0.2` `ux`

**Status: Complete (v0.2 UI overhaul + true redesign pass).** Implemented on
`develop`, deployed to the dev stack — see [UI-DESIGN.md](UI-DESIGN.md). The
interface was redesigned as a coherent v0.2 visual system ("precision calm"):
centralized design tokens, grouped adaptive navigation, one panel/page-header
system, structure-matched loading skeletons, disclosure-based methodology
copy, a unified chart theme and table language, and verified responsive
behavior from 320px to 1920px. A second "true redesign" pass then replaced
the residual v0.1 dashboard feel: desktop navigation moved to a persistent
left rail (context bar + bottom tab bar below desktop), pages were recomposed
as open-canvas sections with editorial hero numerals and diverging signed
bars instead of grids of equal cards, each major route received its own
composition (see [REDESIGN-CONCEPT-v0.2.md](REDESIGN-CONCEPT-v0.2.md) and
UI-DESIGN.md "Page compositions"), and the responsive sweep was re-verified
across 12 routes × 16 widths.

- [x] Loading/empty/error states coherent and structure-matched
- [x] Consistency pass across analytics cards/tables/charts
- [x] Mobile/tablet layout passes (320–430 / 768–1024 verified per route)
- [x] Clearer provenance/confidence presentation without badge overload

### 11. Operator health overview — *issue: `feat(v0.2): operator health overview`* · labels: `v0.2` `enhancement` `reliability`
Infrastructure/sync health only — aggregate operational metrics; no ability
to browse private user analytics.

### 12. Progression & Energy Intelligence — *issue: `feat(v0.2): progression & energy intelligence`* · labels: `v0.2` `analytics`

**Status: Complete (foundation).** Implemented on `develop`, deployed to the
dev stack — see [PROGRESSION-ENERGY.md](PROGRESSION-ENERGY.md).

Turns the `/progression` placeholder into a first-class analytics area:
battlestat progression from the hourly personal-stats snapshots, energy
flow from a new 5-minute bars snapshot resource, conservatively inferred
training sessions, gym gain efficiency against personal baselines, and
transparent happy-jump inference with full evidence disclosure.

Scope:
- battlestat progression (exact hourly observations, derived deltas, milestones)
- energy attribution (exact refill gains, derived natural regeneration, estimated Xanax, unattributed spend first-class)
- training-session analytics (inferred; energy declines + stat gains, competing evidence excluded)
- gym gain efficiency (gain per energy only where both sides are supportable)
- happy-jump analysis (deterministic signal scoring; likely/possible, never "confirmed")

- [x] Source capability audit preceded implementation; no unsupported metric presented as exact
- [x] Energy ledger with cap-aware regeneration and surfaced residuals
- [x] Training sessions carry inference strength, separate from data confidence
- [x] Happy-jump evidence and missing-evidence lists exposed in the UI
- [x] Capability matrix + Settings consequences updated; Limited keys degrade per section
- [x] Daily Summary training strip + single Overview row; demo data fully coherent
- [x] Full test matrix (analytics + DB-backed + isolation + timezone) green

---

## Release blockers — v0.2.0 does NOT ship unless

- [ ] CI green (main and develop)
- [ ] Clean install works (empty DB → all migrations → ready)
- [ ] Upgrade from the current 0.1.x production DB succeeds
- [ ] Migration rehearsal on a recent production backup succeeds (`scripts/rehearse-prod-upgrade.sh --from-prod`)
- [ ] No known data-loss migration
- [ ] `/api/ready` healthy
- [ ] Core pages work with Limited **and** Full capability profiles
- [ ] Dev/prod isolation remains intact (see [ENVIRONMENTS.md](ENVIRONMENTS.md))
- [ ] No critical/high security issues open
- [ ] No resource can remain permanently stuck in a stale "running" state

## Issue plan

Each numbered item above maps to exactly one GitHub issue (title shown in
*italics*), labeled and assigned to the **v0.2.0 — Public Beta 2** milestone,
with the acceptance criteria from this file as the issue's task list. Issue
numbers get linked back here as they are created:

| Item | Issue | Labels |
|---|---|---|
| 1 Data confidence | _pending_ | v0.2, analytics, enhancement |
| 2 Daily Summary | _pending_ | v0.2, analytics, enhancement |
| 3 Sync reliability | _pending_ | v0.2, reliability |
| 4 Onboarding/capabilities | _pending_ | v0.2, enhancement, ux |
| 5 DB upgrade safety | _pending_ | v0.2, database |
| 6 Economy analytics | _pending_ | v0.2, analytics |
| 7 Notifications | _pending_ | v0.2, notifications, enhancement |
| 8 Hosted-instance hardening | _pending_ | v0.2, security |
| 9 Release workflow | _pending_ | v0.2, enhancement |
| 10 UX polish | _pending_ | v0.2, ux |
| 11 Operator health | _pending_ | v0.2, enhancement, reliability |

Creating the milestone and issues requires GitHub API access
(`gh auth login`, then create milestone `v0.2.0 — Public Beta 2`, labels, and
one issue per item above).
