import { describe, expect, it } from "vitest";
import {
  battlestatProgression,
  buildBattlestatSeries,
  buildEnergyLedger,
  detectHappyJumps,
  detectStatMilestones,
  detectTrainingSessions,
  efficiencyBaseline,
  extractBattlestats,
  extractStatCounters,
  sessionMedians,
  type BattlestatPoint,
  type EnergyGainEvent,
  type EnergyObservation,
  type HappyJumpEvent,
} from "../src/progression.js";

const H = 3600;
const T0 = 1_700_000_000;

/* -------------------------------------------------------------------------- */
/* personalstats extraction                                                    */
/* -------------------------------------------------------------------------- */

describe("personalstats extraction (nested cat=all shape)", () => {
  const blob = {
    battle_stats: { strength: 1000, defense: 900, speed: 800, dexterity: 700, total: 3400 },
    drugs: { xanax: 10, ecstasy: 2, total: 12 },
    other: { refills: { energy: 5, nerve: 0 }, awards: 42 },
    items: { used: { candy: 100 } },
    level: 42,
  };

  it("extracts exact battlestats and counters", () => {
    const b = extractBattlestats(blob);
    expect(b).toEqual({ strength: 1000, defense: 900, speed: 800, dexterity: 700, total: 3400 });
    const c = extractStatCounters(blob);
    expect(c).toEqual({ xanax: 10, ecstasy: 2, refillsEnergy: 5, candy: 100, awards: 42, level: 42 });
  });

  it("stays null for unknown shapes — never guesses", () => {
    const b = extractBattlestats({ something: "else" });
    expect(b.strength).toBeNull();
    expect(extractStatCounters({}).xanax).toBeNull();
  });

  it("builds a series from snapshot blobs in time order", () => {
    const series = buildBattlestatSeries([
      { capturedAt: T0 + H, stats: blob },
      { capturedAt: T0, stats: blob },
    ]);
    expect(series.map((p) => p.t)).toEqual([T0, T0 + H]);
  });
});

/* -------------------------------------------------------------------------- */
/* Energy ledger (spec matrix 1-17)                                            */
/* -------------------------------------------------------------------------- */

function bars(points: Array<[number, number]>, max = 150): EnergyObservation[] {
  return points.map(([t, e]) => ({ t, energyCurrent: e, energyMaximum: max }));
}

describe("energy ledger", () => {
  it("1-3. exact snapshots: known gains and observed declines are recorded", () => {
    const gains: EnergyGainEvent[] = [{ t: T0 + 600, amount: 150, category: "refill", provenance: "exact" }];
    const ledger = buildEnergyLedger(bars([[T0, 10], [T0 + 300, 20], [T0 + 600, 100], [T0 + 900, 30]]), gains);
    expect(ledger.observedSpent).toBe(70);
    expect(ledger.knownGainsByCategory).toContainEqual({ category: "refill", amount: 80, provenance: "exact" });
    expect(ledger.absorbedOvershoot).toBe(70); // refill exceeded the observed rise
    expect(ledger.reconciliation).toEqual({ opening: 10, closing: 30, observedDelta: 20, quality: "full" });
  });

  it("5. refill attribution is exact; 4. xanax is an estimate", () => {
    const ledger = buildEnergyLedger(
      bars([[T0, 0], [T0 + 300, 150]]),
      [
        { t: T0 + 150, amount: 150, category: "refill", provenance: "exact" },
        { t: T0 + 150, amount: 150, category: "xanax", provenance: "estimated" },
      ]
    );
    // The observed rise is attributed to the EXACT source first; the
    // estimated Xanax never materialized → overshoot.
    expect(ledger.knownGainsByCategory).toContainEqual({ category: "refill", amount: 150, provenance: "exact" });
    expect(ledger.knownGainsByCategory.find((c) => c.category === "xanax")).toBeUndefined();
    expect(ledger.derivedRegen).toBe(0);
    expect(ledger.absorbedOvershoot).toBe(150);
    expect(ledger.knownGains).toBe(150);
  });

  it("9. capped regen: pinned-at-cap time is bounded, never counted as banked", () => {
    const ledger = buildEnergyLedger(bars([[T0, 150], [T0 + 3600, 150], [T0 + 5400, 140]]), []);
    expect(ledger.cappedSeconds).toBe(3600);
    expect(ledger.derivedRegen).toBe(0);
  });

  it("10-11. gains inside a decline interval net out exactly once (no double count)", () => {
    const gains: EnergyGainEvent[] = [{ t: T0 + 150, amount: 150, category: "refill", provenance: "exact" }];
    const ledger = buildEnergyLedger(bars([[T0, 100], [T0 + 300, 80]]), gains);
    // 100→80 while gaining 150: the full refill materialized and 170 was spent.
    expect(ledger.observedSpent).toBe(170);
    expect(ledger.knownGains).toBe(150);
    expect(ledger.spendIntervals[0]?.amount).toBe(170);
  });

  it("13. cap interaction overshoot is surfaced, never silently dropped", () => {
    // Refill at cap: +150 known but observed rise 0.
    const ledger = buildEnergyLedger(bars([[T0, 150], [T0 + 300, 150]]), [
      { t: T0 + 150, amount: 150, category: "xanax", provenance: "estimated" },
    ]);
    expect(ledger.absorbedOvershoot).toBe(150);
    expect(ledger.knownGains).toBe(0);
  });

  it("14. missing anchors: a single observation cannot reconcile", () => {
    const ledger = buildEnergyLedger(bars([[T0, 50]]), []);
    expect(ledger.reconciliation.quality).toBe("unavailable");
    expect(ledger.reconciliation.observedDelta).toBeNull();
  });

  it("16→17. empty bar history stays unavailable; flat bars are a real zero", () => {
    expect(buildEnergyLedger([], []).reconciliation.quality).toBe("unavailable");
    const flat = buildEnergyLedger(bars([[T0, 100], [T0 + 600, 100], [T0 + 1200, 100]]), []);
    expect(flat.observedSpent).toBe(0);
    expect(flat.spendIntervals).toHaveLength(0);
  });

  it("derived regen rate comes from clean intervals (12 energy / 30 min = 24/h)", () => {
    const ledger = buildEnergyLedger(bars([[T0, 50], [T0 + 1800, 62], [T0 + 3600, 74]]), []);
    expect(ledger.regenPerHour).toBeCloseTo(24, 5);
  });
});

/* -------------------------------------------------------------------------- */
/* Training sessions (spec matrix 28-38)                                       */
/* -------------------------------------------------------------------------- */

function statPoint(t: number, values: [number, number, number, number]): BattlestatPoint {
  return { t, strength: values[0], defense: values[1], speed: values[2], dexterity: values[3], total: values[0] + values[1] + values[2] + values[3] };
}

function run(observations: EnergyObservation[], gains: EnergyGainEvent[] = [], competing = []) {
  const ledger = buildEnergyLedger(observations, gains, competing);
  return { ledger, sessions: detectTrainingSessions(ledger, statSeries) };
}
const statSeries = [
  statPoint(T0 - H, [1000, 1000, 1000, 1000]),
  statPoint(T0 + H, [2000, 1050, 1030, 1010]),
  statPoint(T0 + 2 * H, [2000, 1050, 1030, 1010]),
];

describe("training session detection", () => {
  it("28. isolated training burst: energy decline + stat gain → likely, with gain/E", () => {
    const { sessions } = run(bars([[T0, 150], [T0 + 300, 120], [T0 + 600, 90], [T0 + 900, 60], [T0 + 1200, 30]]));
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.energySpent).toBe(120);
    expect(s.inference).toBe("likely");
    expect(s.totalGain).toBe(1090);
    expect(s.primaryStat).toBe("strength");
    expect(s.gainPerEnergy).toBeCloseTo(1090 / 120, 5);
  });

  it("29. a drop during an attack window is NEVER training (competing evidence)", () => {
    const { sessions } = run(
      bars([[T0, 150], [T0 + 300, 90], [T0 + 600, 30]]),
      [],
      [{ from: T0, to: T0 + 600, kind: "attack" }]
    );
    expect(sessions).toHaveLength(0);
  });

  it("30+8. energy-only declines stay 'possible' and out of training attribution", () => {
    const flatStats = [statPoint(T0 - H, [1000, 1000, 1000, 1000]), statPoint(T0 + H, [1000, 1000, 1000, 1000]), statPoint(T0 + 2 * H, [1000, 1000, 1000, 1000])];
    const ledger = buildEnergyLedger(bars([[T0, 150], [T0 + 300, 100], [T0 + 600, 50]]), []);
    const sessions = detectTrainingSessions(ledger, flatStats);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.inference).toBe("possible");
    expect(sessions[0]!.totalGain).toBe(0);
    // The observed spend remains unattributed in the ledger.
    expect(ledger.observedSpent).toBe(100);
  });

  it("34-35. merge and split thresholds: adjacent declines are one burst", () => {
    const { sessions } = run(bars([
      [T0, 150], [T0 + 300, 120], [T0 + 600, 90],
      [T0 + 900, 60], [T0 + 1200, 30], // contiguous — same burst
    ]));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.energySpent).toBe(120);
  });

  it("36. gain per energy only when the denominator is meaningful", () => {
    // Tiny 25-energy burst → below SESSION_MIN_ENERGY_FOR_GAIN_PER_E.
    const { sessions } = run(bars([[T0, 30], [T0 + 300, 5]]));
    expect(sessions[0]!.energySpent).toBe(25);
    expect(sessions[0]!.gainPerEnergy).toBeNull();
  });

  it("37-38. deterministic ordering, no duplicate sessions across reruns", () => {
    const observations = bars([[T0, 150], [T0 + 300, 120], [T0 + 600, 90], [T0 + 900, 60]]);
    const a = run(observations).sessions;
    const b = run(observations).sessions;
    expect(a).toEqual(b);
    expect(a.map((s) => s.startedAt)).toEqual([...a.map((s) => s.startedAt)].sort((x, y) => x - y));
  });
});

/* -------------------------------------------------------------------------- */
/* Happy jumps (spec matrix 39-50)                                             */
/* -------------------------------------------------------------------------- */

describe("happy jump inference", () => {
  const jumpBars = bars([
    [T0, 150], [T0 + 300, 120], [T0 + 600, 90], [T0 + 900, 60], [T0 + 1200, 30],
  ]);
  const { sessions } = { sessions: detectTrainingSessions(buildEnergyLedger(jumpBars, [], []), statSeries) };
  const xanaxPair: HappyJumpEvent[] = [
    { t: T0 - 2 * H, kind: "xanax" },
    { t: T0 - H, kind: "xanax" },
  ];
  const medians = { energy: 50, gain: 500 };

  it("39. strong evidence → likely, with full evidence list", () => {
    const jumps = detectHappyJumps(
      sessions,
      [...xanaxPair, { t: T0 - 600, kind: "ecstasy" }, { t: T0 + 450, kind: "refill" }],
      jumpBars.map((b) => ({ ...b, happyCurrent: 4800, happyMaximum: 5000 })),
      { medianSessionEnergy: medians.energy, medianSessionGain: medians.gain }
    );
    expect(jumps).toHaveLength(1);
    const j = jumps[0]!;
    expect(j.confidence).toBe("likely");
    expect(j.signals).toEqual(expect.arrayContaining(["xanax_cluster", "ecstasy", "refill", "peak_happy"]));
    expect(j.evidence.length).toBeGreaterThanOrEqual(4);
    expect(j.xanaxCount).toBe(2);
    expect(j.peakHappyObserved).toBe(4800);
  });

  it("40-42. single signals never imply a jump", () => {
    // Xanax pair alone (no other evidence).
    const onlyXanax = detectHappyJumps(sessions, xanaxPair, bars(jumpBars.map((b) => [b.t, b.energyCurrent] as [number, number])), {
      medianSessionEnergy: null,
      medianSessionGain: null,
    });
    expect(onlyXanax).toHaveLength(0);
    // Ecstasy alone.
    const onlyEcstasy = detectHappyJumps(sessions, [{ t: T0 - 600, kind: "ecstasy" }], bars(jumpBars.map((b) => [b.t, b.energyCurrent] as [number, number])), {
      medianSessionEnergy: null,
      medianSessionGain: null,
    });
    expect(onlyEcstasy).toHaveLength(0);
  });

  it("43. normal training without preparation is never labeled a jump", () => {
    const jumps = detectHappyJumps(sessions, [], [], { medianSessionEnergy: 50, medianSessionGain: 500 });
    expect(jumps).toHaveLength(0);
  });

  it("44. incomplete evidence grades 'possible', never confirmed", () => {
    const jumps = detectHappyJumps(
      sessions,
      [...xanaxPair, { t: T0 - 600, kind: "ecstasy" }],
      bars(jumpBars.map((b) => [b.t, b.energyCurrent] as [number, number])),
      { medianSessionEnergy: 50, medianSessionGain: 500 }
    );
    expect(jumps).toHaveLength(1);
    expect(jumps[0]!.confidence).toBe("possible");
    expect(jumps[0]!.peakHappyObserved).toBeNull();
    expect(jumps[0]!.missing.some((m) => m.includes("happy observation"))).toBe(true);
  });

  it("49-50. evidence is explicit and inference is stable across reruns", () => {
    const events: HappyJumpEvent[] = [...xanaxPair, { t: T0 - 600, kind: "ecstasy" }];
    const obs = jumpBars.map((b) => ({ ...b, happyCurrent: 4800, happyMaximum: 5000 }));
    const a = detectHappyJumps(sessions, events, obs, { medianSessionEnergy: 50, medianSessionGain: 500 });
    const b = detectHappyJumps(sessions, events, obs, { medianSessionEnergy: 50, medianSessionGain: 500 });
    expect(a).toEqual(b);
    expect(a[0]!.missing.some((m) => m.includes("estimate"))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Battlestat progression (spec matrix 18-27)                                  */
/* -------------------------------------------------------------------------- */

describe("battlestat progression", () => {
  const series = [
    statPoint(T0, [1_000_000, 900_000, 950_000, 850_000]),
    statPoint(T0 + 86_400, [1_100_000, 910_000, 960_000, 860_000]),
    statPoint(T0 + 2 * 86_400, [1_300_000, 920_000, 970_000, 870_000]),
    statPoint(T0 + 10 * 86_400, [1_400_000, 930_000, 980_000, 880_000]),
  ];

  it("18-21. deltas, totals, individual and multi-stat growth over observation windows", () => {
    const prog = battlestatProgression(series, T0 + 86_400, T0 + 2 * 86_400);
    expect(prog.openingTotal).toBe(1_100_000 + 910_000 + 960_000 + 860_000);
    expect(prog.closingTotal).toBe(1_300_000 + 920_000 + 970_000 + 870_000);
    expect(prog.perStat.find((s) => s.key === "strength")?.delta).toBe(200_000);
    expect(prog.perStat.find((s) => s.key === "defense")?.delta).toBe(10_000);
  });

  it("22-23. missing intermediate snapshots and long gaps: anchors are the closest observations at/before", () => {
    const prog = battlestatProgression(series, T0 + 3 * 86_400, T0 + 11 * 86_400);
    // No observation inside (3d..10d) — the bracket is the 2d → 10d pair.
    expect(prog.openingTotal).toBe(1_300_000 + 920_000 + 970_000 + 870_000);
    expect(prog.closingTotal).toBe(1_400_000 + 930_000 + 980_000 + 880_000);
  });

  it("24. ranges before the first observation stay null; the first real point anchors from itself", () => {
    // Range entirely before data: no anchors — null, never a zero bracket.
    const beforeAny = battlestatProgression(series, T0 - 5 * 86_400, T0 - 86_400);
    expect(beforeAny.openingTotal).toBeNull();
    expect(beforeAny.closingTotal).toBeNull();
    expect(beforeAny.deltaTotal).toBeNull();
    // Baseline = the closest observation at/before the range start.
    const prog = battlestatProgression(series, T0, T0 + 86_400);
    expect(prog.openingTotal).toBe(1_000_000 + 900_000 + 950_000 + 850_000);
  });

  it("25. series carries exact observation timestamps only", () => {
    const prog = battlestatProgression(series, T0, T0 + 10 * 86_400);
    expect(prog.series.map((p) => p.t)).toEqual(series.map((p) => p.t));
  });

  it("26. milestones report the crossing WINDOW between observations", () => {
    const milestones = detectStatMilestones(series, [1_250_000]);
    expect(milestones).toHaveLength(1);
    const m = milestones[0]!;
    expect(m.kind).toBe("strength");
    expect(m.label).toBe("Strength");
    expect(m.threshold).toBe(1_250_000);
    expect(m.crossedBetween).toEqual([T0 + 86_400, T0 + 2 * 86_400]);
  });

  it("27. changePct null when the baseline is zero — never a fabricated percentage", () => {
    const zeroed = [statPoint(T0, [0, 0, 0, 0]), statPoint(T0 + H, [10, 0, 0, 0])];
    const prog = battlestatProgression(zeroed, T0, T0 + H);
    expect(prog.changePct).toBeNull();
  });

  it("personal baselines: efficiency ratio vs earlier sessions", () => {
    const mk = (gainPerEnergy: number | null) => ({
      startedAt: T0, endedAt: T0 + 600, energySpent: 100, energyKnown: true,
      gains: null, totalGain: null, gainPerEnergy, primaryStat: null, inference: "likely" as const, evidence: [], bracketShared: false,
    });
    const baseline = efficiencyBaseline([mk(100), mk(120), mk(140)], mk(126));
    expect(baseline.medianGainPerEnergy).toBe(120);
    expect(baseline.ratio).toBeCloseTo(1.05, 5);
  });

  it("session medians feed jump scoring", () => {
    const mk = (energy: number | null, totalGain: number | null) => ({
      startedAt: T0, endedAt: T0 + 600, energySpent: energy, energyKnown: energy !== null,
      gains: null, totalGain, gainPerEnergy: null, primaryStat: null, inference: "likely" as const, evidence: [], bracketShared: false,
    });
    const medians = sessionMedians([mk(100, 50_000), mk(120, 60_000), mk(80, null)]);
    expect(medians.energy).toBe(100);
    expect(medians.gain).toBe(55_000); // median of even set = midpoint
  });
});
