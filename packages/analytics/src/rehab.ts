import type { Provenance } from "@tornscope/shared";
import { filterByRange } from "./money.js";

/**
 * Rehab analytics.
 */

export interface RehabEventLike {
  occurredAt: number;
  cost: number | null;
  rehabPercent: number | null;
  addictionPointsRemoved?: number | null;
}

/** One hospital trip: a cluster of rehab sessions close together in time. */
export interface RehabTrip {
  startedAt: number;
  sessions: number;
  cost: number | null;
}

export interface RehabStats {
  totalSpend: number | null;
  /** Clustered hospital trips — NOT the raw session count. */
  trips: number;
  latestAt: number | null;
  averageSpend: number | null;
  history: RehabEventLike[];
  provenance: Provenance;
  /** Individual rehab actions (the raw Torn log count). */
  sessions: number;
  tripClusters: RehabTrip[];
  averageSessionsPerTrip: number | null;
  averageCostPerTrip: number | null;
  averageCostPerSession: number | null;
}

/** Sessions within this window of each other belong to the same hospital trip. */
const TRIP_CLUSTER_GAP_SECONDS = 12 * 3600;

/** Group rehab sessions into hospital trips (chronological, gap-based). */
export function clusterRehabTrips(sessions: readonly RehabEventLike[]): RehabTrip[] {
  const ordered = [...sessions].sort((a, b) => a.occurredAt - b.occurredAt);
  const trips: RehabTrip[] = [];
  let current: RehabTrip | null = null;
  let previous: number | null = null;
  for (const s of ordered) {
    // occurredAt values are unix SECONDS.
    if (current === null || previous === null || s.occurredAt - previous > TRIP_CLUSTER_GAP_SECONDS) {
      current = { startedAt: s.occurredAt, sessions: 0, cost: 0 };
      trips.push(current);
    }
    current.sessions += 1;
    current.cost = (current.cost ?? 0) + (s.cost ?? 0);
    previous = s.occurredAt;
  }
  return trips;
}

export function calculateRehabStats(events: readonly RehabEventLike[], from: number, to: number): RehabStats {
  const inRange = filterByRange(events, from, to).sort((a, b) => b.occurredAt - a.occurredAt);
  const withCost = inRange.filter((e) => e.cost !== null);
  const totalSpend = withCost.reduce((sum, e) => sum + (e.cost ?? 0), 0);

  const tripClusters = clusterRehabTrips(inRange);
  const tripsWithCost = tripClusters.filter((t) => (t.cost ?? 0) > 0);
  const avgCostPerTrip = tripsWithCost.length > 0 ? tripsWithCost.reduce((s, t) => s + (t.cost ?? 0), 0) / tripsWithCost.length : null;
  const avgCostPerSession = withCost.length > 0 ? totalSpend / withCost.length : null;

  return {
    totalSpend: withCost.length > 0 ? totalSpend : inRange.length > 0 ? null : 0,
    trips: tripClusters.length,
    latestAt: inRange[0]?.occurredAt ?? null,
    averageSpend: withCost.length > 0 ? totalSpend / withCost.length : null,
    history: inRange,
    provenance: withCost.length === inRange.length ? "exact" : "estimated",
    sessions: inRange.length,
    tripClusters,
    averageSessionsPerTrip: tripClusters.length > 0 ? inRange.length / tripClusters.length : null,
    averageCostPerTrip: avgCostPerTrip !== null ? Math.round(avgCostPerTrip) : null,
    averageCostPerSession: avgCostPerSession !== null ? Math.round(avgCostPerSession) : null,
  };
}
