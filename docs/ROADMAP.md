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

Clear Limited vs Full capability explanation, showing exactly which features
each key enables, better initial sync progress, and a clear warning when
historical data cannot be recovered.

Acceptance criteria:
- [ ] Capability selection explains per-feature consequences before the user picks.
- [ ] Settings shows which features the current key enables.
- [ ] Initial sync shows real progress per resource (ties into 3).
- [ ] Choosing Limited (or a partial key) warns clearly that the skipped history cannot be recovered later.

### 5. v0.2 database upgrade safety — *issue: `chore(v0.2): database upgrade safety for 0.2.x`* · labels: `v0.2` `database`

All schema changes land as committed Prisma migrations using
expand/migrate/contract where appropriate; a production-copy migration
rehearsal is **required** before release; no destructive migration without
rollback/compatibility consideration. See
[DATABASE-MIGRATIONS.md](DATABASE-MIGRATIONS.md).

Acceptance criteria:
- [ ] Every 0.2 schema change has a committed migration; no manual schema edits.
- [ ] `scripts/rehearse-prod-upgrade.sh --from-prod` passes on a recent production backup.
- [ ] Upgrade from the current 0.1.x production DB and clean install both succeed.
- [ ] No migration drops/renames data without a documented compatibility path.

---

## SHOULD HAVE

### 6. Economy analytics improvements — *issue: `feat(v0.2): economy analytics refinements`* · labels: `v0.2` `analytics`
Stronger cashflow vs asset-conversion distinction, better wallet
reconciliation, better "why did my net worth move?" analysis, clearer
confirmed-vs-estimated values. Related: 1, 2.

### 7. Notification improvements — *issue: `feat(v0.2): notification settings & delivery improvements`* · labels: `v0.2` `notifications` `enhancement`
Per-notification-type settings, improved quiet-hours behavior, queue
non-critical notifications instead of silently dropping where practical, and
a device test notification.

### 8. Hosted-instance hardening — *issue: `chore(v0.2): hosted-instance abuse & health hardening`* · labels: `v0.2` `security`
Review abuse/rate-limit protection, sensible profile/session limits where
justified, operational health visibility without exposing user data.

### 9. Release/dev workflow hardening — *issue: `chore(v0.2): release & dev workflow hardening`* · labels: `v0.2` `enhancement`
CI requirements on main/develop, a release checklist, a migration rehearsal
checklist, backup/restore verification, and a single source of truth for the
displayed version/environment (builds on the existing `PUBLIC_ENV_LABEL`
marker — see [ENVIRONMENTS.md](ENVIRONMENTS.md)).

---

## NICE TO HAVE

### 10. UX polish — *issue: `feat(v0.2): UX consistency & state polish`* · labels: `v0.2` `ux`

**Status: Complete (v0.2 UI overhaul).** Implemented on `develop`, deployed to
the dev stack — see [UI-DESIGN.md](UI-DESIGN.md). The interface was redesigned
as a coherent v0.2 visual system ("precision calm"): centralized design tokens
(graphite surface scale, radius/control scales, teal accent), grouped adaptive
navigation with a mobile bottom tab bar + nav sheet, one panel/page-header/KPI
system, structure-matched loading skeletons, disclosure-based methodology copy,
a unified chart theme and table language, humanized Timeline entries, an
aligned Sync Status grid, and verified responsive behavior from 320px to 1920px
(no horizontal overflow, WCAG-AA label contrast, reduced-motion support).

- [x] Loading/empty/error states coherent and structure-matched
- [x] Consistency pass across analytics cards/tables/charts
- [x] Mobile/tablet layout passes (320–430 / 768–1024 verified per route)
- [x] Clearer provenance/confidence presentation without badge overload

### 11. Operator health overview — *issue: `feat(v0.2): operator health overview`* · labels: `v0.2` `enhancement` `reliability`
Infrastructure/sync health only — aggregate operational metrics; no ability
to browse private user analytics.

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
