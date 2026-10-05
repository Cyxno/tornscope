# Decision Intelligence — Performance & Scalability

Audit basis: 2026-10-05, production dataset (v2.3.0), plus synthetic
SMALL/MEDIUM fixtures on an isolated benchmark database
(`scripts/benchmark-decision-intelligence.ts`, `pnpm benchmark:decision` —
explicit command, never wired into CI).

## Request architecture

```
browser (Overview strip / Insights page / Settings prefs)
  → GET /api/decisions            (session auth; demo-safe)
  → getDecisions(userId)
      ├─ TtlMap cache hit (key = userId, TTL 60s) → return
      └─ cold: per-user single-flight
          ├─ prefs read (AppSetting KV, 1 read)
          ├─ gatherDecisionFacts (11 bounded queries, one parallel batch)
          ├─ pure engine pass (median/MAD, threshold rules)
          ├─ lifecycle reconcile (AppSetting read + upsert)
          └─ response (cache.set)
```

Per-user isolation: cache key and all queries are strictly userId-scoped.
Invalidation: prefs updates delete the cache entry; data changes flow in via
the 60s TTL (signals are slow-moving by design).

## Query inventory (cold request)

| # | Table | Purpose | Bounds | Index | rows@prod | ms | Risk |
|---|---|---|---|---|---|---|---|
| Q1 | MoneyEvent | money signals + income pace | 37d, userId+time, LIMIT 20 000 | (userId, occurredAt) | ~2 100 | ~8 | WATCH (cap order) |
| Q2 | DrugEvent | xanax pace + OD rate | 37d, LIMIT 10 000 | (userId, occurredAt) | ~180 | ~2 | GOOD |
| Q3 | RehabEvent | rehab cost trend | 37d, LIMIT 2 000 | (userId, occurredAt) | ~25 | ~1 | GOOD |
| Q4 | TimelineEvent | gym energy (exact) | 37d + title prefix, LIMIT 8 000 | (userId, type, occurredAt) | ~600 | ~6 | GOOD |
| Q5 | TimelineEvent | refill pace | 37d + exact title, LIMIT 2 000 | (userId, type, occurredAt) | ~260 | ~2 | GOOD |
| Q6a | TravelEvent | trip window | 44d (7d attach margin), LIMIT — | (userId, departedAt) | ~90 | ~2 | GOOD |
| Q6b | TravelItemEvent | trip items | 44d | (userId, occurredAt) | ~90 | ~2 | GOOD |
| Q6c | TornItemCatalog | price map (global) | price IS NOT NULL | pk/scan of 1 500 | 1 500 | ~4 | WATCH |
| Q7–Q10 | 4× findFirst | trackingSince per domain | indexed backward scan, stops at row 1 | (userId, occurredAt) | 1 each | ~1 ea | GOOD |
| Q11 | Goal | active goals w/ target date | userId+status | (userId, status) | ≤ handful | ~1 | GOOD |
| S0/S1 | AppSetting | prefs + lifecycle read | userId+key unique | unique | 1 each | ~1 ea | GOOD |
| S2 | AppSetting | lifecycle write | upsert, **only on cold build** | unique | 1 | ~1 | GOOD |

Every gather query is HARD-bounded to the 37-day decision window by
userId + occurredAt. The only non-window reads are the trackingSince
`findFirst`s (indexed, stop at row 1), the global price map (1 500 rows,
bounded by the catalog itself) and the goal list (active + target date).

## Current performance (production data, 2026-10)

| Metric | Value |
|---|---|
| gather cold p50 | ~4 ms |
| gather cold p95 | 20–27 ms |
| engine-only | ~3 ms |
| service cold (incl. prefs + lifecycle + engine) p50/p95 | 7–10 ms / 44–55 ms |
| service warm (cache hit) | ~0 ms |
| endpoint p95 (HTTP, incl. network+auth) | ~60 ms |
| queries per cold build | 16 (11 gather + prefs/lifecycle KV + goal) |
| response size | small (≤8 signals, ≤8 recently-resolved; a few KB uncompressed) |

## Cache

TTL 60s per userId. Signals are day-granularity — 60s is generous; the TTL
exists so prefs changes and lifecycle state stay reasonably fresh, not for
correctness. Prefs updates invalidate the entry immediately. Duplicate cold
work: before 2.3.1, N concurrent cold misses for one user ran N identical
gathers (Overview strip + Insights page can fire within the same cold
window). Now per-user single-flight shares one build; the response object is
shared by reference across concurrent callers (regression-tested).

## Scaling model

- Old-history growth (years of data outside the 37d window) is FREE: every
  gather query is window-bounded and indexed — verified with EXPLAIN (index
  scans, no seq scans on event tables).
- In-window density is the only dimension that scales cost: the caps
  (LIMIT 20k/10k/8k/2k) bound every read. Measured with a dense-recent
  probe (200k events inside the window): gather p95 ≈ 185–230 ms — within
  the 250 ms budget, and the caps silently keep only the NEWEST rows
  (post-2.3.1: desc order — the asc variant could have kept the OLDEST and
  missed the recent week at extreme density; fixed as a correctness item).
- Concurrency: 25 concurrent cold users ≈ 80 ms total wall (~3 ms/user
  amortized) on the benchmark DB; queries are indexed point-reads, so DB
  CPU scales near-linearly with active users and stays trivial at this
  scale. The Prisma pool (bounded) is the shared resource; a cold build
  holds a connection for the gather only.

## Performance budgets

| Condition | Budget |
|---|---|
| current data, cold gather p95 | < 150 ms (measured: 20–27 ms) |
| current data, warm endpoint p95 | < 25 ms (measured: ~0 ms cache hit) |
| dense-recent (10× in-window), cold gather p95 | < 250 ms (measured: ~185 ms) |
| 25 concurrent cold users | total wall < 500 ms; no pool exhaustion (measured: 80 ms) |

## Future trigger points

- Cold gather p95 > 250 ms on current-size data → re-examine query shapes.
- Cache hit rate < 70% (would need request logging) → audit client behavior
  and TTL.
- MoneyEvent > 5M rows AND gather p95 degrades materially → consider a
  daily aggregate table (not before).
- Pool wait time observed on /api/decisions → review connection budget and
  consider serving stale-while-revalidate.

## Explicit non-goals (no evidence at this scale)

Daily aggregate tables, materialized views, background aggregation jobs,
Redis analytics stores, denormalized signal tables — all rejected: every
query is already bounded and indexed, and current cold p95 is ~20 ms against
a 150 ms budget.
