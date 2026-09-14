# Date & Time Display Contract (V1.0)

One contract for every timestamp TornScope shows. Canonical storage never
changes; presentation is a single browser-local preference.

## Canonical storage

- All timestamps are **UTC epoch seconds** (Torn server time is UTC).
- Analytics comparisons, day boundaries and range math run in UTC (or the
  profile timezone where a user-scoped day is the semantic — see below).
- Raw Torn timestamps are never mutated for display.

## Time display preference

`Settings → General → Time display` (browser-local, key
`tornscope.timeDisplay.v1`):

| Mode | Display zone | Alternate-time tooltip shows |
|---|---|---|
| **Local time** (default) | the browser device IANA zone | `… Torn time (UTC)` |
| **Torn time (UTC)** | UTC | `… local time` |

- Default is **Local**: events read against the user's real day.
- Presentation only — switching modes never changes analytical grouping,
  totals, or ordering.
- Alternate-zone tooltip: significant timestamps (Today's countdowns and
  events) carry the other zone in their tooltip, e.g.
  `29-03-2026 19:43 Torn time (UTC)`.
- DST: `Intl.DateTimeFormat` resolves each timestamp's own historical
  offset (Europe/Amsterdam CET/CEST correct per event); no manual
  arithmetic anywhere.
- SSR/hydration: server output resolves to UTC; the client re-renders in
  its zone after hydration. Data timestamps render after the client fetch,
  so no visible jump occurs in practice.

## Day-boundary semantics (two different, documented concepts)

| Surface | Day definition |
|---|---|
| **Today page** | the profile timezone's calendar day (default UTC = Torn's server day). The masthead captions it: "day boundary {tz}". |
| **Analytics `1D` range** | the current **UTC** calendar day (Torn server day) — NOT a rolling 24h window |
| `7D`/`14D`/`30D`/`90D` | the last N UTC days, inclusive of today |
| `Month` / `Year` | current UTC month / year |
| `All` | everything recorded |
| `Custom` | user-entered UTC dates (`00:00:00Z` → `23:59:59Z`); a one-sided entry clamps to epoch / now |

Display timezone and analytical grouping timezone are deliberately
independent: a 23:30 UTC event displays as 00:30 next day in Amsterdam but
stays inside the same analytical UTC day everywhere.

## Format hierarchy

| Surface | Format | Example |
|---|---|---|
| Tables / event rows | `DD-MM-YYYY HH:mm` (display zone) | `14-09-2026 23:43` |
| Masthead / headings | long day style | `Sunday 14 Sep` |
| Chart axes | compact `d/m` or `HH:mm` (display zone) | `14/9`, `23:43` |
| Freshness | relative (`formatRelative`) | `just now`, `3m ago`, `2h ago`, `1d ago` |

Relative time is for freshness only — event history always keeps an exact
timestamp. Number/abbreviation formatting (`$1.25m`, `1.05m`, `~1,255 E`)
stays locale-neutral per the financial format contract; dates/times use
`en-GB` ordering with the selected zone.

## Implementation

- Pure helpers: `apps/web/src/lib/datetime.ts` (explicit zone argument,
  `Intl` formatter cache, DST-safe — unit-tested against
  UTC/Europe/Amsterdam/America/New_York/Asia/Tokyo).
- Preference + reactive wrappers: `apps/web/src/lib/time-display.svelte.ts`.
- Route components import `* as td from "$lib/time-display.svelte.js"`.
  The UTC-only `formatDate`/`formatDateTime` (shared) remain for canonical
  server-side rendering (push text, docs examples).
