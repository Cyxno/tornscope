# Stocks & stock benefits — sources, formulas, honesty rules

## Sources (audited live, Torn API v2, spec 6.13.5)

| Data | Source | Status |
|------|--------|--------|
| Owned shares | `/v2/user/stocks` (`stocks[].shares`) | **Exact** |
| Benefit threshold (`bonus.requirement`) | `/v2/torn/stocks` (public) | **Exact** |
| Payout interval (`bonus.frequency`, days) | `/v2/torn/stocks` | **Exact** |
| Benefit description (reward text) | `/v2/torn/stocks` | **Exact** (human text) |
| Passive flag (`bonus.passive`) | `/v2/torn/stocks` | **Exact** |
| Current price (`market.price`) | `/v2/torn/stocks` | **Exact at capture**; freshness labeled |
| Reward collectible now (`bonus.available`) | `/v2/user/stocks` | **Exact** |
| Cycle progress (`bonus.progress`) | `/v2/user/stocks` | undocumented semantics → **derived, evidence-gated** |
| Item reward values | `TornItemCatalog` (same catalog as Drugs/Travel) | **Estimated** at current catalog price |
| Stock benefit collection history | not reliably classifiable from logs | **not built** (no fabrication) |

Requires the `stocks` user selection — **minimal access (level 1)**.

## Single-block semantics (source-proven)

The `/v2/torn/stocks` bonus is a single OBJECT (not an array) and
`/v2/user/stocks` mirrors it: each stock has exactly ONE benefit block with
one threshold. Multi-block accounting does not exist in the source; the UI
accordingly speaks of "the benefit block", not "blocks 1..n".

## Collection strategy

Live fetch per page view (single-flight, 60s cache) for holdings; the public
stock catalog is cached in-process for 24h. No database tables — holdings are
current-state data with no historical product need (Phase 62 decision:
explicitly no schema change).

## Reward valuation (`classifyReward`)

Classification order against the reward description:

1. `$50,000,000` → **fixed cash** (exact).
2. `100 points` → **points** — rendered as points; TornScope has no defensible
   point-price model, so no money conversion.
3. `100 energy` / `50 nerve` / `1000 happiness` → **bar refill** — no canonical
   per-unit value.
4. `1x Drug Pack` → **item** — valued as quantity × current `TornItemCatalog`
   price (labeled "Est. value at current catalog price"). No catalog coverage
   → **unvalued**. `1x Random Property` → **non-monetary** (inherently
   unpredictable).
5. Passive perks (`a 10% bank interest bonus`, `Private jet access`, …) →
   **non-monetary**.
6. Anything unrecognized → **unvalued**.

**Unvalued never renders `$0`** — value fields are null and the page says
"This reward has no reliable money value, so no yield or payback is claimed."

## Payout timing

| Evidence | Output | Provenance |
|----------|--------|------------|
| `available: true` | "ready to collect" | exact source boolean |
| threshold met, `0 < progress ≤ frequency` | "in ~N days", N = frequency − progress | **derived** (cycle basis shown: "day 3 of a 7-day cycle") |
| anything else | "timing unavailable" | — |

`progress` semantics are undocumented by Torn; the derivation is gated on
complete evidence and never produces negative countdowns. Below the threshold
the benefit is not running, so no timing is claimed at all.

## Formulas

Let `price` = current market price, `req` = benefit share requirement,
`value` = reward value per payout, `freq` = payout interval (days).

- Missing shares (below threshold): `req − shares`
- Est. cost to benefit: `missingShares × price` — **estimate at current price**
- Position value: `shares × price` — **estimate at current price**
- Est. annual benefit: `value × (365 / freq)` — valued rewards only
- Est. yield: `annualBenefit / (req × price) × 100`
- Est. payback: `(req × price) / (annualBenefit / 365)` days

Capital basis is the **required shares' current value**, not the user's whole
position: these metrics measure the benefit alone. The page states that stock
price movement is excluded and that this is never investment advice.

Degradation rules (all tested): unvalued reward → annual/yield/payback null;
missing frequency → annual/yield/payback null; zero or missing price →
cost/yield/payback null; division by zero impossible.

## Confidence / provenance

- Shares, threshold, frequency, reward text: exact.
- Position value, est. cost: exact inputs × current price (freshness shown:
  "captured X ago").
- Item reward value: estimated (current catalog price).
- Yield / payback: estimated, with tooltip explanations.
- No page-wide "Exact" badge — each figure carries its own provenance.

## Known limitations

1. `progress` timing is a derived estimate from undocumented field semantics.
2. Passive perks and point rewards have no money valuation (deliberate).
3. Item valuations move with the item catalog; stale catalog prices are not
   individually labeled beyond the catalog's own freshness.
4. No collection history — TornScope cannot yet identify stock-benefit
   payouts in money logs reliably; revisit if a distinct log category is
   confirmed.
