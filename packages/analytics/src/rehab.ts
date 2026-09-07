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
