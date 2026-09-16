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
  /** Exact release tag (e.g. "v1.0.0"); the current in-progress release uses its plain version ("1.0.1") until tagged. */
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
    version: "1.0.1",
    date: "2026-09-16",
    stage: "Public Testing",
    current: true,
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
