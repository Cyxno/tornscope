# TornScope Content Style — v0.2

Canonical user-facing vocabulary and copy rules, established during the v0.2
product-finish program. Source contracts live in
`apps/web/tests/product-finish.test.ts` and the semantic copy tests
(`economy-copy`, `semantic-units`, `canonical-labels`).

## Canonical terms

| Term | Use for | Never use |
|------|---------|-----------|
| Net worth | official Torn snapshot wealth | "wealth" alone for the figure |
| Cash movement | money through the wallet | "income" for receipts |
| Cash received / Cash spent | ledger sides | Income / Expenses (labels) |
| Economic effect | value genuinely gained or lost | "profit" |
| Asset conversion (conversion) | value changing form | "gain"/"loss" for conversions |
| Estimated / est. | catalog-priced values | unlabeled estimates |
| Derived | computed from exact inputs | — |
| Inferred | concluded from evidence (sessions) | "deterministic" |
| Unavailable (`—`) | no data | rendering `0` for missing data |
| Battlestats | strength/defense/speed/dexterity | "Battle Stats", "stats" alone |
| Energy / Happy / Nerve | bars; plain numbers, never `$` | — |
| Happy Jump | large inferred training burst | "happy jump exploit" |
| Daily Summary | the Today day record | "daily recap" |
| Sync status | operational page | "Sync run details" |
| History available since | coverage boundary | "backfilled since" |
| Unexplained (residual) | wallet movement not covered by logs | "missing" / "lost" |

## Casing

- Sentence case everywhere: headings, labels, chips, buttons.
- "Net worth" (sentence case) in prose and labels; the KPI label renders
  `NET WORTH` via CSS uppercase only.
- Chip provenance labels are lowercase (`exact`, `derived`, `estimated`,
  `inferred`) unless CSS uppercases them contextually.

## Dates & times

- Day: `DD-MM-YYYY` (`formatDate`); Today page shows weekday for non-today.
- Timestamps: user timezone, `DD-MM-YYYY HH:mm` (`formatDateTimeInZone`).
- Countdowns: `clock` style `HH:MM:SS` or `Xd Yh`; never epoch or raw ISO.
- Never embed a date into a text string via markup; use structured spans
  (see Money rules).

## Money & units

- Money: `formatMoneyCompact` — `$1.25m`, `$666`, **`$0.23` for nonzero
  sub-dollar values; `$0` only for actual zero**.
- Energy/Happy/Nerve/Battlestats/Points: plain numeric or compact number,
  never `$`.
- Percent: only real shares (share of total), one decimal max.
- Durations: duration formatter ("5d 0h", "28m 38s"); annualised rates take
  "p.a.".

## Actions & links

- Buttons are verbs, specific: "Sync now", "Retry failed", "Replace API key",
  "Validate", "Send test notification", "Exit demo".
- Links are destinations, not "here/more": "The full day →", "Open Economy",
  "Review API access in Settings".
- In-app navigation uses SvelteKit `goto` — `window.location` assignments are
  reserved for the profile-deletion hard reset.

## Sentence hygiene

- No trailing space before a period when an inline `{#if}` tail is false —
  keep punctuation flush against the preceding word.
- Pluralize with the explicit ternary pattern (`session{… === 1 ? "" : "s"}`).
- No developer vocabulary in UI copy: resource, payload, cursor, backfill,
  endpoint, legacy, deterministic, stale run. Explain the concept instead
  ("Torn keeps no history for this", "an interrupted sync resumed").
- Raw enum values (`stale_permission`, `capability_denied`, …) never render;
  map them through `syncHealth.ts` copy tables.

## Merits & stocks terminology

| Term | Use for | Never use |
|------|---------|-----------|
| Merit ranks / "7 / 10" | invested levels (exact) | "level 7 of 10" in tight rows |
| Cap | maximum ranks (TornScope-maintained) | "max" alone; never claim maxed without a cap |
| Stock benefit | the recurring reward per stock | "dividend", "bonus payout" |
| Benefit block | the share threshold + reward | "benefit tier" |
| Shares owned | position size (plain number) | shares rendered as money |
| Benefit reached / active | threshold met | "unlocked" |
| Est. reward value | one payout's value | raw "reward" as money when unvalued |
| Est. annual benefit | value × payouts/year | "annual ROI" |
| Est. yield | annual benefit / required shares' current value (%) | "return" |
| Est. payback | capital / daily benefit (days) | exact ROI phrasing |

- Estimates always carry "Est."/"~" and the assumption ("at the current
  catalog price", "at current prices").
- Unvalued rewards render their description (or "—"), never "$0".
- Benefit copy states the exclusion: benefit-only economics, stock price
  movement excluded, never investment advice.

## States vocabulary

- Empty (no activity in range): name the range, offer the action.
- No history: say tracking starts when TornScope begins collecting.
- Partial: one calm sentence, no banners.
- Missing capability: what's missing + why it matters + next action
  ("Review API access in Settings").
- Stale: "Updated Xs ago" / "Last known" — live-looking UI never implies
  freshness it doesn't have.
- Demo: "The demo record covers recent history — today's demo day is still
  empty…" when the seeded day has no activity.
