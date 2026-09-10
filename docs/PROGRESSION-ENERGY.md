# Progression & Energy Intelligence

Progression turns the previously placeholder `/progression` route into a
first-class analytics area. Its defining rule: **never invent data**. Every
figure is labeled with what kind of knowledge it actually is, and anything
Torn's surfaces cannot tell us stays visibly unknown.

## 1. Data sources (audited before design — see git history)

| Source | What it provides | Historic? | Provenance |
|---|---|---|---|
| `PersonalStatSnapshot.stats` (hourly, `personal_stats` resource) | **`battle_stats` group: exact strength / defense / speed / dexterity / total values** (nested `cat=all` JSON; extractor tolerates flat shapes). Cumulative counters: `drugs.xanax`, `drugs.ecstasy`, `other.refills.energy`, `items.used.candy`, `other.awards`. | From first personal-stats sync | exact-at-snapshot; deltas **derived** |
| `BarsSnapshot` (5-minute, **new `bars` resource**) | energy current/max, happy current/max | **Going forward only** — Torn exposes bars live-only; TornScope snapshots them from collection start. No retroactive history exists or is fabricated. | exact-at-snapshot |
| Timeline log `"Points energy refill use"` | raw payload carries `energy_increased` (the exact refilled amount) and `points_used` | log history (money_logs walk) | **exact** per event |
| `DrugEvent` | Xanax / Ecstasy uses with outcomes | log history (drugs walk) | exact events; **energy is NOT in the payload** |
| `ConsumptionEvent` (`energy` / `candy` / `happy_jump`) | item-use raw payloads carry `energy_increased` / `happy_increased` where Torn records them | log history | exact where the field exists |
| `CombatEvent` | attack timestamps (competing-energy evidence). Torn provides **no energy cost per attack** | attacks walk | evidence only — never attributed spend |
| `UserSnapshot` | level history | from profile sync | exact-at-snapshot |

**What Torn does NOT provide (and TornScope therefore never claims):**
- gym-training logs — training is not logged anywhere; personalstats has **no
  train counter** (verified against live stored JSON)
- exact per-train gains or an energy-per-train constant
- the energy effect of a normal Xanax use (raw payload is `{item, faction}`;
  only overdoses carry `energy_decreased`)
- happy at arbitrary past moments before bar collection started
- happy-jump start/end records — "happy jump" is never a Torn classification
- per-attack energy costs

## 2. Provenance classes

- **exact** — recorded by Torn verbatim (bar readings, battlestat snapshot
  values, refill `energy_increased`, happy deltas where logged).
- **derived** — deterministic from exact observations (battlestat deltas,
  natural regeneration between snapshots, milestone crossing windows).
- **estimated** — relies on one documented convention: `XANAX_ENERGY_ESTIMATE
  = 150` per normal Xanax use (`packages/analytics/src/progression.ts`). Cap
  interactions surface as reconciliation overshoot instead of silently
  inflating regeneration.
- **inferred** — pattern-based classification (training sessions, happy
  jumps). Always shipped with the evidence list and a "missing" list.
- **unavailable** — no reliable basis; rendered as "—", never zero.

## 3. Energy model

`buildEnergyLedger(bars, gains, competing)` walks consecutive bar snapshots:

- **rise** minus known gains inside the interval = **derived natural
  regeneration**; the median rate over clean regenerating intervals is the
  personal `regenPerHour`.
- **pinned at cap** (`e0 == max && e1 == max`) → `cappedSeconds` (a
  snapshot-bounded *lower bound*, worded "observed at cap for at least…");
  potential regeneration during cap time is estimated from the personal rate
  and explicitly **never counted as banked energy**.
- **decline** → observed spend. Known gains inside a decline materialize
  fully and the net decline adds on top (`spend = gains + |dE|`).
- **known gains that exceed the observed rise** (refill at cap, Xanax
  estimate near cap) → `absorbedOvershoot`, surfaced in the UI.
- Exact sources are preferred when attributing a rise: the estimated Xanax
  amount is applied only after exact gains.

Reconciliation quality: `full` (≥2 snapshots), `partial` (fetch bounds cut
the range), `unavailable` (<2 snapshots). Residuals are never hidden and
never zero-filled.

## 4. Attribution of energy spend

- **Training** is inferred: a burst of energy declines (each ≥
  `SESSION_MIN_DROP`, merged within `SESSION_MERGE_GAP_SECONDS`) that
  overlaps no attack window (`ATTACK_COMPETITION_SECONDS`).
  - `likely` — decline **and** a positive battlestat gain in the bracket.
  - `possible` — energy-only (or shared stat bracket); its energy **stays in
    Unattributed**, never counted as training.
- **Unattributed** is first-class: observed declines no evidence explains
  (including anything during attacks — attacks have no energy cost in Torn's
  data, so they are never attributed).
- Stat attribution uses the hourly stat bracket around the burst; when the
  bracket is shared with another burst the gain is `null` (shown "shared
  window"), and a dominant stat (>60% of gain) names the `primaryStat`,
  otherwise `mixed`.
- `gainPerEnergy` only when the bracket is 1:1 with the session, the gain is
  positive, and attributed energy ≥ `SESSION_MIN_ENERGY_FOR_GAIN_PER_E`.

## 5. Happy-jump inference

A deterministic rule engine scores evidence around a training burst
(`detectHappyJumps`): ≥2 Xanax in the preparation window, Ecstasy nearby, a
refill inside the burst, energy/gain far above the player's own session
medians, peak observed happy ≥80% of observed max, a happy item (EDVD) near
the burst. ≥3 signals → **likely**, 2 → **possible**. There is no
"confirmed": Torn proves no such classification. Every jump ships its signal
list, human-readable evidence, and a "missing" list (e.g. "no exact happy
observation during training", "Xanax energy is an estimate").

Comparisons are strictly personal: gain/E vs the player's own earlier
sessions, jump medians vs normal medians — shown only when enough samples
exist.

## 6. Battlestat progression

`battlestatProgression(series, from, to)` anchors on the closest observation
at/before each range end; deltas are bracket deltas — hidden gains between
hourly snapshots are never presented as exact. Growth mode charts cumulative
observed delta from the range start (fair visual comparison across stats).
Milestones (`detectStatMilestones`) report threshold crossings **with their
crossing window** between two observations. Balance is descriptive (share of
total) — no ideal distribution is prescribed.

## 7. Confidence vs inference strength

- **Data confidence** (coverage/freshness) reuses the central
  `DataConfidenceMeta` per backing resource (`bars`, `personal_stats`, `drugs`)
  via the standard `resourceConfidence` derivation.
- **Inference strength** (`likely` / `possible`) is a separate field on
  sessions and jumps — it says how strongly evidence supports the
  classification, not how complete the data is.

## 8. Capabilities & sync

New sync resource `bars` (300s) through the canonical scheduler, requiring
the existing `canReadUserBars` capability — no bespoke worker logic. Feature
matrix additions (surfaced automatically in Settings/onboarding):
`progression_battlestats` (personal stats), `progression_energy` (bars,
optional logs, partial), `progression_training` (bars + personal stats,
partial), `progression_happy_jumps` (logs, optional bars, partial). Limited
keys degrade per section: retained personalstats history keeps battlestat
progression alive while energy analytics degrade to unavailable — the page
never blanks as a whole.

## 9. API

`GET /api/progression` (`ProgressionResponse` in `@tornscope/shared`):
`summary`, `energy`, `battlestats`, `training`, `happyJumps`, `profile`,
`availability`, `confidence` — one payload, two batched read waves (bars
capped ≈70 days at 5-min cadence, stat snapshots capped ≈166 days at hourly;
fetch window extends one 30-day baseline period for personal medians). The
compact `getProgressionGlimpse` feeds the Daily Summary training strip and
the single Overview row.

## 10. Demo data

The demo seed simulates a coherent account: an energy state machine (regen,
training bursts, refills, Xanax — including random Xanax absorbed at cap)
writes the BarsSnapshot ground truth; battlestat gains land on the following
hourly stat snapshot (clean session brackets); refill/EDVD/Xanax/Ecstasy
evidence rows are seeded alongside; one full happy jump (yesterday evening)
detects as `likely` with its complete evidence list, and unattributed drops
exercise the honest-unknown path. Demo never writes global state.

## 11. Known limitations

- Energy/happy history exists only from `bars` collection start — before
  that, energy analytics honestly show "no bar history" instead of estimates.
- All training figures are inferences at snapshot resolution; Torn exposes
  no per-train data, so "gain per energy" is an observational estimate.
- Xanax energy is a documented convention, not a recorded value.
- Milestones carry windows, not exact timestamps; level changes inherit the
  sparse (change-triggered) UserSnapshot cadence.
- Awards are a personalstats counter only — Torn medal/honor detail would
  need the unused `/user/medals` selections and new capabilities.

## 12. Tests

- `packages/analytics/tests/progression.test.ts` — the full semantic matrix:
  extraction, ledger accounting (cap, overshoot, netting, rates), session
  merge/split/competing-evidence, gain/E gating, jump signal grading,
  determinism, battlestat brackets/milestones/percent-null rules.
- `apps/api/tests/progression.test.ts` — DB-backed capability gating,
  zero-vs-unavailable, isolation, timezone-day handling via the Daily
  Summary glimpse, and the demo endpoint.
