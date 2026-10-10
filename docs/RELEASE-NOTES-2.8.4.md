# TornScope 2.8.4 — Account Effects & Unlocks

Release notes · previous: 2.8.3

The proven Education and Merit data now summarize into combined ACTIVE
account bonuses — what the account does right now, not just what it owns.
Read-time derivation only: zero schema change, zero new upstream calls,
zero new endpoints.

## Added

- **Education — Account effects** (`/education`, top block): one row per
  effect family with its source(s) chipped — `Merits`, `Education` or
  both. Merit figures are exact (rank × anchor-verified per-rank formula);
  course figures are quoted verbatim from official catalog text (only when
  the number is literally stated). Contributions are never summed across
  sources — different mechanics. Earned degrees (fully completed
  categories) and honors sit alongside; ability/feature unlocks Torn's API
  does not publish are stated as unknown rather than fabricated. Current
  course and future course rewards remain strictly separated — future
  rewards are never active.

## Improved

- **Merits — Current effects**: regrouped per effect family with
  percentage, flat and per-rank (special) semantics visually separated;
  where a completed education course states the same family it appears on
  the same row from its own source (`Education` chip, with course count).

## Technical

- Shared `buildAccountEffects` derivation (analytics) over the two proven
  sources only. Conservative family matching (unit + direction +
  normalized target); duplicates never double count (repeated merit ids,
  per-weapon mastery rows); effect strings without a stated number stay
  verbatim text ("not quantified") — unknown stays unknown.
- Education moved to its own `/education` route under the Progression
  family (alongside Energy/Merits/Drugs) as of the 2.8.3→2.8.4 window;
  `/progression` keeps its range-scoped analytics.
