# TornScope 2.7.0 — Event Reward Coverage

Release notes · previous: 2.6.2

Non-cash reward components that Torn's raw activity logs always carried —
but that had no semantic home — are now parsed, stored, valued where the
item catalog makes that defensible, and shown next to the exact cash they
never replace. No new upstream API calls; everything comes from history
TornScope already stores. Built ONLY from payload shapes proven in the
stored archive (audited live 2026-10-08); nothing guessed, nothing invented.

## Added

- **Generic non-cash reward components** on `ActivityEvent` (`otherRewards`):
  items, ammo, property wins and object rewards as structured components
  (kind, label, item id, exact quantity). Cash never moves into them — cash
  stays in its exact columns and the MoneyEvent ledger, so nothing is
  double-counted; casino wheel points/tokens stay in their existing columns.
- **Crimes — Other rewards per row**: the crime log table now shows the
  non-cash loot of every attempt next to Cash and the item-value estimate —
  the archive's 3,462 crime item gains and 37 ammo gains become visible.
- **Rewards — "Other rewards" panel**: casino wheel prizes (16 item wins,
  4 property wins) and the previously invisible special families in one
  component table with current-catalog estimates and honest unpriced rows.
- **Special rewards domain** (`ActivityEvent` domain `special`): job perks
  (3), company perks (9), stock benefit items (21) and subscription rewards
  (8) — item-bearing perk logs that previously had no semantic row at all.

## Improved

- **Unpriced semantics, everywhere**: a component's value is an ESTIMATE
  from the current item catalog and is null ("unpriced") whenever the
  catalog cannot price it — never zero, never folded into exact cash.
  Casino wheel property wins and crime ammo gains are unpriced by
  construction (their payloads carry no catalog-resolvable id); the
  long-dangling `nonPriceable` descriptor finally persists as a component.

## Technical

- **Historical repair** (`repair:reward-components`, dry-run first,
  idempotent): pass 1 backfills reward components onto existing activity
  rows from the raw log archive — 3,274 rows stamped (166 with components,
  0 malformed), the raw archive strictly read-only; pass 2 inserted the 41
  missing special-reward events. Cash columns untouched. A re-run reports
  zero on both passes.
- **Schema**: additive nullable JSONB column only
  (`20261008200000_activity_event_other_rewards`, SAFE EXPAND, inventoried
  in docs/DATABASE-MIGRATIONS.md).
