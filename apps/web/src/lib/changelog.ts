/**
 * TornScope release history — the single structured source for the
 * user-facing Changelog page. Built from REAL repository history only:
 * annotated release tags (git tag), docs/RELEASE-NOTES-*.md and the commit
 * log between them. No invented versions, no invented dates.
 *
 * Order: latest release first. Intermediate development that shipped inside
 * a later release is presented as part of that release (the Public Beta 2
 * "v0.2" line never released as its own version — it culminated in 1.0.0).
 */

export type ChangelogKind = "Added" | "Improved" | "Fixed" | "Technical";

export interface ChangelogEntry {
  kind: ChangelogKind;
  text: string;
}

export interface ChangelogRelease {
  /** Exact release tag (e.g. "v1.0.0"); the current in-progress release uses its plain version ("1.0.3") until tagged. */
  version: string;
  /** Release date (YYYY-MM-DD) when known — from the tag, never guessed. */
  date?: string;
  /** Lifecycle stage as shown on the release. */
  stage: string;
  /** True for the release this running deployment represents. */
  current?: boolean;
  /** One-paragraph positioning of the release. */
  summary?: string;
  changes: ChangelogEntry[];
}

export const CHANGELOG_KINDS: ChangelogKind[] = ["Added", "Improved", "Fixed", "Technical"];

export const CHANGELOG: ChangelogRelease[] = [
  {
    version: "2.0.3",
    stage: "Public Testing",
    current: true,
    summary:
      "Dashboard-first Overview: the homepage now opens with a live cockpit — dominant Energy/Nerve/Happy/Life bars, compact cooldown tiles, current states only, capped Needs-attention and goal mini-cards — with charts and trend data moved below.",
    changes: [
      {
        kind: "Improved",
        text: "Overview — dashboard-first redesign. The first screen is now your live status: four dominant bar rows (Energy, Nerve, Happy, Life) with big current/max numerals and compact timers (over-cap stacking shown honestly), compact cooldown tiles where READY is instantly recognizable, and a current-states block that only renders what is actually active (travel, education, OC, bank, hospital, jail). Needs-attention is capped to the few items that matter now, and up to three goal mini-cards ride along with their projection ranges.",
      },
      {
        kind: "Improved",
        text: "Overview — the net-worth chart, today's story, recent activity and beyond-the-wallet rows move into a dedicated analytics zone below the cockpit; the financial snapshot keeps the hero figures without the chart. On wide screens the cockpit is a real multi-column layout (live block beside attention and goals); on mobile it reads as a compact status app. State and attention are never duplicated: the live block shows state, Needs-attention shows only actions.",
      },
      {
        kind: "Technical",
        text: "No new backend surface: the redesign reuses the existing today/command-center/goals/dashboard endpoints and the tested live-now derivation (now including the Life bar). Public contracts unchanged.",
      },
    ],
  },
  {
    version: "2.0.2",
    stage: "Public Testing",
    summary:
      "Honest labeling pass on the battle-stat projection: it is an EMPIRICAL projection (calibrated on your observed stat growth), not a mechanistic simulator — confidence is now capped so a perfect historical fit can never read as a certain forecast, and the assumptions are stated verbatim.",
    changes: [
      {
        kind: "Improved",
        text: 'Goals — battle-stat projections are reclassified and labeled as what they are: an empirical compounding model, "Projected … from your observed stat growth", calibrated on observed conditions. It does not simulate future gym unlocks or changes in happiness, perks, books, faction bonuses or training frequency, and the copy now says exactly that.',
      },
      {
        kind: "Improved",
        text: 'Goals — confidence semantics: projection confidence is now the minimum of statistical fit quality, horizon distance and a model cap of "medium". A statistically perfect calibration over 30/90 days can no longer produce a high-confidence exact date for a stat goal — a range with a regime-change floor is always shown, because the model assumes recent conditions persist.',
      },
      {
        kind: "Technical",
        text: "Semantic audit documentation gains a three-level taxonomy (DESCRIPTIVE / EMPIRICAL PROJECTION / MECHANISTIC PROJECTION) with battle-stat goals explicitly classified as empirical, plus the investigated-and-documented limits around temporary regimes (books, boost periods) and single-stat training under total battle-stat goals. Public contract values are unchanged.",
      },
    ],
  },
  {
    version: "2.0.1",
    stage: "Public Testing",
    summary:
      "Semantic correctness for the intelligence layer: battle-stat projections now respect Torn's stat scaling (calibrated compounding with honest ETA ranges), level goals no longer claim an ETA, and display-coherence repairs.",
    changes: [
      {
        kind: "Fixed",
        text: 'Goals — battle-stat projections no longer extrapolate a frozen gain-per-day. Torn\u2019s gym gains scale with the current stat, so the model is calibrated on your observed RELATIVE growth and simulated forward (gains rising as the stat rises), producing an honest range ("~2\u20133 months") unless the calibration is strong and the horizon short. Level goals show no ETA at all — that mechanic is not reliably modelable, and very distant wealth ETAs degrade in confidence. See docs/SEMANTIC-AUDIT-2.0.md.',
      },
      {
        kind: "Fixed",
        text: 'Goals — the projection line is internally coherent: step-shaped stat histories no longer co-display "0/day observed growth" next to a live ETA, and a calibration window that ends at-or-below its start withholds the ETA outright.',
      },
      {
        kind: "Fixed",
        text: "System health — the last-sync age no longer renders an impossible duration (timestamp unit mismatch).",
      },
    ],
  },
  {
    version: "2.0.0",
    stage: "Public Testing",
    summary: "From recording your history to acting on it: a Command Center that prioritizes what needs attention, personal goals with honest trend projections, a deterministic insights engine, training & wealth intelligence, smarter notification rules and a real data-freshness view.",
    changes: [
      { kind: "Added", text: "Command Center — the Overview now opens with a prioritized attention feed built from deterministic rules: energy capped (possible regen loss), cooldowns ready, bank matured, travel landing, OC almost ready, education finishing, hospital/jail, goals at a milestone, top insights and data-health warnings. At most one entry per fact, explicit activation thresholds and per-priority caps — information hierarchy instead of notification spam." },
      { kind: "Added", text: "Goals — set personal targets (net worth, liquid wealth, total or individual battle stats, level) with an optional target date. Every goal shows live progress and a PROJECTION of when you'll get there, computed from your own history over a 7/30/90-day lookback with an explicit confidence. When history is short, flat or noisy the ETA is withheld — never guessed." },
      { kind: "Added", text: "Insights — a curated, fully deterministic insight engine over your stored history: income/spending shifts vs your 30-day baseline, travel profit swings, rehab spend highs, xanax usage changes, training efficiency shifts, personal records and net worth milestones. Every insight names its comparison, evidence window and sample size; nothing below the significance gates is shown." },
      { kind: "Added", text: "Training intelligence (Progression) — last 7 days vs previous 7 days vs your 30-day baseline: sessions, energy trained, stat gain, gain-per-energy and hours spent capped, plus personal bests (best gain/E day, best gain day, best week) and — only with enough sessions — an explicitly observational time-of-day comparison." },
      { kind: "Added", text: "Wealth intelligence (Economy) — 7/30/90-day wealth velocity from official snapshots, a 30-day trend projection with confidence, wealth attribution for the selected range (earned income vs true spending vs asset conversions vs the market residual — conversions never count as income or loss) and all-time personal financial records." },
      { kind: "Added", text: "Smart notifications — goal achievements and milestone crossings (50/75/90%), 'OC almost ready' with a configurable window, and at most one significant insight per day (opt-in). Everything reuses the existing quiet-hours, dedupe and delivery-ledger machinery." },
      { kind: "Added", text: "System health — a new page separating 'no data because there is nothing' from 'no data because syncing broke': service status (API, PostgreSQL, Redis, worker, Torn API), queue state, and per-domain data freshness (fresh / delayed / stale / failed / unavailable) derived from real sync bookkeeping." },
      { kind: "Improved", text: "Navigation gains an Intelligence group (Goals, Insights) and System health sits beside Sync status. Demo mode includes goals and the full insights pipeline, so every 2.0 feature is explorable without an API key." },
      { kind: "Improved", text: "Semantic correctness pass over the intelligence layer (\"correct math is not enough\"): battle-stat goal projections no longer extrapolate a frozen gain-per-day — Torn's gym gains scale with the current stat, so goals now project via a model calibrated on your own observed RELATIVE growth (compounding forward, gains rising as the stat rises) with an honest ETA range (\"~4–6 months\") unless the calibration is strong and the horizon short. Level goals no longer claim an ETA at all (the mechanic isn't reliably modelable), and very distant wealth ETAs degrade in confidence. Assumptions are documented in-app on every stat projection." },
      { kind: "Technical", text: "One additive database migration (a Goal table storing user intent only — all analytics keep reading the existing snapshot tables), zero new Torn API calls (2.0 is computed from data already stored), one shared fact-gatherer feeding both the API and the notification worker, and pure analytics modules with per-figure provenance throughout." },
    ],
  },
  {
    version: "1.0.4",
    stage: "Public Testing",
    summary: "Fixed over-capped (stacked) energy being displayed as full — the real value is now shown everywhere, with an honest over-cap note.",
    changes: [
      { kind: "Fixed", text: "Overview / Today — Energy above its natural cap is no longer clamped to \"150 / 150\". Stacked energy — e.g. 400/150 after a Xanax — now shows the real numbers (\"400 / 150\") with a calm \"Stacked · +250 over cap\" note instead of a misleading \"Full\". No full-at countdown is invented while over cap (Torn supplies none: regeneration really is stopped until you drop below the cap), and the normal energy accent is kept — a stack is intentional, not an error. Your natural cap (100 or 150) is always the denominator, never hardcoded." },
      { kind: "Technical", text: "Bar semantics made explicit across the API contract: current (the real Torn value — may legitimately exceed the cap), natural cap, and bar fill (bounded 0–100%) are now separate concepts, with a derived overCap amount exposed by the Today API. Regression tests pin the whole range — 100/150, 150/150, 151/150, 400/150, 1000/150 and 350/100 — the API contract itself (raw Torn 400/150 in → 400/150 out), and the energy ledger (a banked Xanax +250 reconciles exactly — energy above the cap is real, nothing is lost)." },
    ],
  },
  {
    version: "1.0.3",
    date: "2026-09-17",
    stage: "Public Testing",
    summary: "Fixed test push delivery for Apple devices, and rebuilt the Overview \"Right now\" area as an action board with direct Torn.com links.",
    changes: [
      { kind: "Fixed", text: "Notifications — test pushes (and all alerts) now actually arrive on iPhone/iPad. Apple's push service rejected deliveries with 403 BadJwtToken because the server identified itself with a reserved-TLD mailto address; the subject is now the site's own https address. Desktop providers had accepted the old value, which is why only Apple devices were affected." },
      { kind: "Improved", text: "Overview — \"Right now\" is now an action board: Energy/Nerve/Happy bars are larger with readable values, travel shows the destination, the big countdown and the exact landing time together, and every card is one compact, fully-clickable action into Torn (the small Torn/Open buttons are gone — a subtle corner arrow marks the exit)." },
      { kind: "Fixed", text: "Overview — active bank investments are shown again, and a matured investment now stays on the board as \"Ready to collect\" with its payout amount until you actually withdraw it. (Torn clears the maturity timestamp the moment the term ends — that null tripped our data validation and hid the whole bank state, exactly when the money needed collecting.)" },
      { kind: "Improved", text: "Overview — travel, organized crime, education and bank actions now open Torn.com directly (the game where you act); TornScope's own analytics remain one click behind as history links." },
      { kind: "Improved", text: "Notifications — a failed test push now says why: subscription expired (re-enable), push service rejected the delivery (operator config), or a transient failure that retries automatically." },
      { kind: "Technical", text: "Push delivery telemetry: every failed send is logged with the subscription id, endpoint host, provider status and rejection reason — never endpoint tokens or key material. A provider rejection no longer revokes valid devices; only 404/410 does." },
    ],
  },
  {
    version: "1.0.2",
    date: "2026-09-17",
    stage: "Public Testing",
    summary: "Hotfix: enabling push notifications failed on every browser — most visibly on iPhone, where Safari reports it as \"The string contains invalid characters.\"",
    changes: [
      { kind: "Fixed", text: "Notifications — enabling push works again. The server's VAPID public key is base64URL; a settings-rebuild regression fed it to the browser's decoder unnormalized, which browsers reject (WebKit's wording: \"The string contains invalid characters.\") before subscription even starts." },
      { kind: "Improved", text: "Notifications — enable/disable/test failures now explain themselves in plain language (permission blocked, server key misconfigured, service worker unavailable, subscription refused) instead of surfacing raw browser exceptions." },
      { kind: "Technical", text: "Push key decoding and the enable pipeline moved into a tested module (base64url normalization, 65-byte P-256 validation) with secret-free diagnostic logging; the API trims VAPID env values and warns at boot when a key has the wrong shape." },
    ],
  },
  {
    version: "1.0.1",
    date: "2026-09-16",
    stage: "Public Testing",
    summary: "First maintenance release on the production-only workflow: two chart fixes, a notification reliability fix and this changelog.",
    changes: [
      { kind: "Fixed", text: "Overview — the net-worth chart no longer blanks while you hover it; the tooltip, line and area stay visible and mouse-out is clean." },
      { kind: "Fixed", text: "Economy — the \"Received vs spent mix\" donut legends no longer collide across the card; the two charts stack before they get cramped." },
      { kind: "Fixed", text: "Notifications — timeline evaluation no longer fails every cycle for affected profiles (a timestamp was converted to milliseconds twice), so alerts flow and the cursor no longer stalls." },
      { kind: "Added", text: "This Changelog page." },
      { kind: "Technical", text: "Ingestion guard: impossible external timestamps (pre-2004, far future, unparsable) are dropped with a warning at the persistence boundary and can never poison stored history." },
    ],
  },
  {
    version: "v1.0.0",
    date: "2026-09-15",
    stage: "Public Testing",
    summary:
      "First stable release — a year of continuous development certified against live production data, and the culmination of the Public Beta 2 development line. The hosted service runs as PUBLIC TESTING.",
    changes: [
      { kind: "Added", text: "Wealth-first financial reporting everywhere: net-worth change first, then true income vs. true costs, with asset conversions and wallet movement as clearly-labeled neutral context — cash moving between forms is never a loss, sale proceeds never profit." },
      { kind: "Added", text: "Merits and Stocks: the full merit ledger with ranks, concentration and unspent points; stock positions with benefit blocks, missing shares, estimated cost-to-reach, yield and payback." },
      { kind: "Added", text: "Notifications: push with per-type control, quiet hours that defer instead of dropping, profile-level dedupe, bounded retries and a plain-language delivery ledger. Installable as a PWA." },
      { kind: "Added", text: "Local time or Torn time for every timestamp, with alternate-zone tooltips; DST handled per event. Today follows your calendar day; range analytics follow Torn's UTC day." },
      { kind: "Added", text: "A clearly-labeled demo profile with 180 days of deterministic history that keeps extending toward the present." },
      { kind: "Added", text: "Light / dark / system themes with accent colors, chart palettes (including colorblind-friendly and monochrome), density and motion preferences — applied before first paint." },
      { kind: "Improved", text: "Overview and Today rebuilt around the story: a net-worth hero with its drivers, and a dated Daily Summary backed by dual reconciliation — your wealth story and your wallet arithmetic each say what they can and cannot explain." },
      { kind: "Improved", text: "Full historical analytics across Economy, Progression, Combat, Crimes, Travel, Drugs, Stocks, Merits and Faction — period-aware, with provenance and data-confidence badges and the raw ledger underneath. Training sessions, gym gains and Xanax funding are reconstructed and evidence-classified, never guessed." },
      { kind: "Improved", text: "Range intelligence: pages remember their own date range; a Settings default governs first visits; custom ranges are explicit Torn-day windows." },
      { kind: "Improved", text: "Multi-profile and security foundations: anonymous browser-bound profiles, AES-256-GCM encrypted API keys, per-route rate limiting, CSRF origin checking, strict demo isolation." },
      { kind: "Technical", text: "Sync reliability rework: per-resource schedules, incremental cursors, capability-aware scheduling and heartbeat-based crash recovery." },
      { kind: "Technical", text: "Data Confidence model — every figure is exact, derived, estimated or inferred, and \"unavailable\" never masquerades as zero." },
      { kind: "Technical", text: "Additive-only database migration policy with production-copy upgrade rehearsals; Docker-first self-hosting with a hardened deploy script and build-identity verification." },
    ],
  },
  {
    version: "v0.1.3",
    date: "2026-09-09",
    stage: "Public Beta",
    summary: "Sync recovery reliability fix for stuck resources.",
    changes: [
      { kind: "Fixed", text: "Stale sync recovery livelock: staleness is now judged by a dedicated run heartbeat instead of a bookkeeping timestamp, so a worker crash mid-run recovers instead of looping \"resource busy\" forever. No cursor or history reset required." },
    ],
  },
  {
    version: "v0.1.1",
    date: "2026-09-09",
    stage: "Public Beta",
    summary: "Layout polish pass on the first public beta.",
    changes: [
      { kind: "Fixed", text: "Settings — the API-key input row and quiet-hours row wrap on narrow phones instead of overflowing." },
      { kind: "Fixed", text: "Global mobile horizontal overflow removed across routes." },
    ],
  },
  {
    version: "v0.1.0-beta.1",
    date: "2026-09-09",
    stage: "Public Beta",
    summary: "The first public beta: the core TornScope record — live account status and the analytics foundation.",
    changes: [
      { kind: "Added", text: "Live account overview, Today view, Timeline, and the first analytics surfaces: Economy, Progression, Combat, Crimes, Drugs, Travel, Stocks and Faction." },
      { kind: "Added", text: "Torn API key onboarding with capability awareness, incremental background syncing with per-resource cursors, and a Sync status view." },
    ],
  },
];

/** Releases ordered latest-first, ready to render. */
export function changelogReleases(): ChangelogRelease[] {
  return CHANGELOG;
}

/** All entries of one release grouped by kind, in canonical kind order. */
export function entriesByKind(release: ChangelogRelease): Array<{ kind: ChangelogKind; entries: string[] }> {
  return CHANGELOG_KINDS.map((kind) => ({
    kind,
    entries: release.changes.filter((c) => c.kind === kind).map((c) => c.text),
  })).filter((group) => group.entries.length > 0);
}
