# TornScope 2.5.0 — Value Coverage Expansion

Release notes · previous: 2.4.0

A data-utilization release: substantially more of the already-stored raw
archive is now semantically understood, normalized, reconciled and turned
into analytics — while unknown or uncertain values stay explicit instead of
being guessed or silently discarded.

## Added

- **Hunting** (`/hunting`): per-session bait costs and prey-sale income
  (exact from Torn's own logs), net per session, session-type breakdown,
  most valuable session, and the hunting-skill trajectory the logs record
  (latest skill, gain since first session, sum of logged gains, level-ups).
- **Activity & value overview** (`/activity`): cross-domain value
  attribution across casino, openables, hunting, missions, racing,
  bounties and education. Exact cash in/out and net, item value estimated
  at current catalog prices (labeled), progression quantities in their own
  units (racing points, mission credits), unpriced activities kept visible
  (never zeroed), and per-domain ledger linkage — semantic-only domains
  are labeled as such so nothing is double counted.
- **Expanded historical coverage**: missions (exact cash + mission
  credits, including credits-only completions), racing finishes (position,
  exact racing points, skill gains) and upgrade spend, bounty placements
  (committed cost; the listed reward belongs to the claimer) vs claims
  (income), and education starts (exact committed course cost).
- **Legacy casino payouts**: old-format money rows that carry only an
  amount and no game attribution now normalize as unattributed legacy
  casino income — the game stays unknown rather than guessed.

## Fixed

- Money reconciliation now sums the signed ledger correctly (expenses are
  stored negative; the previous diagnostic double-flipped them).
  Differences between the semantic activity view and the ledger are
  disclosed with their structural causes — slots/keno/blackjack/high-low/
  bookie cash has no money logs in Torn's API and lottery/wheel
  placements are pending — never silently patched.

## Technical

- Expanded deterministic normalizer registry, anchored on category, exact
  title grammar and semantic payload keys — never bare keywords.
- Utilization audit 2.0 (`audit:activities`): recognized / normalized /
  analytics-used coverage at family AND event level with an A–F gap
  classification, plus the generic per-domain money reconciliation.
- Historical repair covers all new families, stays idempotent (dry-run →
  apply → rerun must insert nothing), and treats the raw archive as
  read-only. No schema migration: new domains live in the existing
  ActivityEvent structure.

## Upgrade

Standard flow: `deploy-prod.sh`, then run the historical repair once
(dry-run first; `docker compose exec worker pnpm --filter
@tornscope/database exec tsx src/repair/activity-repair.ts`). No config
changes, no database migration.
