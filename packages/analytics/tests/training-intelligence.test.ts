import { describe, expect, it } from "vitest";
import { buildTrainingIntelligence, trainingTimeOfDay, TRAINING_TIME_OF_DAY_POLICY, type TrainingIntelligenceInputs } from "../src/training-intelligence.js";
import type { TrainingSession } from "../src/progression.js";

const DAY = 86_400;
const NOW = 1_750_000_000;

function session(startedAt: number, gainPerEnergy: number | null, gymGain: number | null, opts: Partial<TrainingSession> = {}): TrainingSession {
  return {
    startedAt,
    endedAt: startedAt + 600,
    energySpent: 150,
    energyKnown: true,
    gains: null,
    gymGain,
    totalGain: gymGain,
    nonGymJobGain: 0,
    friendTrains: 0,
    gainPerEnergy,
    primaryStat: "strength",
    inference: "likely",
    evidence: [],
    bracketShared: false,
    ...opts,
  };
}

const emptyInputs = (): TrainingIntelligenceInputs => ({ now: NOW, sessions: [], energyCappedHours: [] });

describe("buildTrainingIntelligence", () => {
  it("returns zeroed periods on empty input without inventing numbers", () => {
    const result = buildTrainingIntelligence(emptyInputs());
    expect(result.current.sessions).toBe(0);
    expect(result.current.energyTrained).toBeNull();
    expect(result.current.gainPerEnergyMedian).toBeNull();
    expect(result.records.bestWeek).toBeNull();
    expect(result.timeOfDay).toBeNull();
    expect(result.provenance).toBe("inferred");
  });

  it("aggregates the three periods and honors window boundaries", () => {
    const sessions = [
      // current 7d: two sessions
      session(NOW - 1 * DAY, 12, 1800),
      session(NOW - 3 * DAY, 10, 1500),
      // previous 7d (8-14d ago): one session
      session(NOW - 10 * DAY, 8, 1200),
      // baseline only (20-29d ago): two sessions
      session(NOW - 20 * DAY, 9, 1350),
      session(NOW - 29 * DAY, 11, 1650),
    ];
    const result = buildTrainingIntelligence({ now: NOW, sessions, energyCappedHours: [] });
    expect(result.current.sessions).toBe(2);
    expect(result.current.energyTrained).toBe(300);
    expect(result.current.statGain).toBe(3300);
    expect(result.current.gainPerEnergyMedian).toBeCloseTo(11, 5);
    expect(result.previous.sessions).toBe(1);
    expect(result.baseline30d.sessions).toBe(5);
  });

  it("excludes bracket-shared sessions from gain-per-energy medians", () => {
    const sessions = [
      session(NOW - 1 * DAY, 50, 5000, { bracketShared: true }),
      session(NOW - 2 * DAY, 10, 1500),
      session(NOW - 3 * DAY, 12, 1800),
    ];
    const result = buildTrainingIntelligence({ now: NOW, sessions, energyCappedHours: [] });
    expect(result.current.gainPerEnergyMedian).toBeCloseTo(11, 5); // 50 ignored
    expect(result.current.statGain).toBe(8300); // gains still count
  });

  it("sums capped hours per period from the daily array", () => {
    const energyCappedHours = [
      { t: NOW - 1 * DAY, hours: 3 },
      { t: NOW - 2 * DAY, hours: 2.5 },
      { t: NOW - 10 * DAY, hours: 9 }, // falls in the PREVIOUS 7d window (7–14d ago)
    ];
    const result = buildTrainingIntelligence({ now: NOW, sessions: [], energyCappedHours });
    expect(result.current.cappedHours).toBeCloseTo(5.5, 5);
    expect(result.previous.cappedHours).toBe(9);
    expect(result.baseline30d.cappedHours).toBeCloseTo(14.5, 5);
  });

  it("computes personal records across days and weeks", () => {
    // Synthetic weeks anchored at real UTC week starts, so gains per week are
    // deterministic regardless of where NOW falls inside its week.
    const weekStart = (ts: number): number => {
      const d = new Date(ts * 1000);
      const day = (d.getUTCDay() + 6) % 7;
      return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000) - day * DAY;
    };
    const w1 = weekStart(NOW) - 21 * DAY;
    const w2 = weekStart(NOW) - 14 * DAY;
    const w3 = weekStart(NOW) - 7 * DAY;
    const w4 = weekStart(NOW);
    const sessions = [
      // week 1: two sessions, one day → best gpE day 9 (2 samples)
      session(w1 + 3 * DAY, 9, 1000),
      session(w1 + 3 * DAY + 3600, 9, 1000),
      // week 2: one day, two sessions
      session(w2 + 2 * DAY, 10, 2000),
      session(w2 + 2 * DAY + 3600, 10, 2000),
      // week 3: day A = best day (5000, gpE 20 ×2), day B 2000 → week total 7000
      session(w3 + 1 * DAY, 20, 5000),
      session(w3 + 1 * DAY + 3600, 20, 0), // eligible for gpE median, adds no gain
      session(w3 + 3 * DAY, 10, 2000),
      // week 4 (live): 6000 across two days
      session(w4 + DAY, 12, 3000),
      session(w4 + 2 * DAY, 12, 3000),
    ];
    const result = buildTrainingIntelligence({ now: NOW, sessions, energyCappedHours: [] });
    expect(result.records.bestStatGainDay?.value).toBe(5000);
    expect(result.records.bestGainPerEnergyDay?.value).toBe(20);
    expect(result.records.bestWeek?.value).toBe(7000);
    expect(result.records.bestWeek?.at).toBe(w3);
  });
});

describe("trainingTimeOfDay", () => {
  it("returns null under the minimum total sample", () => {
    const sessions = Array.from({ length: 10 }, (_, i) => session(NOW - i * DAY, 10, 1500));
    expect(trainingTimeOfDay(sessions, NOW)).toBeNull();
  });

  it("names the strongest bucket only above uplift and sample gates", () => {
    // 24 morning sessions at gain/E 12, 24 evening sessions at 10 — morning
    // uplift = 20% ≥ gate; overall median ≈ 11ish (mixed).
    const sessions: TrainingSession[] = [];
    for (let i = 0; i < 24; i++) sessions.push(session(NOW - (1 + i) * 3600 * 2, 12, 1800)); // alternating hours spread
    // Force exact hour buckets: first 24 at 07:00 UTC, next 24 at 20:00 UTC.
    sessions.length = 0;
    for (let i = 0; i < 24; i++) {
      const dayTs = NOW - i * DAY;
      const morning = Math.floor(dayTs / DAY) * DAY + 7 * 3600;
      const evening = Math.floor(dayTs / DAY) * DAY + 20 * 3600;
      sessions.push(session(morning, 12, 1800));
      sessions.push(session(evening, 10, 1500));
    }
    const obs = trainingTimeOfDay(sessions, NOW);
    expect(obs).not.toBeNull();
    expect(obs!.buckets).toHaveLength(4);
    expect(obs!.best?.label).toBe("06:00–12:00");
    expect(obs!.best!.upliftPct).toBeGreaterThan(TRAINING_TIME_OF_DAY_POLICY.MIN_UPLIFT_PCT);
    expect(obs!.note).toContain("Observational only");
    expect(obs!.note).toContain("does not imply");
  });

  it("stays silent when no bucket clears the uplift gate", () => {
    const sessions: TrainingSession[] = [];
    for (let i = 0; i < 30; i++) {
      const dayTs = NOW - i * DAY;
      const base = Math.floor(dayTs / DAY) * DAY;
      sessions.push(session(base + 7 * 3600, 10, 1500));
      sessions.push(session(base + 20 * 3600, 10, 1500));
    }
    const obs = trainingTimeOfDay(sessions, NOW);
    expect(obs).not.toBeNull();
    expect(obs!.best).toBeNull();
  });

  it("requires a bucket to clear the min bucket sample", () => {
    // 30 sessions in the morning bucket, only 3 in the evening (high).
    const sessions: TrainingSession[] = [];
    for (let i = 0; i < 30; i++) {
      const dayTs = NOW - i * DAY;
      const base = Math.floor(dayTs / DAY) * DAY;
      sessions.push(session(base + 7 * 3600, 10, 1500));
      if (i < 3) sessions.push(session(base + 20 * 3600, 30, 4500));
    }
    const obs = trainingTimeOfDay(sessions, NOW);
    expect(obs).not.toBeNull();
    expect(obs!.best).toBeNull(); // evening bucket under MIN_BUCKET_SESSIONS
  });
});
