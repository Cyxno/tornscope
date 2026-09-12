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

## Verified non-issues (checked, working)

- All nav links, More-sheet links, Torn external links carry correct targets; no `href="#"`, no dead anchors, `target="_blank"` always paired with `rel="noopener noreferrer"`.
- Notification toggles, quiet hours set/clear, feature matrix, sign-out UI state all persist correctly (verified in DB).
- "Sync now" queues with clear feedback; incident chip expands incident detail.
- Travel trip-log rows expand/collapse correctly; session-table rows correctly have no false affordance.
- Keyboard: Tab order sensible, visible focus outlines, Enter activates nav links, 404 page offers "Back to Overview".
- Mobile 390px: no horizontal overflow on audited routes, bottom nav + More sheet work, lens switcher works.
- Charts: tooltips show correct label/unit/sign (verified "24/8 · Cash received $2.17m / Cash spent -$2.18m").
- Quiet-hours "(UTC)" label reflects the profile timezone — correct, not a bug.
