import { describe, expect, it } from "vitest";
import { MONEY_CATEGORIES, type MoneyCategory } from "@tornscope/shared";
import { aggregateMoneyEvents, aggregateMoneySemantics, buildCashReceivedBreakdown } from "../src/money.js";

/**
 * Overview / Economy single-source-of-truth guarantee: both pages render
 * totals from aggregateMoneyEvents (P&L flow) and aggregateMoneySemantics
 * (cash received/spent). Their received/spent totals must be IDENTICAL for
 * any event set drawn from the canonical category universe — never two
 * divergent definitions of "cash received".
 */
describe("Overview / Economy semantic equivalence", () => {
  it("aggregateMoneyEvents totals equal aggregateMoneySemantics for the whole category universe", () => {
    const events = MONEY_CATEGORIES.map((category: MoneyCategory, i: number) => ({
      id: `e${i}`,
      occurredAt: 1_000 + i,
      category,
      direction: i % 2 === 0 ? ("income" as const) : ("expense" as const),
      amount: i % 2 === 0 ? 1_000 + i : -(2_000 + i),
    }));
    const flow = aggregateMoneyEvents(events, 0, 5_000);
    const sem = aggregateMoneySemantics(events, 0, 5_000);
    expect(flow.totalIncome).toBe(sem.cashInflow);
    expect(flow.totalExpenses).toBe(sem.cashOutflow);
  });

  it("cash received breakdown stays consistent with cashInflow on mixed real-world shapes", () => {
    const events = [
      { occurredAt: 100, category: "salary" as const, direction: "income" as const, amount: 5_000 },
      { occurredAt: 101, category: "bazaar" as const, direction: "income" as const, amount: 7_000 },
      { occurredAt: 102, category: "rehab" as const, direction: "expense" as const, amount: -900 },
      { occurredAt: 103, category: "city_bank" as const, direction: "neutral" as const, amount: 4_000 },
    ];
    const flow = aggregateMoneyEvents(events, 0, 200);
    const sem = aggregateMoneySemantics(events, 0, 200);
    const breakdown = buildCashReceivedBreakdown(events);
    expect(flow.totalIncome).toBe(sem.cashInflow);
    expect(breakdown.total).toBe(sem.cashInflow);
  });
});
