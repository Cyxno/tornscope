import type { Provenance } from "@tornscope/shared";

/**
 * Net worth history analytics.
 */

export interface NetworthPointLike {
  capturedAt: number;
  total: number;
}

export interface NetworthChanges {
  current: number | null;
  change7d: number | null;
  change30d: number | null;
  changeYtd: number | null;
  changeAllTime: number | null;
  firstTrackedAt: number | null;
  provenance: Provenance;
}

const DAY = 86_400;

function valueAtOrBefore(snapshots: readonly NetworthPointLike[], ts: number): NetworthPointLike | null {
  let best: NetworthPointLike | null = null;
  for (const s of snapshots) {
    if (s.capturedAt <= ts && (best === null || s.capturedAt >= best.capturedAt)) best = s;
  }
  return best;
}

/** Compute period changes from snapshot history (ascending or unordered). */
export function calculateNetworthChanges(
  snapshots: readonly NetworthPointLike[],
  now: number,
  yearStart: number
): NetworthChanges {
  if (snapshots.length === 0) {
    return { current: null, change7d: null, change30d: null, changeYtd: null, changeAllTime: null, firstTrackedAt: null, provenance: "exact" };
  }

  const sorted = [...snapshots].sort((a, b) => a.capturedAt - b.capturedAt);
  const latest = sorted[sorted.length - 1];
  const earliest = sorted[0];
  if (!latest || !earliest) {
    return { current: null, change7d: null, change30d: null, changeYtd: null, changeAllTime: null, firstTrackedAt: null, provenance: "exact" };
  }

  const changeFor = (sinceTs: number): number | null => {
    const base = valueAtOrBefore(sorted, sinceTs);
    return base ? latest.total - base.total : null;
  };

  return {
    current: latest.total,
    change7d: changeFor(now - 7 * DAY),
    change30d: changeFor(now - 30 * DAY),
    changeYtd: changeFor(yearStart),
    changeAllTime: latest.total - earliest.total,
    firstTrackedAt: earliest.capturedAt,
    provenance: "exact",
  };
}
