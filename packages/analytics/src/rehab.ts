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

export interface RehabStats {
  totalSpend: number | null;
  trips: number;
  latestAt: number | null;
  averageSpend: number | null;
  history: RehabEventLike[];
  provenance: Provenance;
}

export function calculateRehabStats(events: readonly RehabEventLike[], from: number, to: number): RehabStats {
  const inRange = filterByRange(events, from, to).sort((a, b) => b.occurredAt - a.occurredAt);
  const withCost = inRange.filter((e) => e.cost !== null);
  const totalSpend = withCost.reduce((sum, e) => sum + (e.cost ?? 0), 0);

  return {
    totalSpend: withCost.length > 0 ? totalSpend : inRange.length > 0 ? null : 0,
    trips: inRange.length,
    latestAt: inRange[0]?.occurredAt ?? null,
    averageSpend: withCost.length > 0 ? totalSpend / withCost.length : null,
    history: inRange,
    provenance: withCost.length === inRange.length ? "exact" : "estimated",
  };
}
