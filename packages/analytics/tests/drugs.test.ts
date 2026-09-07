import { describe, expect, it } from "vitest";
import { calculateDrugStats, type DrugEventLike } from "../src/drugs.js";
import { calculateRehabStats, type RehabEventLike } from "../src/rehab.js";

const DAY = 86_400;
const T0 = Date.UTC(2026, 0, 1) / 1000;
const H0 = 6 * 3600; // 06:00

const PRICES = new Map<number, number>([
  [196, 9_000], // Cannabis-ish demo price
  [200, 45_000],
]);

function drug(day: number, outcome: "success" | "overdose", itemId: number | null, drugName: string | null): DrugEventLike {
  return { occurredAt: T0 + day * DAY + H0, drugItemId: itemId, drugName, outcome };
}

describe("calculateDrugStats", () => {
  it("counts uses, overdoses and overdose rate", () => {
    const events = [
      drug(0, "success", 196, "Cannabis"),
      drug(0, "success", 196, "Cannabis"),
      drug(1, "overdose", 200, "Xanax"),
    ];
    const stats = calculateDrugStats(events, PRICES, T0, T0 + 2 * DAY);
    expect(stats.totalUses).toBe(3);
    expect(stats.overdoses).toBe(1);
    expect(stats.overdoseRate).toBeCloseTo(1 / 3);
  });

  it("builds a contiguous daily series with good/bad splits", () => {
    const events = [drug(0, "success", 196, "Cannabis"), drug(2, "overdose", 200, "Xanax")];
    const stats = calculateDrugStats(events, PRICES, T0, T0 + 3 * DAY);
    expect(stats.dailySeries).toHaveLength(4);
    expect(stats.dailySeries[0]).toEqual({ t: T0, good: 1, bad: 0 });
    expect(stats.dailySeries[1]).toEqual({ t: T0 + DAY, good: 0, bad: 0 });
    expect(stats.dailySeries[2]!.bad).toBe(1);
  });

  it("estimates spend from market prices and computes cost per use", () => {
    const events = [drug(0, "success", 196, "Cannabis"), drug(0, "success", 200, "Xanax")];
    const stats = calculateDrugStats(events, PRICES, T0, T0 + DAY);
    expect(stats.estimatedSpend).toBe(54_000);
    expect(stats.averageCostPerUse).toBe(27_000);
    expect(stats.provenance).toBe("estimated");
  });

  it("returns null spend when prices are unknown (no guessing)", () => {
    const events = [drug(0, "success", 999, "Unknown")];
    const stats = calculateDrugStats(events, PRICES, T0, T0 + DAY);
    expect(stats.estimatedSpend).toBeNull();
  });

  it("breaks down per drug with shares", () => {
    const events = [
      drug(0, "success", 196, "Cannabis"),
      drug(0, "success", 196, "Cannabis"),
      drug(0, "success", 200, "Xanax"),
    ];
    const stats = calculateDrugStats(events, PRICES, T0, T0 + DAY);
    expect(stats.byDrug[0]).toMatchObject({ drug: "Cannabis", uses: 2, shareOfTotal: 2 / 3 });
    expect(stats.byDrug[1]).toMatchObject({ drug: "Xanax", uses: 1 });
  });

  it("honors a drug name filter", () => {
    const events = [drug(0, "success", 196, "Cannabis"), drug(0, "success", 200, "Xanax")];
    const stats = calculateDrugStats(events, PRICES, T0, T0 + DAY, "day", new Set(["Cannabis"]));
    expect(stats.totalUses).toBe(1);
    expect(stats.byDrug[0]!.drug).toBe("Cannabis");
  });
});

describe("calculateRehabStats", () => {
  it("sums spend, counts visits, and reports the latest rehab", () => {
    const events: RehabEventLike[] = [
      { occurredAt: T0, cost: 50_000, rehabPercent: 20 },
      { occurredAt: T0 + DAY, cost: 75_000, rehabPercent: 40 },
      { occurredAt: T0 + 2 * DAY, cost: null, rehabPercent: null },
    ];
    const stats = calculateRehabStats(events, T0, T0 + 3 * DAY);
    expect(stats.visits).toBe(3);
    expect(stats.totalSpend).toBe(125_000);
    expect(stats.averageSpend).toBeCloseTo(62_500);
    expect(stats.latestAt).toBe(T0 + 2 * DAY);
    expect(stats.provenance).toBe("estimated"); // one event lacks cost
  });

  it("returns null spend when no cost data exists", () => {
    const stats = calculateRehabStats([{ occurredAt: T0, cost: null, rehabPercent: null }], T0, T0 + DAY);
    expect(stats.totalSpend).toBeNull();
  });
});
