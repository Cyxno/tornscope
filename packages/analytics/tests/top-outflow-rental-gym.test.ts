import { describe, expect, it } from "vitest";
import { aggregateMoneyEvents, aggregateMoneySemantics, buildCashSpentBreakdown, classifyMoneySemantics } from "../src/money.js";

/**
 * Regression for the 2026-09-08 top-outflow misclassification.
 *
 * Real movements inside one 15-minute window (Torn logs 18:03–18:05):
 *   - Private Island rental extension accepted .... -$17,000,000 (housing)
 *   - Gym membership purchase (Gun Shop) .......... -$10,000,000 (gym)
 *   - 10x Xanax from a bazaar ..................... -$8,447,000  (bazaar)
 *
 * The ledger previously only held the bazaar row, so "Top cash outflow"
 * showed Bazaar Purchases ≈ $8.45m. With the three rows present the top
 * outflow must be the $17m rent payment — while the bazaar buy keeps its
 * asset-conversion semantics (cash → inventory, NOT an economic expense).
 */

// 2026-09-08 18:03–18:08 UTC, in order.
const RENT_EXTENSION_TS = 1_788_890_634; // 18:03:54
const GYM_TS = 1_788_890_640; // 18:04:00
const BAZAAR_TS = 1_788_890_751; // 18:05:51

const incidentEvents = [
  { id: "rent", occurredAt: RENT_EXTENSION_TS, category: "housing", subcategory: "Property rental market extension accept renter", direction: "expense" as const, amount: -17_000_000 },
  { id: "gym", occurredAt: GYM_TS, category: "gym", subcategory: "Gym purchase", direction: "expense" as const, amount: -10_000_000 },
  { id: "bazaar", occurredAt: BAZAAR_TS, category: "bazaar", subcategory: "Bazaar buy", direction: "expense" as const, amount: -8_447_000 },
];

const FROM = 1_788_864_000; // 2026-09-08 00:00:00 UTC
const TO = 1_788_950_400; // 2026-09-09 00:00:00 UTC

describe("top cash outflow over the incident window", () => {
  it("ranks the $17m rental extension above the $10m gym fee and the $8.447m bazaar buy", () => {
    const agg = aggregateMoneyEvents(incidentEvents, FROM, TO);
    expect(agg.largestExpenseCategory).toEqual({ category: "housing", total: 17_000_000 });
    expect(agg.expensesByCategory).toEqual([
      { category: "housing", total: 17_000_000 },
      { category: "gym", total: 10_000_000 },
      { category: "bazaar", total: 8_447_000 },
    ]);
    expect(agg.totalExpenses).toBe(35_447_000);
  });

  it("counts the gym membership as a $10m outgoing cash movement", () => {
    const agg = aggregateMoneyEvents(incidentEvents, FROM, TO);
    const gym = agg.expensesByCategory.find((c) => c.category === "gym");
    expect(gym?.total).toBe(10_000_000);
  });
});

describe("economic semantics of the three movements", () => {
  it("rent extension and gym fee are true expenses; the bazaar buy stays an asset conversion", () => {
    expect(classifyMoneySemantics({ category: "housing", direction: "expense" })).toBe("true_expense");
    expect(classifyMoneySemantics({ category: "gym", direction: "expense" })).toBe("true_expense");
    expect(classifyMoneySemantics({ category: "bazaar", direction: "expense" })).toBe("asset_out");
  });

  it("splits true expense (27m) from asset purchase (8.447m) — never merged", () => {
    const agg = aggregateMoneySemantics(incidentEvents, FROM, TO);
    expect(agg.cashOutflow).toBe(35_447_000);
    expect(agg.trueExpense).toBe(27_000_000);
    expect(agg.assetOutflow).toBe(8_447_000);
  });

  it("cash-spent breakdown files gym under expenses and bazaar under asset purchases", () => {
    const breakdown = buildCashSpentBreakdown(incidentEvents);
    expect(breakdown.expenses.rows.map((r) => r.key)).toEqual(["housing", "gym"]);
    expect(breakdown.assetPurchases.rows.map((r) => r.key)).toEqual(["bazaar"]);
  });
});
