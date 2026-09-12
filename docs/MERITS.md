# Merits — source, semantics and limitations

## Source (audited live, Torn API v2, spec 6.13.5)

| Data | Source | Status |
|------|--------|--------|
| Invested ranks (`upgrades[{id, level}]`) | `/v2/user/merits` | **Exact** |
| Unspent merit points (`available`) | `/v2/user/merits` | **Exact** |
| Invested points (`used`) | `/v2/user/merits` | **Exact** |
| Earned medals / honors (each grants a point) | `/v2/user/merits` | **Exact** |
| Merit names + descriptions | `/v2/torn/merits` (public) | **Exact** (official catalog) |
| Merit caps (max levels) | **not exposed by Torn** | TornScope-maintained (partial) |
| Merit categories | **not exposed by Torn** | TornScope UI grouping |
| Historical merit changes | not exposed | unavailable (not built) |

Requires the `merits` user selection — a **minimal-access (level 1)** selection,
so both Limited and Full keys carry it (verified: Full keys list `merits` in
`selections.user`).

## Capability

Feature `merits_overview` requires `canReadUserMerits` (derived from the
`merits` selection, level-1 fallback). The Settings matrix and onboarding
consequences reflect this automatically via the shared feature matrix.

## Collection strategy

Live fetch per page view with a 5-minute single-flight cache (the same model
as the Today page). Merit ranks change rarely; polling would burn Torn API
budget for stale data. No database tables: current state only, no historical
product need.

## Catalog (`packages/analytics/src/merits.ts`)

- Ids/names/descriptions are fetched from the official `/torn/merits` catalog
  at request time (24h in-process cache) — never scraped or hardcoded.
- `MERIT_CATALOG` adds TornScope-maintained metadata per id:
  - `maxLevel` — maintained only where the in-game cap is a stable, well-known
    constant (the ten-cap merits and the weapon masteries). Merits with an
    uncertain cap carry `null` and render **level-only**; they are never
    classified maxed.
  - `category` — TornScope UI grouping (Combat, Battlestats, Crime, Weapons
    mastery, Recovery, Money & career). Explicitly NOT Torn-native taxonomy;
    the page labels it as such.
- **Mismatch detection:** a stored rank above the maintained cap renders a
  "catalog out of date" marker instead of being trusted. Maintain the catalog
  when Torn adds merits or changes caps — the id set is asserted by a golden
  test (`packages/analytics/tests/merits.test.ts`).

## Rank semantics

- Ranks are integer levels, one merit point per rank.
- State machine: `maxed` (exact rank ≥ maintained cap), `partial` (0 < rank <
  cap), `owned` (invested, cap not maintained), `untouched` (no upgrade row).
- Summary counts mirror those states exactly; the page discloses how many
  invested merits are level-only because caps are unpublished.

## Known limitations

1. Torn publishes no caps: `maxed` claims are only as good as the maintained
   catalog (which prefers honest "unknown" over wrong).
2. No merit history (Torn exposes none); the page is current-state only.
3. If the official catalog cannot be fetched, names render as null and the
   response flags `catalogDegraded` — ranks stay exact and visible.
