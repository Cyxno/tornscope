import { describe, expect, it } from "vitest";
import { aggregateMoneySemantics, buildCashReceivedBreakdown, buildCashSpentBreakdown, CASH_INCOME_LABELS } from "../src/money.js";

/**
 * Cash-flow terminology contract:
 * - "Cash received" is a MOVEMENT, not profit — the breakdown separates
 *   earned income from asset sales with explicit labels;
 * - the breakdown reconciles EXACTLY to the cash-inflow aggregate: every
 *   counted event lands in exactly one bucket, nothing is dropped or
 *   double-counted;
 * - item sales (cash for items sold) and item rewards (items gained, never
 *   cash) are distinct concepts and never share a bare "Items" label.
 */

type E = { occurredAt?: number; category: string; direction: "income" | "expense" | "neutral" | "unknown"; amount: number; ocPayout?: boolean };

describe("buildCashReceivedBreakdown", () => {
  it("reconciles earned + asset sales + other exactly to total", () => {
    const events: E[] = [
      { category: "salary", direction: "income", amount: 21_000_000 },
      { category: "crime", direction: "income", amount: 5_000_000 },
      { category: "faction", direction: "income", amount: 12_000_000, ocPayout: true },
      { category: "bazaar", direction: "income", amount: 100_000_000 },
      { category: "items", direction: "income", amount: 14_000_000 },
      { category: "points", direction: "income", amount: 6_000_000 },
      { category: "rehab", direction: "expense", amount: 500_000 },
      { category: "city_bank", direction: "neutral", amount: 8_000_000 },
    ];
    const b = buildCashReceivedBreakdown(events);
    expect(b.earned.total + b.assetSales.total + b.other.total).toBe(b.total);
    expect(b.total).toBe(158_000_000);
    expect(b.earned.total).toBe(38_000_000);
    expect(b.assetSales.total).toBe(120_000_000);
    expect(b.earned.ocPayouts).toBe(12_000_000);
  });

  it("matches aggregateMoneySemantics.cashInflow exactly (no double counting)", () => {
    const events: E[] = [
      { occurredAt: 100, category: "crime", direction: "income", amount: 3_000 },
      { occurredAt: 100, category: "bazaar", direction: "income", amount: 4_000 },
      { occurredAt: 100, category: "missions", direction: "income", amount: 2_000 },
      { occurredAt: 100, category: "mugging", direction: "income", amount: 1_000 },
    ];
    const b = buildCashReceivedBreakdown(events);
    const sem = aggregateMoneySemantics(events, 0, 200);
    expect(b.total).toBe(sem.cashInflow);
  });

  it("lists OC payouts inside earned income with their own labeled row", () => {
    const b = buildCashReceivedBreakdown([{ category: "faction", direction: "income", amount: 7_000, ocPayout: true }]);
    expect(b.earned.ocPayouts).toBe(7_000);
    expect(b.earned.rows.map((r) => r.key)).toContain("oc_payout");
    expect(b.earned.rows.find((r) => r.key === "oc_payout")?.label).toContain("OC payouts");
  });

  it("gives item sales an explicit label — never a bare 'Items'", () => {
    expect(CASH_INCOME_LABELS["items"]).toBe("Item Market sales");
    const b = buildCashReceivedBreakdown([{ category: "items", direction: "income", amount: 14_000_000 }]);
    expect(b.assetSales.rows[0]!.label).toBe("Item Market sales");
    // The row must NOT be in earned income: selling items is not earnings.
    expect(b.earned.rows).toHaveLength(0);
  });

  it("keeps item REWARDS out of cash received entirely (they are not cash)", () => {
    // Crime/OC item rewards are non-cash gains: no income money event exists
    // for them, so they never appear in any cash-received bucket. An expense
    // or neutral row must not leak in either.
    const b = buildCashReceivedBreakdown([
      { category: "items", direction: "expense", amount: 5_000 },
      { category: "other", direction: "neutral", amount: 9_000 },
    ]);
    expect(b.total).toBe(0);
    expect(b.earned.total).toBe(0);
    expect(b.assetSales.total).toBe(0);
  });

  it("skips zero-amount rows and unknown-direction rows (reported, not folded in)", () => {
    const b = buildCashReceivedBreakdown([
      { category: "crime", direction: "income", amount: 0 },
      { category: "crime", direction: "unknown", amount: 5_000 },
    ]);
    expect(b.total).toBe(0);
    expect(b.unclassified.count).toBe(0);
  });
});

describe("buildCashSpentBreakdown", () => {
  it("reconciles expenses + asset purchases + other exactly to total", () => {
    const b = buildCashSpentBreakdown([
      { category: "rehab", direction: "expense", amount: 500_000 },
      { category: "housing", direction: "expense", amount: 250_000 },
      { category: "bazaar", direction: "expense", amount: 10_000_000 },
      { category: "points", direction: "expense", amount: 2_000_000 },
      { category: "salary", direction: "income", amount: 99_000_000 },
    ]);
    expect(b.expenses.total + b.assetPurchases.total + b.other.total).toBe(b.total);
    expect(b.total).toBe(12_750_000);
    expect(b.assetPurchases.total).toBe(12_000_000);
    expect(b.expenses.total).toBe(750_000);
  });
});
