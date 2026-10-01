import type { Provenance } from "@tornscope/shared";
import { filterByRange } from "./money.js";

/**
 * Rehab analytics.
 *
 * TERMINOLOGY (verified against the live Torn payload):
 * - One Torn "Rehab" log row is ONE VISIT. Torn itself emits a single row
 *   per visit — no time clustering is needed or correct.
 * - `rehab_times` in the payload is the explicit number of rehab SESSIONS
 *   purchased during that visit (live data: 2–4 per visit). One row has
 *   NEVER meant one session.
 * - `cost` is the TOTAL cost of the visit (all sessions included).
 *
 * A missing `rehab_times` renders "Sessions unavailable" — a session count
 * is never inferred from money (no pricing formula is proven) or from row
 * counts.
 */

export interface RehabEventLike {
  occurredAt: number;
  cost: number | null;
  rehabPercent: number | null;
  /** Explicit session count from Torn; null = unavailable. */
  sessions?: number | null;
  addictionPointsRemoved?: number | null;
}

/** One rehab visit (one Torn log row) with its explicit session count. */
export interface RehabVisit {
  startedAt: number;
  /** Sessions purchased during the visit; null = unavailable. */
  sessions: number | null;
  cost: number | null;
  /** Total cost ÷ sessions; only when both are known. */
  costPerSession: number | null;
}

export interface RehabStats {
  totalSpend: number | null;
  /** Rehab VISITS (Torn log rows) — not sessions, not time clusters. */
  visits: number;
  /** Sum of explicit session counts; null when NO visit carried a count. */
  sessions: number | null;
  /** Visits whose session count was unavailable in the source payload. */
  sessionsUnavailable: number;
  latestAt: number | null;
  /** Total spend ÷ visits. */
  averageSpend: number | null;
  history: RehabEventLike[];
  provenance: Provenance;
  /** Per-visit trend, oldest first. */
  visitTrend: RehabVisit[];
  /** Mean sessions per visit — over visits with a known count only. */
  averageSessionsPerVisit: number | null;
  averageCostPerVisit: number | null;
  /** Total spend ÷ total sessions; null unless EVERY visit has a count. */
  averageCostPerSession: number | null;
}

export function calculateRehabStats(events: readonly RehabEventLike[], from: number, to: number): RehabStats {
  const inRange = filterByRange(events, from, to).sort((a, b) => b.occurredAt - a.occurredAt);
  const withCost = inRange.filter((e) => e.cost !== null);
  const totalSpend = withCost.reduce((sum, e) => sum + (e.cost ?? 0), 0);

  const visits: RehabVisit[] = inRange
    .slice()
    .sort((a, b) => a.occurredAt - b.occurredAt)
    .map((e) => {
      const sessions = typeof e.sessions === "number" && e.sessions > 0 ? e.sessions : null;
      const cost = e.cost;
      return {
        startedAt: e.occurredAt,
        sessions,
        cost,
        costPerSession: sessions !== null && cost !== null && cost > 0 ? Math.round(cost / sessions) : null,
      };
    });

  const visitsWithSessions = visits.filter((v) => v.sessions !== null);
  const knownSessionSum = visitsWithSessions.reduce((s, v) => s + (v.sessions ?? 0), 0);
  const sessionsUnavailable = visits.length - visitsWithSessions.length;

  const avgCostPerVisit = withCost.length > 0 ? totalSpend / withCost.length : null;
  // Cost per session requires the full session count — partial knowledge
  // would produce a biased average, so it stays unavailable instead.
  const avgCostPerSession =
    sessionsUnavailable === 0 && visitsWithSessions.length > 0 && knownSessionSum > 0 ? totalSpend / knownSessionSum : null;

  return {
    totalSpend: withCost.length > 0 ? totalSpend : inRange.length > 0 ? null : 0,
    visits: inRange.length,
    sessions: visitsWithSessions.length > 0 ? knownSessionSum : null,
    sessionsUnavailable,
    latestAt: inRange[0]?.occurredAt ?? null,
    averageSpend: avgCostPerVisit,
    history: inRange,
    provenance: withCost.length === inRange.length ? "exact" : "estimated",
    visitTrend: visits,
    averageSessionsPerVisit: visitsWithSessions.length > 0 ? knownSessionSum / visitsWithSessions.length : null,
    averageCostPerVisit: avgCostPerVisit !== null ? Math.round(avgCostPerVisit) : null,
    averageCostPerSession: avgCostPerSession !== null ? Math.round(avgCostPerSession) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Rehab deep metrics (2.1.0)                                                  */
/* -------------------------------------------------------------------------- */

export interface RehabDeepStats {
  /** Sum of explicit addiction-points removals (exact where the payload
   *  carried them); null when NO visit carried a value. */
  addictionPointsRemoved: number | null;
  /** Visits whose payload carried an explicit AP value. */
  addictionPointsKnownVisits: number;
  /** Total spend ÷ total removed AP — only when every cost-bearing visit
   *  also carried an AP value (partial data would bias the ratio). */
  costPerAddictionPoint: number | null;
  /** Median cost of the most recent visits (estimated next visit). */
  estimatedNextCost: number | null;
  estimatedNextCostBasis: number;
  earliestAt: number | null;
}

const NEXT_COST_SAMPLE = 10;

export function calculateRehabDeepStats(events: readonly RehabEventLike[]): RehabDeepStats {
  const ordered = [...events].sort((a, b) => a.occurredAt - b.occurredAt);
  const withAp = ordered.filter((e) => typeof e.addictionPointsRemoved === "number" && (e.addictionPointsRemoved ?? 0) > 0);
  const apTotal = withAp.reduce((s, e) => s + (e.addictionPointsRemoved ?? 0), 0);
  // Every cost-bearing visit must carry an explicit AP value: rehab visits
  // always remove AP, so a missing value in ANY costed visit would bias a
  // partial ratio — refuse it instead of dividing a biased fraction.
  const withCost = ordered.filter((e) => typeof e.cost === "number" && (e.cost ?? 0) > 0);
  const apComplete = withCost.length > 0 && withCost.every((e) => typeof e.addictionPointsRemoved === "number" && (e.addictionPointsRemoved ?? 0) > 0);
  const costSum = withCost.reduce((s, e) => s + (e.cost ?? 0), 0);
  const apOfCosted = withCost.reduce((s, e) => s + (e.addictionPointsRemoved ?? 0), 0);
  // "Next visit" estimate: median cost of the most recent cost-bearing
  // visits (rehab pricing scales with addiction level — the median of
  // recent history is an estimate, never a quote).
  const recentCosts = [...ordered]
    .reverse()
    .filter((e) => typeof e.cost === "number" && (e.cost ?? 0) > 0)
    .slice(0, NEXT_COST_SAMPLE)
    .map((e) => e.cost as number);
  return {
    addictionPointsRemoved: withAp.length > 0 ? apTotal : null,
    addictionPointsKnownVisits: withAp.length,
    costPerAddictionPoint: apComplete && apOfCosted > 0 ? costSum / apOfCosted : null,
    estimatedNextCost: recentCosts.length > 0 ? medianOf(recentCosts) : null,
    estimatedNextCostBasis: recentCosts.length,
    earliestAt: ordered.length > 0 ? ordered[0]!.occurredAt : null,
  };
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
