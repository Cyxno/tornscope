# TornScope 2.0 — Semantic Intelligence Audit

**Principle: "Correct math is not enough."** An insight or projection is only
valid when (1) the computation is right for the stored data AND (2) the model
matches the Torn mechanic behind the metric. Where TornScope cannot model the
mechanic reliably, it shows the observation and refuses the forecast.

Trigger for this audit: battle-stat goal projections used
`remaining_stat / observed_gain_per_day`. In Torn, per-train gym gain scales
with the CURRENT stat (plus happiness, gym, faction/education/company
modifiers, and better gyms over time) — so a frozen absolute gain/day is the
wrong mechanic for any target that is a multiple of the current stat. This was
semantic, not arithmetic: the numbers were correct for the data and wrong for
the game.

---

## Intelligence taxonomy (2.0.2)

TornScope intelligence comes in exactly three levels, and every surface says
which one it is:

1. **DESCRIPTIVE** — what actually happened (records, observations,
   comparisons). All insights, all charts, all "recent growth" figures.
2. **EMPIRICAL PROJECTION** — a historical pattern is extended forward with
   guarded assumptions and explicit uncertainty. **Battle-stat goals are
   HERE.** This is not a shortcoming to hide: it is the honest statement of
   what TornScope knows.
3. **MECHANISTIC PROJECTION** — the game mechanics themselves are modeled
   from reliable parameters. **TornScope ships none of these today**, and
   none may be implied by copy or confidence.

Model naming: the battle-stat model is the **empirical compounding** model.
Its public contract value stays `relative_compounding` (renaming a shipped
API value buys nothing), but every description now says empirical:
calibrated on observed conditions — never "accounts for all modifiers" or
"models current modifiers".

### recent_conditions_assumed

The load-bearing assumption: recent conditions roughly persist. That fails
when a temporary gym-gain book wears off, faction Steadfast changes, the
company or education changes, happiness or training strategy shifts
materially, energy/day changes structurally, or a better gym unlocks.
TornScope does not detect these events (no new Torn calls, no new sync
resources in this patch); instead the uncertainty is carried structurally:

- projection confidence for stat goals = min(statistical fit confidence,
  horizon confidence, MODEL confidence cap = "medium") — a statistically
  perfect fit NEVER becomes a high-confidence forecast;
- the ETA is always a RANGE at medium/low confidence (regime-change floor
  −8%/+15%);
- the UI states the basis and the limits verbatim ("uses your recent
  relative stat growth… does not simulate future gym unlocks or changes in
  happiness, perks, books, faction bonuses or training frequency").

### Temporary regimes — investigated, deliberately not auto-detected

Read-only check: TornScope stores consumption events (incl. happy-jump
evidence) and session inference with "likely/possible" strength, so boost
periods are sometimes VISIBLE — but as inference-grade signals, not reliable
facts, and book usage is not synced at all. Per patch policy (no new Torn
endpoints): temporary regimes are therefore NOT auto-detected; the
documented limitation above is the mitigation.

### Total battle stats — decision

One exponential fit over the TOTAL series is kept, explicitly labeled as a
BEHAVIORAL projection: the goal target IS a total, and the projection says
"this observed total pattern continues under current conditions" — it makes
no per-stat mechanic claim. When a player trains a single stat, the total's
growth is that stat's growth plus three static components; the empirical
label (not "Torn scaling model") is what keeps this honest. Least complex
semantically-correct option; distribution-stability suppression (option C)
is unnecessary for a behavioral claim.

---

## Projection inventory

| Metric | Previous model | Torn-correct? | New model | Confidence method |
|---|---|---|---|---|
| battle stats (total + strength/defense/speed/dexterity) | Linear: `remaining / median gain-per-day` | **NO** — gain/train scales with the current stat; linear freezes today's absolute gain | **EMPIRICAL PROJECTION** `relative_compounding` (stat-projection.ts): least-squares fit of ln(stat) over the lookback → daily relative rate r; iterative forward simulation `stat(t+1)=stat(t)·e^r`; uncertainty r±SE → ETA range. Empirical, NOT mechanistic — recent_conditions_assumed | fit quality + horizon, CAPPED at medium by the model (perfect fit ≠ trustworthy forecast); regime-change floor −8%/+15%; ETA withheld below gates |
| level | Same linear model | **NO** — level pacing depends on an XP curve and activity patterns TornScope does not store | **No projection** (`mechanics_not_modelled`): observed history stays visible, forecast withheld | n/a — deliberately none |
| net worth | Robust linear (median daily delta + least-squares cross-check, R²/sign gates) | Acceptable: the stored value IS the tracked quantity; volatility gates suppress one-off-driven trends; conversions are already excluded from "growth" semantics by the money model | Unchanged linear + **new horizon degradation**: ETA > 1 year downgrades high→medium confidence | Existing R²/method-agreement gates + horizon degrade at 365d |
| liquid wealth | Same linear model | Acceptable with the same caveat; asset conversions DO move liquid wealth by construction — that is what the metric is, and the fit gates reject conversion-driven sawtooth as noise | Unchanged + horizon degradation | As net worth |
| wealth projection (Economy "projectedIn30d") | Linear 30d ahead of the 30-day median velocity, withheld unless confidence ≥ medium | Acceptable: fixed short horizon, explicitly labeled "projection, not prediction", never shown for flat/noisy trends | Unchanged (already gated) | observedTrend confidence (median×LSQ agreement + R²) |
| travel / rehab / drugs / stocks | No projections existed | n/a — these surfaces are descriptive only | Unchanged — explicitly confirmed: no future profit/behavior/appreciation is ever forecast | n/a |

## Insight inventory

Every rule runs over stored history; none projects the future. Classification
after audit (descriptive = direct observation, comparative = period A vs B,
inferred = reasonable derivation, projected = future claim):

| Insight | Type | Mechanic-dependent | Verdict | Change |
|---|---|---|---|---|
| networth_growth_shift | comparative | wealth composition drifts, but both periods are measured the same way | KEEP | none |
| income_shift | comparative | true-income semantics (conversions excluded) | KEEP | none |
| spending_spike | comparative | true-expense semantics | KEEP | none |
| travel_profit_shift | comparative | estimated resale (labeled estimated; unpriced trips suppress) | KEEP | none |
| rehab_spend_high | comparative | visits vs cost from logs | KEEP | none |
| xanax_usage_shift | comparative | cumulative counter deltas | KEEP | none |
| training_efficiency_shift | comparative | gain/E from session inference; explicitly observational wording | KEEP | none |
| personal_record (best training week) | descriptive | session inference; "observed" wording | KEEP | none |
| wealth_contributor_shift | comparative | official snapshot category deltas | KEEP | none |
| energy_capped_elevated | comparative | BarsSnapshot capped-hours (lower bound) | KEEP | none |
| best_income_day | descriptive | true-income day records | KEEP | none |
| networth_record | descriptive | official snapshots, staleness-guarded | KEEP | none |

**No insight was projected**, so none needed downgrading — but the audit now
pins that property: the registry documents each kind's class, and future rules
that make future-claims must ship a mechanic model or be rejected.

Command Center conclusions inherit goal ETAs and were fixed by the projection
fix (goal "almost there"/"behind pace" now reason over the compounding model;
nothing else in the feed extrapolates).

## Battle-stat model — exact specification

- **Input data** (all stored, zero new Torn API calls): battlestat snapshot
  series within the lookback (7/30/90d), current value, target.
- **Calibration**: OLS on `(day, ln(stat))` → daily relative rate r (implicit
  carrier of the player's real happiness, faction/education/company perks,
  gym and energy/day: what they ACTUALLY achieve).
- **Scaling**: only the stat-scaling component is modeled forward — the
  calibrated environment is held constant ("current conditions").
- **Method**: iterative simulation `stat(t+1) = stat(t) · e^r` until target;
  central ETA = `ln(target/current)/r`. No closed-form shortcut, so the
  modeled gain each day is computed at the grown stat.
- **Gym handling**: TornScope stores no gym membership/dots/XP data, so gym
  unlocks are NOT predicted. Single "current conditions" scenario; the
  assumption is stated verbatim in the UI tooltip.
- **Happy/modifier handling**: folded into the calibration (observed gains
  already contain them); only the stat-scaling component is extrapolated.
- **Uncertainty**: slope standard error → ETA range [fast, slow]; ranges are
  floor-limited to −8%/+15% around the central estimate (a clean historical
  fit cannot speak for future regime changes).
- **Confidence**: high = R² ≥ 0.7, ≥20 points, span ≥ 70% of lookback, ETA
  ≤ 1 year (single date); low = ETA > 2 years or thin sample; medium =
  otherwise (range).
- **Withhold conditions**: <5 points, <5-day span, target <1.02× current,
  r ≤ 0 (no growth), R² < 0.3 (too volatile), ETA > 5 years (beyond horizon),
  target already reached.

## Removed / downgraded intelligence

- **Removed**: exact battle-stat ETA dates computed from frozen gain/day
  (the semantic bug) — replaced by the calibrated compounding model.
- **Removed**: level-goal ETAs entirely (was a linear fit of a step-shaped
  history — manufactured precision).
- **Downgraded**: battle-stat ETA at medium/low confidence now presents a
  range ("~4–6 months") instead of a date; high confidence is required for a
  single date and only within a one-year horizon.
- **Downgraded**: wealth-goal ETAs beyond one year degrade from high to
  medium confidence (horizon degradation).
- **Deliberately NOT built**: a gym-unlock scenario ("optimistic projection") —
  TornScope cannot reliably predict unlocks, and inventing one would be fake
  intelligence. Current conditions only.

## Tests

New semantic regression suite `packages/analytics/tests/stat-projection.test.ts`:
- CASE A: 1M→10M is not `remaining/gainPerDay` — modeled daily gain grows
  with the stat (simulated gains verified to double mid-trajectory; linear
  answer ≈1800d explicitly excluded, compounding ≈461d asserted).
- CASE B: 1M vs 100M profiles with equivalent calibrated behavior → same
  relative ETA, 100× absolute first-day gain.
- CASE C: implicit +10% modifiers shorten the ETA ≈ 10% without knowing
  which modifier changed.
- CASE D: unstable history → confidence low, ETA withheld (`too_volatile`)
  while descriptive observed growth remains available.
- CASE E: insufficient history → no ETA, ever.
- CASE F: distant goal → confidence degraded, honest RANGE returned
  (brackets central estimate, regime-change floor enforced).
Plus: withhold on receding series/beyond horizon; determinism; schema tests
pin the `model`/`etaRangeDays`/`observedChangePerDay` contract and the
`mechanics_not_modelled` reason; UI contract tests pin range rendering,
"(observed)" labeling and the assumptions tooltip.

2.0.2 additions (confidence semantics):
- CASE G — regime change (slow → fast halves): the recent regime MAY be
  extrapolated, but confidence is never high and the range is present.
- CASE H — boost-shaped window with a statistically perfect fit (R²>0.9):
  medium confidence with range — a perfect fit is not extreme certainty.
- CASE I — total battle stats with single-stat training: stays an honest
  behavioral projection (no mechanistic claim).
- CASE J — long horizon with a perfect fit: LOW confidence with range, never
  a high-confidence exact date.
- policy pin: STAT_PROJECTION_POLICY.CONFIDENCE_CAP === "medium";
  minConfidence picks the most conservative level.
