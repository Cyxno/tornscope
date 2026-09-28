import { describe, expect, it } from "vitest";
import { buildFinancialRecords, buildWealthAttribution, buildWealthProjection, buildWealthVelocity, type EconomyIntelligenceInputs } from "../src/economy-intelligence.js";
import type { MoneyEventLike } from "../src/money.js";
import type { NetworthSnapshotFields } from "../src/networth.js";
import type { TravelTripLike } from "../src/travel.js";

const DAY = 86_400;
const NOW = 1_750_000_000;

function nw(total: number, capturedAt: number, wallet = 0): NetworthSnapshotFields {
  return {
    capturedAt, total, wallet, pending: 0, vault: 0, bookie: 0, cityBank: 0, caymanBank: 0, piggyBank: 0,
    inventory: 0, displayCase: 0, bazaar: 0, trades: 0, itemMarket: 0, auctionHouse: 0, enlistedCars: 0,
    property: 0, stockMarket: 0, company: 0, points: 0,
  };
}

function money(occurredAt: number, amount: number, category: string, direction: "income" | "expense" | "neutral"): MoneyEventLike {
  return { id: `m:${occurredAt}:${amount}:${category}:${direction}`, occurredAt, category, direction, amount };
}

describe("buildWealthVelocity", () => {
  it("returns nulls with 'none' coverage on empty history", () => {
    const result = buildWealthVelocity([], NOW);
    expect(result[0]!.coverage).toBe("none");
    expect(result[0]!.change).toBeNull();
    expect(result[0]!.velocityPerDay).toBeNull();
  });

  it("computes velocity from an at-or-before baseline with full coverage", () => {
    const snapshots = [
      nw(1_000_000_000, NOW - 40 * DAY),
      ...Array.from({ length: 31 }, (_, i) => nw(1_000_000_000 + (i + 10) * 10_000_000, NOW - (30 - i) * DAY)),
    ];
    const [d7, d30] = buildWealthVelocity(snapshots, NOW);
    expect(d30!.coverage).toBe("full");
    expect(d30!.velocityPerDay).toBeCloseTo(10_000_000, 3);
    expect(d7!.change).toBe(70_000_000);
  });

  it("marks partial coverage when tracking started inside the window", () => {
    const snapshots = [nw(500_000_000, NOW - 3 * DAY), nw(530_000_000, NOW - DAY)];
    const [d30] = buildWealthVelocity(snapshots, NOW);
    expect(d30!.coverage).toBe("partial");
    expect(d30!.change).toBe(30_000_000);
  });
});

describe("buildWealthProjection", () => {
  it("projects from a clean trend and reports medium/high confidence", () => {
    const snapshots = Array.from({ length: 40 }, (_, i) => nw(1_000_000_000 + i * 5_000_000, NOW - (40 - i) * DAY));
    const p = buildWealthProjection(snapshots, NOW);
    expect(p.current).toBe(1_000_000_000 + 39 * 5_000_000);
    expect(p.projectedIn30d).toBeCloseTo(p.current! + 5_000_000 * 30, 3);
    expect(["medium", "high"]).toContain(p.confidence);
  });

  it("withholds the projection for flat series", () => {
    const snapshots = Array.from({ length: 40 }, (_, i) => nw(1_000_000_000, NOW - (40 - i) * DAY));
    const p = buildWealthProjection(snapshots, NOW);
    expect(p.projectedIn30d).toBeNull();
    expect(p.confidence).toBe("low");
  });

  it("withholds everything on empty history", () => {
    const p = buildWealthProjection([], NOW);
    expect(p.current).toBeNull();
    expect(p.projectedIn30d).toBeNull();
    expect(p.confidence).toBe("insufficient");
  });
});

describe("buildWealthAttribution", () => {
  const base: EconomyIntelligenceInputs = {
    now: NOW,
    networthSnapshots: [nw(1_000_000_000, NOW - 31 * DAY), ...Array.from({ length: 30 }, (_, i) => nw(1_100_000_000 + i * 1_000_000, NOW - (30 - i) * DAY))],
    moneyEvents: [],
    travelTrips: [],
  };

  it("splits earned income, spending and asset flows without double counting", () => {
    const events: MoneyEventLike[] = [];
    for (let d = 30; d >= 1; d--) {
      events.push(money(NOW - d * DAY + 3600, 1_000_000, "salary", "income"));
      events.push(money(NOW - d * DAY + 7200, 200_000, "hospital", "expense"));
      // Conversions: buying and selling stocks must NOT touch income/expense.
      events.push(money(NOW - d * DAY + 10800, 500_000, "stock", "income"));
      events.push(money(NOW - d * DAY + 14400, 400_000, "stock", "expense"));
      // Internal transfer must appear nowhere.
      events.push(money(NOW - d * DAY + 18000, 2_000_000, "city_bank", "neutral"));
    }
    const attribution = buildWealthAttribution({ moneyEvents: events, networthSnapshots: base.networthSnapshots }, NOW - 30 * DAY, NOW);
    expect(attribution.earnedIncome).toBe(30_000_000);
    expect(attribution.spending).toBe(6_000_000);
    expect(attribution.assetSales).toBe(15_000_000);
    expect(attribution.assetPurchases).toBe(12_000_000);
    // Bank transfers appear nowhere:
    const totalKnown = attribution.earnedIncome + attribution.spending + attribution.assetSales + attribution.assetPurchases;
    expect(totalKnown).toBe(30_000_000 + 6_000_000 + 15_000_000 + 12_000_000);
    expect(attribution.netWorthCoverage).toBe("full");
    // NW delta (100M + 29M growth) minus ledger net (24M) = residual.
    expect(attribution.netWorthChange).not.toBeNull();
    expect(attribution.unexplainedMovement).toBe(attribution.netWorthChange! - (30_000_000 - 6_000_000));
    expect(attribution.unknownShare).toBe(0);
  });

  it("reports none coverage without a baseline snapshot", () => {
    const attribution = buildWealthAttribution({ moneyEvents: [], networthSnapshots: [nw(1, NOW)] }, NOW - 30 * DAY, NOW);
    expect(attribution.netWorthCoverage).toBe("none");
    expect(attribution.unexplainedMovement).toBeNull();
  });
});

describe("buildFinancialRecords", () => {
  it("finds all records with their timestamps", () => {
    const snapshots = [
      nw(1_000_000_000, NOW - 10 * DAY, 100_000),
      nw(1_200_000_000, NOW - 5 * DAY, 900_000),
      nw(1_100_000_000, NOW - DAY, 50_000),
    ];
    const records = buildFinancialRecords({
      networthSnapshots: snapshots,
      moneyEvents: [money(NOW - 9 * DAY, 100_000, "salary", "income"), money(NOW - 4 * DAY, 2_000_000, "salary", "income"), money(NOW - 3 * DAY, 500_000, "hospital", "expense"), money(NOW - DAY, 50_000, "items", "income")],
      travelTrips: [
        {
          id: "t1", destination: "Mexico", departedAt: NOW - 6 * DAY, returnedAt: NOW - 6 * DAY + 10 * 3600, durationSeconds: 10 * 3600,
          items: [{ id: "i", category: "plushie", itemId: 1, itemName: "X", quantity: 5, unitCost: 1000, totalCost: 5000, estimatedTotalValue: 20_000 }],
        },
      ],
    });
    expect(records.highestNetWorth).toEqual({ value: 1_200_000_000, at: NOW - 5 * DAY, provenance: "exact" });
    expect(records.highestWalletBalance).toEqual({ value: 900_000, at: NOW - 5 * DAY, provenance: "exact" });
    expect(records.bestIncomeDay?.value).toBe(2_000_000);
    expect(records.largestExpenseDay?.value).toBe(500_000);
    expect(records.highestDailyWealthGrowth?.value).toBe(200_000_000);
    expect(records.mostProfitableTravelDay?.value).toBe(15_000);
    expect(records.mostProfitableTravelDay?.provenance).toBe("estimated");
  });

  it("returns all nulls for empty inputs", () => {
    const records = buildFinancialRecords({ networthSnapshots: [], moneyEvents: [], travelTrips: [] });
    for (const value of Object.values(records)) expect(value).toBeNull();
  });
});
