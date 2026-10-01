import { describe, expect, it } from "vitest";
import {
  buildEnergyAccounting,
  energyChartInterval,
  rebucketEnergyDaily,
  shapeDeepEnergyInputs,
  shapeGymUses,
  shapeOverdoseLosses,
  worstProvenance,
  type AttackEvidenceRow,
  type GymEvidenceRow,
  type OverdoseEvidenceRow,
} from "../src/energy.js";
import type { EnergyObservation } from "../src/progression.js";

const T = 1_750_000_000;
const DAY = 86_400;
const MAX = 150;

function bars(points: Array<[number, number]>, max = MAX): EnergyObservation[] {
  return points.map(([t, e]) => ({ t, energyCurrent: e, energyMaximum: max }));
}

function refillMeta(energy: number, points = 30): { data: Record<string, unknown> } {
  return { data: { points_used: points, energy_increased: energy } };
}

function gymMeta(energyUsed: number, trains = 10, happy = 50): { data: Record<string, unknown> } {
  return { data: { energy_used: energyUsed, trains, happy_used: happy } };
}

function odMeta(energy: number): { data: Record<string, unknown> } {
  return { data: { energy_decreased: energy, happy_decreased: 100 } };
}

describe("deep energy shaping", () => {
  it("extracts exact gym energy_used and skips payloads without it", () => {
    const rows: GymEvidenceRow[] = [
      { occurredAt: T, metadata: gymMeta(400, 40, 204) },
      { occurredAt: T + 60, metadata: { data: { trains: 5 } } },
    ];
    const uses = shapeGymUses(rows);
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ t: T, energyUsed: 400, trains: 40, happyUsed: 204 });
  });

  it("extracts exact overdose energy losses only when energy_decreased exists", () => {
    const rows: OverdoseEvidenceRow[] = [
      { occurredAt: T, title: "Item use xanax overdose", metadata: odMeta(150) },
      // Ecstasy overdoses drain happiness, not the energy bar — never a loss.
      { occurredAt: T + 60, title: "Item use ecstasy overdose", metadata: { data: { happy_increased: 6250 } } },
    ];
    const losses = shapeOverdoseLosses(rows);
    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({ amount: 150, category: "Xanax" });
  });

  it("shapes refill/xanax/energy-drink gains with the documented provenance", () => {
    const gains = shapeDeepEnergyInputs(
      [{ occurredAt: T, metadata: refillMeta(150, 30) }],
      [{ occurredAt: T + 100, drugName: "Xanax", outcome: "success" }],
      [{ occurredAt: T + 200, category: "energy", metadata: refillMeta(75) }]
    );
    expect(gains).toHaveLength(3);
    expect(gains[0]).toMatchObject({ category: "refill", amount: 150, pointsUsed: 30, provenance: "exact" });
    expect(gains[1]).toMatchObject({ category: "xanax", amount: 250, provenance: "estimated" });
    expect(gains[2]).toMatchObject({ category: "energy_drink", amount: 75, provenance: "exact" });
  });

  it("worst provenance never upgrades a mixed figure", () => {
    expect(worstProvenance(["exact", "exact"])).toBe("exact");
    expect(worstProvenance(["exact", "estimated"])).toBe("estimated");
    expect(worstProvenance(["exact", "inferred"])).toBe("inferred");
  });
});

describe("buildEnergyAccounting — sources", () => {
  const from = T;
  const to = T + 3 * DAY;

  it("aggregates known sources with counts, shares and refill points", () => {
    const gains = shapeDeepEnergyInputs(
      [T + 10, T + 20].map((t) => ({ occurredAt: t, metadata: refillMeta(150, 30) })),
      [T + 30].map((t) => ({ occurredAt: t, drugName: "Xanax", outcome: "success" })),
      []
    );
    const accounting = buildEnergyAccounting({ from, to, gains, gymUses: [], losses: [], attacks: [], bars: [] });
    const refill = accounting.sources.find((s) => s.category === "refill");
    const xanax = accounting.sources.find((s) => s.category === "xanax");
    expect(refill).toMatchObject({ amount: 300, events: 2, provenance: "exact", pointsUsed: 60 });
    expect(xanax).toMatchObject({ amount: 250, events: 1, provenance: "estimated" });
    expect(refill?.share).toBeCloseTo(300 / 550, 5);
  });

  it("keeps natural regen separate from external gains and derives it from bar rises", () => {
    const gains = shapeDeepEnergyInputs([{ occurredAt: from + 3600, metadata: refillMeta(150) }], [], []);
    // Rise 0 -> 150 over one interval contains the refill: natural = 150-150 = 0.
    // Next rise 150 -> 300 with no gains: +150 natural.
    const observations = bars([
      [from, 0],
      [from + 3600, MAX],
      [from + 7200, 2 * MAX],
    ]);
    const accounting = buildEnergyAccounting({ from, to, gains, gymUses: [], losses: [], attacks: [], bars: observations });
    expect(accounting.balance.generated.value).toBe(150);
    expect(accounting.balance.gainedExternally.value).toBe(150);
  });
});

describe("buildEnergyAccounting — uses", () => {
  const from = T;
  const to = T + DAY;

  it("reports exact gym energy from logs, independent of bar coverage", () => {
    const gym = shapeGymUses([from + 100, from + 200].map((t) => ({ occurredAt: t, metadata: gymMeta(200) })));
    const accounting = buildEnergyAccounting({ from, to, gains: [], gymUses: gym, losses: [], attacks: [], bars: [] });
    expect(accounting.uses[0]).toMatchObject({ category: "gym", amount: 400, provenance: "exact" });
    // No bars → no inferred rows and no claimed spent total.
    expect(accounting.balance.spent.value).toBeNull();
    expect(accounting.uses).toHaveLength(1);
  });

  it("separates competed declines (attacks) from unattributed declines", () => {
    const gains = shapeDeepEnergyInputs([], [], []);
    const attacks: AttackEvidenceRow[] = [{ occurredAt: from + 1800 }];
    // Interval 1 declines with an attack inside it; interval 2 declines clean.
    const observations = bars([
      [from, 150],
      [from + 3600, 50],
      [from + 7200, 0],
    ]);
    const accounting = buildEnergyAccounting({ from, to, gains, gymUses: [], losses: [], attacks, bars: observations });
    const attacked = accounting.uses.find((u) => u.category === "attacks");
    const other = accounting.uses.find((u) => u.category === "other");
    expect(attacked?.amount).toBe(100);
    expect(other?.amount).toBe(50);
    expect(attacked?.provenance).toBe("inferred");
  });
});

describe("buildEnergyAccounting — losses", () => {
  const from = T;
  const to = T + DAY;

  it("keeps losses separate from spent and from the sources", () => {
    const losses = shapeOverdoseLosses([{ occurredAt: from + 500, title: "Item use xanax overdose", metadata: odMeta(150) }]);
    const observations = bars([
      [from, 100],
      [from + 3600, 0],
    ]);
    const accounting = buildEnergyAccounting({ from, to, gains: [], gymUses: [], losses, attacks: [], bars: observations });
    expect(accounting.balance.lost.value).toBe(150);
    expect(accounting.losses[0]).toMatchObject({ category: "Xanax", amount: 150, provenance: "exact" });
    // The OD decline (100) is NOT counted as spent: the log already owns it.
    expect(accounting.balance.spent.value).toBe(0);
  });
});

describe("buildEnergyAccounting — coverage & honesty", () => {
  const from = T;
  const to = T + 2 * DAY;

  it("never claims a net balance without bar coverage", () => {
    const gains = shapeDeepEnergyInputs([{ occurredAt: from + 10, metadata: refillMeta(150) }], [], []);
    const accounting = buildEnergyAccounting({ from, to, gains, gymUses: [], losses: [], attacks: [], bars: [] });
    expect(accounting.balance.net.value).toBeNull();
    expect(accounting.balance.generated.value).toBeNull();
    expect(accounting.coverage.quality).toBe("unavailable");
    expect(accounting.coverage.accountedShare).toBeNull();
  });

  it("computes accounted share from explicit logs over observed outflow", () => {
    // Outflow of 150 observed; a gym log owns 100 → 2/3 accounted.
    const gym = shapeGymUses([{ occurredAt: from + 1800, metadata: gymMeta(100) }]);
    const observations = bars([
      [from, MAX],
      [from + 3600, 0],
    ]);
    const accounting = buildEnergyAccounting({ from, to, gains: [], gymUses: gym, losses: [], attacks: [], bars: observations });
    expect(accounting.coverage.accountedShare).toBeCloseTo(100 / 150, 5);
    expect(accounting.coverage.quality).toBe("full");
  });

  it("marks truncated bar history as partial coverage", () => {
    const observations = bars([
      [from, MAX],
      [from + 3600, 0],
    ]);
    const accounting = buildEnergyAccounting({ from, to, gains: [], gymUses: [], losses: [], attacks: [], bars: observations, barsTruncated: true });
    expect(accounting.coverage.quality).toBe("partial");
    expect(accounting.coverage.truncated).toBe(true);
  });

  it("respects date range boundaries for gains, gym and losses", () => {
    const gains = shapeDeepEnergyInputs(
      [
        { occurredAt: from - 10, metadata: refillMeta(150) },
        { occurredAt: from + 10, metadata: refillMeta(150) },
      ],
      [],
      []
    );
    const gym = shapeGymUses([{ occurredAt: to + 10, metadata: gymMeta(500) }]);
    const losses = shapeOverdoseLosses([{ occurredAt: to + 10, title: "Item use xanax overdose", metadata: odMeta(150) }]);
    const accounting = buildEnergyAccounting({ from, to, gains, gymUses: gym, losses, attacks: [], bars: [] });
    expect(accounting.balance.gainedExternally.value).toBe(150);
    expect(accounting.uses).toHaveLength(0);
    expect(accounting.losses).toHaveLength(0);
    expect(accounting.balance.lost.value).toBe(0);
  });
});

describe("buildEnergyAccounting — empty & degenerate history", () => {
  it("survives a completely empty history with zero-division safety", () => {
    const accounting = buildEnergyAccounting({ from: T, to: T + DAY, gains: [], gymUses: [], losses: [], attacks: [], bars: [] });
    expect(accounting.balance.gainedExternally.value).toBe(0);
    expect(accounting.balance.spent.value).toBeNull();
    expect(accounting.sources).toHaveLength(0);
    expect(accounting.daily).toHaveLength(0);
    expect(accounting.intelligence.averageEnergyPerDay.value).toBeNull();
    expect(accounting.intelligence.xanaxPerDay.value).toBeNull();
    expect(accounting.intelligence.gymShareOfSpent).toBeNull();
  });

  it("derives xanax/day and refill intelligence", () => {
    const gains = shapeDeepEnergyInputs(
      [from(), from() + 3600].map((t) => ({ occurredAt: t, metadata: refillMeta(150, 30) })),
      [{ occurredAt: from() + 100, drugName: "Xanax", outcome: "success" }],
      []
    );
    function from(): number {
      return T;
    }
    const accounting = buildEnergyAccounting({ from: T, to: T + 2 * DAY, gains, gymUses: [], losses: [], attacks: [], bars: [] });
    expect(accounting.intelligence.refillCount).toBe(2);
    expect(accounting.intelligence.refillEnergy).toBe(300);
    expect(accounting.intelligence.refillPointsSpent).toBe(60);
    expect(accounting.intelligence.xanaxPerDay.value).toBeCloseTo(0.5, 5);
  });
});

describe("daily series & chart bucketing", () => {
  it("rebuckets daily points into weeks without loss", () => {
    const points = [0, 1, 2, 3, 4, 5, 6, 7].map((d) => ({ t: 1_750_000_000 + d * DAY, gained: 10, spent: 4, lost: 1 }));
    const weekly = rebucketEnergyDaily(points, "week");
    expect(weekly.length).toBeLessThan(points.length);
    expect(weekly.reduce((s, p) => s + p.gained, 0)).toBe(80);
    expect(weekly.reduce((s, p) => s + p.spent, 0)).toBe(32);
    expect(weekly.reduce((s, p) => s + p.lost, 0)).toBe(8);
  });

  it("picks the chart interval by range length", () => {
    expect(energyChartInterval(T, T + 30 * DAY)).toBe("day");
    expect(energyChartInterval(T, T + 200 * DAY)).toBe("week");
    expect(energyChartInterval(T, T + 800 * DAY)).toBe("month");
  });
});
