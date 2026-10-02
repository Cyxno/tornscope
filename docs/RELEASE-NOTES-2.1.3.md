# TornScope 2.1.3 — Normalizer Maintenance

Release notes · 2026-10-02 · previous: 2.1.2

A small maintenance release from a historical normalizer correctness sweep:
one proven false-negative routing class fixed and repaired, plus a
deterministic fix for a date-sensitive demo test flake. No new features, no
migration, no topology changes.

## Ambiguous-token audit

A routing sweep classified every distinct (category, title) pair in the
stored archive and audited each structured event type against its raw
provenance. One proven bug class emerged, mirrored to the Speed fix
(2.1.2): instead of a word creating a false event, the word "Travel"
(category) **shadowed** the money ledger for logs that are money movements:

| Title (category "Travel") | Payload | Expected | Before |
| --- | --- | --- | --- |
| Offshore bank deposit (6 rows) | `{balance, deposited}` | cayman transfer (−wallet) | no MoneyEvent |
| Offshore bank withdraw (1 row) | `{balance, withdrawn}` | cayman transfer (+wallet) | no MoneyEvent |
| Travel fee (3 rows) | `{cost}` | travel expense | no MoneyEvent |

All other routes verified clean: rehab dual-writes its cost to both the
rehab and money ledgers, travel transitions stay travel-only, gym training
logs carry no money payload, and the 2.1.2 drug classification holds.
Un-walked categories with money-shaped payloads (Bounties, Vault, Hunting,
Missions, Racing upgrades, Education, Ammo) are documented as walk-coverage
gaps in docs/ANALYTICS.md — a sync-scope decision, deliberately not changed
in a maintenance release.

## Fixed

- **Money ledger routing.** Offshore bank movements and travel fees route
  to money ahead of the travel check; the offshore payloads are classified
  as cayman-bank transfers (own-pool movement, never P&L) via the new
  precise `deposited`/`withdrawn` payload keys, and travel fees as travel
  expenses from `{cost}`.
- **Historical repair.** `repair:money-gaps` re-normalizes stored gap logs
  and inserts the missing MoneyEvents — strictly additive (no deletes), keyset
  of exact source references, idempotent through the canonical
  (userId, source, sourceRef) unique. Rehearsed on a production copy
  (dry-run → apply 10 rows → second run nothing), then applied to
  production after deploy. The raw archive is untouched.
- **Demo analytics determinism.** Incremental demo generation seeded its
  per-day log randomness by sync window instead of by UTC day, so a
  watermark-rewound rerun (different window → different seed) could add a
  row to the overlap and break idempotence — surfacing only on
  date-boundary-sensitive test runs. Randomness is now seeded per
  (family, UTC day), matching the other generator families; the demo
  top-up test is deterministic regardless of calendar date or timezone.

## Impact

- Production repair inserts 10 MoneyEvent rows (7 cayman transfers,
  3 travel expenses); no deletions; no other analytics recomputed.
- No Torn API changes; no schema migration; demo seed data unchanged in
  shape (day-level decisions now replay identically across windows).

## Tests

Cross-domain routing tests (offshore/travel-fee semantics vs transitions,
deposit/withdraw signs, vault logs stay out of the ledger) and DB-backed
repair tests (additive insert, proven direction/category, idempotent rerun,
dry-run safety); full database suite green including the demo top-up
idempotence test that previously flaked across dates.
