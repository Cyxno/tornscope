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
    jobs: { stats: { total: 500, manual: 200, endurance: 100, intelligence: 200 }, trains_received: 3 },
    level: 42,
  };

  it("extracts exact battlestats and counters", () => {
    const b = extractBattlestats(blob);
    expect(b).toEqual({ strength: 1000, defense: 900, speed: 800, dexterity: 700, total: 3400 });
    const c = extractStatCounters(blob);
    expect(c).toEqual({
      xanax: 10,
      ecstasy: 2,
      refillsEnergy: 5,
      candy: 100,
      awards: 42,
      level: 42,
      jobStats: 500,
      trainsReceived: 3,
    });
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
    expect(ledger.inferredSpent).toBe(70);
    expect(ledger.knownGainsByCategory).toContainEqual({ category: "refill", amount: 150, provenance: "exact" });
    expect(ledger.unresolvedGains).toBe(70); // refill exceeded the observed rise
    expect(ledger.reconciliation).toEqual({ opening: 10, closing: 30, observedDelta: 20, quality: "full" });
  });

  it("5. delivered gains credit in full; the unobservable remainder is unresolved", () => {
    const ledger = buildEnergyLedger(
      bars([[T0, 0], [T0 + 300, 150]]),
      [
        { t: T0 + 150, amount: 150, category: "refill", provenance: "exact" },
        { t: T0 + 150, amount: 150, category: "xanax", provenance: "estimated" },
      ]
    );
    // Both gains are DELIVERED (the bar can hold up to 1,000) and count in
    // full; the 150 the bar never showed is unresolved between snapshots.
    expect(ledger.knownGainsByCategory).toContainEqual({ category: "refill", amount: 150, provenance: "exact" });
    expect(ledger.knownGainsByCategory).toContainEqual({ category: "xanax", amount: 150, provenance: "estimated" });
    expect(ledger.derivedRegen).toBe(0);
    expect(ledger.unresolvedGains).toBe(150);
    expect(ledger.knownGains).toBe(300);
  });

  it("9. capped regen: pinned-at-cap time is bounded, never counted as banked", () => {
    const ledger = buildEnergyLedger(bars([[T0, 150], [T0 + 3600, 150], [T0 + 5400, 140]]), []);
    expect(ledger.cappedSeconds).toBe(3600);
    expect(ledger.derivedRegen).toBe(0);
  });

  it("10-11. gains inside a decline interval credit in full (over-max delivery)", () => {
    // Real-user shape: Xanax lands near cap (105/150 → train to 5). The
    // delivery is NOT clamped at the natural maximum (bar can hold 1,000):
    // the 250 was delivered and consumed between the snapshots, so spend =
    // 250 + 100 = 350. Unobserved delivery is never "lost".
    const nearCap = buildEnergyLedger(bars([[T0, 105], [T0 + 300, 5]]), [
      { t: T0 + 150, amount: 150, category: "xanax", provenance: "estimated" },
    ]);
    expect(nearCap.inferredSpent).toBe(250);
    expect(nearCap.knownGains).toBe(150);
    expect(nearCap.unresolvedGains).toBe(0);
    expect(nearCap.spendIntervals[0]?.amount).toBe(250);
    expect(nearCap.spendIntervals[0]?.estimatedGainsIncluded).toBe(150);

    // Declines WITHOUT gains keep their plain observed drop (regen during a
    // decline is not separable — the ledger stays a bounded inference).
    const plain = buildEnergyLedger(bars([[T0, 100], [T0 + 300, 80]]), []);
    expect(plain.inferredSpent).toBe(20);
    expect(plain.unresolvedGains).toBe(0);
  });

  it("13. gains while pinned stay delivered and unresolved — never lost", () => {
    // Xanax while pinned at cap: +150 delivered but not visible between the
    // snapshots — unresolved, never silently dropped, never claimed lost.
    const ledger = buildEnergyLedger(bars([[T0, 150], [T0 + 300, 150]]), [
      { t: T0 + 150, amount: 150, category: "xanax", provenance: "estimated" },
    ]);
    expect(ledger.unresolvedGains).toBe(150);
    expect(ledger.knownGains).toBe(150);
  });

  it("14. missing anchors: a single observation cannot reconcile", () => {
    const ledger = buildEnergyLedger(bars([[T0, 50]]), []);
    expect(ledger.reconciliation.quality).toBe("unavailable");
    expect(ledger.reconciliation.observedDelta).toBeNull();
  });

  it("14b. truncated fetch: a capped row cap degrades reconciliation to partial", () => {
    const points = bars([[T0, 10], [T0 + 300, 30]]);
    expect(buildEnergyLedger(points, []).reconciliation.quality).toBe("full");
    // Same observations, but the fetch dropped history before the range
    // start — the opening is not the true opening, so full is a false claim.
    expect(buildEnergyLedger(points, [], [], { truncated: true }).reconciliation.quality).toBe("partial");
    // Truncation never upgrades an unavailable reconciliation.
    expect(buildEnergyLedger(bars([[T0, 50]]), [], [], { truncated: true }).reconciliation.quality).toBe("unavailable");
  });

  it("16→17. empty bar history stays unavailable; flat bars are a real zero", () => {
    expect(buildEnergyLedger([], []).reconciliation.quality).toBe("unavailable");
    const flat = buildEnergyLedger(bars([[T0, 100], [T0 + 600, 100], [T0 + 1200, 100]]), []);
    expect(flat.inferredSpent).toBe(0);
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
    // The inferred spend remains unattributed in the ledger.
    expect(ledger.inferredSpent).toBe(100);
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

/* -------------------------------------------------------------------------- */
/* Session grouping (Phase 12 A-E): human sessions, not raw intervals          */
/* -------------------------------------------------------------------------- */

describe("session grouping determinism", () => {
  it("A. three adjacent training intervals with regen pauses between stay ONE session", () => {
    // Real shape: a player trains, pauses a few minutes (bar rises a little),
    // trains again. Rises are not spend intervals; the gaps between spend
    // intervals are under SESSION_MERGE_GAP_SECONDS, so the burst merges.
    const { sessions } = run(bars([
      [T0, 150], [T0 + 300, 120], // spend 30
      [T0 + 600, 125], // small regen blip (rise)
      [T0 + 900, 95], // spend 30
      [T0 + 1200, 100], // blip
      [T0 + 1500, 70], // spend 30
    ]));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.energySpent).toBe(90); // 30 + 30 + 30
  });

  it("B. two training bursts separated by a large gap are TWO sessions", () => {
    const { sessions } = run(bars([
      [T0, 150], [T0 + 300, 100], // burst 1
      [T0 + 600, 105], [T0 + 1200, 110], [T0 + 1800, 115], [T0 + 2400, 120], // long regen (>15 min gap)
      [T0 + 2700, 70], [T0 + 3000, 20], // burst 2
    ]));
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.energySpent).toBe(50);
    expect(sessions[1]!.energySpent).toBe(100);
  });

  it("C. a Xanax between training intervals does NOT automatically split the session", () => {
    // Player trains, takes a Xanax (the +150 estimate is a known gain; the
    // bar ticks up), trains again within the merge gap: one human session,
    // not two. The Xanax is delivered in full; the share the bar never
    // showed between these snapshots stays unresolved — never lost.
    const { ledger, sessions } = run(
      bars([
        [T0, 100], [T0 + 300, 60], // spend 40
        [T0 + 600, 90], // Xanax inside this rise: delivered 150, +30 net
        [T0 + 900, 40], // spend 50
      ]),
      [{ t: T0 + 450, amount: 150, category: "xanax", provenance: "estimated" }]
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.energySpent).toBe(90); // 40 + 50 — gains never padded it
    expect(ledger.unresolvedGains).toBe(120);
  });

  it("D. natural regen between snapshots never creates a phantom session", () => {
    const { sessions, ledger } = run(bars([
      [T0, 50], [T0 + 600, 55], [T0 + 1200, 60], [T0 + 1800, 65], // clean rises
      [T0 + 2400, 70], [T0 + 3000, 75],
    ]));
    expect(sessions).toHaveLength(0);
    expect(ledger.inferredSpent).toBe(0);
    expect(ledger.derivedRegen).toBe(25);
  });

  it("E. a stat-snapshot update without energy evidence creates no fake session", () => {
    const stats = [
      statPoint(T0 - H, [1000, 1000, 1000, 1000]),
      statPoint(T0 + H, [2000, 1050, 1030, 1010]), // stat grew (e.g. job/company gain)
      statPoint(T0 + 2 * H, [2000, 1050, 1030, 1010]),
    ];
    const flatBars = bars([[T0, 100], [T0 + 300, 100], [T0 + 600, 100], [T0 + 900, 100]]);
    const ledger = buildEnergyLedger(flatBars, []);
    const sessions = detectTrainingSessions(ledger, stats);
    expect(sessions).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Gym vs non-gym attribution (Phase 42-43) + ledger identity (Phase 38)       */
/* -------------------------------------------------------------------------- */

describe("gym vs non-gym stat attribution", () => {
  // Cumulative counters ride on the hourly snapshots. The second snapshot is
  // placed exactly at the burst end (T0 + 600) — the counter at/before the
  // bracket end then carries the gain, mirroring real hourly cadence.
  const counters = (job0: number, job1: number, trains1 = 0) => [
    { t: T0 - H, xanax: null, ecstasy: null, refillsEnergy: null, candy: null, awards: null, level: null, jobStats: job0, trainsReceived: 0 },
    { t: T0 + 600, xanax: null, ecstasy: null, refillsEnergy: null, candy: null, awards: null, level: null, jobStats: job1, trainsReceived: trains1 },
  ];

  it("42. a job/company-only Defense gain is NOT gym gain (Mining Corp / Rock Salt case)", () => {
    // Bar evidence of a burst, but the bracket's only stat growth is the
    // exact job counter (+150) — the job points ARE the observed stat delta.
    const stats = [
      statPoint(T0 - H, [1000, 1000, 1000, 1000]),
      statPoint(T0 + H, [1000, 1150, 1000, 1000]), // defense +150 == job delta
    ];
    const ledger = buildEnergyLedger(bars([[T0, 150], [T0 + 300, 100], [T0 + 600, 50]]), []);
    const sessions = detectTrainingSessions(ledger, stats, counters(500, 650));
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.totalGain).toBe(150);
    expect(s.nonGymJobGain).toBe(150);
    expect(s.gymGain).toBe(0);
    expect(s.inference).toBe("possible"); // no gym-attributable gain to confirm
    expect(s.gainPerEnergy).toBeNull();
  });

  it("43. mixed gain: gym strength + job defense — gain/E divides ONLY the gym share", () => {
    const stats = [
      statPoint(T0 - H, [1000, 1000, 1000, 1000]),
      statPoint(T0 + H, [2000, 1150, 1000, 1000]), // strength +1000 (gym), defense +150 (job)
    ];
    const ledger = buildEnergyLedger(bars([[T0, 150], [T0 + 300, 100], [T0 + 600, 50]]), []);
    const sessions = detectTrainingSessions(ledger, stats, counters(500, 650));
    const s = sessions[0]!;
    expect(s.totalGain).toBe(1150);
    expect(s.nonGymJobGain).toBe(150);
    expect(s.gymGain).toBe(1000);
    expect(s.gainPerEnergy).toBeCloseTo(1000 / 100, 5);
    expect(s.primaryStat).toBe("strength");
  });

  it("friend trains in the bracket keep gym attribution provisional and block gain/E", () => {
    const stats = [
      statPoint(T0 - H, [1000, 1000, 1000, 1000]),
      statPoint(T0 + H, [2000, 1000, 1000, 1000]),
    ];
    const ledger = buildEnergyLedger(bars([[T0, 150], [T0 + 300, 100], [T0 + 600, 50]]), []);
    const sessions = detectTrainingSessions(ledger, stats, counters(500, 500, 3));
    const s = sessions[0]!;
    expect(s.friendTrains).toBe(3);
    expect(s.gainPerEnergy).toBeNull();
    expect(s.evidence.some((e) => e.includes("train"))).toBe(true);
  });
});

describe("ledger reconciliation identity (Phase 38)", () => {
  it("opening + knownGains + derivedRegen − inferredSpent − unresolvedGains === closing, exactly", () => {
    // Timeline: clean rises → pinned at cap → Xanax while pinned (delivered,
    // unobservable placement) → small decline → real training decline.
    const observations = bars([
      [T0, 100],
      [T0 + 600, 130], // rise +30 (clean regen)
      [T0 + 1200, 150], // rise +20 (clean regen)
      [T0 + 1800, 150], // pinned at cap
      [T0 + 2400, 140], // decline −10 — the Xanax (T0+2100) lands inside it
      [T0 + 3000, 60], // plain decline −80 (training)
    ]);
    const gains: EnergyGainEvent[] = [{ t: T0 + 2100, amount: 150, category: "xanax", provenance: "estimated" }];
    const ledger = buildEnergyLedger(observations, gains);
    // No hidden balancing term: delivered gains + derived regen − inferred
    // spend − unresolved must equal the observed delta exactly.
    expect(ledger.reconciliation.opening).toBe(100);
    expect(ledger.reconciliation.closing).toBe(60);
    expect(ledger.knownGains).toBe(150); // delivered inside the decline
    expect(ledger.derivedRegen).toBe(50);
    expect(ledger.inferredSpent).toBe(240); // (150 + 10) with the Xanax + plain 80
    expect(ledger.unresolvedGains).toBe(0);
    const identity =
      (ledger.reconciliation.opening ?? 0) + ledger.knownGains + ledger.derivedRegen - ledger.inferredSpent - ledger.unresolvedGains;
    expect(identity).toBe(ledger.reconciliation.closing);
  });

  it("the identity also holds when a Xanax lands inside a decline at cap", () => {
    // Xanax lands at the natural cap and is consumed between the snapshots
    // (the bar can hold up to 1,000 — nothing is clamped away): the
    // delivery joins the decline's inferred spend in full.
    const observations = bars([
      [T0, 120],
      [T0 + 600, 150], // rise to cap +30 (clean regen)
      [T0 + 1200, 140], // Xanax inside: spend = 150 + observed drop 10
      [T0 + 1800, 60], // plain decline 80
    ]);
    const gains: EnergyGainEvent[] = [{ t: T0 + 900, amount: 150, category: "xanax", provenance: "estimated" }];
    const ledger = buildEnergyLedger(observations, gains);
    expect(ledger.knownGains).toBe(150);
    expect(ledger.derivedRegen).toBe(30);
    expect(ledger.inferredSpent).toBe(240);
    expect(ledger.unresolvedGains).toBe(0);
    const identity =
      (ledger.reconciliation.opening ?? 0) + ledger.knownGains + ledger.derivedRegen - ledger.inferredSpent - ledger.unresolvedGains;
    expect(identity).toBe(ledger.reconciliation.closing);
  });
});

/* -------------------------------------------------------------------------- */
/* Battlestat baseline rules (Phase 22/24/25/44): range history semantics      */
/* -------------------------------------------------------------------------- */

describe("battlestat baseline rules", () => {
  const D = 86_400;
  // Tracking began 7 days ago; observations at -7d, -3d and now-ish.
  const series = [
    statPoint(T0 - 7 * D, [10_000, 10_000, 10_000, 10_000]),
    statPoint(T0 - 3 * D, [11_000, 10_100, 10_050, 10_020]),
    statPoint(T0, [12_000, 10_200, 10_100, 10_040]),
  ];

  it("44A. exact baseline exists at range start → at_range_start, full-range delta", () => {
    // Range starts 2d ago: the closest snapshot at/before is -3d (total
    // 41,170); closing is now (42,340) → 1,170 over the actual 3-day span.
    const p = battlestatProgression(series, T0 - 2 * D, T0);
    expect(p.baselineKind).toBe("at_range_start");
    expect(p.deltaTotal).toBe(1_170);
    expect(p.spanDays).toBeCloseTo(3, 5);
    expect(p.gainPerDay).toBeCloseTo(390, 5);
  });

  it("44B. tracking began inside the range → tracked_since, never a fabricated full-range figure", () => {
    const p = battlestatProgression(series, T0 - 30 * D, T0);
    expect(p.baselineKind).toBe("tracked_since");
    // Earliest in-range anchor (-7d, total 40,000) → closing (42,340) over
    // the ACTUAL 7-day span — labeled "since tracking began", gainPerDay
    // divides by the real span.
    expect(p.deltaTotal).toBe(2_340);
    expect(p.spanDays).toBeCloseTo(7, 5);
    expect(p.gainPerDay).toBeCloseTo(2_340 / 7, 5);
  });

  it("44C. less than a day of span → gainPerDay stays null (no fabricated rate)", () => {
    const p = battlestatProgression(series, T0 - 7 * D, T0 - 7 * D + 3600);
    expect(p.deltaTotal).toBe(0);
    expect(p.spanDays).toBe(0);
    expect(p.gainPerDay).toBeNull();
  });

  it("44D. snapshot just before the range start anchors it (boundary-safe baseline)", () => {
    // Range starts 1h after the -7d snapshot: that snapshot is still the
    // baseline — a snapshot AFTER the start must never be the baseline.
    const p = battlestatProgression(series, T0 - 7 * D + 3600, T0);
    expect(p.baselineKind).toBe("at_range_start");
    expect(p.openingTotal).toBe(40_000);
    expect(p.closingTotal).toBe(42_340);
    expect(p.gainPerDay).not.toBeNull();
  });

  it("44E. no history at all → deltas null (the honest dash), gainPerDay null", () => {
    const p = battlestatProgression([], T0 - 7 * D, T0);
    expect(p.baselineKind).toBeNull();
    expect(p.deltaTotal).toBeNull();
    expect(p.gainPerDay).toBeNull();
  });
});
