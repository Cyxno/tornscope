# TornScope 2.0.7 — Cached Cockpit / Monotonic Timers

**Kernregel: server data = checkpoint, browser timer = live projection.** De
Overview opent vanaf 2.0.7 uit de eigen browser-snapshot en projecteert timers
lokaal. Een upstream rate limit of een F5-storm kan de cockpit niet meer
legeren (full-page error) en laat countdowns nooit meer teruglopen.

## Root cause (audit)

Vóór 2.0.7 was het bezoek-patroon van de Overview onnodig duur én broos:

- Elke paginaload (>30s na de vorige) loste een **live Torn-refresh** uit via
  `/api/today` (6 API-calls). Bij gedeeld IP (300/min Torn-bucket) betekende
  F5-spam: `Rate limit exceeded` — en de Overview verving toen de **hele
  pagina** door een foutbeeld (`Promise.all`-rejectie → full-page error).
- Countdowns projecteerden op een gedeelde klok die per respons versprong
  (`fetchedAt`-offset) en op `dueAt`-wobble van Torn zelf: het zichtbare
  2h→1h50m→2h-glitchPatroon.
- De Today-pageload had géén client-cache: elke mount was even duur als de
  eerste.

**Aantal live fetches bij 10× F5 (voor)**: tot 10× 6 Torn-calls binnen ~20
seconden → 429 → foutbeeld.

## After

- **Cache-first cockpit**: de Overview rendert direct uit een versioned,
  per-user browser-snapshot (`tornscope.cockpit.v1:<userId>` — today-subset,
  travel-state/landsAt, cooldown-dueAt, bar-waarden/fullAt, OC readyAt,
  education completesAt, bank maturesAt, fetchedAt/syncedAt; geen secrets,
  schema-gecontroleerd, never-throw). Snapshot jonger dan 120s → de
  live-request wordt helemaal overgeslagen.
- **F5-storm**: tien snelle reloads produceren **één** live fetch (browser
  replayt de snapshot; server-side single-flight + 15s minimum-spacing per
  gebruiker bewaken de gedeelde Torn-budget; de client voegt niets toe).
  Gemeten: 11 paginaloads → 1 `/api/today`-call, 0 page-errors, cockpit
  altijd gerenderd, nooit een 429-zichtbaarheid.
- **429-val**: een rate-limited `/api/today` is non-fataal — de cockpit blijft
  staan vanuit snapshot/last-known met een kalme "Using cached live data"
  notice. Full-page error alléén als er niets renderbaars is (koude load,
  geen snapshot, geen data).
- **Monotone countdowns**: elke timer identiteit (`travel:<landsAt>`,
  `bar:<kind>:<fullAt>`, `cue:<eventKey>`, …) projecteert met een
  never-increase clamp; `dueAt`-wobble ≤90s wordt geabsorbeerd, een échte
  boundary-wissel reset via een nieuwe identiteit. De gedeelde dashboard-klok
  is geankerd op `performance.now()`, clamped non-decreasing, en tikt één
  keer per seconde voor de hele cockpit.
- **Adaptive travel revalidation** (client, alleen vóór/na een landing):
  T-5m→T-1m elke 30s; laatste minuut + post-landing confirmatie elke 15s;
  buiten het landing-window geen extra polling. Elke refetch is één
  rate-limited live fetch (server TTL/single-flight) — geen nieuwe loops.
- **Response-ordering**: een tragere, oudere respons vervangt nooit een
  nieuwere (monotoon op `fetchedAt`, per-load sequence guard).
- **Cached heads-up**: pre-alerts (travel T-2m, cooldown T-2m, …) vuren uit
  snapshot-timestamps — zonder enige Torn-call. Een rate-limited upstream
  dimt de waarschuwingslaag niet.

## Cache-invalidation

De snapshot wordt genegeerd/vervallen bij: wisselende gebruiker (per-user
sleutel), schema-versie-mismatch (`v1`), `fetchedAt` ouder dan 120s (alleen
skip; render blijft gewoon), stale-claim van de server (ervóór render),
uitloggen/account-wissel, en localStorage-fouten (never-throw degradatie naar
het oude gedrag).

## Tests

Nieuw: `monotonic-remaining` (clamp/wobble/identity-reset/prune),
`cockpit-cache` (schema, per-user sleutel, skip-venster, never-throw),
`today-refetch` (15s-spacing, single-flight), cached T-2m heads-up,
response-ordering, 429-fallback. Bestaande suites ongewijzigd groen.

Volledige gate: svelte-check 0/0 · eslint 0 errors · tsc-builds groen ·
hermetische suite 1499 groen · DB-suite **1738/1738** (tijdelijke
postgres+redis containers, achteraf verwijderd) · web-build · compose-config
· browser-simulaties (F5-storm, revisit, 429, cached T-2m, monotone
countdowns) · 390/1440 screenshots visueel beoordeeld (pass).
