# TornScope 2.8.0 — Combat, Racing & Bounty Coverage

Release notes · previous: 2.7.0

The highest-value remaining gaps in already-stored history: the Combat,
Racing and bounty families in the personalstats snapshots — hundreds of
thousands of attacking events' worth of counters that TornScope stored
every hour but never showed — plus Torn's own exact per-crime skill levels
as an authority for the crimes skill table. Every number is read from the
existing snapshot history; no new upstream calls, no migrations, no repair
needed.

## Added

- **Combat progression** (`/progression`, Account progression): attacks
  won / lost / stealthed, critical hits, defends fought, combat ELO, best
  killstreak, total cash mugged, largest mug, faction respect earned and
  ranked-war hits — exact snapshot deltas with rate/day over any range.
  Archive proof (production fingerprint, 2026-10-08): attacks won moved
  672 → 6,804, cash mugged up to $109M, ELO 1,398 → 2,442 across the
  tracked window.
- **Racing & bounty counters**: races entered/won, racing points, racing
  skill, bounty placed/received/collected values — same exact-snapshot
  provenance.

## Improved

- **Crime skill authority** (`/crimes`): the skill table now merges the
  latest personalstats snapshot's `crimes.skills` map — Torn's own exact
  per-crime level — so crimes with no skill-change log in the stored
  history finally render (marked "snapshot") instead of showing "—".
  Log-observed levels are never overwritten; names that do not match
  across sources stay separate rows (`skimming` vs `card_skimming`) —
  never guessed together.

## Technical

- Zero schema change and zero repair: the counters and the skill merge are
  read-time analytics over `PersonalStatSnapshot.stats`, which the hourly
  sync already stores.
- Gauges (`combat_elo`, `killstreak_best`, `largest_mug`, `racing_skill`)
  are labeled as such in the registry and provably never false-positive
  the shared counter-reset detector (drop ≥ 50% + post-drop stability).
- The utilization audit tools now recognize the 2.7.0 special-reward
  claims and fingerprint the 2.8.0 productizations.

## Deferred on purpose

- `investments.bank/stocks` gauges: held-vs-all-time semantics are
  ambiguous in the stored payloads (D — left retained-raw).
- Per-weapon finishing hits (12 weapon classes): a metric wall of low
  decision value; the combat headline counters carry the signal.
- Per-drug use counters: redundant with the normalized DrugEvent ledger.
