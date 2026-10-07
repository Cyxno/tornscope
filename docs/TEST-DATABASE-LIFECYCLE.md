# Test database lifecycle (2.5.4)

One deterministic lifecycle for every full-suite run — local, preflight and
CI are identical by construction, and no operator ever has to clean the test
database by hand.

## The lifecycle

Every vitest run that has `TEST_DATABASE_URL` set executes
`vitest.global-setup.ts` **before any test runs**:

1. `scripts/ci/reset-test-db.ts` drops and recreates the `public` schema
   (guard: the target database name must contain `test`).
2. `prisma migrate deploy` applies every migration.
3. `packages/database/src/seed/demo.ts` seeds the shared demo profile.

The result: every run starts from the exact same baseline regardless of what
previous runs left behind, and the state at the end of a run is kept (it is
useful for debugging a failure — it is simply discarded by the next run).

## How to run the full suite

```bash
TEST_DATABASE_URL=postgresql://… pnpm test
```

That is all. The reset is automatic; re-running against a "dirty" database
produces exactly the same result as running against a fresh one.

## Why reuse no longer leaks state

Before 2.5.4, repeated runs against the same database accumulated leftover
state (extra demo profiles, thousands of synthetic event rows from earlier
runs), and several suites asserted against that shared state — the 2.5.3
release gate failed on exactly this. Three classes of problems were fixed:

1. **Run-to-run leakage** — eliminated by the reset lifecycle above: every
   run rebuilds the schema from migrations plus a fresh demo seed.
2. **Shared global catalog rows** — `TornItemCatalog` is a global table and
   parallel workers mutated the same rows:
   - the demo top-up invariant test now proves "the top-up never mutates the
     catalog" on its own reserved item id (`9_999_206`) instead of claiming
     the real Xanax row (206);
   - suites that seed the shared Teddy row (438) only delete it when they
     created it themselves (golden-data, economy-analytics).
3. **Boundary-sensitive fixtures** — the decisions-service fixture placed its
   oldest row exactly on the facts gatherer's 37-day window boundary, so any
   delay between fixture and assertion dropped it (46 vs 47). Baselines now
   sit 9–34 days back with days of margin.

Additionally, the activity repair CLI is now safe to run against a live
database: if a candidate's user disappears mid-repair (concurrent deletion),
that row is skipped with a notice instead of aborting the pass.

## Worker safety

Suites keep running in parallel by default. DB-mutating suites use unique
per-run identifiers (`randomBytes`/`randomUUID` suffixes) and clean up their
own users; the only shared rows are catalog entries, whose create/update/delete
ownership is now exclusive per suite.

## CI parity

GitHub Actions runs `pnpm test` with `TEST_DATABASE_URL` pointing at its
service Postgres — the same global setup resets and reseeds it before the
suite, exactly like local runs and `scripts/release-preflight.sh` (which
invokes the same vitest run). There is no hidden difference between the three
environments.
