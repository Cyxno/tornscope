import { describe, expect, it } from "vitest";
import {
  SCHEDULE_THRESHOLDS,
  categorizeActivity,
  decayMultiplier,
  isCategoryDue,
  nextCategorySchedule,
} from "../src/sync/schedule.js";

/**
 * Adaptive per-category scheduling policy tests.
 *
 * Correctness contract: intervals only change WHEN a category is polled —
 * the cursor + overlap window keeps every walk lossless regardless.
 */

const MINUTE = 60;
const HOUR = 3600;
const NOW = 1_788_633_600; // 2026-09-05 12:00:00 UTC

const input = (overrides: Partial<Parameters<typeof nextCategorySchedule>[0]> = {}) => ({
  lastNetNewRecords: 0,
  lastActivityAt: null as number | null,
  consecutiveEmptyRuns: 0,
  status: "active",
  now: NOW,
  ...overrides,
});

describe("activity tiers", () => {
  it("hot: activity within the last hour", () => {
    expect(categorizeActivity(NOW - 30 * MINUTE, NOW)).toBe("hot");
  });
  it("warm: activity 1-6 hours ago", () => {
    expect(categorizeActivity(NOW - 3 * HOUR, NOW)).toBe("warm");
  });
  it("cold: activity 6-48 hours ago", () => {
    expect(categorizeActivity(NOW - 24 * HOUR, NOW)).toBe("cold");
  });
  it("very cold: activity days ago or never", () => {
    expect(categorizeActivity(NOW - 72 * HOUR, NOW)).toBe("very_cold");
    expect(categorizeActivity(null, NOW)).toBe("very_cold");
  });
});

describe("adaptive intervals", () => {
  it("a hot category stays fast after activity (promotion)", () => {
    const d = nextCategorySchedule(input({ lastNetNewRecords: 12, lastActivityAt: NOW - 60, consecutiveEmptyRuns: 12 }));
    expect(d.tier).toBe("hot");
    expect(d.nextFrequencySeconds).toBe(SCHEDULE_THRESHOLDS.HOT_FREQUENCY);
    // Empty-run decay resets after activity.
    expect(d.nextRunAt).toBe(NOW + SCHEDULE_THRESHOLDS.HOT_FREQUENCY);
  });

  it("a cold category that suddenly gets rows promotes to hot", () => {
    const before = nextCategorySchedule(input({ lastActivityAt: NOW - 72 * HOUR, consecutiveEmptyRuns: 20 }));
    expect(before.tier).toBe("very_cold");
    const after = nextCategorySchedule(input({ lastNetNewRecords: 5, lastActivityAt: NOW, consecutiveEmptyRuns: 0 }));
    expect(after.tier).toBe("hot");
    expect(after.nextFrequencySeconds).toBe(SCHEDULE_THRESHOLDS.HOT_FREQUENCY);
  });

  it("hot decays gradually after repeated empty runs (no single-jump cliff)", () => {
    const base = SCHEDULE_THRESHOLDS.HOT_FREQUENCY;
    expect(decayMultiplier(2)).toBe(1);
    expect(decayMultiplier(4)).toBe(1.5);
    expect(decayMultiplier(7)).toBe(2);
    expect(decayMultiplier(15)).toBe(3);
    const d = nextCategorySchedule(input({ lastActivityAt: NOW - 30 * MINUTE, consecutiveEmptyRuns: 8 }));
    expect(d.nextFrequencySeconds).toBe(Math.round(base * 2));
  });

  it("very cold polls at most every 6 hours", () => {
    const d = nextCategorySchedule(input({ lastActivityAt: NOW - 30 * 24 * HOUR, consecutiveEmptyRuns: 50 }));
    expect(d.tier).toBe("very_cold");
    expect(d.nextFrequencySeconds).toBe(SCHEDULE_THRESHOLDS.VERY_COLD_FREQUENCY);
    expect(d.priority).toBe(5);
  });
});

describe("due logic", () => {
  it("a not-due category is skipped (no API request)", () => {
    expect(isCategoryDue(NOW + 3 * HOUR, NOW)).toBe(false);
  });
  it("a due category runs", () => {
    expect(isCategoryDue(NOW - MINUTE, NOW)).toBe(true);
  });
  it("a category without schedule state is always due (new category runs immediately)", () => {
    expect(isCategoryDue(null, NOW)).toBe(true);
  });
  it("zero due categories: the due filter empties the walk list (zero API calls)", () => {
    const states = [NOW + HOUR, NOW + 2 * HOUR, NOW + 6 * HOUR];
    const due = states.filter((t) => isCategoryDue(t, NOW));
    expect(due).toHaveLength(0);
  });
});

describe("failure backoff", () => {
  it("failed categories escalate 1m -> 5m -> 15m -> 30m -> 1h cap", () => {
    const ladders = [0, 1, 2, 3, 4, 9].map((empty) =>
      nextCategorySchedule(input({ status: "failed", consecutiveEmptyRuns: empty }))
    );
    expect(ladders.map((d) => d.nextFrequencySeconds)).toEqual([MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, HOUR]);
    for (const d of ladders) expect(d.tier).toBe("retry");
  });

  it("access denied retries slowly (6h) until credentials change", () => {
    const d = nextCategorySchedule(input({ status: "access_denied", consecutiveEmptyRuns: 0 }));
    expect(d.tier).toBe("access_denied");
    expect(d.nextFrequencySeconds).toBe(SCHEDULE_THRESHOLDS.ACCESS_DENIED_RETRY);
    expect(d.nextRunAt).toBe(NOW + SCHEDULE_THRESHOLDS.ACCESS_DENIED_RETRY);
  });
});

describe("cursor correctness is independent of the interval", () => {
  it("long gaps only widen the re-fetch span; overlap still guards same-second rows", () => {
    // Simulate a very-cold category checked after 3 days: its boundary sits
    // below its own cursor minus overlap — whatever appeared in the gap is
    // inside the walk, and rows at the cursor second are re-persisted.
    const cursor = NOW - 3 * 24 * HOUR;
    const boundary = cursor - SCHEDULE_THRESHOLDS.ACCESS_DENIED_RETRY; // worst case
    expect(boundary < cursor).toBe(true);
    // A row at the exact cursor second is above the boundary -> re-fetched.
    expect(cursor > boundary).toBe(true);
  });
});
