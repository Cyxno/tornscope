# TornScope 2.1.2 — Drug Classification Correctness

Release notes · 2026-10-02 · previous: 2.1.1

A targeted data-correctness hotfix for the Deep Analytics drug pipeline:
non-drug activity whose log title happens to contain a drug name could be
counted as substance use, and the affected historical records have been
repaired from their original log provenance. No new features, no database
migration, no topology changes.

## Root cause

The normalizer routed a log to the drugs domain when its category contained
"drug" **or when the title merely contained a drug name**. Torn's gym
training log for the speed stat is titled "Gym train speed" — the word
"speed" matched the Speed alias, so every gym speed session was normalized
into a Speed use event (and its paired consumption-value event). The same
class applied in principle to every other drug alias; a full provenance
audit found exactly two affected title shapes: "Gym train speed" (293 rows)
and "Company special gain speed" (1 row), all Speed, across all profiles.

## Fixed

- **Drug-log classification.** Routing to the drugs domain now requires
  definitive evidence:
  - the log's category is a drug category ("Drugs", "Item use drug"), or
  - the title matches an explicit, name-anchored use grammar built from the
    real Torn title forms: "Item use <drug>[ overdose]", "Used <drug>",
    "Overdosed on <drug>", "Drug use <drug>".
  A bare drug word in any other position ("Gym train speed", "Speed
  increased", "Company special gain speed") can never create a drug use —
  and even true use-grammar titles only count when a drug name is the
  object ("Item use speed loader" does not match).
- **Historical repair.** A provenance-based repair (`pnpm --filter
  @tornscope/database repair:drug-classification [--dry-run]`) re-evaluates
  every stored drug row against its own raw log: rows whose provenance no
  longer routes to drugs are removed, together with their paired
  consumption-value rows. Legitimate history — including real "Used Speed"
  and "Overdosed on Speed" records — is preserved, the raw log archive is
  never touched, and the repair is idempotent (a second run reports nothing
  to repair). Repaired on the production copy first (dry-run → apply →
  idempotence), then applied to production after deploying this release.

## Impact

- Removed on production after deploy: 294 false drug-use rows and 294 false
  consumption-value rows (293 gym speed sessions + 1 job special); 33
  legitimate Speed records preserved; 0 money rows affected.
- Downstream drug analytics (total uses, per-substance breakdown, OD rate,
  streaks, estimated spend/consumption) now compute from clean data.
  Energy accounting was never affected (it reads gym energy directly from
  the raw log archive, not from drug rows).
- No Torn API changes; no database schema migration; the repair touches
  only the two affected structured tables by exact source references.

## Tests

New regression coverage: the pure classification cases (use grammar vs
gym/stat/job titles, item-ID-with-context vs item-ID-without-context,
real Xanax use/overdose) and DB-backed repair tests (false positives
removed, legitimate Speed use preserved, paired consumption rows removed,
archive intact, second run idempotent).
