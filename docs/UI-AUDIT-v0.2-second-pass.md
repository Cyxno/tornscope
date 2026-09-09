# TornScope v0.2 UI — second-pass audit & resolution (2026-09-09)

Second-pass audit of the running dev UI (tornscope-dev), full-page screenshots
across 14 routes at 390/768/1280 (follow-up matrix 320→1920). Tooling:
`scripts/ui-visual-check.mjs`.

## Initial findings (on the post-first-pass UI)

- **A. Inconsistent** — Overview "Right now" (five bordered boxes), Today
  "Live state" (progress bars) and analytics Stat strips were three competing
  presentations of live state; demo identity appeared three times (nav chip,
  banner, Today-only "DEMO — SIMULATED"); Overview's Travel panel sat orphaned
  in the bottom grid.
- **B. Visually dated** — per-page strips of bordered KPI boxes; saturated
  Success/Fail/Attacked/Defended chips on every table row; "Complete" chip on
  every healthy Sync row.
- **C. Too dense** — Economy's three KPI strips + amber explanation walls +
  A/B/C sections of prose; Crimes/Combat double KPI areas.
- **D. Too sparse** — Faction overview ~40% empty; Sync operator prose exposed.
- **E. Mobile awkward** — Economy stacked 12 KPI boxes; Sync rows ~7 wrapped
  lines × 15 resources; Welcome hero pushed the key input below the fold.
- **F. Tablet** — 768 was a squeezed desktop (4-up strips intact, scrolling nav).
- **G. Desktop stretched** — Settings single full-width column of wide panels.
- **H. Duplicated patterns** — identical KPI strips 2–3× per page.
- **I. Unclear hierarchy** — Today's triple header stack (page title →
  greeting → section header).
- **J. Technically correct but weak** — Timeline rows three lines tall;
  Travel "haul" donut for two slices; reconciliation walls of text.

Bugs found during audit: Overview/LiveNow linked to `/economy` (a route that
does not exist — should be `/money`); Overview drug-use row rendered a use
count through a money formatter ("$47").

## Resolution (second pass)

- One grouped navigation model (`lib/nav.ts`) shared by desktop bar, tablet
  row and the phone bottom tab bar + sheet — no horizontally scrolling primary
  nav; every route reachable at every width.
- One control language in `app.css` (`.btn` variants, `.input`, `.chip`);
  segmented rails standardized; reduced-motion honored.
- Stat strips as hairline-divided surfaces (no card soup); explanatory prose
  compressed into semantic legends or `<details>` disclosures.
- Quiet-healthy principle applied: confidence badges hidden when complete,
  outcome chips reduced to dot + word, methodology copy disclosed on demand
  (Sync "How syncing works", Economy "Reading these numbers").
- Timeline as a compact one-line-per-event stream; travel haul as
  quantity-share bars (donut removed).
- Hierarchy fixes: greeting folded into the Today header; page headers own the
  page, sections own sections.

## Verification

- `scripts/ui-visual-check.mjs`: 12 routes × 16 widths (320–1920) — zero
  horizontal overflow, zero console errors, zero failed requests.
- A11y spot audit: exactly one `h1` per route, all images/buttons/links have
  accessible names, `aria-current`/`aria-expanded`/dialog semantics on menus.
- Bundle: immutable JS 1118 KB (pre) → ~1122 KB (post) — no material
  regression (Travel lost a chart).
- Copy contracts (`sync-health-copy`, `onboarding-copy-regressions`) kept
  green throughout.
