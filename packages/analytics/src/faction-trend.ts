/**
 * Faction snapshot history (2.6.0) — respect & member-count trends from the
 * ALREADY-STORED FactionSnapshot series. Read-only derivation; no upstream
 * calls, no fabricated dates: every point is a stored snapshot.
 *
 * Several profiles may snapshot the same faction; per timestamp bucket the
 * earliest observation wins (they describe the same faction state).
 */

export interface FactionTrendPoint {
  t: number;
  respect: number | null;
  members: number | null;
}

export interface FactionTrendDelta {
  respect: { opening: number | null; closing: number | null; delta: number | null; ratePerDay: number | null };
  members: { opening: number | null; closing: number | null; delta: number | null; ratePerDay: number | null };
  trackingSince: number | null;
  points: number;
}

export interface FactionTrend {
  series: FactionTrendPoint[];
  delta: FactionTrendDelta;
}

function firstByBucket(series: FactionTrendPoint[], bucketSeconds: number): FactionTrendPoint[] {
  const byBucket = new Map<number, FactionTrendPoint>();
  for (const point of series) {
    const bucket = Math.floor(point.t / bucketSeconds);
    const existing = byBucket.get(bucket);
    if (!existing || point.t < existing.t) byBucket.set(bucket, point);
  }
  return [...byBucket.values()].sort((a, b) => a.t - b.t);
}

function deltaOf(series: FactionTrendPoint[], pick: (p: FactionTrendPoint) => number | null): FactionTrendDelta["respect"] {
  const withValue = series.map((p) => ({ t: p.t, value: pick(p) })).filter((p): p is { t: number; value: number } => p.value !== null);
  if (withValue.length === 0) return { opening: null, closing: null, delta: null, ratePerDay: null };
  const opening = withValue[0]!;
  const closing = withValue[withValue.length - 1]!;
  const spanDays = Math.max((closing.t - opening.t) / 86_400, 0);
  return {
    opening: opening.value,
    closing: closing.value,
    delta: withValue.length > 1 ? closing.value - opening.value : null,
    ratePerDay: withValue.length > 1 && spanDays >= 0.5 ? (closing.value - opening.value) / spanDays : null,
  };
}

/**
 * Build the faction trend from stored snapshots. `range` filters by capture
 * time. Bucketed hourly to collapse same-moment duplicates across profiles.
 */
export function buildFactionTrend(
  rows: Array<{ t: number; respect: number | null; members: number | null }>,
  range?: { from?: number; to?: number }
): FactionTrend {
  const filtered = rows
    .filter((r) => (range?.from === undefined ? true : r.t >= range.from))
    .filter((r) => (range?.to === undefined ? true : r.t <= range.to))
    .sort((a, b) => a.t - b.t);
  const series = firstByBucket(filtered, 3600);
  return {
    series,
    delta: {
      respect: deltaOf(series, (p) => p.respect),
      members: deltaOf(series, (p) => p.members),
      trackingSince: series.length > 0 ? series[0]!.t : null,
      points: series.length,
    },
  };
}

export interface UserMilestone {
  t: number;
  kind: "level" | "rank" | "faction";
  from: string | number | null;
  to: string | number | null;
}

/**
 * User history transitions (FASE 21-22) from the stored UserSnapshot series:
 * level milestones, rank changes and faction joins/moves. Only OBSERVED
 * transitions are reported — never an inferred leave date.
 */
export function buildUserMilestones(
  rows: Array<{ t: number; level: number | null; rank: string | null; factionId: number | null }>
): UserMilestone[] {
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const milestones: UserMilestone[] = [];
  let prevLevel: number | null = null;
  let prevRank: string | null = null;
  let prevFaction: number | null = null;
  let prevFactionT = 0;
  for (const row of sorted) {
    if (prevLevel !== null && row.level !== null && row.level > prevLevel) {
      milestones.push({ t: row.t, kind: "level", from: prevLevel, to: row.level });
    }
    if (prevRank !== null && row.rank !== null && row.rank !== prevRank) {
      milestones.push({ t: row.t, kind: "rank", from: prevRank, to: row.rank });
    }
    if (prevFaction !== null && row.factionId !== null && row.factionId !== prevFaction && row.t > prevFactionT) {
      milestones.push({ t: row.t, kind: "faction", from: prevFaction, to: row.factionId });
    }
    if (row.level !== null) prevLevel = row.level;
    if (row.rank !== null) prevRank = row.rank;
    if (row.factionId !== null) {
      prevFaction = row.factionId;
      prevFactionT = row.t;
    }
  }
  return milestones;
}

/* -------------------------------------------------------------------------- */
/* Crime skill progression (2.6.0) — from timeline-only skill bookkeeping      */
/* -------------------------------------------------------------------------- */

export interface CrimeSkillEvent {
  t: number;
  crime: string;
  level: number;
  direction: "up" | "down";
}

export interface CrimeSkillStat {
  crime: string;
  /** Latest observed skill level (exact, from Torn's own log). */
  level: number | null;
  /** First observed level in-range (null when unknown). */
  opening: number | null;
  /** Net level change over the observed events (downs subtract). */
  delta: number | null;
  levelUps: number;
  levelDowns: number;
  lastChangeAt: number | null;
}

/**
 * Per-crime skill progression from the bookkeeping logs. No fabricated
 * levels: "level" is the latest observed payload value; "delta" only spans
 * observed events.
 */
export function buildCrimeSkillProgression(events: CrimeSkillEvent[]): CrimeSkillStat[] {
  const byCrime = new Map<string, CrimeSkillStat>();
  for (const e of events) {
    let stat = byCrime.get(e.crime);
    if (!stat) {
      stat = { crime: e.crime, level: null, opening: null, delta: null, levelUps: 0, levelDowns: 0, lastChangeAt: null };
      byCrime.set(e.crime, stat);
    }
    if (stat.opening === null) stat.opening = e.level;
    stat.level = e.level;
    stat.lastChangeAt = e.t;
    if (e.direction === "up") stat.levelUps += 1;
    else stat.levelDowns += 1;
  }
  const stats = [...byCrime.values()];
  for (const stat of stats) {
    stat.delta = stat.opening !== null && stat.level !== null ? stat.level - stat.opening : null;
  }
  return stats.sort((a, b) => (b.level ?? 0) - (a.level ?? 0) || a.crime.localeCompare(b.crime));
}
