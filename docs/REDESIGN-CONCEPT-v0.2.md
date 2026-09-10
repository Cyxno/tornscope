# TornScope v0.2 redesign concept — "The Ledger"

## Problem

The first v0.2 pass cleaned the v0.1 dashboard: tighter nav, softer borders,
consistent tokens. But the bones were unchanged — a top bar, a grid of equal
cards, one shared page template. Nothing about the screen says "new version".

## Concept

TornScope stops presenting itself as a dashboard **of** boxes and becomes a
narrated ledger **about** the player's life: an open graphite canvas, strong
editorial mastheads, numerals set huge, hairline rules instead of card
borders, and inset panels reserved for what genuinely needs containment
(tables, dense charts, the day's story ledger).

Three moves carry the identity:

1. **The rail.** Desktop navigation leaves the top bar and becomes a slim,
   always-visible left rail (labeled at ≥1280, icon-only at 1024–1279).
   Below desktop: a compact context bar + the bottom tab bar. This alone
   re-proportions every page.
2. **Open sections.** Sections are eyebrow + hairline rule + content on the
   bare canvas. Card borders survive only on true insets. Target: 40–60%
   fewer boxed containers on major pages.
3. **Editorial numerals.** Each page leads with one huge tabular figure or
   sentence (net worth; the day's delta; Economy's "you received X and spent
   Y" sentence) set in Newsreader/Inter at display sizes, with quiet
   uppercase labels around it.

## Page composition (each route gets its own skeleton)

- **Overview** — masthead greeting + inline live-state sentence (no boxes) →
  net-worth hero with full-bleed integrated chart → "Today" story ledger
  (signed diverging bars) → compact activity ledger → quiet beyond-money rows.
- **Today** — a dated report: serif date masthead + status, hero delta,
  "why it moved" driver bars, three-lens hairline columns, activity story.
- **Economy** — editorial summary sentence, a four-lens flow strip
  (cash → conversions → effect → net worth; related, not additive), a real
  lens switcher for the analytical body, ledger as inset.
- **Drugs** — provenance-first: a full-width composition bar answering
  "where did these Xanax come from?", consumption trend, rehab strip,
  inset cost table.
- **Travel** — destination-led: ranking rows with inline signed profit bars,
  side estimate block, recent-trip timeline, inset trip log.
- **Timeline** — a dense event ledger: sticky date anchors, aligned time
  column, type tick, detail, signed value.
- **Sync** — an operations surface: one-line fleet pulse, grouped quiet
  resource rows (degraded rows get a warning rule), incidents only when
  present, coverage inset, disclosed operator detail.

## Motion

Restrained: content rise-in on load (already), disclosure ease, hover
emphasis, chart entrance. All disabled under reduced motion.

## Explicitly rejected as "not a redesign"

icon swaps, radius tweaks, spacing passes, chip color changes, class renames.
