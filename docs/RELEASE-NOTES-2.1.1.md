# TornScope 2.1.1 — Deep Analytics Polish

Release notes · 2026-10-02 · previous: 2.1.0

A polish release on top of 2.1.0's Deep Analytics: presentation and
documentation refinements, one pagination fix, and public copy that
describes TornScope's features entirely in its own terms. No new feature
scope, no database migration, no change to the deployment topology.

## Fixed

- **Log Explorer pagination with payload filters.** Money outcome and
  amount-range filters cannot run in SQL, so pages are assembled server-side.
  When matching rows were sparse across many source pages, a page could end
  early and pagination silently stopped. Page assembly now continues across
  consecutive keyset scans (bounded budget) and emits a continuation cursor
  from the last scanned row, so a short filtered page never truncates the
  result set. Covered by a regression test.

## Improved

- **Analytics presentation.** The travel activity chart labels its profit
  lens as estimated; the energy intelligence strip states each figure's
  provenance; provenance wording across Energy, Drugs, Travel and Logs is
  consistent (exact / derived / estimated / inferred).
- **Documentation.** docs/ANALYTICS.md, the built-in changelog and the
  README intro describe what TornScope does — historical analytics across
  energy, drugs, travel and account activity — without comparisons to other
  Torn tools.

## Data semantics (unchanged, verified)

Every Deep Analytics figure keeps its label: exact (refills, gym energy,
overdose losses, rehab addiction points, energy drinks), derived (natural
regen, streaks, balances, cost-per-AP), estimated (Xanax +250 convention,
market-price values, next-rehab estimate) and inferred (bounded
attack/revive decline attribution). Balances are withheld ("uncovered")
when bar history does not cover the range.

## API / DB / performance impact

- No Torn API changes: Deep Analytics keeps reading exclusively from
  locally ingested history.
- No database migration.
- The Log Explorer fix only affects filtered queries; unfiltered keyset
  pages are unchanged.

## Upgrade

Standard flow: `deploy-prod.sh` (no migration service work this release).
Running version after upgrade: `2.1.1`.
