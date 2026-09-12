# Appearance & theming architecture

## Preference model

Five curated preferences, finite options, no free-form pickers:

| Preference | Options | Default |
|------------|---------|---------|
| Theme | system · light · dark | system |
| Accent | teal (default) · blue · indigo · violet · emerald · amber · rose | teal |
| Chart palette | default · muted · high-contrast · colorblind-friendly · monochrome | default |
| Interface density | comfortable · compact | comfortable |
| Motion | system · reduced · full | system |

## Persistence — browser-local by design

Preferences live in `localStorage["tornscope.appearance.v1"]` and apply before
first paint. Rationale:

- anonymous visitors, demo sessions and linked profiles all get correct
  theming with no server roundtrip;
- theming must exist before API/profile data loads, so the profile store is
  the wrong home;
- no schema/migration (explicit Phase 62 decision: no server-side
  appearance state exists at all).

Consequences (documented, deliberate): preferences are per-browser; demo
entry/exit intentionally keeps the browser's visual preference because it
never touches profile data. A "Reset appearance" action restores defaults.

## No-flash bootstrap

`static/appearance-bootstrap.js` is referenced from `app.html` BEFORE the
head content and is parse-blocking, so `data-theme` / `data-accent` /
`data-density` / `data-motion` are set on `<html>` before the stylesheet
applies. System resolves through `prefers-color-scheme`; `color-scheme` is
set on the root element so native form controls match.

CSP note: the app's `script-src 'self'` blocks inline scripts, which is why
the bootstrap is a static same-origin file rather than an inline script.

`lib/appearance-state.svelte.ts` mirrors the stored state reactively
(`appearance`, `resolvedTheme()`, `prefersReducedMotion()`,
`appearanceSignature()`), listens for OS theme/motion changes (live switching
in System mode) and for `storage` events (multi-tab consistency).

## Token architecture

- `app.css` uses Tailwind v4 `@theme inline` — color utilities resolve to
  runtime `--ds-*` variables, so flipping `data-theme`/`data-accent` on
  `<html>` restyles every page without touching components.
- Dark is the product default (The Ledger identity). Light is an intentional
  design: warm paper canvas (`#f4f3ee`), panels that lift LIGHTER than the
  canvas, quiet but visible borders, contrast-tuned semantic colors
  (positive `#178a4e`, negative `#c53f3f`, warning `#9a6a10` in light).
- Accent presets define main/strong/deep per theme plus an `--ds-accent-rgb`
  triplet consumed by tinted alphas (`rgb(var(--ds-accent-rgb) / 0.3)`).
  Keep `ACCENT_FAMILIES` in `lib/charts.ts` in sync with the CSS blocks.
- Semantic colors (positive/negative/warning/info) are theme-scoped and never
  affected by accent choices.
- Density is tokenized (`--row-pad-y`, `--table-head-pad-y`) and applied via
  `[data-density]` overrides on tables/controls; phone control heights are
  preserved (compact control-height overrides start at ≥640px only).
- Motion: `[data-motion]` + `prefersReducedMotion()`; System tracks
  `prefers-reduced-motion`, Reduced forces stillness, Full enables product
  motion. Charts read the same preference (`motionEnabled()`).

## Chart theming

- `lib/charts.ts` exposes `ct()` — the resolved chart theme (semantic colors,
  categorical palette, ramps, battlestat identities) — plus compatibility
  getters (`C.accent`, `TOOLTIP`, `LEGEND`, …) that resolve live, so pages
  keep their existing option-builder code and mounted ECharts instances
  restyle without reload.
- Palette data lives in the pure module `lib/chart-palettes.ts`
  (unit-testable, no SvelteKit imports).
- `Chart.svelte` tracks `appearanceSignature()`; when it changes the chart
  receives a FULL option replace (`notMerge: true`) — merging color-only
  updates into the previous option was observed to drop series.

## Accessibility rules

- Accent selection never changes success/danger/warning semantics; rose
  accents cannot make a gain look like a loss.
- The colorblind-friendly palette derives from the Okabe–Ito set, and
  positive/negative figures always pair color with sign/label.
- Accent swatches and palette cards carry text labels and `aria-pressed`;
  theme choices are buttons in a labelled group; compact density never
  reduces phone tap targets.
