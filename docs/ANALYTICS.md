# Deep Analytics (2.1.0)

TornScope's deep-analytics layer answers "what does my Torn history actually
mean?" — energy accounting, drug/rehab patterns, travel economics and a full
log explorer — computed from ONE locally ingested history, on the existing
production stack (no second deployment of any kind).

## Architecture principle

**LIVE PAGE LOAD ≠ HISTORICAL INGEST.** Deep analytics read only from
TornScope's own database:

```
incremental background ingest (existing worker sync)
  → normalized local storage (TimelineEvent archive + structured events)
  → local analytics queries (@tornscope/analytics, pure functions)
  → cached DTO endpoints (apps/api)
  → frontend
```

Opening any analytics page triggers **zero Torn API calls**. New Torn data
arrives exclusively through the existing sync pipeline (see
docs/SYNC-RELIABILITY.md), which is cursor-based, idempotent
(`(user, source, source_ref)` unique upserts), resumable, page-budgeted and
rate-limit aware. There is no separate analytics worker, database or
deployment — the production topology stays exactly one stack.

## Storage

| What | Where |
| --- | --- |
| Raw log archive (full Torn payload, provenance) | `TimelineEvent` with `type="log"`, payload in `metadata` (JSONB) |
| Structured drug uses / overdoses | `DrugEvent` (outcome, item, name) |
| Consumables (incl. energy drinks) | `ConsumptionEvent` (category, value, provenance) |
| Rehab visits | `RehabEvent` (cost, sessions, addiction points removed) |
| Assembled trips + abroad purchases | `TravelEvent` + `TravelItemEvent` |
| Energy/happy bar observations (5 min) | `BarsSnapshot` (the only historical bar record — Torn is live-only) |
| Money ledger | `MoneyEvent` |
| Combat | `CombatEvent` |

The `2.1` migration adds ONE composite index
(`TimelineEvent(userId, type, occurredAt)`) for the log explorer — pure
`CREATE INDEX`, additive and safe (docs/DATABASE-MIGRATIONS.md).

## Data provenance contract

Every figure carries one of (UI-labelled, never silently upgraded):

- **EXACT** — read verbatim from a Torn record (log payload field, API value).
- **DERIVED** — deterministic computation from exact observations.
- **ESTIMATED** — needs a documented game convention or external price
  (always shown with an "estimated" marker).
- **INFERRED** — bounded conclusion from observed evidence that logs cannot
  attribute (rendered with "~" and an explanation).

Coverage/confidence follows the existing model (docs/DATA-CONFIDENCE.md):
when the bar history does not cover a range, balances and inference rows are
**withheld** ("unavailable"), never faked.

## 1. Energy Analytics (`/energy`, `GET /api/energy/summary`)

Question: *where did my energy come from and where did it go?*

| Figure | Semantics | Source |
| --- | --- | --- |
| Natural regen | derived | `BarsSnapshot` rises net of known gains |
| Points refills | exact (+exact points spent) | log `Points energy refill use` → `data.energy_increased`, `data.points_used` |
| Xanax energy | **estimated** (+250/use) | `DrugEvent` success; normal-use logs carry NO energy field — documented wiki convention (`XANAX_ENERGY_ESTIMATE`) |
| Energy drinks | exact | `ConsumptionEvent` category=energy → `energy_increased` |
| Gym | **exact** | `Gym train *` logs → `data.energy_used` (per train count) |
| Attacks / reviving | inferred (bounded) | bar declines overlapping ±15 min of outgoing attacks; never a log read |
| Other declines | inferred (bounded) | observed declines minus explicit attributions |
| Overdose losses | exact | overdose logs → `data.energy_decreased` (an Ecstasy OD drains happiness, not energy, so it never appears) |

The daily/weekly/monthly chart stacks gained/spent/lost. Coverage states the
share of observed outflow that explicit logs attribute; "Net energy" only
renders when bar history covers the range.

Known limits: reviving/hunting energy use is not in Torn's log payloads and
revives are not ingested — they stay inside the bounded "attacks & reviving"
inference or untracked, never as exact rows. `BarsSnapshot` caps the analyzed
bar window (~70 days at 5-min cadence); longer ranges keep exact rows but
degrade coverage to partial/unavailable.

## 2. Drugs & Rehab 2.0 (`/drugs` extensions)

- Overview adds **good streaks**: current run since the last overdose and
  the longest run, computed over the FULL recorded history up to the range
  end (clipping streaks to the range start would fabricate resets).
- Per-substance table adds current/longest streak, last use, last overdose.
- Rehab adds: total addiction points removed (exact where the payload
  carries them), **cost per AP** (only when EVERY costed visit carries an AP
  value — a partial ratio is refused) and an **estimated next visit cost**
  (median of the most recent costed visits; rehab pricing scales with
  addiction level, so it is an estimate, never a quote).

## 3. Travel Analytics 2.0 (`/travel` extensions)

- Hero adds flight time (sum of completed-trip durations — exact own-history
  data), trips/day, destinations visited and profit/trip.
- "Activity by departure day" chart gets three lenses: Profit / Trips /
  Flight time. Daily profit uses the ONE canonical semantics
  (`buildDailyTravelProfit`): estimated resale net of spend; unknown-value
  items contribute **−spend** (pessimistic, never a fabricated gain).
- New "Destination breakdown" table: trips, flight time, average flight,
  items, spend, profit/trip, profit/hour (estimated) and last visit — over
  completed trips only; open trips count but contribute no flight time.
- "Best historical" intelligence is **descriptive** (historical averages);
  it never recommends a next flight.

## 4. Log Explorer (`/logs`, `GET /api/logs*`)

- Filters: date range (shared SegmentedDateRange), category, log type
  (title), free search (title/category), money outcome (gains/losses) and
  min/max |amount|. Options come from the user's OWN archive
  (`/api/logs/meta`, bounded counts).
- Rows: timestamp, category, type, payload summary, signed money, signed
  energy and an expandable bounded payload digest. The raw payload never
  ships wholesale.
- Money reuses the canonical signed-cash reading (`signMoneyLog`, shared
  with the money ledger — an amount here can never contradict the ledger);
  unknown-direction money shows NO amount (unknown never becomes income).
- Pagination is keyset/cursor (50/page) — no 50k-row dumps.
- **Export**: `GET /api/logs/export?format=csv|json&…filters` streams
  server-side in 500-row batches with a hard 50,000-row cap. Exports are
  session-scoped (auth = the session cookie through the same-origin proxy),
  contain only the user's own log data, and never contain API keys,
  credentials or infrastructure details. Rate-limited to 10/10 min.

## Ingest cadence & backfill

Deep analytics reuse the existing per-resource sync cadence (adaptive tiers;
see docs/SYNC-RELIABILITY.md). Nothing about scheduling changed in 2.1.0.

Operator CLI (runs like every repo CLI, inside the compose network via
`docker compose exec worker pnpm backfill …` or from the host with
`DATABASE_URL` pointed at the instance):

```
pnpm backfill status [--user <id|email|tornId>]   # coverage report (read-only)
pnpm backfill start [--user …] [--deep]           # enqueue historical resources
```

- `start` enqueues the historical resources (drugs, travel, rehab,
  money_logs, events, attacks) onto the EXISTING worker queue — the same
  rate-limited, resumable, dedupe-safe pipeline. No second worker is
  started; the CLI returns immediately (no babysitting).
- `--deep` additionally resets the cursors of non-running historical
  resources so the walk re-enters initial-window mode
  (`TORN_SYNC_INITIAL_HISTORY_DAYS`, default/max 180 days).
- Depth is ultimately bounded by **Torn's own log retention** — rows Torn
  pruned are unrecoverable; whatever was stored stays permanently.

## Rate-limit safety

All Torn traffic flows through the existing client limiter
(`TORN_API_MIN_REQUEST_INTERVAL_MS`, default 700 ms ≈ 85 req/min) with
retry/backoff on 429/transient/network errors and `capability_denied`
parking. 2.1.0 adds **zero** new Torn selections and **zero** page-triggered
fetches; the backfill CLI only re-enqueues existing resources.

## Performance

Measured on production data (~50k archived logs, owner account, 2026-10):

| Query | 30D | 1Y | ALL |
| --- | --- | --- | --- |
| Log explorer page (keyset page of 50) | 0.22 ms | 0.20 ms | 0.08 ms |
| Log meta (category distinct) | — | — | 14 ms |
| Energy evidence (refill / gym) | — | 6–8 ms | — |

Aggregation happens server-side; no endpoint ships raw row sets to the
browser.

## Privacy & retention

Exports contain only the session profile's own rows (isolation tests
enforce it). History is permanent by design ("history is unrecoverable from
Torn once pruned") — no analytics retention job exists; guest-profile
cleanup (docs/HOSTED-SECURITY.md) is the only data lifecyle.

## Known limitations

- Xanax energy is the documented +250 convention (estimated), and bar
  snapshots can miss between-poll consumption — the ledger reports
  unresolvable delivery as "unresolved", never as loss.
- Attack/revive energy attribution is bounded inference from bar declines.
- Revives, hunting energy and dump searching are not ingested (no exact
  Torn payload) — omitted rather than invented.
- Rehab cost/AP requires AP values on every costed visit.
- Demo data includes representative deep-analytics rows (gym/OD/archive
  logs) so the pages render meaningfully in demo mode.
