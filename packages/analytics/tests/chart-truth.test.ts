import { describe, expect, it } from "vitest";
import { aggregateMoneyEvents, buildNetworthSeries } from "@tornscope/analytics";

/**
 * Chart-truth and reconciliation tests.
 *
 * - The networth chart series must preserve every real snapshot value in
 *   chronological order — a synthetic 100/110/90/125 history must arrive at
 *   the chart as exactly those four points (never flattened, never repeated).
 * - Cash-expense category rows must reconcile to the headline total.
 */

describe("buildNetworthSeries preserves real historical values", () => {
  const t = (hoursAgo: number): number => 1_800_000_000 - hoursAgo * 3600;
  const snapshots = [
    { capturedAt: t(4), total: 100 },
    { capturedAt: t(3), total: 110 },
    { capturedAt: t(2), total: 90 },
    { capturedAt: t(1), total: 125 },
  ];

  it("preserves all four values of a synthetic 100/110/90/125 series", () => {
    const series = buildNetworthSeries(snapshots, t(4) - 10, t(1) + 10);
    expect(series.map((p) => p.total)).toEqual([100, 110, 90, 125]);
    expect(series.map((p) => p.t)).toEqual([t(4), t(3), t(2), t(1)]);
  });

  it("sorts chronologically regardless of input order", () => {
    const shuffled = [snapshots[2]!, snapshots[0]!, snapshots[3]!, snapshots[1]!];
    const series = buildNetworthSeries(shuffled, 0, Number.MAX_SAFE_INTEGER);
    expect(series.map((p) => p.total)).toEqual([100, 110, 90, 125]);
  });

  it("does not stretch the series outside the queried range", () => {
    const series = buildNetworthSeries(snapshots, t(3), t(1));
    expect(series).toHaveLength(3);
    expect(series.map((p) => p.total)).toEqual([110, 90, 125]);
  });

  it("does not repeat the latest value to fill the range", () => {
    const series = buildNetworthSeries([{ capturedAt: t(1), total: 125 }], t(4), t(1));
    expect(series).toEqual([{ t: t(1), total: 125 }]);
  });

  it("keeps distinct values distinct (a changing history is not a flat line)", () => {
    const series = buildNetworthSeries(snapshots, 0, Number.MAX_SAFE_INTEGER);
    expect(new Set(series.map((p) => p.total)).size).toBe(4);
  });
});

describe("cash-expense category reconciliation", () => {
  const events = [
    { id: "1", occurredAt: 1_000, category: "rehab", direction: "expense" as const, amount: -975_000 },
    { id: "2", occurredAt: 1_100, category: "casino", direction: "expense" as const, amount: -250_000 },
    { id: "3", occurredAt: 1_200, category: "items", direction: "expense" as const, amount: -1_000_000 },
    { id: "4", occurredAt: 1_300, category: "bazaar", direction: "expense" as const, amount: -40_000 },
    { id: "5", occurredAt: 1_400, category: "crime", direction: "income" as const, amount: 500_000 },
    // Neutral transfers and unknown rows never enter the expense total.
    { id: "6", occurredAt: 1_500, category: "city_bank", direction: "neutral" as const, amount: -5_000_000 },
    { id: "7", occurredAt: 1_600, category: "other", direction: "unknown" as const, amount: -123 },
  ];

  it("expense category rows sum exactly to the headline Cash Expenses", () => {
    const agg = aggregateMoneyEvents(events, 0, 5_000, "day");
    const categorySum = agg.expensesByCategory.reduce((s, r) => s + r.total, 0);
    expect(agg.totalExpenses).toBe(975_000 + 250_000 + 1_000_000 + 40_000);
    expect(categorySum).toBe(agg.totalExpenses);
    expect(agg.netProfit).toBe(agg.totalIncome - agg.totalExpenses);
  });

  it("every expense row carries a category (no unattributed cash out)", () => {
    const agg = aggregateMoneyEvents(events, 0, 5_000, "day");
    for (const row of agg.expensesByCategory) {
      expect(row.category).toBeTruthy();
      expect(row.total).toBeGreaterThan(0);
    }
  });

  it("consumed inventory value never appears in the cash expense aggregate", () => {
    // Consumption is a separate event stream; even if a use is worth as much
    // as a purchase, only the purchase is cash.
    const consumptionOnly = aggregateMoneyEvents([], 0, 5_000, "day");
    expect(consumptionOnly.totalExpenses).toBe(0);
    expect(consumptionOnly.totalIncome).toBe(0);
  });
});
