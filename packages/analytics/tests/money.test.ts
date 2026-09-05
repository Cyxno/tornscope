import { describe, expect, it } from "vitest";
import { aggregateMoneyEvents, totalsByBucket, type MoneyEventLike } from "../src/money.js";
import { buildTimeline, groupTimelineByDay } from "../src/timeline.js";
import { calculateNetworthChanges } from "../src/networth.js";

const DAY = 86_400;
const T0 = Date.UTC(2026, 0, 1) / 1000;

function ev(id: string, occurredAt: number, amount: number, category = "crime"): MoneyEventLike {
  return { id, occurredAt, amount, category, direction: amount >= 0 ? "income" : "expense" };
}

describe("aggregateMoneyEvents", () => {
  it("sums income and expenses and computes net profit", () => {
    const events = [ev("a", T0, 500), ev("b", T0 + 60, -200), ev("c", T0 + 120, 300)];
    const agg = aggregateMoneyEvents(events, T0 - 1000, T0 + 1000);
    expect(agg.totalIncome).toBe(800);
    expect(agg.totalExpenses).toBe(200);
    expect(agg.netProfit).toBe(600);
  });

  it("breaks down by category sorted descending", () => {
    const events = [ev("a", T0, 500, "crime"), ev("b", T0, 900, "faction"), ev("c", T0, -100, "rehab")];
    const agg = aggregateMoneyEvents(events, T0 - 10, T0 + 10);
    expect(agg.incomeByCategory[0]).toEqual({ category: "faction", total: 900 });
    expect(agg.largestIncomeCategory?.category).toBe("faction");
    expect(agg.largestExpenseCategory?.category).toBe("rehab");
  });

  it("produces contiguous daily buckets including empty days", () => {
    const events = [ev("a", T0, 100), ev("b", T0 + 3 * DAY, -50)];
    const agg = aggregateMoneyEvents(events, T0, T0 + 4 * DAY, "day");
    expect(agg.flowSeries).toHaveLength(5);
    expect(agg.flowSeries[1]).toEqual({ t: T0 + DAY, income: 0, expenses: 0 });
    expect(agg.flowSeries[3]!.expenses).toBe(50);
  });

  it("cumulative net series accumulates across buckets", () => {
    const events = [ev("a", T0, 100), ev("b", T0 + DAY, -30), ev("c", T0 + 2 * DAY, 50)];
    const agg = aggregateMoneyEvents(events, T0, T0 + 3 * DAY, "day");
    expect(agg.cumulativeNetSeries.map((p) => p.net)).toEqual([100, 70, 120, 120]);
  });

  it("excludes events outside the range (no double counting)", () => {
    const events = [ev("outside_before", T0 - DAY * 5, 999), ev("in", T0, 100), ev("outside_after", T0 + DAY * 5, 999)];
    const agg = aggregateMoneyEvents(events, T0, T0 + DAY);
    expect(agg.totalIncome).toBe(100);
  });

  it("totalsByBucket returns absolute totals per direction", () => {
    const events = [ev("a", T0, 100), ev("b", T0, -40)];
    const totals = totalsByBucket(events, "day", T0, T0 + DAY);
    expect(totals[0]!.total).toBe(140);
  });
});

describe("calculateNetworthChanges", () => {
  it("computes period changes from snapshot history", () => {
    const DAY = 86_400;
    const now = T0 + 40 * DAY;
    const snapshots = [
      { capturedAt: T0, total: 1_000_000 },
      { capturedAt: T0 + 10 * DAY, total: 1_200_000 },
      { capturedAt: now - 3 * DAY, total: 2_000_000 },
      { capturedAt: now, total: 2_500_000 },
    ];
    const changes = calculateNetworthChanges(snapshots, now, T0);
    expect(changes.current).toBe(2_500_000);
    // base for 7d: last snapshot at or before now-7d is the one at T0+10d
    expect(changes.change7d).toBe(1_300_000);
    // base for 30d: now-30d lands exactly on the T0+10d snapshot (inclusive)
    expect(changes.change30d).toBe(1_300_000);
    expect(changes.changeAllTime).toBe(1_500_000);
  });

  it("returns nulls when there is no history", () => {
    const changes = calculateNetworthChanges([], T0, T0 - 1000);
    expect(changes.current).toBeNull();
    expect(changes.changeAllTime).toBeNull();
  });
});

describe("buildTimeline", () => {
  it("merges sources and sorts descending", () => {
    const logs = [{ occurredAt: T0 + 10, type: "log", title: "Used Xanax", source: "torn_log" }];
    const events = [{ occurredAt: T0 + 20, type: "torn_event", title: "Level up", source: "torn_event" }];
    const items = buildTimeline([logs, events], {});
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe("Level up");
    expect(items[1]!.title).toBe("Used Xanax");
  });

  it("applies limit and range filters", () => {
    const logs = Array.from({ length: 10 }, (_, i) => ({ occurredAt: T0 + i, type: "log", title: `e${i}` }));
    const items = buildTimeline([logs], { limit: 3, from: T0 + 5 });
    expect(items).toHaveLength(3);
    expect(items[0]!.title).toBe("e9");
  });

  it("groups by UTC day", () => {
    const items = buildTimeline(
      [[{ occurredAt: T0 + 10, type: "log", title: "a" }, { occurredAt: T0 + DAY + 10, type: "log", title: "b" }]],
      {}
    );
    const grouped = groupTimelineByDay(items);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]!.items[0]!.title).toBe("b");
  });
});
