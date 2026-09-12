# TornScope v0.2.0 — Release notes (draft)

## New

- **Merits** — your complete merit ledger: exact ranks and unspent points
  straight from Torn, category concentration, maxed/partial/untouched states,
  official descriptions, search and filters.
- **Stocks** — ownership and stock-benefit intelligence: position value at the
  current market price, benefit blocks reached vs next, missing shares and
  estimated cost to reach them, derived payout timing, estimated reward value,
  annual benefit, yield and payback. Unvalued rewards are disclosed, never
  guessed.
- **Light / Dark / System themes** with seven accent colors, five chart
  palettes (including colorblind-friendly and monochrome), interface density
  and motion preferences — applied before first paint, stored per browser.
- **Redesigned Settings** — six deep-linkable tabs (General, Appearance,
  Notifications, API & Data, Devices, Advanced) with destructive actions
  separated into a Danger zone.

## Improved

- **Economy** — cash movement, asset conversions, economic effect and net
  worth presented as four related lenses with wallet reconciliation
  (opening/closing/residual) and shareable range/lens links.
- **Daily Summary (Today)** — one trustworthy recap of a calendar day: net
  worth movement with likely contributors, cash flow, economic effect,
  conversions, travel, drugs & rehab and training.
- **Overview** — the record of your account: live state, official net worth
  with trend, today's story and quiet beyond-money highlights.
- Charts are theme-aware — every graph restyles live with your theme,
  palette and accent.
- Typography and information density refined across every route, with
  tabular numerals for financial scanning.

## Reliability

- Sync reliability rework: per-resource schedules, incremental cursors,
  heartbeat-based crash recovery, capability-aware scheduling and per-resource
  error kinds in Sync Status.
- Data Confidence: every figure is labeled exact, derived, estimated or
  inferred — and "unavailable" never masquerades as zero.

## Security

- API keys encrypted at rest (AES-256-GCM), never returned to the browser.
- Strict Content-Security-Policy, isolated per-profile data, read-only keys.
- Notification quiet hours defer (not drop) alerts, with first-observation
  suppression to prevent storms after enabling.

## Upgrade notes

- Existing v0.1 databases upgrade automatically via the standard migration
  step — existing profiles, sessions, encrypted API keys, historical events,
  sync state and preferences are preserved (certified against a production
  database copy; see docs/V0.2-DATABASE-UPGRADE-CERTIFICATION.md).
- The upgrade adds tables for bars snapshots and notification events and
  backfills user roles; it performs no destructive changes.
- The migration is quick (seconds on a production-sized copy) but plan the
  usual short restart window.

## Known limitations

- Merit caps are maintained by TornScope (Torn's API does not publish them);
  merits with an unverifiable cap render level-only.
- Stock payout timing is derived from Torn's undocumented progress field and
  is labeled as an estimate.
- Torn's API exposes no merit/stock-benefit history, so those pages are
  current-state only.
