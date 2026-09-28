import type { TrainingSession } from "./progression.js";
import { startOfDay, startOfWeek } from "./series.js";

/**
 * Training intelligence (2.0) — personal training aggregates built on the
 * EXISTING session/energy inference (progression.ts), never a re-derivation.
 *
 * All session figures are INFERRED data (documented inference from energy
 * declines + battlestat brackets) and keep that honesty: comparisons are
 * observational, and the time-of-day rule is explicitly correlational —
 * it describes when higher gain/E was OBSERVED, never claims morning
 * training causes anything, and it stays silent under small samples.
 */

const DAY = 86_400;

export interface TrainingPeriodStats {
  /** UTC day start of the period. */
  from: number;
  to: number;
  label: string;
  sessions: number;
  /** Bounded inferred energy spent (null when no session carried energy). */
  energyTrained: number | null;
  /** Observed gym-attributed stat gain. */
  statGain: number | null;
  /** Median gain per energy (null under 2 eligible sessions). */
  gainPerEnergyMedian: number | null;
  /** Hours the energy bar sat at cap in the period (from BarsSnapshot). */
  cappedHours: number;
}

export interface TrainingRecord {
  value: number;
  at: number;
  sampleSize: number;
}

export interface TrainingTimeOfDayBucket {
  /** Hour range start (0/6/12/18, server-local = Torn time). */
  hourStart: number;
  label: string;
  sessions: number;
  gainPerEnergyMedian: number | null;
}

export interface TrainingTimeOfDayObservation {
  buckets: TrainingTimeOfDayBucket[];
  /** The strongest bucket, ONLY when the sample clears the gates. */
  best: { label: string; sessions: number; gainPerEnergyMedian: number; upliftPct: number } | null;
  overallMedian: number | null;
  sampleSize: number;
  /** Explicit correlational framing — the UI shows this verbatim. */
  note: string;
}

export interface TrainingIntelligence {
  current: TrainingPeriodStats;
  previous: TrainingPeriodStats;
  baseline30d: TrainingPeriodStats;
  records: {
    bestGainPerEnergyDay: TrainingRecord | null;
    bestStatGainDay: TrainingRecord | null;
    bestWeek: TrainingRecord | null;
  };
  timeOfDay: TrainingTimeOfDayObservation | null;
  provenance: "inferred";
}

export interface TrainingIntelligenceInputs {
  now: number;
  sessions: ReadonlyArray<TrainingSession>;
  /** Hours at energy cap per UTC day (from BarsSnapshot derivation). */
  energyCappedHours: ReadonlyArray<{ t: number; hours: number }>;
}

const ELIGIBLE = (s: TrainingSession): boolean => s.gainPerEnergy !== null && !s.bracketShared;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid]! + sorted[mid - 1]!) / 2;
}

function periodStats(sessions: ReadonlyArray<TrainingSession>, cappedHours: ReadonlyArray<{ t: number; hours: number }>, from: number, to: number, label: string): TrainingPeriodStats {
  const inRange = sessions.filter((s) => s.startedAt >= from && s.startedAt < to);
  const withEnergy = inRange.filter((s) => s.energySpent !== null);
  const withGain = inRange.filter((s) => s.gymGain !== null);
  const eligible = inRange.filter(ELIGIBLE);
  const capped = cappedHours.filter((d) => d.t >= from && d.t < to);
  return {
    from,
    to,
    label,
    sessions: inRange.length,
    energyTrained: withEnergy.length > 0 ? withEnergy.reduce((sum, s) => sum + (s.energySpent ?? 0), 0) : null,
    statGain: withGain.length > 0 ? withGain.reduce((sum, s) => sum + (s.gymGain ?? 0), 0) : null,
    gainPerEnergyMedian: median(eligible.map((s) => s.gainPerEnergy!)),
    cappedHours: capped.reduce((sum, d) => sum + d.hours, 0),
  };
}

export const TRAINING_TIME_OF_DAY_POLICY = {
  /** Min sessions in a bucket before it can be named. */
  MIN_BUCKET_SESSIONS: 8,
  /** Min sessions overall before the observation runs at all. */
  MIN_TOTAL_SESSIONS: 20,
  /** Min uplift vs the overall median to be worth showing. */
  MIN_UPLIFT_PCT: 8,
  /** How far back the observation looks. */
  LOOKBACK_DAYS: 30,
} as const;

/** Correlational time-of-day observation (gated; null when data is thin). */
export function trainingTimeOfDay(sessions: ReadonlyArray<TrainingSession>, now: number, lookbackDays = TRAINING_TIME_OF_DAY_POLICY.LOOKBACK_DAYS): TrainingTimeOfDayObservation | null {
  const from = now - lookbackDays * DAY;
  const eligible = sessions.filter((s) => s.startedAt >= from && ELIGIBLE(s));
  if (eligible.length < TRAINING_TIME_OF_DAY_POLICY.MIN_TOTAL_SESSIONS) return null;
  const overall = median(eligible.map((s) => s.gainPerEnergy!));
  if (overall === null || overall <= 0) return null;

  const bucketDefs: Array<{ hourStart: number; label: string }> = [
    { hourStart: 0, label: "00:00–06:00" },
    { hourStart: 6, label: "06:00–12:00" },
    { hourStart: 12, label: "12:00–18:00" },
    { hourStart: 18, label: "18:00–24:00" },
  ];
  const buckets: TrainingTimeOfDayBucket[] = bucketDefs.map(({ hourStart, label }) => {
    const inBucket = eligible.filter((s) => {
      const hour = new Date(s.startedAt * 1000).getUTCHours();
      return hour >= hourStart && hour < hourStart + 6;
    });
    return { hourStart, label, sessions: inBucket.length, gainPerEnergyMedian: median(inBucket.map((s) => s.gainPerEnergy!)) };
  });

  let best: TrainingTimeOfDayObservation["best"] = null;
  for (const bucket of buckets) {
    if (bucket.sessions < TRAINING_TIME_OF_DAY_POLICY.MIN_BUCKET_SESSIONS || bucket.gainPerEnergyMedian === null) continue;
    const upliftPct = ((bucket.gainPerEnergyMedian - overall) / overall) * 100;
    if (upliftPct < TRAINING_TIME_OF_DAY_POLICY.MIN_UPLIFT_PCT) continue;
    if (best === null || upliftPct > best.upliftPct) {
      best = { label: bucket.label, sessions: bucket.sessions, gainPerEnergyMedian: bucket.gainPerEnergyMedian, upliftPct };
    }
  }

  return {
    buckets,
    best,
    overallMedian: overall,
    sampleSize: eligible.length,
    note: "Observational only: this compares observed gain per energy across times of day. It does not imply the time of day caused the difference.",
  };
}

/** Full training intelligence over the trailing windows. Pure. */
export function buildTrainingIntelligence(inputs: TrainingIntelligenceInputs): TrainingIntelligence {
  const { now, sessions, energyCappedHours } = inputs;
  const currentFrom = now - 7 * DAY;
  const previousFrom = currentFrom - 7 * DAY;
  const baselineFrom = now - 30 * DAY;

  const current = periodStats(sessions, energyCappedHours, currentFrom, now, "Last 7 days");
  const previous = periodStats(sessions, energyCappedHours, previousFrom, currentFrom, "Previous 7 days");
  const baseline30d = periodStats(sessions, energyCappedHours, baselineFrom, now, "Last 30 days");

  // ---- Records (over the provided history) --------------------------------
  const byDay = new Map<number, { gainPerE: number[]; gain: number }>();
  const byWeek = new Map<number, number>();
  for (const s of sessions) {
    const day = startOfDay(s.startedAt);
    const entry = byDay.get(day) ?? { gainPerE: [], gain: 0 };
    if (ELIGIBLE(s)) entry.gainPerE.push(s.gainPerEnergy!);
    if (s.gymGain !== null && s.gymGain > 0) entry.gain += s.gymGain;
    byDay.set(day, entry);
    if (s.gymGain !== null && s.gymGain > 0) byWeek.set(startOfWeek(s.startedAt), (byWeek.get(startOfWeek(s.startedAt)) ?? 0) + s.gymGain);
  }

  let bestGainPerEnergyDay: TrainingRecord | null = null;
  let bestStatGainDay: TrainingRecord | null = null;
  for (const [day, entry] of byDay) {
    const medianGainPerE = median(entry.gainPerE);
    if (medianGainPerE !== null && entry.gainPerE.length >= 2 && (bestGainPerEnergyDay === null || medianGainPerE > bestGainPerEnergyDay.value)) {
      bestGainPerEnergyDay = { value: medianGainPerE, at: day, sampleSize: entry.gainPerE.length };
    }
    if (entry.gain > 0 && (bestStatGainDay === null || entry.gain > bestStatGainDay.value)) {
      bestStatGainDay = { value: entry.gain, at: day, sampleSize: entry.gainPerE.length };
    }
  }
  let bestWeek: TrainingRecord | null = null;
  for (const [week, gain] of byWeek) {
    if (bestWeek === null || gain > bestWeek.value) bestWeek = { value: gain, at: week, sampleSize: sessions.filter((s) => startOfWeek(s.startedAt) === week).length };
  }

  return {
    current,
    previous,
    baseline30d,
    records: { bestGainPerEnergyDay, bestStatGainDay, bestWeek },
    timeOfDay: trainingTimeOfDay(sessions, now),
    provenance: "inferred",
  };
}
