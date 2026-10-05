# Activity & Rewards (2.4.0, expanded 2.5.0)

Casino, openables and other reward-bearing Torn activity, normalized from
raw logs into a generic `ActivityEvent` semantic layer.

## Generic activity model

One `ActivityEvent` row per Torn log that carries activity/reward
semantics: domain, activityType, outcome, input/reward components (cash,
points, tokens, items, non-priceable perks), valuations (input/reward/net),
valuation class (exact/estimated/unpriced), provenance and the raw log
reference (`sourceRef` → TimelineEvent). Game-specific detail stays in the
raw payload (`metadata`), never flattened into columns.

## Money ledger integration

`MoneyEvent` is the accounting ledger; `ActivityEvent` is the semantic
explanation. Casino cash wagers/payments already flow through MoneyEvent —
casino pages do NOT add them twice: their totals come from ActivityEvent
components and the reconciliation diagnostics (repair + audit + /activity)
report the delta between the two views rather than patching it.

**MoneyEvent.amount is SIGNED** (expenses negative) — reconciliations sum
it directly. (The 2.4 diagnostics double-flipped expenses; fixed in 2.5.0.)

Structural ledger gaps, disclosed everywhere the reconciliation appears:
slots/keno/blackjack/high-low/bookie cash never appears in Torn money
logs; lottery/wheel placements are pending with no settlement log.

## Casino coverage

| Game | Status | Semantics |
|---|---|---|
| Slots | supported (win/lose) | one log = one spin; net = won − bet |
| Roulette | supported (win/lose observed patterns) | won includes stake → net = won − bet |
| Keno | supported (win/lose) | net = won − bet |
| Lottery (Daily Dime) | supported (placement) | cost exact; draw settlement not logged → outcome "placed", never a loss |
| Spin the Wheel | supported (all variants when observed) | start = paid entry; outcome log = prize (money/points/item/tokens/free spin/property/hospital/lose) |
| Blackjack | supported (start/hit/lose/win/push observed or expected shapes) | P/L from terminal log; start = placement |
| High-Low | supported (start/rounds/win/lose) | start = placement; win = pot; lose = stake via pairing |
| Bookie | supported (bet/win/lose/refund/withdraw) | placements are pending; P/L from settlements (win: winnings − bet; lose: −bet; refund: 0); withdrawals are balance movements |
| Legacy money logs | supported (2.5.0, repair) | old-format rows with only a signed amount → `casino-legacy` income/stake; game unknown (`game = null`), never guessed |
| Poker | NOT normalized | player-vs-player session semantics; no reliable per-log evidence in local logs (documented gap) |

## Domain coverage (2.5.0)

| Domain | Families | Semantics |
|---|---|---|
| Hunting | sessions, skill level-ups | one log = one session; cost/income exact; net = income − cost; parsed skill level + exact gains; level-ups are progression only |
| Missions | completions | cash exact (0 = known zero), mission credits as a distinct token unit (domain = the unit discriminator); difficulty/agent stay in payload |
| Racing | official finishes, upgrades | position ordinals + "N racing point(s)" grammar exact; skill gains parsed; upgrade spend exact committed cost |
| Bounties | placements, claims | placement = committed cost (the listed reward belongs to the claimer); claim = exact income; target recorded as opponent |
| Education | starts | exact committed course cost + duration context; no completion/ROI fabrication |

All five domains are **semantic-only**: their cash never flows through Torn
money logs, so the ledger does not contain it and nothing is double
counted. The `/activity` page labels every domain `ledger + semantic` or
`semantic-only`.

## Openables coverage

Detected by payload shape (reward components), not title keywords: an
"Item use" log carrying an `items[]` array, an `item2` reward, or a `money`
reward is an opening. Known labels (Drug Pack, Donator Pack, Box of Medical
Supplies, Six Pack, wallets) get display names; unknown future openables
normalize generically as `openable-<itemId>` with reward components
retained. Input valuation uses current catalog market prices and is labeled
"estimated using current market prices" — never presented as exact
historical profit.

## City Finds

No local log evidence exists in the ingested archive — City Finds are
documented as unsupported until real log shapes prove the semantics. No
wiki-fabricated events.

## Valuation & provenance

- cash components: exact (from payload).
- item rewards: quantities exact; catalog-market values estimated.
- points/tokens: exact quantities; valuation unpriced (never silently $0).
- inputs: current market value when the opened item is in the catalog —
  labeled estimated; otherwise unpriced.

## Unknown value-bearing logs

The repair script's dry-run doubles as the unrecognized-value diagnostic:
casino-routed logs without payload semantics, and item-use logs with
money/item keys that no normalizer claims, are counted and listed by
category/title so future Torn log changes become visible.

`pnpm --filter @tornscope/database audit:activities` reports the full
utilization picture (2.5.0): recognized / normalized / analytics-used at
family AND event level, the A–F family classification, and the per-domain
money reconciliation (surfaced, never patched). See docs/VALUE-COVERAGE.md.

Known unclaimed value-bearing families (observed in the archive, left
visible by the audit rather than guessed at):
- `Hunting | Hunting` was claimed in 2.5.0 (sessions + skill).
- Any future payload-shape change lands in class D/F of the audit —
  counted and listed, never silently dropped.
