import { describe, expect, it } from "vitest";
import { classifyMoneySemantics, aggregateMoneySemantics } from "../src/money.js";

/**
 * Economic semantics: cash inflow is not automatically income and cash
 * outflow is not automatically an economic loss. Asset conversions
 * (items/points/stocks/bank) must be separated from true income/expense.
 */

const ev = (category: string, direction: "income" | "expense", amount: number, description?: string) => ({
  id: `${category}-${direction}-${description ?? ""}`,
  occurredAt: 1_792_000_000,
  category,
  direction: direction as never,
  amount: direction === "income" ? amount : -amount,
  description,
});

describe("classifyMoneySemantics", () => {
  it("bazaar/item sales are asset conversions, not income", () => {
    expect(classifyMoneySemantics({ category: "bazaar", direction: "income" })).toBe("asset_in");
    expect(classifyMoneySemantics({ category: "items", direction: "income" })).toBe("asset_in");
    expect(classifyMoneySemantics({ category: "trading", direction: "income" })).toBe("asset_in");
  });

  it("buying points/items is an asset purchase, not an economic loss", () => {
    expect(classifyMoneySemantics({ category: "points", direction: "expense" })).toBe("asset_out");
    expect(classifyMoneySemantics({ category: "bazaar", direction: "expense" })).toBe("asset_out");
    expect(classifyMoneySemantics({ category: "stock", direction: "expense" })).toBe("asset_out");
    expect(classifyMoneySemantics({ category: "travel", direction: "expense" })).toBe("asset_out");
    expect(classifyMoneySemantics({ category: "drugs", direction: "expense" })).toBe("asset_out");
  });

  it("salary, payouts, crime cash are true income; mugged money is a true expense", () => {
    expect(classifyMoneySemantics({ category: "salary", direction: "income" })).toBe("true_income");
    expect(classifyMoneySemantics({ category: "faction", direction: "income" })).toBe("true_income");
    expect(classifyMoneySemantics({ category: "crime", direction: "income" })).toBe("true_income");
    expect(classifyMoneySemantics({ category: "mugging", direction: "expense" })).toBe("true_expense");
  });

  it("rehab, education, housing are true expenses", () => {
    expect(classifyMoneySemantics({ category: "rehab", direction: "expense" })).toBe("true_expense");
    expect(classifyMoneySemantics({ category: "education", direction: "expense" })).toBe("true_expense");
    expect(classifyMoneySemantics({ category: "housing", direction: "expense" })).toBe("true_expense");
  });

  it("item-derived cash refines to a sale; transfers stay true cash flow", () => {
    expect(classifyMoneySemantics({ category: "other", direction: "income", description: "Item use stash box" })).toBe("asset_in");
    expect(classifyMoneySemantics({ category: "other", direction: "income", description: "Money receive" })).toBe("true_income");
    expect(classifyMoneySemantics({ category: "other", direction: "expense", description: "Money send" })).toBe("true_expense");
  });

  it("bank rows are conversions, and neutral/unknown directions classify as unknown", () => {
    expect(classifyMoneySemantics({ category: "city_bank", direction: "income" })).toBe("asset_in");
    expect(classifyMoneySemantics({ category: "city_bank", direction: "neutral" })).toBe("unknown");
  });
});

describe("aggregateMoneySemantics", () => {
  it("splits inflow into earned vs asset sales, outflow into true expenses vs asset purchases", () => {
    const agg = aggregateMoneySemantics(
      [
        ev("bazaar", "income", 60_000_000), // asset sale
        ev("salary", "income", 10_000_000), // earned
        ev("rehab", "expense", 1_000_000), // true expense
        ev("points", "expense", 20_000_000), // asset purchase
      ],
      0,
      2_000_000_000
    );
    expect(agg.cashInflow).toBe(70_000_000);
    expect(agg.cashOutflow).toBe(21_000_000);
    expect(agg.trueIncome).toBe(10_000_000);
    expect(agg.trueExpense).toBe(1_000_000);
    expect(agg.assetInflow).toBe(60_000_000);
    expect(agg.assetOutflow).toBe(20_000_000);
  });

  it("bazaar 60m cash with 65m inventory value is NOT 60m profit — sales are separated", () => {
    const agg = aggregateMoneySemantics([ev("bazaar", "income", 60_000_000)], 0, 2_000_000_000);
    expect(agg.cashInflow).toBe(60_000_000);
    expect(agg.trueIncome).toBe(0); // nothing earned
    expect(agg.assetInflow).toBe(60_000_000); // conversion
  });
});

describe("bank transfers vs unclassified", () => {
  it("neutral bank rows are reported as transfers, never as unclassified", () => {
    const agg = aggregateMoneySemantics(
      [
        { id: "a", occurredAt: 1_792_000_000, category: "city_bank", direction: "neutral" as never, amount: -344_000_000 },
        { id: "b", occurredAt: 1_792_000_000, category: "city_bank", direction: "neutral" as never, amount: 285_000_000 },
      ],
      0,
      2_000_000_000
    );
    expect(agg.bankTransfers).toBe(629_000_000);
    expect(agg.unknownValue).toBe(0);
    expect(agg.cashInflow).toBe(0);
    expect(agg.cashOutflow).toBe(0);
  });
});
