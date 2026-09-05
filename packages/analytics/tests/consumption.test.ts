import { describe, expect, it } from "vitest";
import { aggregateConsumption, aggregateMoneyEvents, calculateDrugStats, type ConsumptionEventLike } from "../src/index.js";

const DAY = 86_400;
const T0 = Date.UTC(2026, 8, 1) / 1000;
const XANAX = 206;
const EDVD = 470;

describe("aggregateConsumption", () => {
  it("sums consumed value by category and separates unknown-value uses", () => {
    const events: ConsumptionEventLike[] = [
      { occurredAt: T0, category: "drug", quantity: 1, totalValue: 840_000, valuationMethod: "catalog_market_price" },
      { occurredAt: T0 + 3600, category: "drug", quantity: 1, totalValue: 840_000, valuationMethod: "catalog_market_price" },
      { occurredAt: T0 + 7200, category: "happy_jump", quantity: 1, totalValue: 2_500_000, valuationMethod: "catalog_market_price" },
      { occurredAt: T0 + 10_800, category: "booster", quantity: 1, totalValue: null, valuationMethod: "unknown" },
    ];
    const agg = aggregateConsumption(events, T0, T0 + DAY);
    expect(agg.uses).toBe(4);
    expect(agg.totalValue).toBe(4_180_000);
    expect(agg.valueKnownCount).toBe(3);
    expect(agg.valueUnknownCount).toBe(1);
    const drug = agg.byCategory.find((c) => c.category === "drug")!;
    expect(drug.totalValue).toBe(1_680_000);
    expect(drug.uses).toBe(2);
    const booster = agg.byCategory.find((c) => c.category === "booster")!;
    expect(booster.totalValue).toBeNull();
    expect(booster.valueUnknownCount).toBe(1);
  });

  it("respects the [from, to] window", () => {
    const events: ConsumptionEventLike[] = [
      { occurredAt: T0 - DAY, category: "drug", quantity: 1, totalValue: 840_000 },
      { occurredAt: T0, category: "drug", quantity: 1, totalValue: 840_000 },
    ];
    const agg = aggregateConsumption(events, T0, T0 + DAY);
    expect(agg.uses).toBe(1);
    expect(agg.totalValue).toBe(840_000);
  });

  it("returns zeros with no events (a confirmed zero, not unavailable)", () => {
    const agg = aggregateConsumption([], T0, T0 + DAY);
    expect(agg.uses).toBe(0);
    expect(agg.totalValue).toBe(0);
  });
});

describe("no double counting: Xanax purchase then use", () => {
  const purchase = { id: "m1", occurredAt: T0, category: "items", direction: "expense" as const, amount: -840_000 };
  const useConsumption: ConsumptionEventLike = { occurredAt: T0 + 3 * 3600, category: "drug", quantity: 1, totalValue: 840_000, valuationMethod: "catalog_market_price" };

  it("cash flow counts the purchase once; the use adds no cash movement", () => {
    const agg = aggregateMoneyEvents([purchase], T0, T0 + DAY, "day");
    expect(agg.totalExpenses).toBe(840_000);
    expect(agg.totalIncome).toBe(0);
    expect(agg.netProfit).toBe(-840_000);
  });

  it("consumption is reported separately and never added to the cash aggregate", () => {
    const cash = aggregateMoneyEvents([purchase], T0, T0 + DAY, "day");
    const consumption = aggregateConsumption([useConsumption], T0, T0 + DAY);
    // The same 840k appears in both concepts, but they are separate totals:
    // net cash flow stays -840k (not -1.68m) and consumed value is 840k.
    expect(cash.netProfit).toBe(-840_000);
    expect(consumption.totalValue).toBe(840_000);
  });
});

describe("no double counting: EDVD purchase then use", () => {
  const purchase = { id: "m2", occurredAt: T0, category: "items", direction: "expense" as const, amount: -2_500_000 };
  const useConsumption: ConsumptionEventLike = { occurredAt: T0 + 6 * 3600, category: "happy_jump", quantity: 1, totalValue: 2_500_000, valuationMethod: "catalog_market_price" };

  it("purchase is cash expense, use is consumption with zero cash flow", () => {
    const cash = aggregateMoneyEvents([purchase], T0, T0 + DAY, "day");
    const consumption = aggregateConsumption([useConsumption], T0, T0 + DAY);
    expect(cash.netProfit).toBe(-2_500_000);
    expect(consumption.totalValue).toBe(2_500_000);
    expect(consumption.byCategory[0]!.category).toBe("happy_jump");
  });
});

describe("Drugs page and Economy consumption agree", () => {
  it("drug usage cost equals consumption value for the same period and prices", () => {
    const prices = new Map<number, number>([[XANAX, 840_000], [EDVD, 2_500_000]]);
    const drugEvents = [
      { occurredAt: T0, drugItemId: XANAX, drugName: "Xanax", outcome: "success" as const },
      { occurredAt: T0 + 3600, drugItemId: XANAX, drugName: "Xanax", outcome: "overdose" as const },
      { occurredAt: T0 + 7200, drugItemId: 493, drugName: "Ecstasy", outcome: "success" as const },
    ];
    // Missing Ecstasy price in the map: the Drugs page excludes it from spend,
    // and the equivalent consumption event carries null value.
    const drugs = calculateDrugStats(drugEvents, prices, T0, T0 + DAY, "day");
    const consumptionEvents: ConsumptionEventLike[] = [
      { occurredAt: T0, category: "drug", quantity: 1, totalValue: 840_000 },
      { occurredAt: T0 + 3600, category: "drug", quantity: 1, totalValue: 840_000 },
      { occurredAt: T0 + 7200, category: "drug", quantity: 1, totalValue: null },
    ];
    const consumption = aggregateConsumption(consumptionEvents, T0, T0 + DAY);
    expect(drugs.estimatedSpend).toBe(1_680_000);
    expect(consumption.totalValue).toBe(1_680_000);
    const drugRow = consumption.byCategory.find((c) => c.category === "drug")!;
    expect(drugRow.totalValue).toBe(drugs.estimatedSpend);
    // Both count the unpriced use as excluded from value, not from uses.
    expect(drugRow.valueUnknownCount).toBe(1);
    expect(consumption.valueUnknownCount).toBe(1);
  });
});
