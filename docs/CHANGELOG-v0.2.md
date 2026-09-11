# TornScope v0.2 — Release Notes (draft)

Public Beta 2. Everything below shipped on `develop` for v0.2; this file is
the source for the eventual GitHub release notes. No marketing — what
changed, what it means, what it costs you.

## Major features

- **Data Confidence** — every figure carries an honest coverage/freshness
  state (complete / partial / stale_permission / unavailable); unavailable
  is never rendered as zero.
- **Daily Summary** — a timezone-correct single-day view with highlights,
  per-domain sections and an overall completeness state.
- **Sync reliability** — operational health per resource (caught up /
  delayed / failed / parked), incidents, orphan recovery, safe retry and
  bounded backfill; distinct from data confidence.
- **Onboarding & capabilities** — API-key capability presets, a consequence
  matrix (what each permission unlocks), staged initial-sync progress and
  recovery warnings.
- **Database upgrade safety** — additive-only migration policy, migration
  inventory, migration-safety tests, clean-install and production-copy
  upgrade rehearsals (`scripts/rehearse-prod-upgrade.sh`).
- **Economy analytics** — cash flow with asset-conversion separation,
  economic effect (estimated valuation, never mislabeled profit),
  net-worth explanation with unexplained residual, wallet reconciliation.
- **Progression & Energy Intelligence** — battlestat progression from hourly
  snapshots (milestones with crossing windows), energy flow from 5-minute
  bar history (sources, uses, cap time, unattributed spend first-class),
  conservatively inferred training sessions with gain-per-energy against
  personal baselines, and happy-jump inference (likely/possible, never
  "confirmed") with full evidence disclosure.
- **Notifications** — canonical type registry with explicit urgency,
  quiet hours that defer instead of silently dropping (stale events
  expire), profile-level dedupe with per-device delivery ledger, bounded
  retries, invalid-subscription cleanup, test push, delivery history with
  machine reasons in plain language.
- **Hosted-instance hardening** — 429 rate-limit policy with per-route
  buckets, request ids, private cache policy, per-profile session/device
  limits, container sandboxing, SSRF defense-in-depth (structural + DNS),
  documented threat model and deployment guide.
- **v0.2 UI redesign** — ledger design language, persistent desktop rail,
  route-specific compositions, responsive 320–1920.

## Data semantics (what TornScope claims and doesn't)

- Every metric is labeled exact / derived / estimated / inferred.
  Unavailable renders as "—", never zero.
- Xanax use is exact; Xanax energy is a documented estimate (Torn logs no
  per-use energy).
- Training sessions and happy jumps are inferences from energy declines +
  stat brackets — never presented as recorded gym logs (Torn has none).
- Item sales are conversions, not earnings; net-worth deltas are not
  profit; travel profit is estimated against current catalog prices.

## Migration notes (0.1.x → 0.2)

- All migrations are additive (no destructive change): sync-state
  heartbeat/error-kind columns, BarsSnapshot table, notification events +
  delivery lifecycle, User.role default change.
- Run `scripts/rehearse-prod-upgrade.sh --from-prod` against a recent
  production backup before deploying (see docs/V0.2-RELEASE-CHECKLIST.md).
- The migrate container applies migrations on deploy; rollback of the app
  needs no DB downgrade.

## Known limitations

- Energy/happy (bars) history exists only from `bars` collection start.
- Nerve notifications require the live-timer fetch (nerve is not in stored
  bar snapshots).
- "Sent" push status proves provider acceptance, not on-screen display.
- Rate limiters are in-process (single-node); deploy multi-replica only
  after moving them to a shared store.
- Hosted CI enforcement (branch protection) cannot be verified from the
  server — operator must configure it in GitHub settings.
