# TornScope 2.6.0 — Data Utilization Expansion

Release notes · previous: 2.5.4

A systematic expansion of the value drawn from history TornScope ALREADY
stores. No new upstream API calls were required. No dashboard sprawl: every
addition lives on an existing page, compact and expandable.

## Added

- **Account progression** (`/progression`): long-term counters from the stored
  personalstats history — awards, trains received, energy refills, crimes,
  hospitalizations, trips abroad, donator days and more, each with the exact
  snapshot delta over the selected range and rate/day. Reset detection never
  presents a counter reset as negative progress. The remaining counters sit in
  an expandable "More progression stats" section.
- **Internal transfers** (`/money`, cash lens): vault deposits and withdrawals
  now reach the ledger as NEUTRAL transfers (category `vault`) with a compact
  per-account breakdown (Vault / City bank / Cayman). Accounting-neutral by
  construction — they never enter income, expenses, net, alerts or decision
  signals.
- **Liability context** (net worth lens): gross assets, liabilities (loans +
  unpaid fees) and net as balance-sheet figures from the official snapshots —
  provenance exact, never presented as cashflow.
- **Crime skill progression** (`/crimes`): per-crime skill level, range change
  and up/down counts from Torn's own skill bookkeeping logs (exact payloads,
  no invented precision).
- **Faction history** (`/faction`): respect and member-count trends from the
  stored snapshot series — every point is a real stored snapshot.

## Improved

- Broader utilization of already-stored Torn history; ammo purchases complete
  the money-ledger coverage (two rows, expense normalization only).
- New `audit:data-utilization` tool (read-only, `--json`/`--matrix`): a
  permanent storage-to-product matrix — row counts, freshness, code-consumer
  references, field fill rates, JSON path fingerprints and dead-data
  candidates — so stored-but-unused data stays detectable in future releases.

## Technical

- No schema changes: every feature derives from existing tables and columns.
- Historical repair `repair:money-transfers` (dry-run/apply) backfills the
  vault/ammo ledger rows idempotently; rerun reports 0 new.

## Upgrade

Standard flow (`scripts/deploy-prod.sh`). No config changes. The money-
transfer repair is run once during the controlled deploy (dry-run reviewed,
then applied; rerun reports 0).
