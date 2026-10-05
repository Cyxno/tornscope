# TornScope 2.3.1 — Decision Intelligence Performance Hardening

Release notes · previous: 2.3.0

A small performance-and-correctness hardening release driven by a measured
scalability audit of Decision Intelligence. No features, no migration, no
topology changes; the direct-pool Postgres policy is untouched.

## Fixed

- **Extreme in-window density.** The four capped history reads behind
  Decision Intelligence ordered ascending, so if a profile produced more
  events inside the 37-day decision window than the read caps allow, the
  caps kept the OLDEST rows and the recent week could go unrepresented in
  comparisons. The reads now keep the newest rows (the decision engine is
  order-independent). Verified with a dense-recent probe: 200k in-window
  events, gather p95 ≈ 185 ms — inside the 250 ms budget.

## Improved

- **Concurrent cold requests share one build.** Overview strip and Insights
  page can both fire /api/decisions within the same cold window; a per-user
  single-flight now shares one build instead of running identical gathers.
  Regression-tested (shared response identity + one lifecycle write).

## Audit summary

Full audit in docs/DECISION-INTELLIGENCE-PERFORMANCE.md: request path,
query inventory (16 bounded, indexed queries per cold build), EXPLAIN-based
growth model, concurrency measurements (25 concurrent cold users ≈ 80 ms
total on the benchmark DB), cache behavior (60s TTL, per-user single-flight,
≤1 lifecycle write per cold build), documented budgets and objective future
trigger points. Aggregate tables / materialization / background jobs remain
rejected — every query is already bounded and indexed, and current cold p95
is ~20–27 ms against a 150 ms budget.

## Benchmark tooling

`pnpm benchmark:decision` — deterministic generate_series fixtures at
SMALL/MEDIUM/LARGE scale, instrumented query counting, cold/warm service
latency, K-user concurrency. Manual command only; never wired into CI.

## Upgrade

Standard flow. No migration. Running version after upgrade: `2.3.1`.
