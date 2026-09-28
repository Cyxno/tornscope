import { describe, expect, it } from "vitest";
import { buildGoalView, goalCurrentValue, GOAL_MILESTONE_FRACTIONS, liquidWealth, reachedMilestone, type GoalFacts } from "../src/goals.js";
import type { NetworthSnapshotFields } from "../src/networth.js";

const DAY = 86_400;
const NOW = 1_750_000_000;

function networthField(total: number, capturedAt: number, overrides: Partial<NetworthSnapshotFields> = {}): NetworthSnapshotFields {
  return {
    capturedAt,
    total,
    pending: 0,
    wallet: 0,
    vault: 0,
    bookie: 0,
    cityBank: 0,
    caymanBank: 0,
    piggyBank: 0,
    inventory: 0,
    displayCase: 0,
    bazaar: 0,
    trades: 0,
    itemMarket: 0,
    auctionHouse: 0,
    enlistedCars: 0,
    property: 0,
    stockMarket: 0,
    company: 0,
    points: 0,
    ...overrides,
  };
}

const emptyFacts: GoalFacts = { networthSnapshots: [], battlestatSeries: [], levelSeries: [] };

describe("goalCurrentValue", () => {
  it("reads net worth from the latest snapshot", () => {
    const facts: GoalFacts = {
      ...emptyFacts,
      networthSnapshots: [networthField(1_000_000, NOW - 2 * DAY), networthField(2_000_000, NOW - DAY)],
    };
    expect(goalCurrentValue("networth", facts)).toEqual({ value: 2_000_000, at: NOW - DAY });
  });

  it("computes liquid wealth as cash + bank-like balances", () => {
    const snap = networthField(10_000_000, NOW, {
      wallet: 1_000_000,
      vault: 500_000,
      pending: 10_000,
      cityBank: 2_000_000,
      caymanBank: 3_000_000,
      piggyBank: 40_000,
      bookie: 5_000,
      // Excluded: illiquid value.
      inventory: 999_999,
      stockMarket: 999_999,
      property: 999_999,
    });
    expect(liquidWealth(snap)).toBe(1_000_000 + 500_000 + 10_000 + 2_000_000 + 3_000_000 + 40_000 + 5_000);
    expect(goalCurrentValue("liquid_wealth", { ...emptyFacts, networthSnapshots: [snap] })?.value).toBe(liquidWealth(snap));
  });

  it("reads individual and total battlestats, tolerating null gaps", () => {
    const facts: GoalFacts = {
      ...emptyFacts,
      battlestatSeries: [
        { t: NOW - 2 * DAY, strength: 10, defense: 20, speed: 30, dexterity: 40, total: 100 },
        { t: NOW - DAY, strength: 12, defense: null, speed: 31, dexterity: 42, total: null },
      ],
    };
    expect(goalCurrentValue("strength", facts)?.value).toBe(12);
    expect(goalCurrentValue("defense", facts)?.value).toBe(20); // falls back to the last non-null
    expect(goalCurrentValue("battlestats_total", facts)?.value).toBe(100);
  });

  it("returns null for every metric on empty facts", () => {
    for (const metric of ["networth", "liquid_wealth", "battlestats_total", "strength", "defense", "speed", "dexterity", "level"] as const) {
      expect(goalCurrentValue(metric, emptyFacts)).toBeNull();
    }
  });

  it("reads level from the latest user snapshot", () => {
    expect(goalCurrentValue("level", { ...emptyFacts, levelSeries: [{ t: 1, level: 30 }, { t: 2, level: 31 }] })?.value).toBe(31);
  });
});

describe("buildGoalView", () => {
  const facts: GoalFacts = {
    networthSnapshots: Array.from({ length: 30 }, (_, i) => networthField(1_000_000_000 + i * 10_000_000, NOW - (30 - i) * DAY)),
    battlestatSeries: [],
    levelSeries: [],
  };

  it("composes progress and a projection for an active goal", () => {
    const view = buildGoalView({ id: "g1", metric: "networth", target: 2_000_000_000, note: null, createdAt: NOW - 30 * DAY, targetDate: null, status: "active", achievedAt: null }, facts, NOW, 30);
    expect(view.currentValue).toBe(1_000_000_000 + 29 * 10_000_000);
    expect(view.progress).toBeCloseTo(view.currentValue! / 2_000_000_000, 10);
    expect(view.projection.insufficientReason).toBeNull();
    expect(view.projection.confidence).toBe("high");
    expect(view.projection.velocityPerDay).toBeCloseTo(10_000_000, 3);
    expect(view.dataAvailable).toBe(true);
  });

  it("freezes achieved goals on target_reached regardless of later dips", () => {
    const view = buildGoalView({ id: "g2", metric: "networth", target: 1_000_000_000, note: null, createdAt: NOW - 40 * DAY, targetDate: null, status: "achieved", achievedAt: NOW - 5 * DAY }, facts, NOW, 30);
    expect(view.projection.insufficientReason).toBe("target_reached");
    expect(view.projection.etaAt).toBeNull();
    expect(view.goal.achievedAt).toBe(NOW - 5 * DAY);
  });

  it("reports insufficient data without fabricating values", () => {
    const view = buildGoalView({ id: "g3", metric: "battlestats_total", target: 5_000_000, note: null, createdAt: NOW, targetDate: null, status: "active", achievedAt: null }, emptyFacts, NOW, 30);
    expect(view.currentValue).toBeNull();
    expect(view.progress).toBeNull();
    expect(view.dataAvailable).toBe(false);
    expect(view.projection.insufficientReason).toBe("insufficient_history");
    expect(view.projection.confidence).toBe("insufficient");
  });

  it("honors the requested lookback", () => {
    const short = buildGoalView({ id: "g4", metric: "networth", target: 5_000_000_000, note: null, createdAt: NOW - 90 * DAY, targetDate: null, status: "active", achievedAt: null }, facts, NOW, 7);
    expect(short.projection.lookbackDays).toBe(7);
    expect(short.projection.window.points).toBeLessThanOrEqual(8);
  });

  it("clamps progress at 1 and rejects non-positive targets", () => {
    const over = buildGoalView({ id: "g5", metric: "networth", target: 100, note: null, createdAt: NOW, targetDate: null, status: "active", achievedAt: null }, facts, NOW, 30);
    expect(over.progress).toBe(1);
    const zero = buildGoalView({ id: "g6", metric: "networth", target: 0, note: null, createdAt: NOW, targetDate: null, status: "active", achievedAt: null }, facts, NOW, 30);
    expect(zero.progress).toBeNull();
  });
});

describe("goal milestones", () => {
  it("finds the highest reached milestone", () => {
    expect(reachedMilestone(0.1)).toBeNull();
    expect(reachedMilestone(0.5)).toBe(0.5);
    expect(reachedMilestone(0.74)).toBe(0.5);
    expect(reachedMilestone(0.75)).toBe(0.75);
    expect(reachedMilestone(0.999)).toBe(0.9);
    expect(reachedMilestone(1)).toBe(0.9); // 1.0 is achievement, not a milestone
  });

  it("keeps the curated milestone list stable", () => {
    expect([...GOAL_MILESTONE_FRACTIONS]).toEqual([0.5, 0.75, 0.9]);
  });
});
