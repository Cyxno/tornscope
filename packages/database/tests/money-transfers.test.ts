import { describe, expect, it } from "vitest";
import { normalizeLogEntry, type MoneyEventInput } from "../src/index.js";
import { aggregateMoneyEvents } from "@tornscope/analytics";
import type { TornUserLog } from "@tornscope/torn-api";

/**
 * Money-transfer correctness: bank deposits/withdrawals and faction pool
 * movements are transfers (direction "neutral") and must never inflate
 * income or spending — neither at normalization time nor in aggregation.
 */

function moneyLog(id: number, title: string, category: string, amount: number): TornUserLog {
  return {
    id,
    timestamp: 1_792_000_000 + id,
    details: { id, title, category },
    data: { amount },
    params: {},
  } as unknown as TornUserLog;
}

const ctx = { itemNameById: new Map<number, string>() };

function moneyOf(log: TornUserLog): MoneyEventInput {
  const writes = normalizeLogEntry(log, ctx);
  expect(writes.moneyEvents).toHaveLength(1);
  return writes.moneyEvents[0]!;
}

describe("money transfer normalization", () => {
  it("treats a city bank deposit as a neutral transfer with a negative ledger amount", () => {
    const m = moneyOf(moneyLog(1, "Deposited money in the city bank", "Money", 450_000_000));
    expect(m.category).toBe("city_bank");
    expect(m.direction).toBe("neutral");
    expect(m.amount).toBe(-450_000_000n);
  });

  it("treats a bank withdrawal as a neutral transfer (not income)", () => {
    const m = moneyOf(moneyLog(2, "Withdrew money from the city bank", "Money", 100_000_000));
    expect(m.category).toBe("city_bank");
    expect(m.direction).toBe("neutral");
    expect(m.amount).toBe(100_000_000n);
  });

  it("treats a bank investment as a neutral transfer", () => {
    const m = moneyOf(moneyLog(3, "Invested money in the city bank", "Money", 250_000_000));
    expect(m.direction).toBe("neutral");
    expect(m.amount).toBe(-250_000_000n);
  });

  it("treats faction pool deposits/withdrawals as neutral transfers", () => {
    const deposit = moneyOf(moneyLog(4, "Deposited money in the faction vault", "Money", 5_000_000));
    expect(deposit.direction).toBe("neutral");
    const withdrawal = moneyOf(moneyLog(5, "Withdrew money from the faction vault", "Money", 2_000_000));
    expect(withdrawal.direction).toBe("neutral");
  });

  it("still counts a mugging as income", () => {
    const m = moneyOf(moneyLog(6, "Mugged someone", "Muggings", 25_000));
    expect(m.direction).toBe("income");
    expect(m.category).toBe("mugging");
  });

  it("still counts a purchase as an expense", () => {
    const m = moneyOf(moneyLog(7, "Bought item at the bazaar", "Bazaar", 1_200));
    expect(m.direction).toBe("expense");
  });

  it("aggregateMoneyEvents excludes neutral transfers from income and expenses", () => {
    const events = [
      { id: "a", occurredAt: 100, category: "mugging", direction: "income" as const, amount: 50_000 },
      { id: "b", occurredAt: 110, category: "bazaar", direction: "expense" as const, amount: -1_200 },
      // Bank deposit back to the player's own account — not income:
      { id: "c", occurredAt: 120, category: "city_bank", direction: "neutral" as const, amount: 100_000_000 },
      // Faction withdrawal — not income either:
      { id: "d", occurredAt: 130, category: "faction", direction: "neutral" as const, amount: 2_000_000 },
    ];
    const agg = aggregateMoneyEvents(events, 0, 1_000);
    expect(agg.totalIncome).toBe(50_000);
    expect(agg.totalExpenses).toBe(1_200);
    expect(agg.netProfit).toBe(48_800);
  });
});

describe("money direction fixes", () => {
  it("counts 'Money receive' as income and 'Money send' as expense", () => {
    const recv = moneyOf(moneyLog(20, "Money receive", "Money", 500_000));
    expect(recv.direction).toBe("income");
    expect(recv.amount).toBe(500_000n);
    const sent = moneyOf(moneyLog(21, "Money send", "Money", 250_000));
    expect(sent.direction).toBe("expense");
    expect(sent.amount).toBe(-250_000n);
  });

  it("counts 'Bank withdraw' as a neutral transfer with a positive amount", () => {
    const m = moneyOf(moneyLog(22, "Bank withdraw", "Money", 150_000_000));
    expect(m.category).toBe("city_bank");
    expect(m.direction).toBe("neutral");
    expect(m.amount).toBe(150_000_000n);
  });
});
