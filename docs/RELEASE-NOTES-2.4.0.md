# TornScope 2.4.0 — Activity & Rewards Analytics

Release notes · previous: 2.3.1

A product upgrade that converts substantially more of the already-ingested
Torn logs into analytics: a generic activity/reward normalization layer, a
retrospective casino ledger, and openables & rewards tracking. Designed
against the full official Torn feature catalog — implemented only where
actual log evidence proves the semantics.

## Added

- **Casino Analytics** (`/casino`): retrospective per-game wagers, cash
  returned and net P/L, exact from Torn's own logs. Supported games:
  slots, roulette, keno, lottery (placements), spin-the-wheel (all wheel
  variants observed: money/points/item/tokens/free-spin/property/hospital
  outcomes), blackjack (placement vs terminal P/L), high-low, and bookie
  (placement vs settlement — placements are never counted as losses).
  Descriptive history only; no gambling advice, no outcome predictions.
- **Openables & Rewards** (`/rewards`): supply packs, caches, wallets and
  similar openings normalized into input-vs-reward tracking with exact
  cash rewards, exact item/point quantities, and item values estimated at
  current catalog market prices (clearly labeled estimated; quantities
  without a catalog price stay visible as unpriced — never silently $0).
  Unknown future openables degrade gracefully (reward components
  retained, generic labels).
- **Unrecognized value-bearing log diagnostic**: casino-routed logs without
  payload semantics and item-use logs with reward components that no
  normalizer claims are counted and listed, so future Torn log changes
  become visible instead of silently losing coverage. The
  `audit:activities` command reports the full utilization picture (raw vs
  recognized vs normalized vs analytics-used families) plus the casino
  money reconciliation.
- **Historical repair**: deterministic, idempotent backfill of the newly
  recognized activity history from the raw log archive (dry-run counts
  first; raw logs untouched; skipDuplicates prevents duplicates).

## Technical

- One additive migration (new `ActivityEvent` table plus three
  metadata-only schema-convergence statements the generator produced
  against the declared Prisma schema — see DATABASE-MIGRATIONS.md).
- Explicit per-game casino registry and payload-driven openable detection:
  category, exact title grammar, payload keys and item ids together —
  never bare keyword matching. Regression-tested with positive, negative
  and cross-domain collision fixtures.
- MoneyEvent remains the accounting ledger; ActivityEvent is the semantic
  view. Reconciliation diagnostics report the delta between the two
  (known, explainable ledger gaps for games whose bet keys Torn doesn't
  expose through the covered money-key list) — never silently patched.

## Upgrade

Standard flow: `deploy-prod.sh`, then run the historical repair once
(`docker compose exec worker pnpm --filter @tornscope/database exec tsx src/repair/activity-repair.ts` — dry-run first). No config changes.
