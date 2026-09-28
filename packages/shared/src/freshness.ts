/**
 * Data freshness (2.0) — answers, per USER-FACING data domain, whether the
 * stored data is fresh, or WHY it is not: delayed sync, stale sync, failed
 * sync, or data TornScope never had access to.
 *
 * This is deliberately the third, separate vocabulary:
 * - confidence.ts answers "can I trust this stored data for analytics";
 * - sync-health.ts answers "is the sync pipeline healthy for a resource";
 * - freshness here answers the user's question "why does this page say no
 *   data — because there IS nothing, or because syncing broke?".
 *
 * It is derived from the SAME facts as operational sync health (SyncState
 * last-success/last-attempt/error), never guessed. Live-fetched domains
 * (stocks, merits) have no stored history at all — they are flagged `live`
 * and their availability rides on Torn API reachability, not on a cursor.
 */

/* -------------------------------------------------------------------------- */
/* Statuses                                                                    */
/* -------------------------------------------------------------------------- */

export const DATA_FRESHNESS_STATUSES = ["fresh", "delayed", "stale", "failed", "unavailable"] as const;
export type DataFreshnessStatus = (typeof DATA_FRESHNESS_STATUSES)[number];

export const DATA_FRESHNESS_STATUS_LABELS: Record<DataFreshnessStatus, string> = {
  fresh: "Fresh",
  delayed: "Delayed",
  stale: "Stale",
  failed: "Failed",
  unavailable: "Unavailable",
};

export type DataFreshnessSeverity = "ok" | "warning" | "error";

export const DATA_FRESHNESS_SEVERITY: Record<DataFreshnessStatus, DataFreshnessSeverity> = {
  fresh: "ok",
  delayed: "warning",
  stale: "warning",
  failed: "error",
  unavailable: "warning",
};

/* -------------------------------------------------------------------------- */
/* Domain registry                                                             */
/* -------------------------------------------------------------------------- */

export interface DataFreshnessDomainMeta {
  id: string;
  label: string;
  /** SyncState resources whose freshness feeds this domain (worst wins). */
  resources: readonly string[];
  /**
   * Live domains are fetched on demand (no stored history); their freshness
   * is the Torn API service status at read time, never a cursor.
   */
  live?: boolean;
}

/**
 * The user-facing domains. Resource ids match SYNC_RESOURCES / SyncState.resource.
 * `faction` aggregates the faction family; `logs` is the timeline/event feed.
 */
export const DATA_FRESHNESS_DOMAINS: readonly DataFreshnessDomainMeta[] = [
  { id: "profile", label: "Profile", resources: ["profile"] },
  { id: "money", label: "Money logs", resources: ["money_logs"] },
  { id: "networth", label: "Net worth", resources: ["networth"] },
  { id: "bars", label: "Bars", resources: ["bars"] },
  { id: "battle_stats", label: "Battle stats", resources: ["personal_stats"] },
  { id: "events", label: "Events & timeline", resources: ["events"] },
  { id: "travel", label: "Travel", resources: ["travel"] },
  { id: "drugs", label: "Drugs", resources: ["drugs"] },
  { id: "rehab", label: "Rehab", resources: ["rehab"] },
  { id: "combat", label: "Attacks", resources: ["attacks"] },
  { id: "faction", label: "Faction", resources: ["faction", "faction_basic", "ranked_wars", "chains"] },
  { id: "organized_crime", label: "Organized crime", resources: ["organized_crimes"] },
  { id: "stocks", label: "Stocks", resources: [], live: true },
  { id: "merits", label: "Merits", resources: [], live: true },
];

export function dataFreshnessDomain(id: string): DataFreshnessDomainMeta | undefined {
  return DATA_FRESHNESS_DOMAINS.find((d) => d.id === id);
}

/* -------------------------------------------------------------------------- */
/* Derivation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Age tolerances, expressed in multiples of the resource's own cadence — a
 * 5-minute resource must read "stale" far sooner than a daily one.
 * fresh:      age ≤ FRESH × cadence   (2× covers normal queueing jitter)
 * delayed:    age ≤ DELAYED × cadence (6× covers a few missed runs)
 * stale:      beyond that, with no failure explanation
 * failed:     the last attempt failed AND the data is past FRESH age
 * unavailable: never synced, parked (capability denied), or live+API down
 */
export const FRESHNESS_POLICY = {
  FRESH_AGE_MULTIPLE: 2,
  DELAYED_AGE_MULTIPLE: 6,
  /** Cadence floor/ceiling so extreme frequencies cannot distort thresholds. */
  MIN_CADENCE_SECONDS: 5 * 60,
  MAX_CADENCE_SECONDS: 24 * 3600,
} as const;

/** Minimal SyncState facts needed (unix seconds throughout). */
export interface FreshnessResourceFacts {
  resource: string;
  status: string;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextRunAt: number | null;
  frequencySeconds: number;
  errorCount: number;
  lastErrorKind: string | null;
}

export interface ResourceFreshness {
  resource: string;
  status: DataFreshnessStatus;
  /** Seconds since the last successful sync (null when never). */
  ageSeconds: number | null;
  /** The resource's own freshness thresholds used for the verdict. */
  freshAfterSeconds: number;
  delayedAfterSeconds: number;
  lastErrorKind: string | null;
}

const STATUS_ORDER: Record<DataFreshnessStatus, number> = { fresh: 0, delayed: 1, stale: 2, failed: 3, unavailable: 4 };

function worse(a: DataFreshnessStatus, b: DataFreshnessStatus): DataFreshnessStatus {
  return STATUS_ORDER[a] >= STATUS_ORDER[b] ? a : b;
}

/** Derive one resource's freshness from real sync facts. Pure. */
export function deriveResourceFreshness(facts: FreshnessResourceFacts, now: number): ResourceFreshness {
  const cadence = Math.min(Math.max(facts.frequencySeconds, FRESHNESS_POLICY.MIN_CADENCE_SECONDS), FRESHNESS_POLICY.MAX_CADENCE_SECONDS);
  const freshAfter = cadence * FRESHNESS_POLICY.FRESH_AGE_MULTIPLE;
  const delayedAfter = cadence * FRESHNESS_POLICY.DELAYED_AGE_MULTIPLE;
  const age = facts.lastSuccessAt !== null ? Math.max(0, now - facts.lastSuccessAt) : null;

  // No access, or nothing ever attempted: there is no pipeline to be broken.
  if (facts.status === "capability_denied" || facts.lastAttemptAt === null) {
    return { resource: facts.resource, status: "unavailable", ageSeconds: age, freshAfterSeconds: freshAfter, delayedAfterSeconds: delayedAfter, lastErrorKind: facts.lastErrorKind };
  }

  // No success ever arrived: there is no data to be fresh — "unavailable"
  // regardless of the pipeline state (importing has not produced anything).
  if (age === null) {
    return { resource: facts.resource, status: "unavailable", ageSeconds: null, freshAfterSeconds: freshAfter, delayedAfterSeconds: delayedAfter, lastErrorKind: facts.lastErrorKind };
  }

  // A failing sync never reads "fresh" (the domain table must stay visible
  // as a warning), but it only escalates to "failed" once the stored data is
  // itself no longer fresh — a failure 2 minutes ago over 5-minute data is
  // "delayed" (an automatic retry is already scheduled, data is recent).
  if (facts.status === "failed") {
    const failed: DataFreshnessStatus = age > freshAfter ? "failed" : "delayed";
    return { resource: facts.resource, status: failed, ageSeconds: age, freshAfterSeconds: freshAfter, delayedAfterSeconds: delayedAfter, lastErrorKind: facts.lastErrorKind };
  }

  if (age <= freshAfter) return { resource: facts.resource, status: "fresh", ageSeconds: age, freshAfterSeconds: freshAfter, delayedAfterSeconds: delayedAfter, lastErrorKind: null };
  if (age <= delayedAfter) return { resource: facts.resource, status: "delayed", ageSeconds: age, freshAfterSeconds: freshAfter, delayedAfterSeconds: delayedAfter, lastErrorKind: facts.lastErrorKind };
  return { resource: facts.resource, status: "stale", ageSeconds: age, freshAfterSeconds: freshAfter, delayedAfterSeconds: delayedAfter, lastErrorKind: facts.lastErrorKind };
}

/** Aggregated freshness of a domain = worst of its resources. */
export function deriveDomainFreshness(resourceStates: readonly ResourceFreshness[]): DataFreshnessStatus {
  if (resourceStates.length === 0) return "unavailable";
  return resourceStates.map((r) => r.status).reduce((acc, s) => worse(acc, s));
}

/** API shape of one domain's freshness row. */
export interface DataFreshnessEntry {
  domain: string;
  label: string;
  status: DataFreshnessStatus;
  /** Seconds since the newest successful sync among the domain's resources. */
  ageSeconds: number | null;
  /** Newest successful sync among the domain's resources (unix seconds). */
  lastSuccessAt: number | null;
  /** Present only when status is not fresh — the machine why-code. */
  lastErrorKind: string | null;
  /** Per-resource detail rows (compact; UI expands on demand). */
  resources: Array<{ resource: string; status: DataFreshnessStatus; ageSeconds: number | null }>;
  live: boolean;
}

/** Compose the full freshness table for the API. Pure. */
export function buildDataFreshness(facts: readonly FreshnessResourceFacts[], now: number, tornApiUp = true): DataFreshnessEntry[] {
  return DATA_FRESHNESS_DOMAINS.map((domain) => {
    if (domain.live) {
      const status: DataFreshnessStatus = tornApiUp ? "fresh" : "unavailable";
      return { domain: domain.id, label: domain.label, status, ageSeconds: null, lastSuccessAt: null, lastErrorKind: tornApiUp ? null : "torn_api_unreachable", resources: [], live: true };
    }
    const rows = domain.resources
      .map((resource) => facts.find((f) => f.resource === resource))
      .filter((f): f is FreshnessResourceFacts => f !== undefined)
      .map((f) => deriveResourceFreshness(f, now));
    const status = deriveDomainFreshness(rows);
    const newestSuccess = rows.reduce<number | null>((acc, r) => (r.ageSeconds === null ? acc : acc === null ? now - r.ageSeconds : Math.max(acc, now - r.ageSeconds)), null);
    const errorKind = rows.find((r) => r.lastErrorKind !== null && r.status !== "fresh")?.lastErrorKind ?? null;
    return {
      domain: domain.id,
      label: domain.label,
      status,
      ageSeconds: newestSuccess !== null ? Math.max(0, now - newestSuccess) : null,
      lastSuccessAt: newestSuccess,
      lastErrorKind: status === "fresh" ? null : errorKind,
      resources: rows.map((r) => ({ resource: r.resource, status: r.status, ageSeconds: r.ageSeconds })),
      live: false,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Zod contract (mirrors the types above)                                      */
/* -------------------------------------------------------------------------- */

import { z } from "zod";

export const DataFreshnessStatusSchema = z.enum(DATA_FRESHNESS_STATUSES);

export const DataFreshnessEntrySchema = z.object({
  domain: z.string(),
  label: z.string(),
  status: DataFreshnessStatusSchema,
  ageSeconds: z.number().nullable(),
  lastSuccessAt: z.number().nullable(),
  lastErrorKind: z.string().nullable(),
  resources: z.array(z.object({ resource: z.string(), status: DataFreshnessStatusSchema, ageSeconds: z.number().nullable() })),
  live: z.boolean(),
});
