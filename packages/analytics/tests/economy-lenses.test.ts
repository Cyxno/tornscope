import { describe, expect, it } from "vitest";
import {
  aggregateConversions,
  aggregateMoneySemantics,
  classifyMoneySemantics,
  deriveBankInterest,
  explainedRatio,
  majorMoneyMovements,
  MAX_PLAUSIBLE_INTEREST_RATIO,
  type MoneyEventLike,
} from "../src/money.js";

const T0 = 1_700_000_000;

function ev(overrides: Partial<MoneyEventLike> & { id: string; amount: number }): MoneyEventLike {
  return {
    occurredAt: T0,
    category: "other",
    direction: overrides.amount >= 0 ? "income" : "expense",
    description: null,
    ...overrides,
  };
}

/* ----------------------- canonical classification (Phases 3-9) -------------- */

describe("canonical economy semantics", () => {
  it("bazaar sale = cash inflow + asset conversion, never automatic profit", () => {
    const sale = ev({ id: "a", category: "bazaar", direction: "income", amount: 8_400_000 });
    expect(classifyMoneySemantics(sale)).toBe("asset_in");
    const sem = aggregateMoneySemantics([sale], T0 - 10, T0 + 10);
    expect(sem.cashInflow).toBe(8_400_000);
    expect(sem.trueIncome).toBe(0); // no profit is fabricated
    expect(sem.assetInflow).toBe(8_400_000);
  });

  it("item purchase = conversion, not automatic expense", () => {
    const buy = ev({ id: "a", category: "items", direction: "expense", amount: -5_000_000 });
    const sem = aggregateMoneySemantics([buy], T0 - 10, T0 + 10);
    expect(sem.cashOutflow).toBe(5_000_000);
    expect(sem.trueExpense).toBe(0);
    expect(sem.assetOutflow).toBe(5_000_000);
  });

  it("stock purchase = conversion", () => {
    expect(classifyMoneySemantics(ev({ id: "a", category: "stock", direction: "expense", amount: -384_000 }))).toBe("asset_out");
  });

  it("gym purchase = true expense", () => {
    expect(classifyMoneySemantics(ev({ id: "a", category: "gym", direction: "expense", amount: -10_000_000 }))).toBe("true_expense");
  });

  it("property rent = true expense (correct sign already applied at ingest)", () => {
    const rent = ev({ id: "a", category: "housing", direction: "expense", amount: -17_000_000, description: "Property rental market extension accept renter" });
    expect(classifyMoneySemantics(rent)).toBe("true_expense");
    const sem = aggregateMoneySemantics([rent], T0 - 10, T0 + 10);
    expect(sem.trueExpense).toBe(17_000_000);
  });

  it("stock dividend = true income, not a conversion (regression: was 'unknown')", () => {
    const dividend = ev({ id: "a", category: "stock", direction: "income", amount: 45_000, description: "Stock dividend" });
    expect(classifyMoneySemantics(dividend)).toBe("true_income");
    const sem = aggregateMoneySemantics([dividend], T0 - 10, T0 + 10);
    expect(sem.trueIncome).toBe(45_000);
    expect(sem.cashInflow).toBe(45_000);
    expect(sem.assetInflow).toBe(0); // not a sale
  });

  it("loan interest paid = true expense", () => {
    expect(classifyMoneySemantics(ev({ id: "a", category: "other", direction: "expense", amount: -900, description: "Loan interest" }))).toBe("true_expense");
  });

  it("faction transfer (neutral) is never fabricated income", () => {
    const transfer = ev({ id: "a", category: "faction", direction: "neutral", amount: -800_000 });
    const sem = aggregateMoneySemantics([transfer], T0 - 10, T0 + 10);
    expect(sem.trueIncome).toBe(0);
    expect(sem.cashInflow).toBe(0);
    expect(sem.bankTransfers).toBe(800_000);
  });

  it("unknown direction stays out of every P&L figure", () => {
    const row = ev({ id: "a", category: "other", direction: "unknown", amount: 5_000 });
    const sem = aggregateMoneySemantics([row], T0 - 10, T0 + 10);
    expect(sem.cashInflow).toBe(0);
    expect(sem.unknownValue).toBe(5_000);
  });
});

/* --------------------------- bank interest (Phase 6) ----------------------- */

describe("deriveBankInterest — principal vs interest", () => {
  it("bank deposit = conversion: neutral rows never become income", () => {
    const bank = deriveBankInterest([ev({ id: "a", category: "city_bank", direction: "neutral", amount: -148_000_000 })], T0 - 10, T0 + 10);
    expect(bank.interestIncome).toBe(0);
    expect(bank.principalStillInvested).toBe(148_000_000);
    expect(bank.complete).toBe(true);
  });

  it("bank withdrawal = conversion: matched maturity yields interest as the delta only", () => {
    // 148m invested, 151.552m returned → interest = 3.552m (real fixture shape).
    const bank = deriveBankInterest(
      [
        ev({ id: "a", category: "city_bank", direction: "neutral", amount: -148_000_000, occurredAt: T0 }),
        ev({ id: "b", category: "city_bank", direction: "neutral", amount: 151_552_000, occurredAt: T0 + 86_400 }),
      ],
      T0 - 10,
      T0 + 90_000
    );
    expect(bank.interestIncome).toBe(3_552_000);
    expect(bank.principalReturned).toBe(148_000_000);
    expect(bank.complete).toBe(true);
  });

  it("principal return alone is never income (withdrawal ≤ pool)", () => {
    const bank = deriveBankInterest(
      [
        ev({ id: "a", category: "city_bank", direction: "neutral", amount: -100_000, occurredAt: T0 }),
        ev({ id: "b", category: "city_bank", direction: "neutral", amount: 100_000, occurredAt: T0 + 60 }),
      ],
      T0 - 10,
      T0 + 120
    );
    expect(bank.interestIncome).toBe(0);
    expect(bank.principalReturned).toBe(100_000);
  });

  it("withdrawal beyond plausible yield → unattributable (principal predates history), never income", () => {
    const bank = deriveBankInterest(
      [
        ev({ id: "a", category: "city_bank", direction: "neutral", amount: -100_000, occurredAt: T0 }),
        ev({ id: "b", category: "city_bank", direction: "neutral", amount: 10_000_000, occurredAt: T0 + 60 }),
      ],
      T0 - 10,
      T0 + 120
    );
    expect(bank.interestIncome).toBe(0);
    // Only the surplus over recorded principal is unattributable; the
    // matched 100k still counts as returned principal.
    expect(bank.unattributableWithdrawals).toBe(9_900_000);
    expect(bank.principalReturned).toBe(100_000);
    expect(bank.complete).toBe(false);
  });

  it("withdrawal within plausible yield is interest; pools are tracked per bank", () => {
    const excess = Math.round(100_000 * (MAX_PLAUSIBLE_INTEREST_RATIO - 0.01));
    const city = deriveBankInterest(
      [
        ev({ id: "a", category: "city_bank", direction: "neutral", amount: -100_000, occurredAt: T0 }),
        ev({ id: "b", category: "city_bank", direction: "neutral", amount: 100_000 + excess, occurredAt: T0 + 60 }),
      ],
      T0 - 10,
      T0 + 120
    );
    expect(city.interestIncome).toBe(excess);
    // Cayman rows are a separate pool — no cross-bank attribution.
    const cayman = deriveBankInterest(
      [ev({ id: "c", category: "cayman_bank", direction: "neutral", amount: 100_000 + excess, occurredAt: T0 + 60 })],
      T0 - 10,
      T0 + 120
    );
    expect(cayman.interestIncome).toBe(0);
    expect(cayman.unattributableWithdrawals).toBe(100_000 + excess);
  });

  it("multiple sequential terms accumulate interest", () => {
    const bank = deriveBankInterest(
      [
        ev({ id: "a", category: "piggy_bank", direction: "neutral", amount: -50_000, occurredAt: T0 }),
        ev({ id: "b", category: "piggy_bank", direction: "neutral", amount: 50_000, occurredAt: T0 + 60 }),
        ev({ id: "c", category: "piggy_bank", direction: "neutral", amount: -80_000, occurredAt: T0 + 120 }),
        ev({ id: "d", category: "piggy_bank", direction: "neutral", amount: 82_000, occurredAt: T0 + 180 }),
      ],
      T0 - 10,
      T0 + 240
    );
    expect(bank.interestIncome).toBe(2_000);
  });
});

/* --------------------------- conversions (Phase 24) ------------------------ */

describe("aggregateConversions", () => {
  it("classifies bank, vault, stocks, points and item pairs by direction", () => {
    const rows: MoneyEventLike[] = [
      ev({ id: "1", category: "city_bank", direction: "neutral", amount: -500_000 }),
      ev({ id: "2", category: "city_bank", direction: "neutral", amount: 521_000 }),
      ev({ id: "3", category: "faction", direction: "neutral", amount: -800_000 }),
      ev({ id: "4", category: "stock", direction: "expense", amount: -1_500_000 }),
      ev({ id: "5", category: "bazaar", direction: "income", amount: 2_400_000 }),
      ev({ id: "6", category: "points", direction: "expense", amount: -45_000 }),
    ];
    const conv = aggregateConversions(rows, T0 - 10, T0 + 10);
    expect(conv.cashIntoAssets).toBe(500_000 + 800_000 + 1_500_000 + 45_000);
    expect(conv.assetsIntoCash).toBe(521_000 + 2_400_000);
    expect(conv.netCashEffect).toBe(conv.assetsIntoCash - conv.cashIntoAssets);
    expect(conv.bankTransfers).toBe(500_000 + 521_000);
    const pairs = Object.fromEntries(conv.byPair.map((p) => [p.pair, p.amount]));
    expect(pairs["cash->bank"]).toBe(500_000);
    expect(pairs["bank->cash"]).toBe(521_000);
    expect(pairs["cash->faction"]).toBe(800_000);
    expect(pairs["cash->stocks"]).toBe(1_500_000);
    expect(pairs["items->cash"]).toBe(2_400_000);
    expect(pairs["cash->points"]).toBe(45_000);
  });

  it("never counts earned income or true expenses as conversions", () => {
    const rows: MoneyEventLike[] = [
      ev({ id: "1", category: "salary", direction: "income", amount: 365_000 }),
      ev({ id: "2", category: "gym", direction: "expense", amount: -75_000 }),
      ev({ id: "3", category: "stock", direction: "income", amount: 45_000, description: "Stock dividend" }),
    ];
    const conv = aggregateConversions(rows, T0 - 10, T0 + 10);
    expect(conv.byPair).toHaveLength(0);
    expect(conv.cashIntoAssets).toBe(0);
    expect(conv.assetsIntoCash).toBe(0);
  });
});

/* ------------------- major movements detection (Phase 19) ------------------ */

describe("majorMoneyMovements", () => {
  const busy: MoneyEventLike[] = [
    ev({ id: "small1", category: "casino", direction: "income", amount: 5_000, occurredAt: T0 }),
    ev({ id: "big-out", category: "stock", direction: "expense", amount: -9_000_000, occurredAt: T0 + 2 }),
    ev({ id: "big-in", category: "crime", direction: "income", amount: 12_000_000, occurredAt: T0 + 1 }),
    ev({ id: "conv", category: "city_bank", direction: "neutral", amount: -8_400_000, occurredAt: T0 + 3 }),
    ev({ id: "tiny", category: "bazaar", direction: "income", amount: 900, occurredAt: T0 + 4 }),
    ev({ id: "unknown", category: "other", direction: "unknown", amount: 50_000_000, occurredAt: T0 + 5 }),
  ];

  it("orders by magnitude, adaptive floor suppresses noise, unknown rows excluded", () => {
    const major = majorMoneyMovements(busy, T0 - 10, T0 + 20, { limit: 8 });
    expect(major.map((m) => m.id)).toEqual(["big-in", "big-out", "conv"]);
    expect(major[0]).toMatchObject({ role: "income", amount: 12_000_000 });
    expect(major[1]).toMatchObject({ role: "conversion_out", amount: 9_000_000 });
    expect(major[2]).toMatchObject({ role: "transfer", amount: 8_400_000 });
  });

  it("is deterministic: ties break by time then id", () => {
    const tied: MoneyEventLike[] = [
      ev({ id: "b", category: "crime", direction: "income", amount: 1_000_000, occurredAt: T0 + 1 }),
      ev({ id: "a", category: "crime", direction: "income", amount: 1_000_000, occurredAt: T0 + 1 }),
    ];
    expect(majorMoneyMovements(tied, T0 - 10, T0 + 20).map((m) => m.id)).toEqual(["a", "b"]);
  });
});

/* ---------------- reconciliation quality helpers (Phases 10-11) ------------ */

describe("explainedRatio", () => {
  it("full explanation = 1; partial residual scales down", () => {
    expect(explainedRatio(0, 100, 160)).toBe(1);
    expect(explainedRatio(-0.4, 100, 160)).toBeCloseTo(1 - 0.4 / 60);
  });

  it("zero change with exact match = 1; zero change with residual = null (meaningless)", () => {
    expect(explainedRatio(0, 100, 100)).toBe(1);
    expect(explainedRatio(500, 100, 100)).toBeNull();
  });

  it("missing anchors → null", () => {
    expect(explainedRatio(null, null, 100)).toBeNull();
  });
});
