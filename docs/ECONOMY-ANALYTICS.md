# Economy Analytics — semantic model (v0.2 roadmap item #6)

Economy analytics answer a set of distinct questions about the same money.
The core engineering rule is **semantic correctness**: four concepts are
never conflated, never merged into one number, and never silently summed.

| Concept | Question it answers | Where it comes from |
|---|---|---|
| **Cash movement** | Where did cash enter / leave the wallet? | `MoneyEvent` ledger rows (exact Torn logs) |
| **Asset conversion** | Which movements only changed the FORM of value? | classified ledger rows (bank, stocks, items, points, faction vault) |
| **Economic effect** | What was truly earned / truly lost? | classified ledger rows + derived bank interest |
| **Net worth change** | Why did the official snapshot move? | `NetworthSnapshot` deltas (exact Torn data) |

**These lenses are related, NOT additive.** Cash net + economic net +
conversion net does **not** equal net worth change: net worth also includes
market repricing, inventory revaluation and unobserved activity.

---

## 1. Canonical roles

Every money event carries two independent classifications:

- **Direction** (cash-basis): `income` / `expense` / `neutral` / `unknown`
  — did cash enter or leave the wallet? Neutral = movement between the
  player's own pools (bank invest/withdraw, faction vault).
- **Semantics** (value-basis, `classifyMoneySemantics` in
  `@tornscope/analytics/src/money.ts`): `true_income` / `true_expense` /
  `asset_in` / `asset_out` / `unknown`.

The Economy lenses are compositions of the two:

| Lens term | Direction | Semantics |
|---|---|---|
| Cash received | income | true_income + asset_in |
| Cash spent | expense | true_expense + asset_out |
| Income (economic effect) | income | true_income (+ derived interest) |
| Expense (true) | expense | true_expense |
| Conversion in (assets → cash) | income / neutral | asset_in / own-pool inflow |
| Conversion out (cash → assets) | expense / neutral | asset_out / own-pool outflow |
| Transfer | neutral | — |

Classification is by **machine category + source metadata**, never by
display label strings. The category→semantics table lives once in
`classifyMoneySemantics`; labels live once in `@tornscope/shared/labels.ts`.

Special cases:

- **Stock dividends** are `true_income` (yield on shares already owned), not
  conversions. Ingest classifies them explicitly (`moneyPlanFor`:
  `stock dividend` → stock income); read-side also refines by description.
- **Loan interest paid** is `true_expense` (symmetric rule).
- **Unknown** rows never enter any P&L figure; they are counted
  (`unclassifiedCount`, `unknownValue`) and degrade availability.

## 2. Cash flow

`cashFlow` — only real wallet movements, exact provenance. Includes
conversions by definition (a bazaar sale moves wallet cash); the earned vs
converted split (`trueIncome / trueExpense / assetInflow / assetOutflow`)
keeps it readable. Categories reconcile exactly to the totals — no double
counting (enforced by `overview-economy-consistency.test.ts` and
`cash-breakdown.test.ts`).

## 3. Economic effect

`economicEffect` — the closest figure to profit/loss, and deliberately never
labeled "profit" (acquisition cost bases are unknown):

- **Income** = earned income + **derived bank interest**.
- **Expenses** = true expenses (rehab, fees, upkeep, gym, rent, consumption
  of services). Item purchases are NOT here (they are conversions).
- **Bank interest is derived**: bank logs carry only the withdrawal total
  (principal + interest in one amount). `deriveBankInterest` computes, per
  bank (city / cayman / piggy): `surplus = Σ withdrawals − Σ investments`.
  When the surplus is within plausible yield (`≤ 50%` of recorded principal)
  it is interest — exact whenever all pairs are in range. When withdrawals
  exceed recorded principal beyond that ratio, the split is unattributable
  (principal predates recorded history): **no income is claimed**,
  `interestComplete` goes false and the income KPI degrades to
  `incomplete`. Principal returns are never income.

Estimated economic context (travel profit, consumption value, non-cash
gains) is catalog-estimated, provenance-marked, and never merged into the
exact figures above.

## 4. Conversions

`conversions` — first-class cash ↔ asset exchanges: `cashIntoAssets`,
`assetsIntoCash`, `netCashEffect`, bank-transfer volume and a `byPair`
breakdown (`cash->bank`, `bank->cash`, `cash->stocks`, `items->cash`,
`cash->points`, `cash->faction`, …). Earned income, true expenses and yields
never appear here. Bazaar/item sales surface as `items->cash`; the sale
tiles additionally show the **estimated** inventory value removed (current
catalog prices) — the value difference is labeled estimated and is never
treated as historical cost basis.

## 5. Wallet reconciliation

`wallet` — for the selected range:

```
opening wallet + recorded inflows − recorded outflows = expected closing
residual = actual closing (networth snapshot) − expected closing
```

- Anchors are the closest `NetworthSnapshot.wallet` at/before each range end
  (their timestamps are returned).
- OC payouts credit the **faction member balance**, never the wallet; they
  are excluded from flows (single helper `isOcPayoutRow`) and reported
  separately as `factionBalanceCredits`. They stay earned income in every
  P&L figure.
- The residual is always surfaced: `exact` (sub-dollar), `small_residual`
  (≤ max($1k, 0.2% of flow)), `partial` (known money-log coverage gaps cap
  the grade even when the residual is zero — a perfect match over partial
  history is luck, not proof), `unreconciled` (larger), `unavailable`
  (missing anchors — never zero).
- `explainedRatio` (0..1) is only meaningful when the wallet actually moved;
  UI copy: "X% of the wallet movement is explained by available history";
  leftover wording is "…remains unexplained by available money logs" —
  never "missing". Possible causes are described as possibilities only
  (coverage gap, unsupported Torn log type, event outside recorded history).

## 6. Net worth explanation

`networth` + `explanation` — the official snapshot delta stays separate from
every derived figure and is never called profit.

`explanation.contributors` (deterministic order, |value| desc within
groups):

1. **Recorded** — official Torn category deltas (`cash`, `banks`, `stocks`,
   `items`, `property`, `points`, `company`, `other`) — derived from exact
   snapshots, source "Official Torn net worth snapshots".
2. **Estimated** — travel economic effect (catalog estimate), consumed-item
   accessible value (catalog estimate). Provenance `estimated`; these are
   never summed into the official delta.
3. **Unexplained** — `netWorthUnexplained` = NW delta − recorded net wallet
   movement − estimated effects. Includes market repricing, inventory
   revaluation and activity outside available history — the UI presents it
   as "not explained by recorded activity", a residual, not a cause.

UI wording: "Likely contributors — recorded movements, not proven causes".

## 7. Confirmed vs derived vs estimated

Provenance and confidence are distinct axes (see
[DATA-CONFIDENCE.md](DATA-CONFIDENCE.md)):

- **exact** — verbatim Torn data (ledger rows, snapshots).
- **derived** — computed from exact data without estimation (net cash
  effect, NW contributors, bank interest *amount* — flagged on its row).
- **estimated** — relies on current catalog valuations (travel, consumed
  value, sold-inventory value difference, non-cash gains).
- **unavailable** — no reliable basis; renders as "—", never 0.

Every major section carries `DataConfidenceMeta`; value-level states use
`KpiAvailability` (`ok / importing / incomplete / unavailable`). The
explanation reflects the weakest supporting driver via the wallet
reconciliation quality.

## 8. Major movements

`majorMoneyMovements` surfaces the largest movements across **all** semantic
roles (`income`, `expense`, `conversion_in/out`, `transfer`) so a huge bank
investment is never crowded out by sale proceeds. The floor is adaptive:
`max($1k, 0.1% of total recorded magnitude)`. Deterministic order:
magnitude desc → time asc → id.

## 9. API contract

`GET /api/economy` returns one coherent payload
(`EconomySummaryResponse` in `@tornscope/shared`): `range`, `generatedAt`,
`cashFlow`, `economicEffect`, `conversions`, `wallet`, `explanation`,
`majorMovements`, `series` (flow + cumulative net), `sales`, `nonCashGains`,
`consumption`, `networth`, `travel`, `availability`, `confidence`. User
scoped; demo supported; Limited profiles get retained history with
`stale_permission` and degrade networth-anchored sections to
unavailable-without-fabrication. One bounded `MoneyEvent` fetch (metadata
excluded; OC + sale rows get targeted queries), one aggregation pass, one
market-price map, batched networth/wallet anchors — no N+1 (see
`apps/api/src/services/economy.ts` header for the query budget).

## 10. Demo data

The demo seed mirrors real semantics: bank invest/withdraw pairs with yield
(exercising derived interest), stock dividends as income, an OC payout with
scenario metadata, rental-acceptance expense, gym/rehab true expenses, and
wallet snapshots **derived from recorded movements plus a tiny drift** so
reconciliation shows a small honest residual instead of a fake exact match.

## 11. Known limits

- Bank interest is a range-derived estimate of yield; per-investment rates,
  early-withdrawal penalties and pre-history principal are not attributable
  from historical logs (the live Today view shows the exact current bank
  position from `/user/money`).
- Sold-inventory "value difference" uses current catalog prices, not
  historical cost basis — always estimated.
- Realized stock profit is never claimed (no reliable cost basis per lot);
  stock price movement belongs to net worth valuation.
- Historical rows synced before the dividend rule may sit as direction
  `unknown`; `pnpm --filter @tornscope/database renormalize` re-derives
  stored ledgers after normalizer changes.
- Faction balance sits outside official Torn net worth (Extended Wealth);
  it is reported separately, never merged.

## 12. Tests

- `packages/analytics/tests/economy-lenses.test.ts` — classification,
  bank-interest derivation, conversion pairs, major movements, explainedRatio.
- `apps/api/tests/economy-analytics.test.ts` — DB-backed acceptance matrix:
  lens separation, OC exclusion, reconciliation (exact/residual/partial/
  missing anchors), estimated provenance, capability gating, zero-vs-
  unavailable, isolation, range isolation, demo endpoint.
- `apps/web/tests/economy-copy.test.ts` — user-facing semantic copy
  contracts (cash ≠ income, profit hedged, residual wording).
- Pre-existing: `money-semantics`, `cash-breakdown`, `wallet-bridge`,
  `overview-economy-consistency`, `top-outflow-rental-gym`,
  `real-log-coverage`, `money-transfers`, `zero-vs-unavailable-regressions`.

## Simple / Advanced presentation

Economy and Overview carry a browser-local **Simple/Advanced** preference
(Settings → General, plus a toggle on both pages; default **Simple**).

- **Simple** leads with the official net worth change, the largest category
  shifts ("What changed"), real economic gains/costs (conversions excluded),
  asset shifts ("into assets / into cash"), and the largest recorded
  movements. Wallet turnover is demoted to a cash-details disclosure with
  the Torn-specific explanation: players store wealth in banks, stocks and
  items, so wallet flow volume describes behavior, not performance. The
  wallet reconciliation and its graded residual stay inside the disclosure —
  uncertainty is never hidden.
- **Advanced** is the previous full surface: all four lenses, conversion
  pairs, wallet bridge, category tables, methodology notes.

Terminology contract (never interchangeable):
- **Net worth change** — official Torn snapshot delta (includes price moves
  and conversions).
- **Wallet movement / turnover** — cash through the wallet.
- **Economic effect** — known income minus true costs.
- **Asset conversion / shift** — value changing form.

Focus areas (Settings → General): Everything (default) / Wealth / Training /
Combat reorder Overview section prominence only — every section and route
stays available.
