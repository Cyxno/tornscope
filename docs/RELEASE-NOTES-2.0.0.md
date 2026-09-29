# TornScope 2.0.0 — Release Notes

**TornScope 1.0 records your Torn history.
TornScope 2.0 turns that history into intelligence.**

2.0 keeps everything 1.0 did — every event and snapshot, every analytics page,
the demo, the push platform — and adds the layer on top: planning, projections,
actionable insight, and a much clearer answer to "why does this page have no
data?".

Everything below is computed from data TornScope **already stores**. 2.0 makes
**zero new Torn API calls** — history works for you now, for free.

---

## Command Center

The Overview now opens with a prioritized attention feed instead of a wall of
equal cards. Deterministic rules decide what surfaces: energy capped (possible
regen loss), a cooldown ready, a bank investment matured, travel landing, an OC
almost ready, education finishing, hospital/jail, a goal crossing a milestone,
the strongest insight of the moment, and data-health warnings.

Discipline is the feature: at most one entry per fact, explicit activation
thresholds (a cooldown ready for two days stops being news), and per-priority
caps. The existing Right Now board (bars + timers) stays directly below it.

## Goals + Projections

Set targets for **net worth, liquid wealth, total or individual battle stats,
and level**, optionally with a target date. Every goal shows:

- **Progress** against the latest stored value (the same official snapshots the
  Economy/Progression pages use).
- A **projection**: where your own 7/30/90-day trend puts the finish, with an
  explicit confidence and the velocity it was derived from.

The projection is deliberately honest. Short history, a flat or receding trend,
or noise that fails the fit gates means **no ETA is shown** — a reason is shown
instead ("Not enough history yet", "No upward trend right now", "Too volatile to
project"). It is a *projection*, never a prediction, and never fake precision.

## Insights

A curated set of deterministic rules compares measured periods of your stored
history and says something only when the data supports it:

- Net worth growth accelerated/slowed vs the previous 30 days
- Income or true spending clearly off your 30-day baseline
- Travel profit above your average; rehab spend at a 90-day high
- Xanax usage changed; training gain-per-energy shifted
- Personal records (best income day, best training week, net worth record)
- Energy wasted at cap; your largest wealth mover changed

Every insight shows the comparison (baseline → current, delta %), the evidence
window, the sample size and a confidence. Rules stay silent below their
significance gates — an empty insights feed means "nothing worth flagging", not
a failure. No LLM decides anything; every figure is reproducible from your data.

## Training Intelligence (Progression)

Built on the existing session inference (no second pipeline): last 7 days vs
the previous 7 days vs your 30-day baseline — sessions, energy trained, stat
gain, median gain/E and hours spent capped — plus personal bests (best gain/E
day, best gain day, best week). With enough sessions, a time-of-day comparison
may appear; it is explicitly **observational** ("sessions between 06:00–12:00
showed +12% observed gain/E") and never claims causation.

## Wealth Intelligence (Economy)

- **Velocity**: 7/30/90-day per-day wealth movement from official snapshots,
  with trend confidence.
- **Projection**: where the 30-day trend points in 30 days — withheld when the
  trend doesn't support it.
- **Attribution**: earned income vs true spending vs asset conversions vs the
  market residual for the selected range. The wealth-first philosophy is kept:
  cash moved into items/stocks/bank is a conversion, never a loss.
- **Records**: highest net worth, highest wallet balance, best income day,
  largest expense day, best wealth day, best travel day (est.).

## Smart Notifications

Four additions to the existing registry — same quiet hours, same dedupe, same
delivery ledger:

- **Goal achieved** (once per goal) and **goal milestones** (50/75/90%, once
  ever per milestone).
- **OC almost ready** with a configurable window (1h–48h before readiness),
  fired once per OC.
- **Notable insights** (opt-in): at most one high-confidence insight per day.

## System Health

A new page answering the question 1.0 couldn't: **"no data — because there is
nothing, or because syncing broke?"**

- **Services**: API (version + commit), PostgreSQL, Redis, worker heartbeat,
  and Torn API reachability derived from real sync outcomes.
- **Sync**: queue depth, active/failed jobs, oldest outstanding job, last
  successful sync.
- **Data freshness**: per domain (money, bars, battle stats, faction, organized
  crime, travel, …) a status of *fresh / delayed / stale / failed /
  unavailable* with the last success age and the machine error reason — derived
  from the sync bookkeeping, never guessed. Stocks/merits are marked *live*
  (fetched on demand), honestly distinct from synced history.

### Semantic correctness: projections that respect the game

After release review, the battle-stat projection was rebuilt. Torn's gym
gains scale with your CURRENT stat — a frozen historical gain/day is the
wrong mechanic for a target several times your level. Stat goals now project
via a model **calibrated on your own observed relative growth** (which
implicitly carries your happiness, faction/education/company perks and
training habits) and **simulated forward iteratively**, so the modeled gains
rise as the stat rises. The result is an honest **range** ("~4–6 months")
unless the calibration is strong and the horizon short, with the assumptions
in a tooltip. **Level goals no longer show an ETA at all** (the mechanic
isn't reliably modelable), and wealth ETAs beyond a year degrade in
confidence. Details: `docs/SEMANTIC-AUDIT-2.0.md`.

---

## Technical notes

- **One additive migration**: a `Goal` table storing user intent only. All
  analytics keep reading the existing snapshot tables. Expand-only — the 1.0.x
  application never reads it, so rollback after deploy needs no data migration.
- **Zero new Torn API calls**: goals, projections, insights and the command
  center are computed from stored history; a single shared fact-gatherer
  (`@tornscope/database`) feeds both the API and the notification worker.
- **Pure analytics, provenance everywhere**: projections, insights and
  intelligence are pure, unit-tested functions with explicit confidence and
  provenance on every figure — same conventions as 1.0.
- **Demo mode includes everything**: the demo seed ships goals (achieved and
  active) and the insights pipeline runs on demo history, so 2.0 is fully
  explorable without an API key.
- Worker additions are throttled (goal evaluation piggybacks the existing
  notification cycle; insight notifications run at most once per day and only
  for opted-in profiles).

See `docs/2.0-ARCHITECTURE.md` for the full design.
