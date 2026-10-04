# Decision Intelligence (2.3.0)

Deterministic, evidence-backed decision support derived from the user's OWN
stored history. TornScope does not merely report historical metrics — it
turns them into a small number of explainable, conservative signals.

## What it is NOT

- Not a game-bot, not an automatic player, not a pseudo-exact optimizer.
- No live optimization guarantees: a historical signal NEVER claims current
  market availability. Travel/market signals are explicitly labelled
  "descriptive history — not a live recommendation".
- No population benchmarks: the user is compared only with themselves.
- No ML/LLM: all thresholds are deterministic and documented here.
- No new Torn API pressure: signals read exclusively from locally ingested
  history (zero Torn calls per computation).

## Signal model

Every signal carries: stable `id` (lifecycle key), `domain`, `category`,
`title`, one-line `summary`, `evidence` lines (the WHY), `impact` phrase,
`confidence`, `provenance`, deterministic `urgency`, `horizon`,
`metricBefore`/`metricAfter` with `metricUnit`, the exact comparison
`reason` (method sentence), `limitations`, `actionUrl` and `generatedAt`.

### Categories (fixed taxonomy — six, no more)

`OPPORTUNITY` · `RISK` · `INEFFICIENCY` · `TREND` · `MILESTONE` · `ANOMALY`

### Provenance ≠ confidence

- `provenance` (exact / derived / estimated) grades the INPUT data — worst
  of the inputs that feed the signal.
- `confidence` (high / medium / low) grades how much the evidence supports
  the COMPARISON. Exact historical data can still back only a low-confidence
  forward-looking signal (thin samples, estimated values).

Confidence rules: `low` when recent events < 3 or baseline covered days
< 10; `medium` when recent events < 5 or baseline covered days < 15, or
when the signal's provenance is estimated; otherwise `high`.

## Period semantics (one method)

- `recent` = the trailing 7 days `[now-7d, now]`
- `baseline` = the previous 30 days `[now-37d, now-7d)` — **non-overlapping**
- Rates are per **covered day** (a day with at least one in-domain event in
  that window). Raw absence is never zero.

## Baseline & anomaly method

- Baseline center: **median** of per-covered-day totals.
- Anomaly: `|recentRate − baselineMedian| > max(3 × 1.4826 × MAD, 25% of
  median)` with baseline n ≥ 10 covered days and recent n ≥ 3.
- Minimum samples are explicit per signal; below them the signal is
  **suppressed** (and counted in the response), never approximated.
- Median/MAD (robust statistics) are used because outliers (one big sale,
  one big buy) dominate means.

## Signals shipped (v2.3.0)

| id | domain | category | comparison |
| --- | --- | --- | --- |
| `money.spending-anomaly` | money | ANOMALY | recent daily spend vs previous-30d median (3×MAD) |
| `money.income-drop` | money | TREND | recent daily income < 60% of baseline median |
| `money.casino-loss` | money | INEFFICIENCY | casino losses vs baseline median (2× floor) |
| `travel.profit-hour-drop` | travel | TREND | median estimated profit/hour, ≥3 recent / ≥5 baseline trips |
| `travel.best-destination` | travel | OPPORTUNITY | best median profit/hour per destination over 90d (≥3 trips) |
| `drugs.xanax-pace` | drugs | TREND | successful uses/day, ±30% vs baseline |
| `drugs.od-rate-up` | drugs | RISK | overdose rate ≥ 2× baseline (≥10 recent / ≥20 baseline uses) |
| `drugs.rehab-cost-trend` | drugs | TREND | median visit cost, ±25% (≥3 recent / ≥5 baseline visits) |
| `energy.gym-allocation` | energy | TREND | exact gym energy/day, ±30% vs baseline |
| `energy.refill-pace` | energy | TREND | refill count/day, ±50% vs baseline |
| `goals.pace-<goalId>` | goals | TREND | recent pace vs straight-line pace implied by an explicit target date (only goals WITH a target date) |

## Signal lifecycle

Signals carry stable keys so the same insight never re-appears as "new" on
every refresh. State (firstSeenAt / lastSeenAt / resolvedAt) persists in the
existing AppSetting KV store per profile (JSON — no dedicated table):

- first seen → `isNew` for 24h;
- still present → `lastSeenAt` bumps, `resolvedAt` cleared;
- gone → `resolvedAt` set; resolved entries are pruned after 30 days;
- `/insights` shows recently-resolved keys for 7 days.

## Coverage guards

Every comparison requires ≥ 3 covered days recently and ≥ 10 covered days in
the baseline (domain-specific sample floors listed above). Below that, the
signal is suppressed and disclosed (`suppressedInsufficientData`,
`domainsSuppressed`). Coverage per domain is reported in the response.

## User control

Settings → Decision Intelligence: master toggle, per-domain toggles, a
low-confidence visibility toggle, and the Overview strip size (1–5).
Stored per profile in AppSetting KV. No rules-engine UI.

## Performance

One bounded gather per computation (indexed userId+time reads, row caps,
all in a single parallel batch) → one pure engine pass → 60s per-profile
cache. Measured on the production dataset (2026-10): gather ≈ 70 ms, engine
≈ 3 ms. The Overview strip loads after the cockpit settles and never blocks
it. Computation triggers zero Torn API calls.

## Limitations

- Historical comparisons describe the past; they do not predict markets.
- Straight-line goal pacing ignores natural variance.
- Rehab deltas reflect addiction-level changes as much as behaviour.
- Signals are computed on demand and cached briefly; they are not push
  notifications and do not duplicate the live heads-up engine.
