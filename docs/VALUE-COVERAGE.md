# Value Coverage (2.5.0)

How TornScope turns its locally stored raw event archive into analytics,
how coverage is measured, and where the remaining gaps are.

## The coverage model

Raw `TimelineEvent` rows are the canonical provenance. A family
(category + title) is counted as:

- **recognized** — a normalizer claims it (activity layer: claimed against
  the actual payload sample; specialist routes — money, drugs, travel,
  rehab, itemuse, crimes — claim by route into their dedicated tables)
- **normalized** — semantic rows exist (`ActivityEvent` for the activity
  layer, `MoneyEvent` + domain tables for specialist routes)
- **analytics-used** — the semantic rows reach a product surface
- **value-bearing** — the payload carries value-shaped keys; these get the
  strictest coverage accounting

Coverage is always reported at BOTH family level and event level — a
1-event family and a 10,000-event family count equally as families and
proportionally as events. Family % and event % are never mixed.

## The audit

`pnpm --filter @tornscope/database audit:activities [--matrix]` is the
read-only operator diagnostic. It classifies every family:

| Class | Meaning |
|---|---|
| A | recognized + normalized + analytics-used |
| B | recognized + normalized but unused |
| C | recognized but not normalized (includes value families awaiting repair) |
| D | value-bearing but unrecognized |
| E | non-value / low-value informational |
| F | ambiguous — routed to a domain but the normalizer rejects the sample |

The same command prints the money reconciliation (semantic ActivityEvent
cash vs the signed MoneyEvent ledger per domain).

## 2.5.0 additions

Newly claimed families (all evidence-backed from the production archive):

- **Hunting** — sessions (exact cost/income/net + skill trajectory) and
  skill level-ups (progression).
- **Missions complete** — exact cash (zero = known zero, credits-only
  completions exist), mission credits as a distinct token unit.
- **Racing** — official finishes (position ordinals, exact racing points,
  skill gain) and upgrade spend (exact committed cost).
- **Bounties** — placements (exact committed cost; the listed bounty_reward
  belongs to the claimer, never the placer) and claims (exact income).
- **Education starts** — exact committed course cost + duration context.
  No completion/ROI semantics are fabricated.
- **Legacy casino money logs** — old-format rows whose only value is the
  signed `amount` column (no payload, no game attribution) normalize as
  unattributed legacy casino income/stake; the game stays unknown.

## Ledger vs semantic ownership

`MoneyEvent` is the accounting ledger; `ActivityEvent` is the semantic
explanation. Pages never add both. Cash in hunting, missions, racing,
bounties and education is **semantic-only**: Torn emits no money logs for
it, so the activity surfaces report it once and nowhere else. Casino cash
is ledger-linked; the reconciliation discloses the structural ledger gaps
(slots/keno/blackjack/high-low/bookie cash never appears in money logs;
lottery/wheel placements are pending) instead of patching them.

## Unknown value watch

Any value-shaped log family no normalizer claims stays visible: the audit
lists it by category/title with counts (class D/F), and the repair's
dry-run reports the same gap from the candidate side. Nothing is silently
dropped, and unknown value is never converted to zero.

## Measurement

Run after every repair:

```
pnpm --filter @tornscope/database audit:activities
pnpm --filter @tornscope/database repair:activities --dry-run
```

The 2.5.0 rehearsal on a production-shaped snapshot (3,103 affected raw
rows) produced 3,103 recognized → 3,103 inserted → 0 on rerun.
