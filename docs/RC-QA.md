# v0.2 Release-Candidate QA

The final pre-release content, semantic and visual audit (roadmap #9).
Every finding below was either fixed on `develop` or listed as an accepted
limitation. Date of audit: 2026-09-11, at develop `f63f466`+RC commits.

## Method

- Two exhaustive source audits (copy/terminology/enums; formatters/units/
  signs/legends) covering every route and shared module.
- Mechanical sweeps: 22 common misspellings (zero hits), `defence`
  (zero), raw enum + raw API-field greps, `en-US` date audit, `/economy`
  dead-route grep.
- Source-contract tests that keep the guarantees true (see §Tests).
- Live render pass at 390/768/1280 with zero-overflow + console-error
  assertions, plus judge review of full-page screenshots.
- Read-the-page review of every route in demo view.

## Findings and fixes

### Units / formatters (critical — all fixed)

| Issue | Scope | Fix |
|---|---|---|
| Battlestat deltas/totals, gain/day, energy, energy trained, awards rendered with `$` (currency formatter on non-money units) | Progression page (24 sites), Overview glimpse (2), Daily Summary training strip (2) | New `formatNumberCompact`/`formatSignedNumberCompact`; every site swapped; source-contract tests block reintroduction |
| "$1.2k E" double-unit on happy-jump energy | Progression jumps | Number formatter (renders "1.2k E") |
| Money chart axes unit-less ("12.5m" next to "$12.5m" KPIs) | Overview NW, Money ×2, Crimes value, Travel profit | `moneyValueAxis()` with `$` ticks; progression keeps the unit-less axis |
| Chart tooltips showed raw integers on money series | same charts + money donut | `moneyTooltipValue()` / donut formatter with compact `$` |

### Signs / zero-vs-unavailable (fixed)

- Daily Summary highlight kinds rehab/drug-use/asset-conversion are positive
  magnitudes but rendered "+$250k" (costs looking like gains) → signed
  formatter now applies only to genuinely signed movements.
- Overview "Spent"/"True expenses" rows rendered "+$1.2m" → unsigned.
- Daily Summary battlestat strip could render "+-…" on a negative delta →
  conditional sign.
- Null coerced to fake zeros: energy-trained sentence ("$0 of energy"),
  economy-effect prose ("a net of +$0"), combat respect ("+0 gained") →
  "—" / guarded phrasing.

### Copy / terminology (fixed)

- Dead route: notification click paths to `/economy` (no such route) →
  `/money`; contract test guards the registry and producers.
- Raw capability keys in notification copy ("lacks canReadUserEvents
  access") → human labels.
- Raw snake_case delivery status ("invalid_subscription") → human label;
  sync toasts named raw resource slugs ("money_logs") → resource labels;
  sync category status map gained `capability_denied` ("Permission
  needed") + humanized fallback for future codes.
- Developer speak on ComingSoon/faction/stocks placeholders (table names,
  "awaits the sync implementation") → user language.
- Terminology: "Net Worth Change" → "Net worth change"; "Likely Happy
  Jump" → "Likely happy jump"; "Happy items" casing aligned to the
  canonical label map; "dashboard" → "Overview" in error/empty copy.
- Pluralization: "1 attempts", "1 uses in range", "1 covered days",
  money-page singular verb → all conditioned.
- Range prose: "across 7d" / "Across all" → "across all time" for `all`;
  compact control labels (1D/7D/…) intentionally kept for the segmented
  control.
- Date policy: two en-US formatted dates → en-GB (dd/mm), matching the
  shared formatter contract.

### Verified clean

- Zero misspellings across 22 common patterns; no `defence`.
- No percent double-scaling anywhere (every share/ratio ×100 exactly once).
- No duration/epoch confusion; countdowns clamp negatives to Ready/Full.
- No raw API-field leaks (`lastHeartbeatAt`, `energy_increased`, …) in copy.
- No localStorage/sessionStorage token or key storage; service worker
  caches no API responses.
- Chart legends match series names/keys on all seven chart surfaces.
- A11y labels match the redesigned UI (no stale "card"/route references).

## Judge round 2 (post-fix verification)

A second independent judge pass over the fixed build verified: no "$" on
battlestats/energy/gain anywhere; money always "$"; conversions worded as
movement; travel profit labeled estimated; build identity
"0.2.0-dev.0 · <sha>" + Development chip visible on Overview and Settings;
Today/Settings pass. Two judge flags were verified as judge misreads
(progression parts-vs-total: API closings sum EXACTLY to the headline
total and shares sum to 100%; overview-vs-drugs drug counts: both
endpoints report 49 — the "69" was a stale/other-window render).
One real fix landed from this round: the Overview glimpse energy figure
now matches the progression page (likely-only sessions).

## FINAL REMEDIATION PASS

Follow-up remediation with end-to-end data-correctness verification.

| Area | Issue | Severity | Before | After | Test | Status |
|---|---|---|---|---|---|---|
| Row caps | Capped aggregates (economy/money/progression) computed over clipped windows with no disclosure; no deterministic ordering | HIGH | 250k/100k/20k caps silently clipped; arbitrary row order | Env-injectable caps, oldest-first ordering, analysis_truncated confidence reason + response flag | row-cap-truncation.test.ts | FIXED + VERIFIED |
| Cross-page | Overview glimpse counted "possible" sessions as energy trained; progression counted "likely" only — same label, 2,128 vs 1,816 | HIGH | Two definitions behind one label | Glimpse uses the same likely-only definition | golden-data parity via shared service; verified live | FIXED + VERIFIED |
| Timeline | Raw machine tags rendered on ledger rows ("MONEY_POINTS", "ITEM_USE_DRUG") after CSS uppercasing | HIGH | categoryLabel kept underscores | Humanized to "Money Points" et al. | semantic-units contract | FIXED + VERIFIED |
| Energy | Golden-data end-to-end identity unproven | HIGH | — | Fixture proves opening 10 + sources 290 - uses 280 = closing 20, exact attribution (refill exact, Xanax estimate, regen derived), training likely, no residue | golden-data.test.ts energy | FIXED + VERIFIED |
| Battlestats | No end-to-end no-swap proof | MEDIUM | — | Injected distinct per-stat deltas (1000/2000/3000/4000) surface exactly; shares sum to 1 | golden-data.test.ts battlestats | FIXED + VERIFIED |
| Economy | No end-to-end classification/wallet golden | MEDIUM | — | Salary=true income; bazaar/bank/items=conversions; rehab=true expense; unknown disclosed; wallet reconciles residual 0 | golden-data.test.ts economy | FIXED + VERIFIED |
| Drugs | Cross-page count consistency unproven at API level | MEDIUM | — | Daily Summary xanax.consumed = seeded rows; sponsored semantics remain covered by armory suite | golden-data.test.ts drugs | FIXED + VERIFIED |
| Travel | Today-Travel agreement unproven; unknown valuation rendered "$0" | MEDIUM | "$0 est. value" | Single canonical calculateTravelProfit asserted equal on both surfaces; unknown valuation renders "est. value unknown" | golden-data.test.ts travel + UI guard | FIXED + VERIFIED |
| Timezone | DST day-boundary proof at API level | LOW | — | Amsterdam 23h/25h days resolve contiguously | golden-data.test.ts timezone | FIXED + VERIFIED |
| Legacy | Upgraded profile without bars history | MEDIUM | — | Battlestats work; energy.covered false; energyTrained null — never fake 0 | golden-data.test.ts legacy | FIXED + VERIFIED |

### Reopened-check result

Every previously fixed RC finding was re-verified at current HEAD via the
source-contract tests (currency-free progression, net-worth-never-profit,
happy-jump-never-confirmed, no dead /economy targets, timeline humanization,
compose env consistency, single version source). No regression found.

### Cross-page consistency map (verified same-definition)

- Net worth: Overview = Timeline = Economy NW lens (official snapshots).
- Cash received/spent: Today = Economy for the same local day (golden test).
- Travel profit: Today = Travel (single calculateTravelProfit).
- Xanax: Today = Drugs (same DrugEvent source); Progression treats Xanax
  energy as an estimate and never as money.
- Energy trained: Overview = Progression (likely-only, same window).
- Battlestat gain: Overview = Progression (same hourly bracket anchors).

## Accepted limitations

- Compact axis ticks (chart internals) are money-aware but KPI cells remain
  the canonical full-precision surfaces.
- `1D/7D/30D` compact control labels coexist with "This Month" prose labels
  (periodLabel) — compact-control context is intentional.
- Demo/Limited surfaces that lack any data show structural empty states, not
  per-figure "—"; figures themselves follow zero-vs-unavailable rules.

## Walkthroughs

- **Demo (Full-equivalent)**: all 13 routes read page-by-page in demo view;
  numbers coherent, legends/units correct, no raw enums after fixes.
- **Limited**: capability matrix explains each locked section; no false
  zeros; no raw permission codes (locked rows say which permission is
  missing in plain words).
- **Mobile 390**: bottom nav reaches every route; no overflow; jump
  evidence in disclosures; no clipped units (16-width sweep clean).
- **Tablet 768 / Desktop 1280–1920**: two-column groupings and dense rail
  composition verified with full-page screenshots.

## Tests added

- `packages/shared/tests/formatters.test.ts` — money vs number formatter
  contracts (sign/scale/zero/null), build identity format.
- `apps/web/tests/semantic-units.test.ts` — source contracts: no currency
  formatter on progression, net-worth-never-profit, happy-jump-never-
  confirmed, no `/economy` click targets.
- `packages/shared/tests/compose-consistency.test.ts` — compose variants
  share critical env across api/worker (VAPID-class bug guard), sandbox
  options uniform, single version source.
- Suite totals at audit time: **1010 tests / 84 files**, all green.
