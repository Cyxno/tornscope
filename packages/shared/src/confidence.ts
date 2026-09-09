/**
 * Data confidence / coverage model (v0.2 foundation).
 *
 * Derives, from real system state, how trustworthy a dataset is for a
 * requested context — so that zero, unknown, unavailable, partial, stale and
 * estimated stop being interchangeable.
 *
 * Layers:
 * - DataConfidence (dataset level): complete | partial | stale_permission |
 *   unavailable. Answers "can I trust coverage of this range at all?".
 * - Provenance (value level, provenance.ts): exact | derived | estimated.
 *   Answers "how was this number produced?".
 * - KpiAvailability (value level, contracts.ts): ok | unavailable |
 *   importing | incomplete. Answers "may this specific figure be rendered
 *   as-is?" — now DERIVED from confidence instead of per-page heuristics.
 *
 * Operational sync health (is the worker functioning? queued/running/failed)
 * is deliberately NOT part of this model — it stays on the Sync Status page
 * as its own phase enum. Confidence may read sync state as evidence, but the
 * two vocabularies are never merged.
 */

export const DATA_CONFIDENCE_STATES = ["complete", "partial", "stale_permission", "unavailable"] as const;

/**
 * - complete         required source data was available, expected coverage is
 *                    satisfied for the requested range, and no known
 *                    permission or sync gap invalidates the result
 * - partial          useful data exists, but known coverage gaps, incomplete
 *                    history or bounded sync windows prevent claiming completeness
 * - stale_permission history exists and is retained, but the current key can
 *                    no longer refresh it
 * - unavailable      no meaningful value can be produced for this context —
 *                    never rendered as a numeric zero
 */
export type DataConfidence = (typeof DATA_CONFIDENCE_STATES)[number];

/**
 * Machine-readable why-codes. The frontend maps these to localized copy —
 * they are never displayed raw and no server-side prose is shipped.
 * Only codes with a real consumer exist; provenance questions ("estimated?")
 * belong to Provenance, not here.
 */
export const CONFIDENCE_REASONS = [
  /** Permission missing and nothing stored — nothing to show. */
  "missing_permission",
  /** History exists but the current key lost the permission to refresh it. */
  "historical_permission_lost",
  /** Permission is fine, but this resource has never completed a sync. */
  "never_synced",
  /** A sync/backfill walk is currently running — data may still change. */
  "backfill_in_progress",
  /** Historical coverage is bounded (page cap, stalled cursor, walk pending). */
  "sync_incomplete",
  /** The most recent sync attempt failed; retained history is still shown. */
  "sync_error",
  /** The requested range starts before TornScope began collecting this data. */
  "range_before_coverage",
  /** The source answered but holds no data for this context. */
  "source_unavailable",
  /** The day has not ended yet — the summary cannot claim end-of-day completeness. */
  "day_in_progress",
] as const;

export type ConfidenceReason = (typeof CONFIDENCE_REASONS)[number];

/** Known coverage window (unix seconds). Only real boundaries are exposed —
 * the derivation never invents gap ranges it cannot prove. */
export interface ConfidenceCoverage {
  /** Oldest point the collected dataset is expected to cover (null = unknown). */
  from: number | null;
  /** Newest point covered by an actual successful refresh (null = unknown). */
  to: number | null;
  /** True only when the system KNOWS gaps exist inside the window. */
  hasKnownGaps: boolean;
}

export interface DataConfidenceMeta {
  confidence: DataConfidence;
  reason: ConfidenceReason | null;
  /** Last successful refresh of the backing resource (unix seconds). */
  lastRefreshedAt: number | null;
  coverage: ConfidenceCoverage;
}

/* -------------------------------------------------------------------------- */
/* Inputs — facts gathered by the caller (see apps/api confidence service)     */
/* -------------------------------------------------------------------------- */

export interface ConfidenceFacts {
  /** Can the CURRENT key sync this resource (permission-wise)? */
  permissionAllowed: boolean;
  /** Backward-walk resource with Torn-side history (logs, attacks, events). */
  isWalkResource: boolean;
  /** sync_state.status: idle | running | failed | capability_denied. */
  status: string;
  lastSuccessAt: number | null;
  recordsCollected: number;
  /** sync_state.stopReason — null means the resource never ran a backward walk. */
  stopReason: string | null;
  /** Any backing category is failed/access_denied (walk resources only). */
  hasCategoryProblems: boolean;
  /** Trusted lower bound of the collected coverage window (unix seconds). */
  coverageFrom: number | null;
  /** Trusted upper bound — newest actual stored row, when known. */
  coverageTo: number | null;
  /** How far behind a fresh refresh may trail the requested range end before
   * the tail counts as uncovered (typically derived from sync frequency). */
  freshnessToleranceSeconds: number;
}

export interface ConfidenceRangeInput {
  /** Requested analytics range (unix seconds). Null for non-range contexts. */
  from?: number | null;
  to?: number | null;
}

/** stopReasons that prove bounded/incomplete history. */
const INCOMPLETE_STOP_REASONS = new Set(["max_pages", "cursor_stalled", "api_error"]);

const DEFAULT_FRESHNESS_TOLERANCE_SECONDS = 6 * 3600;

/* -------------------------------------------------------------------------- */
/* Derivation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Derive dataset confidence from real facts. Pure — the same inputs always
 * yield the same meta, for any user, with no hidden lookups.
 *
 * Completeness is claimed ONLY when it is actually provable: a clean walk
 * (or a snapshot resource with a successful sync), a refreshed-enough tail
 * and a requested range inside the covered window. Anything less is partial.
 */
export function deriveDataConfidence(facts: ConfidenceFacts, range: ConfidenceRangeInput = {}, now: number = Math.floor(Date.now() / 1000)): DataConfidenceMeta {
  const tolerance = facts.freshnessToleranceSeconds > 0 ? facts.freshnessToleranceSeconds : DEFAULT_FRESHNESS_TOLERANCE_SECONDS;
  const hasStoredData = facts.recordsCollected > 0 || facts.coverageFrom !== null || facts.coverageTo !== null;
  const coverage: ConfidenceCoverage = { from: facts.coverageFrom, to: facts.coverageTo, hasKnownGaps: false };
  const meta = (confidence: DataConfidence, reason: ConfidenceReason | null): DataConfidenceMeta => ({
    confidence,
    reason,
    lastRefreshedAt: facts.lastSuccessAt,
    coverage,
  });

  // 1+2. Permission — the current key cannot refresh this resource. Retained
  // history stays visible (stale_permission); nothing stored stays unavailable.
  // A runtime capability_denied is trusted over a possibly-stale caps blob.
  if (!facts.permissionAllowed || facts.status === "capability_denied") {
    return hasStoredData ? meta("stale_permission", "historical_permission_lost") : meta("unavailable", "missing_permission");
  }

  // 3. Never completed a sync — there is no dataset to speak of.
  if (facts.lastSuccessAt === null) {
    if (facts.status === "running") {
      return hasStoredData ? meta("partial", "backfill_in_progress") : meta("unavailable", "backfill_in_progress");
    }
    return meta("unavailable", "never_synced");
  }

  // 4. A walk is running right now: usable rows may already exist, but the
  // dataset is still growing. With nothing stored yet there is no value to
  // show at all — importing, never zero. (Demo's fabricated states never run.)
  if (facts.status === "running") {
    return hasStoredData ? meta("partial", "backfill_in_progress") : meta("unavailable", "backfill_in_progress");
  }

  const walkIncomplete =
    facts.isWalkResource &&
    (facts.hasCategoryProblems || facts.stopReason === null || INCOMPLETE_STOP_REASONS.has(facts.stopReason));

  // 5. The last attempt failed: retained history stays visible and is still
  // real, but the dataset stopped being refreshed.
  if (facts.status === "failed") {
    return hasStoredData || !walkIncomplete ? meta("partial", "sync_error") : meta("unavailable", "sync_error");
  }

  // 6. Bounded/incomplete history coverage.
  if (walkIncomplete) {
    return meta("partial", facts.stopReason === null ? "backfill_in_progress" : "sync_incomplete");
  }

  // 7. Range-aware gaps — only claimed against a KNOWN boundary.
  const rangeFrom = range.from ?? null;
  const rangeTo = range.to ?? null;
  if (rangeFrom !== null && facts.coverageFrom !== null && rangeFrom < facts.coverageFrom) {
    return meta("partial", "range_before_coverage");
  }
  if (
    rangeTo !== null &&
    rangeTo <= now &&
    facts.lastSuccessAt !== null &&
    facts.lastSuccessAt < rangeTo - tolerance
  ) {
    // The tail of the requested range was never refreshed — the dataset
    // stopped tracking inside the range (sync paused/broken with no error).
    return meta("partial", "sync_incomplete");
  }

  // 8. Clean walk with zero collected rows is a REAL empty source — the walk
  // scanned the whole window and found nothing. Zero is meaningful here.
  if (!hasStoredData) {
    return meta(facts.isWalkResource ? "complete" : "unavailable", facts.isWalkResource ? null : "source_unavailable");
  }

  return meta("complete", null);
}

/* -------------------------------------------------------------------------- */
/* Combining / mapping helpers                                                 */
/* -------------------------------------------------------------------------- */

const CONFIDENCE_SEVERITY: Record<DataConfidence, number> = {
  complete: 0,
  partial: 1,
  stale_permission: 2,
  unavailable: 3,
};

/** Worst confidence of a set — for sections backed by several resources. */
export function worstConfidence(metas: DataConfidenceMeta[]): DataConfidenceMeta | null {
  if (metas.length === 0) return null;
  return metas.reduce((worst, m) => (CONFIDENCE_SEVERITY[m.confidence] > CONFIDENCE_SEVERITY[worst.confidence] ? m : worst), metas[0]!);
}

/**
 * Value-level availability derived from dataset confidence. This is the ONE
 * place the ok/unavailable/importing/incomplete mapping lives, replacing the
 * per-page heuristics that used to diverge between endpoints.
 *
 * stale_permission keeps "ok": the stored values are real historical values
 * (the section badge communicates that they stopped refreshing) — but when no
 * rows exist the value stays null/unavailable, never a fabricated zero.
 */
export function kpiAvailabilityFromConfidence(meta: DataConfidenceMeta): "ok" | "unavailable" | "importing" | "incomplete" {
  switch (meta.confidence) {
    case "complete":
      return "ok";
    case "stale_permission":
      return "ok";
    case "partial":
      return meta.reason === "backfill_in_progress" ? "importing" : "incomplete";
    case "unavailable":
      // An in-progress first sync is a transient "importing", not a dead end.
      return meta.reason === "backfill_in_progress" ? "importing" : "unavailable";
  }
}

const KPI_SEVERITY: Record<"ok" | "unavailable" | "importing" | "incomplete", number> = {
  ok: 0,
  importing: 1,
  incomplete: 2,
  unavailable: 3,
};

/** Worst of two value-level availabilities (dataset-derived vs value-level evidence). */
export function worstKpiAvailability(
  a: "ok" | "unavailable" | "importing" | "incomplete",
  b: "ok" | "unavailable" | "importing" | "incomplete"
): "ok" | "unavailable" | "importing" | "incomplete" {
  return KPI_SEVERITY[a] >= KPI_SEVERITY[b] ? a : b;
}
