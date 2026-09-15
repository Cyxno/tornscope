# Product Finish Issues — TornScope v0.2

Living inventory of product-quality defects found during the v0.2 product-finish
program (real-browser bug bash on deployed dev, build `37cf3d10`).

Legend: Status = `OPEN` / `FIXED` / `ACCEPTED FOR BETA` (with reasoning).
Severity: P0 data-dangerous/critical · P1 clearly broken · P2 noticeable
confusion · P3 polish.

| ID | Route | Issue | Severity | Category | Reproduction | Expected | Actual | Status |
|----|-------|-------|----------|----------|--------------|----------|--------|--------|
| PF-001 | /money | Literal HTML rendered as text in Wallet reconciliation: `Opening wallet <span class="text-[10px] text-fg-faint">11-09-2026</span>` (and same for "Actual closing") — template literal with markup interpolated into a `{text}` expression, so Svelte escapes it | P1 | Markup leak | Open Economy → 1D range → reconciliation panel | "Opening wallet 11-09-2026" as styled text | Raw `<span …>` visible | FIXED |
| PF-002 | /money | "Received vs spent mix" legend lists overlap each other at 1280px: left list amounts clipped mid-digit, right list labels bleed across both columns (panel ≈317px, each legend li needs ≈202px min-content but gets ≈126px) | P1 | Layout | Economy → 30D → "Received vs spent mix" panel | Legends readable below each donut | Columns collide, text unreadable | FIXED |
| PF-003 | /drugs | Xanax provenance rows render count and share jammed together so they read as one wrong number: `4` + `5%` reads "45%", `8` + `10%` reads "810%", `69` + `85%` reads "6985%" | P1 | Wrong content | Drugs → "Where did 81 Xanax come from?" | Count and share visually separated (e.g. "4 uses · 5%") | Reads as 45% / 810% / 6985% | FIXED |
| PF-004 | /combat | Respect summary shows raw float: "+471.93000000000023 gained" | P1 | Wrong content | Combat → respect line under charts | "+471.93 gained" | 15 decimal places shown | FIXED |
| PF-005 | /sync | Networth bars-coverage row is self-contradictory: requested start 16-03-2026, stored since 09-09-2026, confidence "COMPLETE", stop reason "not walked yet" — for a live-only resource this mixes the backfill model with live collection semantics | P1 | Semantics | Sync → "Energy & Happy Bars" coverage table, Networth row | Live-only resources marked as live collection with no misleading stop reason | "COMPLETE + not walked yet" contradiction | FIXED |
| PF-006 | / (Overview), all routes | "Today →" button and 11 "Review API access in Settings" actions use `window.location.href = …` — full page reload instead of SPA navigation | P2 | Interaction | Overview → click "Today →" (window marker disappears) | Client-side navigation, state preserved | Full reload | FIXED |
| PF-007 | /, /progression | Conditional-period whitespace bug: "…not causes ." / "…8 inferred training sessions ." — sentence ends with space before period when the `{#if}` inline tail is false (`/+page.svelte:286`, `/progression/+page.svelte:181,191`) | P2 | Copy | Overview → Today's story; Progression → hero (no happy jumps) | Clean sentence | Space before period | FIXED |
| PF-008 | /money | Wallet-reconciliation unavailable state leaks internal reasoning: "Missing anchors render as “—”, never as $0." | P2 | Copy | Economy → range without snapshot anchors | User-facing explanation only | Internal rendering rule shown | FIXED |
| PF-009 | /progression, Today | Developer jargon "deterministic" user-facing: "Deterministic threshold crossings…", "What moved — deterministic highlights, never causes" | P2 | Copy | Progression → Milestones; Today → What moved | Plain user language | Dev terminology | FIXED |
| PF-010 | /money | Range and lens selection not reflected in the URL — refresh/back loses the view, view can't be shared | P2 | State | Economy → pick 7D → refresh | Range/lens restored from URL | Resets to default 30D/cash | FIXED |
| PF-011 | /money | "At a glance" lens names (cash movement / conversion / economic effect / net worth) are styled as chips but are inert `<span>`s — misleading affordance | P2 | Affordance | Economy → click a lens chip | Chip activates/scrolls to lens | Nothing happens | FIXED |
| PF-012 | demo mode | Demo Today page is a wall of $0 (seed data ends yesterday) with no explanation — first demo impression looks broken; zero vs no-data conflated | P2 | States | Fresh browser → welcome → Explore demo → Today | Hint that demo history covers past days, or seeded today data | All-$0 with no context | FIXED |
| PF-013 | /welcome | Environment marking inconsistent on dev: eyebrow says "Public Beta" and body cites `v0.1.3 — Public Beta` while the header/NavRail correctly say "Development" | P2 | Copy | Fresh browser on dev → /welcome | Development-appropriate label | Claims public beta | FIXED |
| PF-014 | /today | Invalid `?date=2026-02-30` renders raw error text "invalid date: 2026-02-30" with Retry while the header simultaneously shows "Monday" (rolled-over date) | P2 | States | /today?date=2026-02-30 | Friendly "that date doesn't exist" state, consistent header | Raw error + mixed states | FIXED |
| PF-015 | /sync | "Faction overview — Legacy faction snapshots" — "Legacy" is developer language | P2 | Copy | Sync → Faction overview resource row | User-meaningful description | Internal migration terminology | FIXED |
| PF-016 | /settings | Quiet-hours save race: start/end handlers each save the other field from stale status; fast edits revert one field (start=01:00 then end=08:00 snapped end back to 07:00) | P2 | Interaction | Settings → set both quiet-hour inputs quickly | Both values persist | One field reverts | FIXED |
| PF-017 | routes /stocks, /faction/ranked-wars, /faction/organized-crimes | Orphan/stale ComingSoon routes: /stocks linked from nowhere; faction subroutes duplicate the faction page's in-page tabs | P2 | Navigation | Direct URL to each | No stale routes; faction tabs are the single surface | Dead ComingSoon pages | FIXED |
| PF-018 | /money, /timeline, all money cells | Sub-$1 money values render as "$0" (e.g. Crimes "per nerve -$0" for -$0.227) — nonzero rendered as zero | P2 | Formatter | Crimes → by crime → copying DVDs per nerve | Cents shown for values under $1 | "-$0" | FIXED |
| PF-019 | /today | Travel row shows landing timestamp twice ("Home in 01:45:12 at 12-09-2026 17:06" + progress strip's right label) | P3 | Layout | Today → Travel | Timestamp shown once prominent | Duplicated within the card | FIXED |
| PF-020 | /progression | "Happy jumps — inferred, with the evidence in the open" heading phrasing is odd | P3 | Copy | Progression → section D | Natural wording | "in the open" | FIXED |
| PF-021 | /welcome | Invalid API key error "Request validation failed" is terse and doesn't suggest a fix | P3 | Copy | Welcome → validate garbage key | Actionable hint (check key copied in full) | Generic failure text | ACCEPTED FOR BETA — message is honest and the retry loop is obvious; wording refined in same pass |
| PF-022 | /faction | Tab buttons lack `aria-pressed` state for assistive tech | P3 | Accessibility | Faction → tab row | State exposed to AT | Visual only | FIXED |
| PF-023 | /sync | Incident copy "Recovered stale worker run · worker interrupted · auto-recovered" is semi-jargon | P3 | Copy | Sync → click "1 issue · 24h" chip | Plain incident wording | Worker internals phrasing | FIXED |
| PF-024 | /timeline | Log titles like "Crime success item gain (new)" contain Torn's own "(new)" suffix — verified authentic Torn wording, kept | P3 | Content | Timeline | — | — | ACCEPTED FOR BETA (authentic Torn data, not our artifact) |

### Energy / training / battlestats correctness cluster (real-user findings)

Root causes and the full semantic model live in docs/PROGRESSION-ENERGY.md.
The inflated numbers below came from the pre-remediation ledger, which
charged the full Xanax estimate (150) on top of every observed decline
(`spend = gains + |ΔE|`) without capping gains at the bar's remaining
headroom, and presented raw snapshot deltas as training gains.

| ID | Route | Issue | Severity | Status |
|----|-------|-------|----------|--------|
| PF-025 | Today → Training | User trained twice in a day; TornScope reported ~360 E across 3 sessions — one real period split into two bursts and Xanax energy that never existed (taken at cap) was charged as training | P1 | FIXED — cap-aware ledger (gains bounded by interval headroom, overshoot surfaced) + canonical session grouping; Today and Progression share one engine (cross-page contract test) |
| PF-026 | Progression → Energy Flow | Reconciliation read Xanax +300 / Natural +435 / Training −660 for ~2 real bursts — sources were overstated (regen credited during cap-pinned time) and training absorbed the inflated balance | P1 | FIXED — sources are headroom-bounded (estimated Xanax, derived natural regen), uses split Training (inferred, "likely" only) vs Unattributed, cap-waste surfaces as overshoot, and opening + sources − uses = closing holds exactly in tests |
| PF-027 | Progression → Battlestats | "7d change" / "gain per day" showed an unexplained dash for accounts whose tracking began inside the range | P1 | FIXED — baseline rules: at_range_start / tracked_since (disclosed "since tracking began" with actual span) / no-history ("Not enough history yet"); gain/day divides by actual span, null below one day |
| PF-028 | Progression → Recent Training Sessions | Session energies 295 / 250 / 115 looked inconsistent with the known activity — 295/250-style values were full-Xanax-on-top-of-drop artifacts | P1 | IMPROVED BUT INHERENTLY INFERRED — energies are headroom-bounded "~" figures with evidence lists now; exact per-train energy is unobservable in Torn (5-minute bar resolution, no training log) |
| PF-029 | Progression, Today | Non-gym stat gains (e.g. Mining Corporation / Rock Salt-style Defense from company specials, received friend trains) were implicitly presented as gym gains | P1 | FIXED — exact job/company stat counter netted out of every bracket and every range split (gym / job / other); friend trains keep attribution provisional and block gain/E; Today's Training strip leads with the gym-attributable gain, never the raw snapshot delta |

### Money reconciliation + iOS/PWA/notifications cluster (final release blockers)

| ID | Route | Issue | Severity | Status |
|----|-------|-------|----------|--------|
| PF-030 | Today | Persistent unexplained money: a $500k–$800k "Unexplained" row with no way to see where it came from | P1 | FIXED — the structural double-count (snapshot category deltas + activity flows double-added) was removed, so the partition sums to the snapshot change exactly (verified residual = $0 over 7 real days); the wallet equation behind the Cash row is now inspectable on Today (opening + received − spent = expected vs actual closing) with a graded residual — exact / partially reconciled / unexplained movement — always surfaced, never hidden or zero-filled |
| PF-031 | iOS, all routes | The installed Home Screen app's chrome paddings were inert: `viewport-fit=cover` was missing, so `env(safe-area-inset-*)` resolved to 0 and the header sat under the iOS status bar | P2 | FIXED — viewport-fit=cover + top safe-area padding on the mobile header and nav rail (bottom nav already padded) |
| PF-032 | Settings → Devices | Registered push devices showed raw user-agent strings ("Mozilla/5.0 (iPhone; CPU iPhone OS…") | P3 | FIXED — coarse human labels derived server-side ("iPhone · iOS 17.5", "Mac · Chrome"); no fingerprinting beyond the UA the browser already sent |

## Verified non-issues (checked, working)

- All nav links, More-sheet links, Torn external links carry correct targets; no `href="#"`, no dead anchors, `target="_blank"` always paired with `rel="noopener noreferrer"`.
- Notification toggles, quiet hours set/clear, feature matrix, sign-out UI state all persist correctly (verified in DB).
- "Sync now" queues with clear feedback; incident chip expands incident detail.
- Travel trip-log rows expand/collapse correctly; session-table rows correctly have no false affordance.
- Keyboard: Tab order sensible, visible focus outlines, Enter activates nav links, 404 page offers "Back to Overview".
- Mobile 390px: no horizontal overflow on audited routes, bottom nav + More sheet work, lens switcher works.
- Charts: tooltips show correct label/unit/sign (verified "24/8 · Cash received $2.17m / Cash spent -$2.18m").
- Quiet-hours "(UTC)" label reflects the profile timezone — correct, not a bug.

---

## Settings redesign & theming epic (builds 4ebb997 → 8be89a6+)

Found during the settings/theming epic's own walkthroughs:

| ID | Route | Issue | Severity | Status |
|----|-------|-------|----------|--------|
| TH-001 | all | Inline pre-paint theme bootstrap was blocked by CSP (script-src 'self'), so stored themes never applied before paint (flash) | P1 | FIXED — bootstrap moved to static/appearance-bootstrap.js |
| TH-002 | Charts | Live theme switch merged color-only option updates and could leave series unrendered (net-worth line vanished in Light until reload) | P1 | FIXED — appearance signature forces full option replace in Chart.svelte |
| TH-003 | Settings | Feature matrix + About mixed with daily preferences in one monolithic page | P2 | FIXED — six-tab IA (?tab= deep links) |
| TH-004 | /stocks, /money, tests | Stale travel-golden fixture: time-of-day dependent failure (passes ~19:00 UTC, fails later; reproduces on the previously accepted SHA 8be89a6) | P2 | FIXED — root cause: the fixture's departure was `now − 1h` with the purchased item at `+3h`; `resolveDateRange` clamps `to` to end-of-UTC-today, so after ~22:00 UTC the item fell into "tomorrow", dropped out of the clamped range, and the golden profit read 0. Fixture now anchors departure inside today (00:30 UTC), deterministic for any run hour |

### Product simplification cluster (information hierarchy, economy UX, Android)

| ID | Route | Issue | Severity | Status |
|----|-------|-------|----------|--------|
| PF-033 | Overview | "Bank" rendered warning-yellow for a healthy active investment countdown — yellow must mean caution/action, not a normal asset timer | P2 | FIXED — countdown is neutral; warning reserved for "Matured — collect" (actionable) |
| PF-034 | Overview, Economy | Wallet turnover led the economy story ("$54m in / $54m out") — in Torn that describes normal behavior (players store wealth outside the wallet), not performance | P1 | FIXED — Simple mode leads with the net worth result, category shifts, real gains/costs and asset shifts; wallet turnover demoted to a cash-details disclosure with the Torn-specific explanation; Advanced keeps the full bridge |
| PF-035 | Economy | Net Worth change vs Economic Effect read as contradictory (+$4.53m vs −$29.21m style) with no reconciliation | P1 | FIXED — Simple mode adds plain-language definitions and the explicit note that net worth also moves with prices and form changes, so the two rarely match; tooltips carry the same copy |
| PF-036 | Overview | No way to personalize what matters per player goal | P2 | FIXED — Focus areas (Everything/Wealth/Training/Combat) reorder Overview prominence; personalization only — no routes hidden, "Everything" is the default |
| PF-037 | Economy, Overview | No Simple/Advanced presentation model | P1 | FIXED — browser-local Simple/Advanced preference with toggles on both pages and in Settings → General; Simple = wealth result + what changed + real gains/costs + asset shifts + cash disclosure; Advanced = the complete previous surface |

### Semantic correctness pass (V0.2 — Xanax mechanic, energy sources)

| ID | Route | Issue | Severity | Status |
|----|-------|-------|----------|--------|
| PF-038 | Progression, model | Xanax energy estimate was a stale historical 150 — the current documented Torn mechanic is +250 energy per use (official wiki, Xanax item page + Energy page, fetched 2026-09-14; the success log payload carries no energy field) | P1 | FIXED — `XANAX_ENERGY_ESTIMATE = 250` with verified sourcing; cap behavior verified empirically (energy never exceeds the maximum in 6 months of snapshots; Xanax-while-full events stay pinned at max, so the excess is lost) |
| PF-039 | Progression | 1D could read as "0 Xanax" despite 2 taken: the energy-sources list only shows MATERIALIZED gains, and both uses landed on a full bar → zero materialized, row omitted, "Known gains" card read 0 | P1 | FIXED — ledger now attributes overshoot per source category (`absorbedOvershootByCategory`) and the API ships the exact drug-log count (`energy.xanax`); the Energy-in panel states "2 Xanax taken · est. +500 delivered — ~0 visible in your bars, ~500 lost at your energy cap (taken at/near full)" instead of omitting the row |
| PF-040 | Progression | The 7D "+175 from Xanax" had no explanation of what it meant (materialized-under-cap only) and no use count beside it | P2 | FIXED — the same intake line shows uses, delivered estimate, bar-visible share and cap loss together, so 7D (+175 visible) and 1D (0 visible, 500 lost) read as one consistent story |
| PF-041 | Overview, charts | The restored strip bars were invisible in practice: the track color matched the page background and a near-empty resource drew a 1-2px fill (judge finding); dense hourly chart axes also printed the same date label many times consecutively | P2 | FIXED — track uses the hairline border color at Today's bar height; `timeAxis` collapses runs of identical labels to one tick |
| PF-042 | Progression | Xanax intake line initially computed "visible" as delivered − cap-loss, overstating visibility when uses predate bar-history coverage (real profile: 6 of 17 uses in 7D fall before bars began) | P1 | FIXED — three-way split: bar-visible (sources row) + lost at cap (overshoot) + "before bar history began" remainder; verified to reconcile on live data (+35 visible + ~715 lost + ~17.5k pre-bars = 81 uses × 250 on 30D) |
| PF-043 | Progression, model | Correction of PF-038/039/042's cap assumption: "hard clamp at the natural maximum / lost at cap" was inferred from snapshot absence, not documented mechanics. The Energy wiki states the absolute maximum is 1,000 and chaining guides confirm gains stack above the natural max ("after 4 Xanax you have 1000e"); the player's take-then-train pattern hides 150→400→low entirely between 5-minute polls | P1 | FIXED — ledger credits delivered Xanax energy in full inside decline intervals (spend = gains + observed drop); unobservable delivered energy is an explicit UNRESOLVED bucket (`unresolvedGains` + by-category), never "lost"; reconciliation gains a 6th cell; intake line reads "N Xanax taken · ~X E delivered — ~Y E attributed to training, ~Z E unresolved between snapshots"; demo seed no longer clamps Xanax at the natural max |

### Release-candidate human QA pass (post-d77901e)

| ID | Route | Issue | Severity | Status |
|----|-------|-------|----------|--------|
| PF-044 | Overview | Happy was missing from the live resource strip — the release criterion "Energy/Nerve/Happy readable at a glance (value + bar)" was unmet; Happy lived only on Today | P2 | FIXED — Happy joins the strip as a third bar chip (same track/fill pattern, links to Torn items) |
| PF-045 | Today | Header showed "Updated just now" next to the amber "stale — refreshing" chip: the age label reads a clock anchored to the served payload's own fetch time, so a stale payload claimed "just now" forever | P2 | FIXED — the Updated label is suppressed while `data.stale` (the chip alone tells the story); a stale payload no longer prints a contradictory age |
| PF-046 | Economy (Simple) | "What changed" could list $0 rows (Bank $0) — technically available, zero informational value | P2 | FIXED — zero-change rows are filtered; "Nothing moved this period" empty state when all categories are flat; full table remains in Advanced |
| PF-047 | Today | "Activity behind the moves" printed cramped separators ("-$819.8k·Consumed value") — Svelte whitespace collapse | P3 | FIXED — explicit spaced separators |

### V1.0 product-wide summary hierarchy + Simple maturity pass

Block inventory (Phase 3, before edits): every route's visible blocks were
classified A (primary outcome) / B (actionable now) / C (useful context) /
D (supporting analysis) / E (technical-forensic) / F (low-value-redundant).
Primary-slot offenders found and fixed below; the classified inventory is
reflected in the UI-DESIGN summary-composition rules.

| ID | Route | Issue | Severity | Status |
|----|-------|-------|----------|--------|
| PF-048 | Progression | 1D summary grid filled fixed 4 slots: "Gain per day — less than a day of history" (dead card) and "Awards 1D = 0" (meaningless zero) occupied primary positions; the useful gym-attributed gain sat in a strip below | P1 | FIXED — conditional summary grid: Total battlestats / Battlestat gain (sub "all gym-attributed" when the split is trivial) / Gain per day ONLY when a full day of history exists / Gym-attributed only when the split is informative / Training sessions·E; awards moved into the Milestones panel (shown only when ≠ 0) |
| PF-049 | Progression | Period repeated three times near the top ("1D in training" heading, "grew by +15.7k across 1D" sentence, "1D change" card label) | P2 | FIXED — human range headline named once ("Training today" / "Training — last 7 days" / "Training — selected range"); sentence reads "+15.7k battlestats"; grid label "Battlestat gain" |
| PF-050 | Economy (Simple) | Simple still showed three lenses over the same events (What changed / Asset shifts / What mattered most) plus accounting vocabulary — not curated | P1 | FIXED — Simple = Net worth change → Main drivers → Known income & costs → neutral residual note → cash-details disclosure; Asset shifts, What mattered most and Biggest costs remain in Advanced (conversions lens, Major movements rail, effect lens) |
| PF-051 | Economy (Simple) | Material unexplained residual rendered as a large amber warning banner for a normal partial-attribution state | P2 | FIXED — neutral "X of the net worth change could not be attributed … shown, not forced into a category" with pointer to reconciliation; amber reserved for genuine caution |
| PF-052 | Overview (Simple) | Simple strip carried accounting perspectives (economic effect, moved into assets, largest shift) — Economy work, not dashboard content | P2 | FIXED — Simple strip = Cash on hand + Battlestats today + Training today (sessions · ~E · Xanax count); Advanced keeps its cash-movement cells |
| PF-053 | Combat | "MUGS 0 / MUGGED 0" occupied hero summary slots when no mugging occurred | P2 | FIXED — mugs/mugged cells render only when > 0 (losses 0 kept — a clean record is meaningful) |

Deliberately unchanged after audit: Stocks (summary already outcome-first,
no zero heroes), Merits (unspent/invested/recommendation summary correct),
Crimes (attempts/success/value summary correct), Travel (est. labels quiet,
status first), Overview Advanced (financial context allowed below the
dashboard), Today (top already outcome-first after PF-045).

### V1.0 QOL + time consistency pass

Timestamp-source audit (Part 3): A (Torn event timestamps) and B (Torn API
fetch times) dominate surfaces; C (DB row times) never surfaces raw; D
(TornScope fetch time) drives freshness labels; E (browser display) is the
new presentation layer. Canonical storage/comparison remains UTC.

| ID | Route | Issue | Severity | Status |
|----|-------|-------|----------|--------|
| PF-054 | product-wide | All timestamps rendered in UTC regardless of the user's real day; no way to choose; charts and tables could disagree with the user's clock | P1 | FIXED — Settings → General → Time display (Local [default] / Torn time (UTC)), browser-local preference; central `datetime.ts` + `time-display.svelte.ts` (Intl, DST-correct, formatter cache); swept every route's event tables, timelines, countdowns and chart axes; alternate-zone tooltips on significant Today timestamps; contracts in docs/DATETIME.md; timezone/DST/SSR tests (UTC, Europe/Amsterdam incl. DST transition days, America/New_York, Asia/Tokyo) |
| PF-055 | all analytics routes | Selected range reset to the stored default on every full page load; one global range leaked across routes | P2 | FIXED — per-route range memory (`tornscope.routeRange.v1`): each route reopens with its own last preset; the Settings default still governs first visits; custom windows remain session-only |
| PF-056 | Today | Day boundary semantic (profile timezone, default UTC = Torn server day) was undocumented — a local-time user near midnight could not tell which day the page meant | P2 | FIXED — masthead captions "day boundary {tz}" with a tooltip; display timezone stays independent of analytical grouping (verified near-midnight: a 23:30 UTC event displays 00:30 Amsterdam but remains in the same analytical day) |

### V1.0 final settings + date/range sanity pass

Pre-release usability audit of the two-day-semantics product (Today =
profile-timezone day; 1D = Torn/UTC day) and every browser-local setting.
Full test matrix: packages/shared/tests/today-vs-1d.test.ts and
apps/web/tests/prefs.test.ts.

| ID | Route | Issue | Severity | Status |
|----|-------|-------|----------|--------|
| PF-057 | Settings (Time display) | Help text claimed "Analytics day boundaries (Today, the 1D range) follow your profile timezone" — factually wrong (1D is a UTC/Torn day) and self-contradictory in one sentence | P2 | FIXED — copy states the display-vs-analytics contract: time display changes how timestamps are shown, never how analytics are grouped; Today = profile timezone, 1D and all ranges = Torn days (UTC) |
| PF-058 | Progression | Last route rendering dates through the UTC-only shared formatters — training sessions, milestones and "tracked since" ignored the Local/Torn preference (near-midnight dates read a day off in local mode) | P2 | FIXED — all six sites render through the display-zone helpers; session window carries the alternate-zone tooltip |
| PF-059 | Progression | Range headline "Training today" labeled the UTC current day "today" — the same word naming two different analytical days (Today page = profile day) | P2 | FIXED — headline reads "Training — current Torn day" / "last N Torn days"; "today" is reserved for the profile-timezone day |
| PF-060 | Timeline | Feed grouped rows into UTC-day buckets but rendered display-zone headings — near midnight in local mode, rows appeared under the wrong day heading | P2 | FIXED — feed buckets keyed in the display zone, so every sticky heading names the day its rows actually show (presentation-only grouping; analytics untouched) |
| PF-061 | Range control | Preset buttons (1D/7D/…/All) had no stated semantics; custom picker presented local date inputs that are interpreted as Torn (UTC) days without saying so | P2 | FIXED — per-preset tooltips ("Current Torn day (UTC) — in progress", "Last N Torn days (UTC), today included", …) and a custom-form caption "Dates are Torn calendar days (UTC)" |
| PF-062 | Overview / Today | Greetings read the UTC hour — "Good morning" could render at local noon | P3 | FIXED — greeting reads the display-zone hour (td.displayHour), skew-corrected on Today |
| PF-063 | Overview | "Today —" masthead date rendered the profile day's start in the DISPLAY zone (could disagree with the profile day for far-apart zones) | P3 | FIXED — masthead renders the day key in the profile timezone, matching the summary semantics |
| PF-064 | Notifications | Delivery history "Fired at HH:MM (UTC)" labeled the display-preference time with the profile timezone — wrong whenever the two differ | P2 | FIXED — full display-zone datetime with the alternate-zone tooltip; the misleading caption removed |
| PF-065 | Notifications | Quiet hours showed a bare "(UTC)" tag with no explanation of what governs it; the daily-summary time input had no zone context; the daily_summary_ready type promised "at your local time" while the engine uses the profile timezone | P2 | FIXED — quiet-hours label tooltip states "follows your profile timezone, not this device's clock"; summary-time input names the profile zone; notification copy now says "on your profile timezone" (engine behavior verified consistent: minutes-since-midnight in User.timezone end-to-end) |
| PF-066 | Devices | Push-device list showed a raw toLocaleDateString "since" date (bypassed the display preference) and the API's lastSeenAt was never shown | P3 | FIXED — display-zone date with alternate-zone tooltip; "last seen {relative}" added with exact time in tooltip; current browser stays labeled "This browser" |
| PF-067 | Charts | Axis tooltips repeated the compact axis label ("14/9") instead of an exact timestamp — hourly charts showed no date at all | P3 | FIXED — shared axisTimeTooltip titles every axis-trigger tooltip with the full display-zone datetime plus the alternate zone ("14-09-2026 22:43 · 20:43 Torn time (UTC)"); applied across Overview/Economy/Combat/Crimes/Drugs/Travel/Progression |
| PF-068 | Settings | ?tab= deep links pushed history entries but back/forward did not restore the tab | P3 | FIXED — popstate re-reads ?tab= |
| PF-069 | product-wide | Preference parsing lived in three modules with duplicated whitelists (drift risk); stale-permission "last refreshed" date bypassed the display preference; sync page extracted clock times via .slice(11) on a formatted string | P3 | FIXED — prefs.ts centralizes every browser-local key + pure fallback parsers (malformed storage → shipped default, unit-tested); capabilities.ts renders the refreshed date via the display zone; sync rows use displayTime |
| PF-070 | Economy | Editorial lead read "Across 1D, …" — jargon label inside prose | P3 | FIXED — prose period names ("the current Torn day", "the last 7 Torn days", …) |

Deliberately NOT changed (documented decisions): display-timezone preference
still never touches analytical grouping; 1D keeps its Torn-day meaning (a
tooltip, not a rename); no global timezone badge (masthead captions +
tooltips + Settings state suffice); no "reset remembered ranges" control
(route memories are harmless presets — reselecting or clearing site data
recovers, and the Settings default still governs first visits); custom-range
semantics stay UTC-day based (now captioned, not changed).
