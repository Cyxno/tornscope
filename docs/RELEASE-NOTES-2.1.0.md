# TornScope 2.1.0 — Deep Analytics

Release notes · 2026-10-01 · previous: 2.0.7

## Added

- **Energy Analytics** (`/energy`): a full accounting of where energy came
  from and where it went — natural regen (derived), points refills (exact,
  incl. points spent), Xanax (documented +250 estimate), energy drinks
  (exact), gym (exact from Torn's gym-train logs), bounded attack/revive
  inference and exact overdose losses. A stacked daily/weekly/monthly chart,
  a coverage statement ("X% of observed outflow is explicitly attributed")
  and derived intelligence (energy/day, Xanax/day, regen lost at cap).
- **Historical Log Explorer** (`/logs`): filterable audit view over the
  complete raw log archive — category, type, search, money outcome and
  amount-range filters, keyset pagination, expandable payload digests and
  **streaming CSV/JSON export** (server-side, capped at 50k rows,
  session-scoped, key-free).
- **Drugs & Rehab 2.0**: good-streak accounting (current + longest, per
  substance and overall), last use / last overdose per substance, OD-rate in
  the stat strip, rehab addiction-points removed, cost-per-AP (only on
  complete data) and an estimated next-visit cost.
- **Travel Analytics 2.0**: flight-time totals and averages, trips/day,
  destination count, a three-lens activity chart (Profit / Trips / Flight
  time), a full destination-breakdown table (flight time, avg flight, items,
  spend, profit/trip, profit/hour, last visit) and descriptive "best
  historical" intelligence.
- **Shared derived analytics engine** in `@tornscope/analytics`: energy
  accounting, drug streaks, rehab deep stats and travel overview — UI
  renders models, it does not compute statistics.
- **Backfill CLI** (`pnpm backfill status|start [--deep]`): operator control
  of the historical walk — status/coverage reporting and (re)start on the
  existing worker pipeline; resumable, dedupe-safe, rate-limit aware, no
  babysitting.

## Improved

- Historical range analysis: every new view honours the shared date-range
  selector (7D → ALL + custom) with server-side aggregation and keyset
  pagination — no full-history loads in the browser.
- Provenance/confidence visibility: the provenance ladder gained an explicit
  **inferred** level (bounded bar-decline inference) alongside
  exact/derived/estimated, rendered with "~" and explanations.
- Local-first analytics performance: log-explorer page queries measured at
  ≤0.25 ms (30D/1Y/ALL) on production data after one additive index.

## Changed

- Analytics pages read exclusively from locally ingested history — opening a
  page never triggers a Torn fetch. No beta/staging stack: the production
  topology remains one stack, one database, one Redis, one worker.

## Database

- One additive migration: `20261001196000_timeline_log_type_index`
  (`CREATE INDEX` on `TimelineEvent(userId, type, occurredAt)`). No table,
  column or row is touched; rehearsal ran `migrate deploy` + idempotence
  against a production-shaped copy.

## Upgrade notes

- Deploy via the standard flow (`deploy-prod.sh`); the migrate service
  applies the single index migration automatically.
- Optional: start a deeper historical walk with
  `docker compose exec worker pnpm backfill status` and `… backfill start`.
  Depth is bounded by Torn's own log retention (initial window default 180
  days; see docs/ANALYTICS.md).
