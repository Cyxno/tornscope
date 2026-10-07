# TornScope 2.5.4 — Test Isolation & Release Reliability

Release notes · previous: 2.5.3

Infrastructure-only release: the test database lifecycle became
deterministic and isolated. No product features, no UI changes, no analytics
changes, no database-semantic changes.

## Fixed

- **Eliminated test-database state leakage** that could cause
  non-reproducible release-gate failures. Every vitest run with a
  `TEST_DATABASE_URL` now rebuilds the test database to the same baseline
  (schema drop → migrations → demo seed) before any test executes — locally,
  in the release preflight and in GitHub Actions alike.
- **Parallel test workers no longer race on shared catalog rows**: the demo
  top-up invariant proves itself on a reserved item id instead of claiming
  the shared Xanax catalog row, suites only delete shared rows they created
  themselves, and the activity repair survives a candidate's user
  disappearing mid-run (concurrent deletion) instead of aborting.

## Improved

- One database lifecycle for local runs, `scripts/release-preflight.sh` and
  CI — re-running the full suite against a reused database now always
  produces the same result, with no manual cleanup step.
- Documented in `docs/TEST-DATABASE-LIFECYCLE.md`.

## Upgrade

Standard flow (`scripts/deploy-prod.sh`). No config changes, no database
migration, no historical repair.
