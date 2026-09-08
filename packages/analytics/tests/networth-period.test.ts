import { describe, expect, it } from "vitest";
import { calculateNetworthPeriodChange, type NetworthSnapshotFields } from "../src/networth.js";
import { resolveDateRange } from "@tornscope/shared";

/**
 * Networth period semantics:
 * - baseline = closest valid snapshot at or before the period start
 * - coverage "partial" = tracking began after the period start (Tracked
 *   period change over the covered span)
 * - coverage "none" = insufficient history — callers must never render 0.
 */

const DAY = 86_400;
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0) / 1000; // 2026-09-05 12:00 UTC

const nextTs = 1_700_000_000;
function snap(daysAgo: number, total: number, overrides: Partial<NetworthSnapshotFields> = {}): NetworthSnapshotFields {
  return {
    capturedAt: Math.floor(NOW - daysAgo * DAY),
    total,
    pending: 0,
    wallet: Math.floor(total * 0.2),
    vault: 0,
    bookie: 0,
    cityBank: Math.floor(total * 0.3),
    caymanBank: 0,
    piggyBank: 0,
    inventory: Math.floor(total * 0.4),
    displayCase: 0,
    bazaar: 0,
    trades: 0,
    itemMarket: 0,
    auctionHouse: 0,
    enlistedCars: 0,
    property: Math.floor(total * 0.1),
    stockMarket: 0,
    company: 0,
    points: 0,
    ...overrides,
  };
}

function range(preset: Parameters<typeof resolveDateRange>[0], now = NOW) {
  return resolveDateRange(preset, now);
}

describe("baseline selection", () => {
  it("uses the closest snapshot at or before the period start, not one inside it", () => {
    const snapshots = [snap(40, 100), snap(10, 140), snap(0, 150)];
    const r = range({ preset: "14d" });
    const result = calculateNetworthPeriodChange(snapshots, r.from, r.to);
    expect(result.coverage).toBe("full");
    // The 10-days-ago snapshot is inside a 14D window — the 40-days-ago
    // snapshot (at/before the start) is the baseline.
    expect(result.baseline?.capturedAt).toBe(snapshots[0]!.capturedAt);
    expect(result.change).toBe(50);
  });

  it("prefers a snapshot slightly before the period start over an older one", () => {
    const snapshots = [snap(60, 80), snap(15, 120), snap(0, 160)];
    const r = range({ preset: "14d" });
    const result = calculateNetworthPeriodChange(snapshots, r.from, r.to);
    expect(result.baseline?.capturedAt).toBe(snapshots[1]!.capturedAt);
    expect(result.change).toBe(40);
  });

  it("computes percentage change against the baseline", () => {
    const snapshots = [snap(30, 200), snap(0, 250)];
    const r = range({ preset: "30d" });
    const result = calculateNetworthPeriodChange(snapshots, r.from, r.to);
    expect(result.change).toBe(50);
    expect(result.changePct).toBeCloseTo(25);
  });
});

describe("period presets over one consistent history", () => {
  // Tracking started 200 days ago; steady +10/day since. Total rises from
  // 1,000,000 (200 days ago) to 3,000,000 (now).
  const snapshots: NetworthSnapshotFields[] = Array.from({ length: 201 }, (_, i) => snap(200 - i, 1_000_000 + i * 10_000));

  const expectations: Array<[Parameters<typeof resolveDateRange>[0], number]> = [
    ["1d", 10_000],
    ["7d", 70_000],
    ["14d", 140_000],
    ["30d", 300_000],
    ["90d", 900_000],
    // Aug 31 12:00 snapshot is the closest at/before Sep 1 00:00 -> 5 days of change.
    ["this_month", 50_000],
  ];

  it.each(expectations)("preset %s yields the expected change", (preset, expected) => {
    const r = range({ preset });
    const result = calculateNetworthPeriodChange(snapshots, r.from, r.to);
    expect(result.coverage).toBe("full");
    expect(result.change).toBe(expected);
    expect(result.current?.total).toBe(3_000_000);
  });

  it("this_year: tracking began after Jan 1 -> Tracked period change", () => {
    const r = range({ preset: "this_year" });
    const result = calculateNetworthPeriodChange(snapshots, r.from, r.to);
    expect(result.coverage).toBe("partial");
    expect(result.change).toBe(2_000_000); // 3,000,000 now - 1,000,000 at first snapshot
  });

  it("all: no snapshot at epoch -> tracked period change from the earliest snapshot", () => {
    const r = range({ preset: "all" });
    const result = calculateNetworthPeriodChange(snapshots, r.from, r.to);
    expect(result.coverage).toBe("partial");
    expect(result.change).toBe(2_000_000);
  });
});

describe("insufficient and partial history", () => {
  it("no snapshots at all -> coverage none, change null (Insufficient history)", () => {
    const r = range({ preset: "7d" });
    const result = calculateNetworthPeriodChange([], r.from, r.to);
    expect(result.coverage).toBe("none");
    expect(result.change).toBeNull();
    expect(result.current).toBeNull();
    expect(result.byCategory).toHaveLength(0);
  });

  it("a single snapshot inside the period -> coverage none, never a fake 0", () => {
    const snapshots = [snap(1, 5_000)];
    const r = range({ preset: "7d" });
    const result = calculateNetworthPeriodChange(snapshots, r.from, r.to);
    expect(result.coverage).toBe("none");
    expect(result.change).toBeNull();
  });

  it("tracking began after the period start -> Tracked period change (partial)", () => {
    // 7D period but tracking only started 3 days ago.
    const snapshots = [snap(3, 1_000_000), snap(2, 1_010_000), snap(1, 1_020_000), snap(0, 1_030_000)];
    const r = range({ preset: "7d" });
    const result = calculateNetworthPeriodChange(snapshots, r.from, r.to);
    expect(result.coverage).toBe("partial");
    expect(result.baseline?.capturedAt).toBe(snapshots[0]!.capturedAt);
    expect(result.change).toBe(30_000);
    expect(result.byCategory).toHaveLength(8);
  });

  it("all snapshots strictly after the period end -> coverage none", () => {
    const snapshots = [snap(-5, 100)]; // in the future relative to `to`
    const r = range({ preset: "30d" });
    const result = calculateNetworthPeriodChange(snapshots, r.from, r.to);
    expect(result.coverage).toBe("none");
    expect(result.change).toBeNull();
  });
});

describe("category breakdown", () => {
  it("compares every Torn category between baseline and current", () => {
    const baseline = snap(10, 1_000_000, { inventory: 100_000, stockMarket: 50_000, wallet: 200_000 });
    const current = snap(0, 1_050_000, { inventory: 131_000, stockMarket: 58_000, wallet: 178_000 });
    const result = calculateNetworthPeriodChange([baseline, current], baseline.capturedAt, current.capturedAt);
    expect(result.coverage).toBe("full");
    const byKey = Object.fromEntries(result.byCategory.map((c) => [c.key, c]));
    expect(byKey.cash!.change).toBe(-22_000);
    expect(byKey.stocks!.change).toBe(8_000);
    expect(byKey.items!.change).toBe(31_000);
    expect(byKey.items!.current).toBe(131_000);
    expect(byKey.total === undefined).toBe(true);
    expect(result.change).toBe(50_000);
  });

  it("inventory appreciation lands in the items category, never in cash", () => {
    const fixed = { wallet: 150_000, cityBank: 150_000, property: 0, points: 0, stockMarket: 0 };
    const baseline = snap(7, 500_000, { inventory: 100_000, ...fixed });
    const current = snap(0, 531_000, { inventory: 131_000, ...fixed });
    const result = calculateNetworthPeriodChange([baseline, current], baseline.capturedAt, current.capturedAt);
    const byKey = Object.fromEntries(result.byCategory.map((c) => [c.key, c]));
    expect(byKey.items!.change).toBe(31_000);
    expect(byKey.cash!.change).toBe(0);
    expect(byKey.items!.current).toBe(131_000);
  });

  it("the other category reconciles the breakdown to the total", () => {
    const baseline = snap(10, 1_000_000);
    // Snapshot total differs from the sum of parts by -1,000 (loans/fees).
    const current = { ...snap(0, 1_050_000), total: 1_049_000 };
    const result = calculateNetworthPeriodChange([baseline, current], baseline.capturedAt, current.capturedAt);
    const known = result.byCategory.filter((c) => c.key !== "other").reduce((s, c) => s + c.change, 0);
    const other = result.byCategory.find((c) => c.key === "other")!;
    expect(known + other.change).toBe(result.change);
    expect(other.change).toBe(-1_000);
  });
});
