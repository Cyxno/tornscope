# TornScope 2.8.2 — Education & Merit Effects

Release notes · previous: 2.8.1

Two existing account surfaces made genuinely useful, from sources TornScope
already fetches — zero schema change, zero repair, zero new endpoints.

## Added

- **Education** (`/progression`, new section): current course with live
  countdown and exact completion time; completed/total against the official
  catalog (12 categories, 143 courses); per-category degree progress;
  earned-vs-future reward totals (working stats) strictly separated; the
  full course list with All / Completed / In progress / Remaining filters
  and search, each row carrying its exact duration, cost and reward/effect
  line. SOURCES (verified live 2026-10-08): `/v2/user/education` (current +
  completed state ONLY — Torn publishes no completion history, so none is
  fabricated) and `/v2/torn/education` (official catalog, cached a day).
- **Merits — Current effects** (`/merits`, top block): what the invested
  ranks DO right now — +50% bank interest, +20% mug money, +3%×ranks
  battlestats, −2%×ranks course time, flat nerve/stealth/employee bonuses,
  weapon masteries grouped. Every formula is anchored to a phrase in the
  official description (drift ⇒ the merit drops out of the summary and
  stays ledger-only); unmodeled merits are never guessed.

## Technical

- Read-time derivation only: `buildEducationProgress` (analytics) over the
  two live sources, cached per the merits-service precedent; `effects`
  rides on the existing merits payload. No migration, no repair, no
  changes to upstream call volume at rest.
