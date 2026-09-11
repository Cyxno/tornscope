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
