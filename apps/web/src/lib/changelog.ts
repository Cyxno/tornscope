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
  /** Exact release tag (e.g. "v2.2.0"); the current in-progress release uses its plain version ("2.1.3") until tagged. */
  version: string;
  /** True for the release this running deployment represents. */
  current?: boolean;
  /** One-paragraph positioning of the release. */
  summary?: string;
  changes: ChangelogEntry[];
}

export const CHANGELOG_KINDS: ChangelogKind[] = ["Added", "Improved", "Fixed", "Technical"];

export const CHANGELOG: ChangelogRelease[] = [
  {
    version: "2.8.0",
    current: true,
    summary:
      "Coverage expansion from already-stored history: the Combat, Racing and bounty families from your personalstats snapshots — hundreds of thousands of attacking events' worth of counters that TornScope stored but never showed — plus exact per-crime skill levels from the snapshot authority.",
    changes: [
      {
        kind: "Added",
        text: "Combat progression on the Progression page: attacks won/lost/stealthed, critical hits, defends, combat ELO, best killstreak, total cash mugged, largest mug, faction respect and ranked-war hits — exact snapshot deltas with rate/day over any range.",
      },
      {
        kind: "Added",
        text: "Racing and bounty counters: races entered/won, racing points and skill, bounty placed/received/collected values — all from the stored snapshot history.",
      },
      {
        kind: "Improved",
        text: "Crime skill levels now carry Torn's own snapshot authority: every crime shows the exact current level from your latest personalstats snapshot, including crimes with no skill-change log in the stored history (marked 'snapshot'); log-observed levels are never overwritten.",
      },
    ],
  },
  {
    version: "2.7.0",
    current: false,
    summary:
      "Event reward coverage: non-cash reward components that Torn's raw logs always carried — crime item and ammo gains, casino wheel prizes, job/company perks, stock benefit items and subscription rewards — are now parsed, valued from the item catalog where that is defensible, and shown next to the exact cash they never replace.",
    changes: [
      {
        kind: "Added",
        text: "Non-cash reward components on played activities: crime item gains (3,462 in the archive), crime ammo gains, casino wheel item/property prizes, job and company perks, stock benefit items and subscription rewards now appear as structured components with name, type and exact quantity.",
      },
      {
        kind: "Added",
        text: "Crimes page rows and the Rewards page show Other rewards per activity; the Activity page gains a Special rewards domain for the previously invisible perk/benefit families.",
      },
      {
        kind: "Improved",
        text: "Unpriced semantics: value is estimated only where the current item catalog prices the component — anything the catalog cannot price stays visible as 'unpriced', never zeroed, and is never mixed into exact cash totals.",
      },
      {
        kind: "Technical",
        text: "Historical reward-component backfill (dry-run first, idempotent): existing activity rows were stamped from the raw log archive (3,274 rows, 166 with components) and 41 missing special-reward events were inserted; the raw archive stayed read-only and a re-run reports zero.",
      },
    ],
  },
  {
    version: "2.6.2",
    current: false,
    summary:
      "Production regression fix: the Overview cockpit could permanently render every cooldown as green 'Ready' with frozen countdowns from a stale cached snapshot, while the Today page showed the truth. Corrupt payload stamps can no longer own the cockpit clock or suppress fresh live data.",
    changes: [
      {
        kind: "Fixed",
        text: "Overview cooldowns no longer freeze as 'Ready': a cached cockpit snapshot with an impossible (future-fetchedAt) stamp can never fast-forward the shared dashboard clock, and its stamp can never discard fresh live responses — the broken state now heals itself instead of surviving reloads.",
      },
      {
        kind: "Improved",
        text: "Clock-sync hardening: payload timestamps beyond a plausible api↔browser skew bound are treated as corrupt in one shared rule used by Overview, Today and the cockpit snapshot loader — both surfaces always derive identical state from the same payload.",
      },
    ],
  },
  {
    version: "2.6.1",
    current: false,
    summary:
      "Release-safety hardening — no features: the release pipeline itself was made production-safe (isolated smoke tests, immutable release tags, route-integrity guard, hermetic test environment), on top of 2.5.4's deterministic test lifecycle.",
    changes: [
      {
        kind: "Technical",
        text: "Docker smoke tests now run fully isolated under their own compose project and can never touch production resources; release tags are immutable and the CI route-integrity check prevents SvelteKit route pages from being silently ignored or untracked.",
      },
      {
        kind: "Technical",
        text: "Hermetic test environment: test runs use only safe, dedicated test database/Redis configuration, keeping the deterministic test lifecycle from 2.5.4 intact.",
      },
    ],
  },
  {
    version: "2.6.0",
    current: false,
    summary:
      "Data utilization expansion: more value from the history TornScope already stores — long-term account progression, balance-sheet liabilities, internal transfer visibility for vault activity, crime skill progression and faction historical trends, plus a permanent audit that keeps stored-but-unused data visible.",
    changes: [
      {
        kind: "Added",
        text: "Deeper account progression: long-term counters (awards, trains, refills, crimes, hospitalizations, trips and more) with exact snapshot deltas and rate/day on the Progression page.",
      },
      {
        kind: "Added",
        text: "Internal transfer visibility: vault deposits/withdrawals are now neutral ledger transfers with an Economy breakdown per account — never income, never expense, never P/L.",
      },
      {
        kind: "Added",
        text: "Liability context in net-worth analytics: gross assets, liabilities (loans + unpaid fees) and net as balance-sheet figures.",
      },
      {
        kind: "Added",
        text: "Crime skill progression from Torn's own skill bookkeeping, and faction respect/member historical trends from stored snapshots.",
      },
      {
        kind: "Improved",
        text: "Broader utilization of already-stored Torn history; the new audit:data-utilization tool detects stored-but-unused data automatically. Ammo purchases now complete the ledger coverage.",
      },
    ],
  },
  {
    version: "2.5.4",
    current: false,
    summary:
      "Release-infrastructure hardening: every full-suite run now rebuilds the test database to the same baseline automatically, eliminating the test-state leakage that could make release-gate results depend on earlier runs.",
    changes: [
      {
        kind: "Fixed",
        text: "Eliminated test database state leakage that could cause non-reproducible release-gate failures — every vitest run now starts from the same schema-plus-seed baseline, locally and in CI alike.",
      },
      {
        kind: "Fixed",
        text: "Parallel test workers no longer race on shared catalog rows, and the activity repair no longer aborts when a candidate's user disappears mid-run.",
      },
      {
        kind: "Improved",
        text: "Aligned local, release-preflight and CI database lifecycle into one deterministic path; re-running the suite against a reused database is now always safe.",
      },
    ],
  },
  {
    version: "2.5.3",
    current: false,
    summary:
      "Navigation correctness pass: every collapsible section is now led by a real hub page — the Rewards & games header navigates to a light wayfinding hub instead of being an inert, link-looking label — with consistent click targets and keyboard focus handling across desktop and mobile.",
    changes: [
      {
        kind: "Fixed",
        text: "The Rewards & games section header now navigates to a light /rewards-games hub (pointing at Casino, Openables & rewards and Hunting) instead of looking clickable but doing nothing.",
      },
      {
        kind: "Improved",
        text: "Standardized hub navigation: all four collapsible families (Economy, Progression, Activity, Rewards & games) follow one interaction rule — the label navigates, only the chevron expands.",
      },
      {
        kind: "Improved",
        text: "Enlarged the family expand/collapse hit area in the sidebar and returned keyboard focus to the More button when the mobile section sheet closes.",
      },
    ],
  },
  {
    version: "2.5.2",
    current: false,
    summary:
      "Navigation realignment for a growing analytics surface: primary destinations stay visible while secondary pages moved into expandable families, the mobile More menu became a compact accordion sheet, and the current page is always in context. Also carries the Xanax usage/streak presentation clarification and realigns the release identity as 2.5.2.",
    changes: [
      {
        kind: "Improved",
        text: "Reorganized navigation as the analytics surface has grown: Economy, Progression and Activity act as hubs, with Stocks, Energy/Merits/Drugs and Timeline/Logs one expand away.",
      },
      {
        kind: "Improved",
        text: "Reduced sidebar clutter with progressive disclosure for secondary pages — Gameplay and Rewards & games group the rest, and collapsed groups persist per device.",
      },
      {
        kind: "Improved",
        text: "Made the mobile More menu faster to scan: a compact accordion of groups (at most two open at once) instead of a full route matrix, with the current group pre-expanded.",
      },
      {
        kind: "Improved",
        text: "Improved current-section context across secondary pages: an active child expands and lights its family, and the mobile header shows the current page next to the brand.",
      },
      {
        kind: "Fixed",
        text: "Clarified Xanax usage and successful-use streak semantics — the used count includes overdoses, the good streak counts consecutive successful uses across all drugs, and both populations are labeled explicitly.",
      },
    ],
  },
  {
    version: "2.5.1",
    summary:
      "Correctness and resilience hardening for Activity & Rewards: casino totals now use logical-play economics (stakes counted once, withdrawals excluded, pending placements never losses), best/worst session results are computed deterministically, reward parsing survives malformed or evolving payload shapes, and partial valuations are labeled as partial. The utilization audit evaluates payload-shape coverage and explains reconciliation differences.",
    changes: [
      {
        kind: "Fixed",
        text: "Casino aggregation no longer double-counts stakes that appear on both the placement and the settlement (bookie, blackjack), no longer treats bookie withdrawals as winnings, and no longer drops high-low lost stakes from the net. Best and worst session results are computed deterministically.",
      },
      {
        kind: "Fixed",
        text: "Reward parsing hardening: non-array item lists, non-integer ids and invalid quantities are excluded from every total and counted as malformed components — malformed or future payload shapes can no longer break the page, and no invalid value is converted to zero.",
      },
      {
        kind: "Improved",
        text: "Partial valuations are labeled explicitly (complete / partial / unpriced) so an estimated net that excludes unpriced rewards is never presented as complete. Null and exact zero stay strictly distinguished across casino and rewards surfaces.",
      },
      {
        kind: "Technical",
        text: "The utilization audit evaluates every payload shape per log family (not one representative sample), reports coverage by families, shapes and events, flags partially covered families, and emits stable JSON (--json). Casino reconciliation is decomposed into semantic wagers/returns/withdrawals/pending vs signed ledger income/expense/net. Historical repair output clarifies that recognized rows are exactly the rows an apply would insert.",
      },
    ],
  },
  {
    version: "2.5.0",
    summary:
      "Value Coverage Expansion: substantially more of your stored history is now semantically understood and turned into analytics — hunting sessions with skill progression, mission completions with credits, racing performance and upgrade spend, bounty placements and claims, education costs, and legacy casino payouts — with cross-domain value attribution that keeps exact cash, estimated item value and unpriced rewards strictly separate, and a corrected money reconciliation.",
    changes: [
      {
        kind: "Added",
        text: "Hunting analytics (/hunting) — per-session bait costs and prey-sale income (exact from Torn's own logs), net per session, session-type breakdown, and the hunting-skill trajectory they record.",
      },
      {
        kind: "Added",
        text: "Activity & value overview (/activity) — cross-domain value attribution across casino, openables, hunting, missions, racing, bounties and education: exact cash in/out and net, item value estimated at current catalog prices, progression quantities (racing points, mission credits) shown in their own units, and per-domain ledger linkage — semantic-only domains are labeled as such so nothing is double counted.",
      },
      {
        kind: "Added",
        text: "Expanded historical coverage: missions (exact cash + mission credits, credits-only completions included), racing finishes (position, exact racing points, skill gains) and upgrade spend, bounty placements (committed cost) vs claims (income) with correct opposite directions, and education starts (exact committed course cost).",
      },
      {
        kind: "Improved",
        text: "Legacy casino money logs (old-format rows with only an amount and no game attribution) are now normalized as unattributed legacy casino income — the game stays unknown rather than guessed — closing the largest previously unexplained value gap.",
      },
      {
        kind: "Fixed",
        text: "Money reconciliation now sums the signed ledger correctly (expense amounts are stored negative; the previous diagnostic double-flipped them). Differences between the semantic activity view and the ledger are disclosed with their structural causes — slots/keno/blackjack/high-low/bookie cash has no money logs in Torn's API, and lottery/wheel placements are pending — never silently patched.",
      },
      {
        kind: "Technical",
        text: "Expanded deterministic normalizer registry with per-family adapters anchored on category, exact title grammar and semantic payload keys; utilization audit 2.0 (audit:activities) reports recognized/normalized/analytics-used coverage at family and event level with an A–F gap classification; the historical repair covers all new families, stays idempotent, and treats the raw archive as read-only.",
      },
    ],
  },
  {
    version: "2.4.0",
    summary:
      "Activity & Rewards Analytics: a generic normalization layer converts substantially more of your ingested Torn logs into analytics — a retrospective casino ledger (per-game wagers, returns and net P/L, exact from Torn's own logs), openables & rewards tracking (packs, caches, wallets: inputs vs rewards), plus a repair that backfills the newly recognized history and a diagnostic that surfaces value-bearing logs not yet covered.",
    changes: [
      {
        kind: "Added",
        text: "Casino Analytics (/casino) — retrospective per-game wagers, cash returned and net P/L, exact from Torn's own logs: slots, roulette, keno, lottery, spin-the-wheel (all wheel variants), blackjack, high-low and bookie (placement vs settlement semantics; placements never counted as losses). Descriptive history only — never gambling advice.",
      },
      {
        kind: "Added",
        text: "Openables & Rewards (/rewards) — supply packs, caches, wallets and similar openings normalized into input-vs-reward analytics: exact cash rewards, exact item/point quantities, and item values estimated at current catalog prices (clearly labeled, never silently zero) with an estimated net where defensible.",
      },
      {
        kind: "Added",
        text: "Unrecognized value-bearing log diagnostic — casino-routed logs without payload semantics and item-use logs with reward components that no normalizer claims are counted and listed, so future Torn log changes become visible.",
      },
      {
        kind: "Technical",
        text: "Generic ActivityEvent semantic layer (additive migration) with an explicit per-game casino registry and payload-driven openable detection — anchored on category/title grammar and payload keys, never bare keywords. Historical repair backfills from the raw log archive idempotently (raw logs untouched) and a utilization audit reports raw vs recognized vs normalized vs unclassified value-bearing log families. MoneyEvent remains the accounting ledger with reconciliation diagnostics — no double counting.",
      },
    ],
  },
  {
    version: "2.3.1",
    summary:
      "Performance hardening for Decision Intelligence, driven by a measured scalability audit: at extreme in-window density the signal reads now keep the newest history (previously the oldest could survive the read cap and the recent week could go unrepresented), and concurrent cold requests share a single build instead of duplicating work. Includes a reproducible benchmark harness with documented budgets and future trigger points.",
    changes: [
      {
        kind: "Fixed",
        text: "Extreme in-window density — signal reads kept the OLDEST rows above the read cap (ascending order), so the recent week could go unrepresented in comparisons. Reads now keep the newest rows; verified with a dense-recent probe (200k in-window events).",
      },
      {
        kind: "Improved",
        text: "Concurrent cold requests for the same profile share one build (per-user single-flight) instead of running identical gathers — Overview strip and Insights page can both fire within the same cold window.",
      },
      {
        kind: "Technical",
        text: "Reproducible benchmark harness (pnpm benchmark:decision) with deterministic synthetic fixtures at 1x/10x/100x scale, plus documented performance budgets and objective future trigger points in docs/DECISION-INTELLIGENCE-PERFORMANCE.md.",
      },
    ],
  },
  {
    version: "2.3.0",
    summary:
      "Decision Intelligence: a small number of explainable, conservative signals derived from your own Torn history — opportunities, risks, trends and anomalies compared against your own rolling baselines, each with evidence, confidence, provenance and sample-size context. Historical signals only: no live optimization claims, no duplication of live alerts, no new Torn API pressure.",
    changes: [
      {
        kind: "Added",
        text: "Decision Intelligence with personalized opportunities, risks, trends and anomalies derived from your own Torn history.",
      },
      {
        kind: "Added",
        text: "Personal rolling baselines across energy, travel, drugs and money (trailing 7 days versus the previous 30, per covered day).",
      },
      {
        kind: "Added",
        text: "Evidence-backed signal explanations with confidence, provenance and sample-size context.",
      },
      {
        kind: "Added",
        text: "Goal-aware historical pacing signals — only for goals with an explicit target date.",
      },
      {
        kind: "Improved",
        text: "Insights now leads with actionable historical signals instead of isolated metrics; Overview can surface a small number of high-value decision signals without duplicating live heads-up alerts.",
      },
      {
        kind: "Technical",
        text: "Shared deterministic decision engine with bounded queries, coverage guards, robust statistics (median/MAD) and stable signal lifecycle semantics; preferences and lifecycle state reuse the existing settings storage — no new tables, no migration.",
      },
    ],
  },
  {
    version: "2.2.0",
    summary:
      "First regular stable release: TornScope is now presented as the product it already is — a self-hosted Torn analytics and live-status platform in production use — with a simplified release history and a hardened CI pipeline that runs the full verification reliably in a clean environment.",
    changes: [
      {
        kind: "Improved",
        text: "TornScope is presented as a regular stable release rather than a public-testing build — across the interface, documentation and deployment defaults.",
      },
      {
        kind: "Improved",
        text: "Simplified release history: redundant release dates and lifecycle labels were removed from the in-app changelog.",
      },
      {
        kind: "Improved",
        text: "Hardened GitHub CI: the demo-data seed now builds every internal package it depends on, so the complete verification pipeline runs reliably from a clean checkout.",
      },
      {
        kind: "Fixed",
        text: "GitHub CI on main reported a failed status because the seed step resolved an unbuilt internal package on a clean checkout; the build order is fixed and verified against a clean-environment reproduction.",
      },
      {
        kind: "Technical",
        text: "Release and changelog metadata were simplified without changing any historical feature or fix descriptions.",
      },
    ],
  },
  {
    version: "2.1.3",
    summary:
      "Normalizer maintenance: offshore bank movements and travel fees — which Torn files under the Travel category — now reach the money ledger, and the affected historical rows were repaired additively from their raw logs. Demo analytics generation is now day-deterministic, removing a date-sensitive test flake.",
    changes: [
      {
        kind: "Fixed",
        text: "Money ledger — offshore bank deposits/withdrawals (cayman transfers) and travel fees were shadowed by the travel route and never produced money ledger rows; routing now proves the money movement from the payload ({deposited}/{withdrawn}/{cost}) and the ten affected historical rows were repaired additively from their raw logs.",
      },
      {
        kind: "Fixed",
        text: "Demo analytics — incremental demo generation now seeds its per-day randomness by UTC day instead of by sync window, so reruns replay identical decisions regardless of window boundaries, calendar date or timezone.",
      },
      {
        kind: "Improved",
        text: "Regression coverage — cross-domain routing tests (offshore/travel-fee money semantics vs travel transitions, category-authoritative routing) and DB-backed additive repair tests with idempotence.",
      },
    ],
  },
  {
    version: "2.1.2",
    summary:
      "Data correctness fix: tightened drug-log classification so non-drug activity that happens to contain a drug name (gym speed training, job specials) can no longer be counted as substance use, and repaired the affected historical drug and consumption records from their original log provenance.",
    changes: [
      {
        kind: "Fixed",
        text: "Drug classification — routing to the drugs domain now requires definitive category evidence (Drugs / Item use drug) or an explicit name-anchored use title (Item use xanax, Used Speed, Overdosed on Xanax); a bare drug word inside any other title is never sufficient. Gym speed training and job special logs can no longer create Speed use events.",
      },
      {
        kind: "Fixed",
        text: "Historical repair — proven false-positive drug and consumption rows were removed using each row's original log provenance (evidence-based, idempotent, raw archive untouched); legitimate historical Speed use is preserved and downstream drug analytics now compute from clean data.",
      },
    ],
  },
  {
    version: "2.1.1",
    summary:
      "Deep Analytics polish: presentation and documentation refinements across Energy, Drugs, Travel and Logs — clearer provenance wording, better empty/error states and a pagination fix for filtered log queries. Public documentation now describes TornScope features in its own terms.",
    changes: [
      {
        kind: "Fixed",
        text: "Log Explorer — filtered queries (money outcome / amount range) no longer stop paginating early when matches are sparse across many pages; page assembly now continues server-side within a bounded scan budget.",
      },
      {
        kind: "Improved",
        text: "Analytics presentation — the travel activity chart labels its profit lens as estimated, the energy intelligence strip states its provenance per figure, and provenance wording across the Deep Analytics pages is consistent (exact / derived / estimated / inferred).",
      },
      {
        kind: "Improved",
        text: "Documentation — docs/ANALYTICS.md and the built-in changelog describe features independently, without comparisons to other Torn tools; the README intro reflects the current product surface.",
      },
    ],
  },
  {
    version: "2.1.0",
    summary:
      "Deep Analytics: expanded historical analytics across energy, drugs, travel and account activity — a full energy accounting (sources, uses, losses with honest provenance), drug/rehab streaks and deep rehab economics, travel flight-time economics, and a filterable Log Explorer with streaming CSV/JSON export. Everything reads from locally ingested history: opening a page never triggers a Torn fetch, and the production topology stays one stack.",
    changes: [
      {
        kind: "Added",
        text: "Energy Analytics (/energy) — where energy came from and where it went: natural regen (derived), points refills (exact, incl. points spent), Xanax (documented +250 estimate), energy drinks (exact), gym (exact from Torn's gym-train logs), bounded attack/revive inference and exact overdose losses. Stacked daily/weekly/monthly chart, an explicit coverage statement, and derived intelligence (energy/day, Xanax/day, regen lost at cap).",
      },
      {
        kind: "Added",
        text: "Log Explorer (/logs) — filterable audit view over the complete raw log archive: category, type, search, money outcome and amount-range filters, keyset pagination, expandable payload digests, and streaming CSV/JSON export (server-side, capped at 50,000 rows, session-scoped and free of any key material).",
      },
      {
        kind: "Added",
        text: "Drugs & Rehab 2.0 — good-streak accounting (current + longest, per substance and overall), last use / last overdose per substance, OD rate in the stat strip, rehab addiction-points removed, cost-per-addiction-point (only on complete data) and an estimated next-visit cost.",
      },
      {
        kind: "Added",
        text: "Travel Analytics 2.0 — flight-time totals and averages, trips/day, destinations visited, a three-lens activity chart (Profit / Trips / Flight time), a destination-breakdown table (flight time, avg flight, items, spend, profit/trip, profit/hour, last visit) and descriptive best-historical intelligence.",
      },
      {
        kind: "Added",
        text: "Backfill CLI (pnpm backfill status|start [--deep]) — operator control of the historical walk on the existing worker pipeline: resumable, dedupe-safe, rate-limit aware; depth bounded by Torn's own log retention. See docs/ANALYTICS.md.",
      },
      {
        kind: "Improved",
        text: "Provenance visibility — the value ladder gained an explicit inferred level (bounded bar-decline inference) next to exact/derived/estimated, rendered with \u201c~\u201d and an explanation; balances are withheld (\u201cuncovered\u201d) instead of guessed when bar history does not cover the range.",
      },
      {
        kind: "Improved",
        text: "Analytics performance — one additive index (TimelineEvent userId+type+occurredAt) backs the log explorer; page queries measure \u22640.25 ms at 30D/1Y/ALL on production data. All aggregation is server-side with keyset pagination.",
      },
      {
        kind: "Technical",
        text: "One additive migration (CREATE INDEX only); the analytics engine lives in shared pure modules (@tornscope/analytics) covered by new unit and DB-backed integration tests including export isolation and rate-limit semantics.",
      },
    ],
  },
  {
    version: "2.0.7",
    summary:
      "Cached Cockpit update: the Overview opens from the browser's own snapshot and projects timers locally — a rate-limited upstream or an F5 storm can no longer blank the cockpit or glitch the countdowns. Server data is a checkpoint; the browser timer is the live projection.",
    changes: [
      {
        kind: "Fixed",
        text: "Overview — a Torn rate limit (429) no longer replaces the dashboard with a full-page error. When cached state exists, the cockpit keeps rendering from the last-known snapshot with a quiet \u201cUsing cached live data\u201d notice; only a truly unrenderable cold load shows the error screen.",
      },
      {
        kind: "Fixed",
        text: "Overview — countdowns are now monotonic. Each timer is projected per identity (travel landing, bar full-time, cooldown end) and can never run backwards for the same boundary — the 2h\u21921h50m\u21922h glitch class is gone. A real boundary change resets the projection; server clock corrections and arrival-time wobble (up to 90s) can never drag a countdown backwards.",
      },
      {
        kind: "Improved",
        text: "Overview — cache-first loading: the cockpit renders instantly from a versioned, per-user browser snapshot (no secrets, schema-checked), skips the live request entirely while it is fresh, and revalidates in the background. Revisiting within two minutes makes zero live-data requests.",
      },
      {
        kind: "Improved",
        text: "Overview — an F5 storm now replays the browser snapshot instead of hammering the API: ten rapid reloads produce one live fetch (server-side single-flight + minimum refetch spacing guard the shared Torn rate budget; the client adds none).",
      },
      {
        kind: "Improved",
        text: "Cockpit — heads-up cues and travel countdowns keep working from cached timestamps: a landing pre-alert (T-2m) fires from the snapshot without any Torn call, so a rate-limited upstream never silences the warning layer.",
      },
      {
        kind: "Technical",
        text: "Client refresh is decoupled from Torn refresh: /api/today serves the persisted latest-known copy immediately (stale-while-revalidate, single-flight, 15s minimum spacing per user) and background revalidation stays the only path to live Torn data. Out-of-order responses are dropped (monotonic on fetchedAt), and the shared dashboard clock is anchored to performance time — clamped non-decreasing, one 1s ticker for the whole cockpit.",
      },
    ],
  },
  {
    version: "2.0.6",
    summary:
      "Travel freshness hotfix: the cockpit's travel state is now resource-specific — an unrelated section's stale payload can no longer show \u201cTravel data stale\u201d, landings confirm within seconds of the boundary, and the gap reads as an honest \u201cLanding…\u201d transition.",
    changes: [
      {
        kind: "Fixed",
        text: "Overview — travel freshness is now resource-specific. A global payload staleness flag (one failed upstream refresh of ANY section) no longer shows \u201cTravel data stale\u201d: travel is fresh when the served payload is live or when the travel resource itself was recently synced. Money can be stale while travel is fresh.",
      },
      {
        kind: "Fixed",
        text: "Overview — landing transitions no longer disappear behind a stale claim. When the recorded landing time passes without fresh confirmation, the row reads \u201cLanding…\u201d for a short grace window (an honest transition — never stale, never an unconfirmed Home); a confirmation fetch around the boundary flips it to Abroad or Home within seconds.",
      },
      {
        kind: "Improved",
        text: "Cockpit — context-aware travel refresh: while a flight is inside its last five minutes (and briefly after the boundary) the live status refreshes automatically at 30s/15s cadence; at any other time the normal cadence applies. One bounded confirmation burst per landing — no new polling loops.",
      },
      {
        kind: "Fixed",
        text: "Heads-up — travel cues (landing T-2m, at-landing) are suppressed only when TRAVEL itself is stale; unrelated section staleness no longer hides the landing warning. The travel/OC conflict warning follows the same travel-specific freshness.",
      },
      {
        kind: "Technical",
        text: "The Today payload's travel section now carries the travel resource's own last successful sync time (worker bookkeeping, zero extra Torn calls), and the scheduler runs a landing fast-path: while a flight is inside its landing window the travel sync is pulled due every tick so the stored state confirms immediately after landing.",
      },
    ],
  },
  {
    version: "2.0.5",
    summary:
      "Cockpit heads-up update: Active States sort by urgency, configurable pre-alert cues for landing/cooldowns/OC/bank, and a travel-vs-OC timing conflict warning — conservative, deduped, personally configurable.",
    changes: [
      {
        kind: "Added",
        text: "Overview — configurable heads-up alerts: a compact banner warns before (and exactly at) travel landings, cooldown readiness, organized-crime readiness and bank maturity. Thresholds per timer type (e.g. travel T-2 min, OC T-5 min, bank T-10 min) live in Settings → Notifications; every cue has a deterministic one-shot key so rerenders and restarts never duplicate one.",
      },
      {
        kind: "Added",
        text: "Overview — travel/OC timing conflict warning: while you are actually flying, the cockpit compares your round trip (own recorded flight durations + buffers) against the OC ready time and tells you when you may not be back in time. Only for real flights, never for guessed intent; unknown destination duration means no warning.",
      },
      {
        kind: "Improved",
        text: "Overview — Active States now sort by urgency: hard states and in-progress flights first, actionable-now next, then anything finishing within the hour, with same-urgency items ordered by time remaining. Travel stays the top state while away; a compact Home row makes the travel state explicit even when you are simply home.",
      },
      {
        kind: "Improved",
        text: "Overview/Today roles are now explicit: Overview answers \u201cwhat is happening now?\u201d, Today answers \u201cwhat happened today?\u201d — the cockpit link now reads \u201cToday's activity\u201d instead of implying a bigger live view.",
      },
      {
        kind: "Fixed",
        text: "Stale timer data can no longer trigger actionable heads-ups: a stale payload suppresses every cue and the conflict warning. One-shot dedupe covers threshold cues across rerenders; the optional local sound is explicit opt-in, fires once per new cue and never autoplays before page interaction.",
      },
    ],
  },
  {
    version: "2.0.4",
    summary:
      "Live-status correctness: Travel is a canonical state on the Overview — it always renders exactly one explicit status (Home / Flying / Returning / Landed / Abroad / Stale / Unavailable), with flights at the top of the cockpit. Hidden is never a travel state.",
    changes: [
      {
        kind: "Fixed",
        text: "Overview — travel can no longer disappear from the live block. Just landed used to leave NO travel row at all (the traveling card expired while abroad did not apply), making state ambiguous. Travel now always renders exactly one explicit status: Home, Flying to <destination>, Returning from <destination>, Landed, Abroad · <destination>, Travel data stale (with age) or Travel status unavailable. Flights, returns, landed and abroad sit at the top of the active-states block with an accent marker and keep their safe Torn travel link; Home closes the block compactly. Stale or unavailable data never claims Home.",
      },
    ],
  },
  {
    version: "2.0.3",
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
    summary: "Fixed over-capped (stacked) energy being displayed as full — the real value is now shown everywhere, with an honest over-cap note.",
    changes: [
      { kind: "Fixed", text: "Overview / Today — Energy above its natural cap is no longer clamped to \"150 / 150\". Stacked energy — e.g. 400/150 after a Xanax — now shows the real numbers (\"400 / 150\") with a calm \"Stacked · +250 over cap\" note instead of a misleading \"Full\". No full-at countdown is invented while over cap (Torn supplies none: regeneration really is stopped until you drop below the cap), and the normal energy accent is kept — a stack is intentional, not an error. Your natural cap (100 or 150) is always the denominator, never hardcoded." },
      { kind: "Technical", text: "Bar semantics made explicit across the API contract: current (the real Torn value — may legitimately exceed the cap), natural cap, and bar fill (bounded 0–100%) are now separate concepts, with a derived overCap amount exposed by the Today API. Regression tests pin the whole range — 100/150, 150/150, 151/150, 400/150, 1000/150 and 350/100 — the API contract itself (raw Torn 400/150 in → 400/150 out), and the energy ledger (a banked Xanax +250 reconciles exactly — energy above the cap is real, nothing is lost)." },
    ],
  },
  {
    version: "1.0.3",
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
    summary: "Hotfix: enabling push notifications failed on every browser — most visibly on iPhone, where Safari reports it as \"The string contains invalid characters.\"",
    changes: [
      { kind: "Fixed", text: "Notifications — enabling push works again. The server's VAPID public key is base64URL; a settings-rebuild regression fed it to the browser's decoder unnormalized, which browsers reject (WebKit's wording: \"The string contains invalid characters.\") before subscription even starts." },
      { kind: "Improved", text: "Notifications — enable/disable/test failures now explain themselves in plain language (permission blocked, server key misconfigured, service worker unavailable, subscription refused) instead of surfacing raw browser exceptions." },
      { kind: "Technical", text: "Push key decoding and the enable pipeline moved into a tested module (base64url normalization, 65-byte P-256 validation) with secret-free diagnostic logging; the API trims VAPID env values and warns at boot when a key has the wrong shape." },
    ],
  },
  {
    version: "1.0.1",
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
    summary:
      "First stable release — a year of continuous development certified against live production data, and the culmination of the Public Beta 2 development line.",
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
    summary: "Sync recovery reliability fix for stuck resources.",
    changes: [
      { kind: "Fixed", text: "Stale sync recovery livelock: staleness is now judged by a dedicated run heartbeat instead of a bookkeeping timestamp, so a worker crash mid-run recovers instead of looping \"resource busy\" forever. No cursor or history reset required." },
    ],
  },
  {
    version: "v0.1.1",
    summary: "Layout polish pass on the first public beta.",
    changes: [
      { kind: "Fixed", text: "Settings — the API-key input row and quiet-hours row wrap on narrow phones instead of overflowing." },
      { kind: "Fixed", text: "Global mobile horizontal overflow removed across routes." },
    ],
  },
  {
    version: "v0.1.0-beta.1",
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
