# TornScope 2.3.0 — Decision Intelligence

Release notes · previous: 2.2.0

A real product upgrade: TornScope now turns the user's own historical data
into a small number of explainable, conservative decision signals.
Architecture and production topology are unchanged — one stack, direct-pool
Postgres, zero new Torn API pressure.

## Added

- **Decision Intelligence**: deterministic signals (opportunities, risks,
  trends, anomalies) comparing recent activity (trailing 7 days) against
  the user's own previous-30-day baselines — per covered day, never raw
  absence-as-zero. Categories: OPPORTUNITY, RISK, INEFFICIENCY, TREND,
  MILESTONE, ANOMALY.
- **Personal rolling baselines** across energy, travel, drugs and money,
  with explicit minimum-sample floors and robust statistics (median + MAD)
  so one outlier never drives a signal.
- **Evidence-first explanations**: every signal shows its metric comparison,
  the exact comparison method, limitations, confidence (high/medium/low)
  and provenance (exact/derived/estimated — worst of its inputs; provenance
  never upgrades to confidence).
- **Goal-aware pacing**: signals compare recent pace against the
  straight-line pace implied by a goal's explicit target date — and only
  for goals that have one.
- **Signal lifecycle**: stable keys with first-seen / last-seen / resolved
  semantics, so the same insight never re-appears as "new" on every refresh.

## Improved

- Insights now leads with actionable historical signals (filterable:
  opportunities / trends / risks & inefficiencies) with recently-resolved
  context; the observed-shifts feed remains below.
- Overview can surface up to five high-value decision signals (default 3)
  in a compact strip that loads after the cockpit settles — it never
  delays the cockpit and never duplicates live heads-up alerts.
- Settings → Decision Intelligence: master toggle, per-domain toggles,
  low-confidence visibility, Overview strip size.

## Technical

- One shared deterministic engine (`@tornscope/analytics`), one bounded
  gather per computation over local tables, 60s per-profile cache.
  Measured on the production dataset: gather ≈ 70 ms, engine ≈ 3 ms.
- Preferences and lifecycle state reuse the existing settings KV storage —
  **no database migration**.
- Zero new Torn API calls: computations read exclusively from locally
  ingested history.

## Upgrade

Standard flow: `deploy-prod.sh`. No migration. Running version after
upgrade: `2.3.0`. See docs/DECISION-INTELLIGENCE.md for the full model,
thresholds and limitations.
