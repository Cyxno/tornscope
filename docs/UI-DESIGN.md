# TornScope UI Design — v0.2 "precision calm"

This document is the design reference for TornScope's interface. It records the
design goals, the token system, the component primitives and the layout rules
introduced by the v0.2 UI overhaul, so new pages and edits stay coherent.

## Design goals

- **Modern premium data product** — calm, sophisticated, dense but readable,
  analytical, intentional. References: Linear / Vercel / modern fintech
  analytics (direction only, nothing copied).
- **Recognizably TornScope** — warm graphite base (never navy-on-blue),
  restrained teal accent, editorial typography (Newsreader display serif +
  Inter UI sans), soft layering instead of hard frames.
- **Numbers lead** — tabular numerals, compact money formatting, quiet labels;
  a confirmed zero renders `0`, an unavailable figure renders `—`.
- **Honesty is part of the visual language** — confidence, provenance and
  operational state are always visible but never dominant; estimates are
  labelled; missing data is never fabricated or rendered as zero.

## Design tokens

Single source of truth: `apps/web/src/app.css` (Tailwind v4 `@theme`).
`packages/ui/src/index.ts` mirrors the palette for non-CSS consumers — keep
the two in sync.

### Surfaces (graphite, zero blue cast)

| Token | Value | Use |
|---|---|---|
| `bg` | `#0a0a0c` | page background |
| `bg-raise` | `#0f0f12` | raised strips, inputs, sheet |
| `surface` | `#141417` | panels / cards (also chart tooltip + donut hole) |
| `surface-2` | `#1a1a1f` | chip fills, bar tracks, hover washes |
| `surface-3` | `#212128` | highest tonal elevation |
| `border` | `#232329` | hairline borders, dividers |
| `border-strong` | `#34343c` | emphasized borders, button outlines |

### Text

| Token | Value | Use |
|---|---|---|
| `fg` | `#f4f4f1` | primary text and headline values |
| `fg-muted` | `#a2a2ab` | secondary copy, captions |
| `fg-faint` | `#7d7d87` | quiet labels (≥ 4.5:1 on `bg` for accessibility) |

### Accent & semantics

| Token | Value | Use |
|---|---|---|
| `accent` / `accent-strong` | `#2dd4bf` / `#14b8a6` | active states, links, focus, hero data series — sparingly |
| `positive` | `#3fd68f` | gains, wins, "Ready", successful defenses |
| `negative` | `#f87171` | losses, overdoses, true expenses, errors |
| `warning` | `#f0b24a` | partial/stale confidence, overdue syncs, estimates needing caution |
| `info` (violet) | `#a78bfa` | provenance/derived contexts, OC tiers |

Status is never conveyed by color alone — every dot/chip pairs with a text
label.

### Radii, controls, motion

- Radius scale: `--radius-card` 16px (panels), `--radius-tile` 12px (inner
  tiles, notices), `--radius-control` 8px (buttons, inputs), chips `999px`.
- Control heights: `--control-height` 34px, `--control-height-sm` 30px.
- Motion: 100–320ms ease transitions only; skeleton shimmer and live-dot pulse
  are the only looping animations; `prefers-reduced-motion` disables all of it
  (including chart animation, handled in `Chart.svelte`).

## Typography

- Display (page titles, hero figures, day headings): Newsreader Variable —
  page titles 28–32px medium; hero numbers may go larger with tabular numerals.
- UI (everything else): Inter Variable, base size 14.5px.
- Section labels: `.section-label` — 11px semibold, +0.14em tracking, uppercase,
  `fg-faint`. Used sparingly; KPI labels are normal-case 11px medium instead.
- Numbers always `.tnum` (tabular). Money renders compact (`$12.4m`) with
  `formatMoneyCompact` / `formatSignedMoneyCompact`; full precision is reserved
  for ledger rows where exactness is the point.

### Date & time display

See docs/DATETIME.md — canonical UTC storage, Local (default) / Torn time (UTC)
display preference, DST-safe historical offsets, and the analytical-day
vs display-day separation.

### Summary composition rules (V1.0 hierarchy pass)

- **Summary admission rule** — a metric may occupy a top-level summary card
  only if it answers one of: *Where am I now? / Am I improving? / What
  changed? / What should I act on? / What is the most important result?* —
  for the **selected range**.
- **Range-aware rule** — rates like gain-per-day appear only when the range
  makes them meaningful (a full day of observed history). Short ranges
  substitute metrics that do answer the question (gym-attributed gain,
  sessions, training energy).
- **Zero / unavailable rule** — no hero slot for a meaningless 0 or an
  em-dash. Meaningful zeros stay (0 losses, a fully reconciled residual);
  zeros that only mean "nothing happened" (awards today, mugs made) hide
  until they have a value. A primary card rendering "—" should be
  exceptional.
- **Conditional composition** — summary grids render however many cards
  earn a slot. Never pad to a fixed count; whitespace beats filler.
- **Simple mode** — a curated interpretation of the data, not
  Advanced-minus-rows: each event gets ONE primary representation;
  additional lenses (asset shifts, notable movements, cost breakdowns)
  live in Advanced.
- **Residual styling** — an unattributed residual is neutral context
  ("could not be attributed … shown, not forced into a category"), never a
  warning banner by default. Amber is reserved for genuine caution or
  required action.

## Layout rules

- **Summary first, explanation second, technical detail last** (V0.2
  information-hierarchy rule): every analytics page opens with the result a
  player came for (net worth on Economy, battlestat growth on Progression,
  live bars + cash on Overview), keeps explanations and context in the
  middle, and puts accounting detail (reconciliations, ledgers, turnovers)
  behind disclosures or at the bottom. A figure that is *throughput* rather
  than *performance* (e.g. wallet turnover in Torn) must never be the first
  thing a page says.
- Content column: `.page-shell` — max-width 80rem (1280px), padding
  16/24px inline, rhythm 2rem mobile → 2.75rem desktop between sections.
- Page mastheads vary by page on purpose: `PageHeader` (eyebrow · serif
  title · description · actions) for analytics routes; custom editorial
  mastheads where the data is the headline (Overview's greeting, Today's
  date, Drugs' provenance question). Whichever form, there is exactly ONE
  masthead per page and it never competes with section headers.
- Stat strips: open hairline strips (`grid + md:divide-x divide-border`, no
  outer border) by default; the boxed `gap-px bg-border` variant is an inset
  reserved for surfaces that need containment.
- Bento sections: `Panel` tiles in 3-col desktop / 2-col tablet / 1-col mobile
  grids; `class="h-full"` keeps rows equal height.

## Navigation — the v0.2 rail shell (Option B)

Desktop navigation left the top bar entirely. Three regimes:

- **Desktop (lg+)**: a slim, always-visible **left rail** (`NavRail.svelte`) —
  brand + environment chip on top, grouped nav below (Core: Overview, Today ·
  Analytics: Economy, Drugs, Travel · Activity: Crimes, Combat, Faction,
  Timeline · System: Sync, Settings), sync pulse + identity pinned to the
  rail's bottom. Labeled at xl (≥1280, 228px); icon-only between lg and xl
  (68px, `title` tooltips). The active route gets an accent tick on the rail's
  left edge.
- **Tablet (md–lg)**: compact **context bar** (brand, env chip, sync pulse,
  identity — never primary nav) plus the fixed bottom tab bar.
- **Phone (<md)**: the same context bar and bottom tab bar; **More** opens a
  grouped bottom sheet listing every route. Route semantics never change.
- Nav model lives in `apps/web/src/lib/nav.ts`; `isActivePath` decides
  `aria-current`.

Why a rail: an analytics record benefits from a persistent spatial anchor —
every page shares the same left edge, so the content column is free to
compose (open canvas, hero numerals, asymmetric splits) instead of reserving
its top for navigation.

## Page composition — open canvas, not card soup

The v0.2 rule: **sections, not boxes.**

- A section is `eyebrow (section-label) + hairline rule (.section-rule) +
  content on the bare canvas`. Borders are reserved for true insets
  (tables, dense charts, form groups) and controls.
- Hero numerals (`.hero-num`, `clamp(2.6rem, 6vw, 4.4rem)`) — each page leads
  with ONE loudest figure; everything else steps down from it.
- **Diverging signed bars** (`.delta-bar`) are the signature data device:
  drivers, destination profit, per-day movement — a centred rule with
  positive teal/green right, negative red left.
- **Inline live sentences** replace status-card grids: colored ticks + linked
  labels + tabular values (see `LiveNow.svelte`).
- **Semantic legend bands** (`dot + label + amount + quiet meaning`) replace
  explanatory paragraphs (Economy's "earned / asset sales / asset purchases /
  true expenses").
- Insets (`Panel`) are for what genuinely needs containment: the cash ledger,
  daily-use charts, the trip log, settings forms. Count boxed containers per
  page in review; Overview's target is zero.
- Each major route has its own skeleton (see "Page compositions" below).
  Sharing the design system is mandatory; sharing an identical template is a
  regression.

### Page compositions (v0.2)

- **Overview** — masthead greeting + data-health line → live-state sentence →
  net-worth hero with the trend chart integrated into the canvas → today's
  story (driver bars + the three lenses condensed) → recent-activity ledger →
  quiet beyond-the-wallet links. Zero bordered containers.
- **Today** — a dated report: serif weekday masthead, status chips, date nav;
  hero delta; "why it moved" bars; the three lens columns separated by
  hairlines; travel/drugs open columns; live bars, cooldowns, bank,
  education, upcoming as open rows.
- **Economy** — editorial summary sentence ("Across 30d you received… spent…"),
  a four-lens flow strip (cash → conversions → effect → net worth; related,
  never additive), a real lens switcher (Cash flow / Consumption / Wealth)
  swapping the analytical body; the ledger as inset.
- **Drugs** — provenance-first: "Where did these Xanax come from?" with a
  full-width composition bar (proven sources first, unknowns last), a
  segment ledger with per-bucket meaning, then trend, rehab strip, cost table.
- **Travel** — destination-led: hero estimate numeral, destination ranking
  rows with signed bars, haul quantity bars, departure-day chart, trip log.
- **Timeline** — an event ledger: sticky date anchors, aligned time column,
  inline type icon + category, description revealed on wide screens, signed
  value right.
- **Sync** — an operations surface: fleet pulse ("4/15 caught up · 11
  overdue"), grouped resource rows (Identity & live state / Logs & history /
  Faction / Catalog), incidents only when present, coverage inset, operator
  detail disclosed.

### Mobile / tablet / desktop strategy

- **Phone**: own interface, not stacked desktop — context bar + bottom tab
  bar (52px targets, safe-area padding), single column, 2-col open KPI
  strips, horizontal-scroll filter rows, stacked trip cards, sheet navigation.
- **Tablet**: top context bar + bottom tab bar + 2-column editorial content
  (an intentional intermediate, never a wide phone or squeezed desktop).
- **Desktop**: the rail frees the canvas; content max-width 80rem; asymmetric
  splits (3+2 lenses, hero + context rail) and hairline-divided open strips.


## Components (apps/web/src/lib/components)

- **Panel** — the one card primitive. Variants: `surface` (default),
  `outlined` (hairline only), `quiet` (no box). `flush` for charts; `footer`
  snippet for captioned footers; `class` passthrough for `h-full`.
- **Stat** — KPI cell: label row (label + confidence + provenance), big
  tabular value, delta, optional sub-context. Used inside hairline strips.
- **PageHeader** — the one page-header pattern (see above).
- **StateMessage** — loading (structure-matched skeletons: `page`, `strip`,
  `chart`, `rows`), empty, error, permission and stale states. Permission/stale
  are visually distinct from "no data" and never render as zeros.
- **ConfidenceBadge / ProvenanceBadge** — micro indicators (`complete` renders
  nothing by default; `partial`/`stale` warn; `unavailable` pairs with `—`).
- **Chart** — ECharts wrapper: resize-robust, `confine: true` tooltips,
  reduced-motion aware. Shared theme in `$lib/charts.ts` (`C`, `TOOLTIP`,
  `LEGEND`, `GRID`, `MOTION`, axis factories, `tealArea()`).
- **Icon** — inline stroke icon set (24×24, 1.75px); no icon library.
- **MobileNav** — bottom tab bar (below lg: phones AND tablets) + grouped sheet.
- **NavRail** — the desktop left rail (labeled ≥xl, icon-only lg–xl).
- **Header** — the below-desktop context bar (brand, env chip, sync, identity).

### Primitives (app.css `@layer components`)

`.btn` (+ `-primary`, `-accent`, `-danger`, `-sm`), `.chip` (+ tone modifiers),
`.input`, `.tsv-table`, `.section-label`, `.text-link`, `.skeleton`, `.tnum`,
`.page-shell`, `.app-backdrop`, `.live-dot`.

## Tables

- Use `.tsv-table` inside `overflow-x-auto`. Header row = plain `<tr>` (CSS
  provides the uppercase micro treatment). Right-align numeric columns with
  `text-right` + `.tnum`.
- Choose per table: scroll only when necessary. Wide analytics tables
  (ledger, crime log, opponents) scroll; card/list representation where
  structure benefits (trip log renders cards on phones).

## Charts

- One visual language from `$lib/charts.ts`: subtle split lines, 10.5px axis
  labels, rounded tooltips, teal for primary series, semantic colors for
  value direction (positive/negative/warning/violet).
- Bars `barMaxWidth` ≤ 14 with 3px radii; donut borders match the surface
  color; legends render as HTML below charts on Economy (never over graphics).
- Mobile: heights drop (360→220–300), `dataZoom` for dense daily series,
  tooltips confined, canvas cannot widen the page (contain: inline-size).

## Responsive behavior

- Breakpoints exercised: 320/360/375/390/414/430 (phones), 768/820/834/912/1024
  (tablets), 1280/1440/1920 (desktop). `document.scrollWidth ≤ clientWidth`
  verified on every route at every width.
- Phones: single column, bottom tab bar, stat strips at 2 columns, chips row
  scrolls horizontally, trip log as cards, nav sheet for full routing.
- Tablets: 2-column bento, scrollable nav row, intermediate stat strips — an
  intentional layout, not a wide phone. The 1024px overflow regression stays
  fixed.
- Desktop: 1280px content column keeps analytics dense; no stretched giants.

## Confidence & provenance presentation

- Operational sync state and data confidence are separate concepts and render
  separately (Sync Status rows: operational label + dot, then confidence badge).
- `0` = confirmed zero; `—` = unavailable; `Importing`/`Incomplete` = worker
  state; `estimated` provenance dot labels catalog-priced values.
- Explanatory methodology copy lives in `<details>` disclosures, not wall-of-
  text paragraphs.

## Accessibility

- Semantic headings (one `h1` per page), labelled form controls,
  `aria-current` nav, `aria-expanded` disclosures, dialog semantics +
  Escape/backdrop close on the nav sheet, `role="progressbar"` on live bars,
  `aria-busy` skeletons.
- Focus: one tokenized `:focus-visible` ring (2px accent, 2px offset).
- Contrast: body text ≥ 7:1, muted ≥ 4.5:1, faint labels ≥ 4.5:1.
- Touch targets: tab bar items 56px; chips/tiles ≥ 44px in their larger
  dimension where interactive.
- `prefers-reduced-motion` honored globally (CSS + ECharts).

## Developer guidance

1. Consume tokens; never hardcode colors/radii/sizes in pages.
2. Compose pages from open sections (`.section-rule` + `.section-label`) +
   `Panel` insets + `StateMessage`; reach for `.btn`/`.chip`/`.input`/
   `.tsv-table` primitives before inventing classes. Count your bordered
   containers — if a page has more than ~3, you are building card soup.
3. Money: compact formatters from `@tornscope/shared`; keep full precision in
   ledger detail only.
4. New route: add it to `nav.ts` (group + icon) — rail, context bar and mobile
   sheet all follow.
5. New chart: build options from `$lib/charts.ts` fragments; never restate
   axis/tooltip styling inline.
6. Keep `packages/ui/src/index.ts` in sync with `app.css` tokens.

## Product-finish addendum (v0.2 bug bash, build 6611af7)

Rules added from real-browser defects (docs/PRODUCT-FINISH-ISSUES.md):

- **Chart-panel pairing width rule.** Donut+legend groups need ~210px
  min-content per column. The "Cash received vs spent" / "Received vs spent
  mix" row therefore only sits side by side at `min-[1500px]`; below that it
  stacks full-width. Do not add side-by-side chart panels that each embed a
  two-column legend below ~1500px.
- **Count + share must never be visually joinable.** Anywhere a count and a
  percentage sit adjacent ("4 uses · 5%"), separate them with a unit word and
  a separator so they cannot read as one number ("45%").
- **Range/lens state is URL state** on Economy (`?range=&lens=`), restored on
  load, reflected via `history.replaceState` — pages are shareable and
  refresh-stable.
- **Chips that look interactive must act.** The at-a-glance lens chips are
  buttons (select + scroll); text that carries no action uses plain text
  styling, not chip styling.
- **Live-only resources** (no Torn-side history, e.g. net worth) read as
  "live collection — Torn keeps no history" in the Sync coverage table —
  never "COMPLETE + not walked yet".
- **Float hygiene.** Any float interpolated into copy goes through a
  formatter (`toFixed(2)`, compact money); raw `${value}` of a computed float
  is how "+471.93000000000023" reached the screen.

## Theming & personalization (v0.2 settings epic)

- Preferences: Theme (system/light/dark), Accent (7 presets), Chart palette
  (5), Density (comfortable/compact), Motion (system/reduced/full).
  Browser-local persistence + pre-paint bootstrap in
  `static/appearance-bootstrap.js` — no flash, hydration-safe, CSP-compliant
  (external file; inline scripts are blocked by script-src 'self').
- Token flow: `@theme inline` maps color utilities onto runtime `--ds-*`
  variables; `[data-theme]` and `[data-accent]` on `<html>` restyle the
  product. See docs/APPEARANCE.md for the full contract.
- Accent restyles the interactive layer only; semantic positive/negative/
  warning/info are theme-scoped constants that accents never touch.
- Chart colors come exclusively from `lib/charts.ts` (`ct()` + compatibility
  getters) — pages never hardcode series colors. Battlestat identities and
  positive/negative are stable across palettes.
