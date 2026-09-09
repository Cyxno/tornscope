import {
  DATA_CONFIDENCE_STATES,
  deriveDataConfidence,
  resourceAllowed,
  type ConfidenceFacts,
  type DataConfidence,
  type DataConfidenceMeta,
  type SyncResource,
} from "@tornscope/shared";
import { getPrismaClient, type SyncStateRow } from "@tornscope/database";
import type { AvailabilityContext } from "./availability.js";

/**
 * Central data-confidence derivation (v0.2).
 *
 * The ONLY place endpoints turn system state (capabilities + sync state +
 * coverage evidence) into a DataConfidenceMeta. Controllers never hand-roll
 * `if capability && lastSuccess ...` — they load one batched context and ask
 * for the resources they render.
 *
 * Coverage evidence comes from existing SyncState fields (stopReason,
 * sourceEarliestAt, lastTimestamp, frequencySeconds) — no new persistence.
 * A clean backward walk is the proof that the resource's collection window
 * is covered; table-level row bounds are exposed separately on the Sync
 * Status page ("stored data"), not conflated with collection coverage.
 */

/** Resources whose history comes from a Torn-side backward walk. */
const WALK_RESOURCES: ReadonlySet<string> = new Set(["drugs", "rehab", "money_logs", "travel", "events", "attacks"]);

/** Configured initial history window (worker env default), as seconds. */
export function requestedHistorySeconds(): number {
  const days = Number(process.env.TORN_SYNC_INITIAL_HISTORY_DAYS ?? 180);
  return (Number.isFinite(days) && days > 0 ? days : 180) * 86_400;
}

const sec = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null);

/**
 * Lower bound of the coverage a clean walk established, in unix seconds.
 *
 * - history_boundary_reached: the walk stopped at the configured window's
 *   lower bound — coverage starts there (even if no rows exist that old).
 * - source_exhausted (or the boundary is unknown): the walk consumed the
 *   source's retention — coverage starts at the oldest observed timestamp.
 */
function walkCoverageFrom(state: SyncStateRow, nowMs: number): number | null {
  if (state.stopReason === "history_boundary_reached" || state.sourceEarliestAt === null) {
    return Math.floor((nowMs - requestedHistorySeconds() * 1000) / 1000);
  }
  return Number(state.sourceEarliestAt);
}

/**
 * Build the derivation facts for one resource from the shared context.
 * `range` is the requested analytics window (unix seconds) when the caller
 * renders a range-based value; `coverageTo` may carry a table-level newest
 * row (Sync Status page) for display.
 */
export function resourceConfidence(
  ctx: AvailabilityContext,
  resource: SyncResource,
  opts: { range?: { from: number; to: number } | null; coverageTo?: number | null; hasCategoryProblems?: boolean } = {},
  nowMs: number = Date.now()
): DataConfidenceMeta {
  const state = ctx.states.get(resource);
  const isWalkResource = WALK_RESOURCES.has(resource);

  if (!state) {
    // No sync row at all (unexpected): the resource was never set up.
    return {
      confidence: "unavailable",
      reason: "never_synced",
      lastRefreshedAt: null,
      coverage: { from: null, to: null, hasKnownGaps: false },
    };
  }

  // Demo data is a complete synthetic snapshot by construction: permission
  // questions do not apply (there is no key) and its walks count as finished,
  // so the demo dataset reports complete/partial on its own merits — never
  // as stale_permission or backfill_in_progress.
  const permissionAllowed = ctx.isDemo ? true : resourceAllowed(ctx.caps, resource);
  const stopReason = ctx.isDemo && isWalkResource ? "source_exhausted" : state.stopReason;
  const nowSec = Math.floor(nowMs / 1000);

  const facts: ConfidenceFacts = {
    permissionAllowed,
    isWalkResource,
    status: state.status,
    lastSuccessAt: sec(state.lastSuccessAt),
    recordsCollected: state.recordsCollected,
    stopReason,
    hasCategoryProblems: opts.hasCategoryProblems ?? false,
    coverageFrom: isWalkResource && stopReason !== null && state.lastSuccessAt !== null ? walkCoverageFrom(state, nowMs) : null,
    coverageTo: opts.coverageTo ?? null,
    // Demo never goes stale (it cannot refresh — there is no key).
    freshnessToleranceSeconds: ctx.isDemo ? Math.floor(Number.MAX_SAFE_INTEGER / 4) : Math.max(3 * state.frequencySeconds, 900),
  };
  return deriveDataConfidence(facts, opts.range ?? {}, nowSec);
}

/**
 * Batched table-level stored row bounds for the given domains — the real
 * "oldest/latest structured row" evidence shown next to collection coverage.
 * Two aggregates per domain, grouped into one round trip per table.
 */
export async function getStoredCoverageWindows(
  db: ReturnType<typeof getPrismaClient>,
  userId: string,
  domains: string[]
): Promise<Record<string, { earliest: number | null; latest: number | null }>> {
  const want = new Set(domains);
  const [drugW, rehabW, moneyW, travelW, eventW, networthW, attackW] = await Promise.all([
    want.has("drugs") ? db.drugEvent.aggregate({ where: { userId }, _min: { occurredAt: true }, _max: { occurredAt: true } }) : null,
    want.has("rehab") ? db.rehabEvent.aggregate({ where: { userId }, _min: { occurredAt: true }, _max: { occurredAt: true } }) : null,
    want.has("money_logs") ? db.moneyEvent.aggregate({ where: { userId }, _min: { occurredAt: true }, _max: { occurredAt: true } }) : null,
    want.has("travel") ? db.travelTransition.aggregate({ where: { userId }, _min: { occurredAt: true }, _max: { occurredAt: true } }) : null,
    want.has("events") ? db.timelineEvent.aggregate({ where: { userId, type: "torn_event" }, _min: { occurredAt: true }, _max: { occurredAt: true } }) : null,
    want.has("networth") ? db.networthSnapshot.aggregate({ where: { userId }, _min: { capturedAt: true }, _max: { capturedAt: true } }) : null,
    want.has("attacks") ? db.combatEvent.aggregate({ where: { userId }, _min: { occurredAt: true }, _max: { occurredAt: true } }) : null,
  ]);
  const windows: Record<string, { earliest: number | null; latest: number | null }> = {};
  const put = (key: string, min: unknown, max: unknown) => {
    if (!want.has(key)) return;
    windows[key] = {
      earliest: min instanceof Date ? sec(min) : null,
      latest: max instanceof Date ? sec(max) : null,
    };
  };
  put("drugs", drugW?._min.occurredAt, drugW?._max.occurredAt);
  put("rehab", rehabW?._min.occurredAt, rehabW?._max.occurredAt);
  put("money_logs", moneyW?._min.occurredAt, moneyW?._max.occurredAt);
  put("travel", travelW?._min.occurredAt, travelW?._max.occurredAt);
  put("events", eventW?._min.occurredAt, eventW?._max.occurredAt);
  put("networth", networthW?._min.capturedAt, networthW?._max.capturedAt);
  put("attacks", attackW?._min.occurredAt, attackW?._max.occurredAt);
  return windows;
}

/** Stable ordering for UI sorting ("worst first"). */
export function confidenceSeverity(confidence: DataConfidence): number {
  return DATA_CONFIDENCE_STATES.indexOf(confidence);
}
