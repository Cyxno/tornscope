import { describe, expect, it } from "vitest";
import {
  assembleStockRow,
  benefitReached,
  classifyReward,
  payoutTiming,
  type StockBenefitDefinition,
  type StockCatalogEntry,
  type UserBonusState,
} from "../src/stocks.js";

/**
 * Stocks golden coverage (v0.2 feature completion).
 *
 * Golden fixture (Phase 51 of the feature brief):
 *   price $500 · owned 800,000 · requirement 1,000,000
 *   → missing 200,000 shares, est. cost $100m
 *   reward $10,000,000 every 30 days
 *   → annual = 10m × 365/30 = $121,666,666.67 (121_666_666.666…)
 *   → yield  = annual / (requirement × price) = 24.333…%
 *   → payback = capital / (annual / 365) = 1500 days exactly
 *
 * Honesty rules under test: unknown value is NULL (never $0), timing is
 * unavailable without evidence, and there is never a negative countdown.
 */

const bonus = (over: Partial<UserBonusState> = {}): UserBonusState => ({
  available: false,
  increment: 1,
  progress: 0,
  frequency: 7,
  ...over,
});

const entry = (over: Partial<StockCatalogEntry> = {}): StockCatalogEntry => ({
  id: 1,
  name: "Test Holdings",
  acronym: "TST",
  price: 500,
  benefit: { passive: false, frequency: 30, requirement: 1_000_000, description: "$10,000,000" },
  ...over,
});

const itemPrices = new Map<string, number>([["drug pack", 4_301_565]]);

describe("classifyReward", () => {
  it("parses exact cash", () => {
    const v = classifyReward({ passive: false, frequency: 31, requirement: 3_000_000, description: "$50,000,000" }, itemPrices);
    expect(v.kind).toBe("fixed_cash");
    expect(v.cash).toBe(50_000_000);
    expect(v.valuePerPayout).toBe(50_000_000);
    expect(v.valueIsExact).toBe(true);
  });

  it("values item rewards at the current catalog price", () => {
    const v = classifyReward({ passive: false, frequency: 7, requirement: 500_000, description: "1x Drug Pack" }, itemPrices);
    expect(v.kind).toBe("item");
    expect(v.quantity).toBe(1);
    expect(v.valuePerPayout).toBe(4_301_565);
    expect(v.valueIsExact).toBe(false);
  });

  it("renders items without catalog coverage as unvalued — never $0", () => {
    const v = classifyReward({ passive: false, frequency: 7, requirement: 3_000_000, description: "1x Ammunition Pack" }, itemPrices);
    expect(v.kind).toBe("unvalued");
    expect(v.valuePerPayout).toBeNull();
  });

  it("keeps random properties non-monetary even though phrased as an item", () => {
    const v = classifyReward({ passive: false, frequency: 31, requirement: 10_000_000, description: "1x Random Property" }, itemPrices);
    expect(v.kind).toBe("non_monetary");
    expect(v.valuePerPayout).toBeNull();
  });

  it("keeps point rewards as points (no invented conversion)", () => {
    const v = classifyReward({ passive: false, frequency: 7, requirement: 10_000_000, description: "100 points" }, itemPrices);
    expect(v.kind).toBe("points");
    expect(v.points).toBe(100);
    expect(v.valuePerPayout).toBeNull();
  });

  it("classifies bar refills and passive perks as non-monetary", () => {
    const refill = classifyReward({ passive: false, frequency: 7, requirement: 350_000, description: "100 energy" }, itemPrices);
    expect(refill.kind).toBe("bar_refill");
    expect(refill.valuePerPayout).toBeNull();
    const passive = classifyReward({ passive: true, frequency: 7, requirement: 1_500_000, description: "a 10% bank interest bonus" }, itemPrices);
    expect(passive.kind).toBe("non_monetary");
    expect(passive.valuePerPayout).toBeNull();
  });
});

describe("benefitReached", () => {
  it("is exact at the threshold and false without a requirement", () => {
    expect(benefitReached(1_000_000, 1_000_000)).toBe(true);
    expect(benefitReached(999_999, 1_000_000)).toBe(false);
    expect(benefitReached(5_000_000, null)).toBe(false);
  });
});

describe("payoutTiming", () => {
  it("reports ready when the source says the reward is collectible", () => {
    const t = payoutTiming({ shares: 1_000_000, requirement: 1_000_000, bonus: bonus({ available: true, progress: 7 }) });
    expect(t.kind).toBe("ready");
    expect(t.daysRemaining).toBe(0);
  });

  it("derives days remaining mid-cycle", () => {
    const t = payoutTiming({ shares: 1_000_000, requirement: 1_000_000, bonus: bonus({ progress: 3, frequency: 7 }) });
    expect(t.kind).toBe("derived");
    expect(t.daysRemaining).toBe(4);
  });

  it("never produces a negative countdown", () => {
    const t = payoutTiming({ shares: 1_000_000, requirement: 1_000_000, bonus: bonus({ progress: 9, frequency: 7 }) });
    expect(t.kind).toBe("unavailable"); // progress beyond the cycle = no evidence
  });

  it("is unavailable below the threshold or with missing evidence", () => {
    expect(payoutTiming({ shares: 10, requirement: 1_000_000, bonus: bonus({ progress: 3 }) }).kind).toBe("unavailable");
    expect(payoutTiming({ shares: 2_000_000, requirement: null, bonus: bonus({ progress: 3, frequency: 7 }) }).kind).toBe("unavailable");
    expect(payoutTiming({ shares: 2_000_000, requirement: 1_000_000, bonus: bonus({ progress: null, frequency: null }) }).kind).toBe("unavailable");
  });
});

describe("assembleStockRow — the Phase 51 golden fixture", () => {
  const row = assembleStockRow({
    catalog: entry(),
    shares: 800_000,
    bonus: bonus({ progress: 0, frequency: 30 }),
  });

  it("computes missing shares and cost at the current price", () => {
    expect(row.owned).toBe(true);
    expect(row.shares).toBe(800_000);
    expect(row.positionValue).toBe(400_000_000);
    expect(row.benefitReached).toBe(false);
    expect(row.missingShares).toBe(200_000);
    expect(row.estimatedCostToBenefit).toBe(100_000_000);
  });

  it("computes the exact annual/yield/payback triple", () => {
    expect(row.estimatedAnnualValue).toBeCloseTo(121_666_666.666_666_67, 6);
    const capital = 1_000_000 * 500; // requirement × price
    expect(row.yieldCapitalBasis).toBe(500_000_000);
    expect(row.estimatedYieldPct).toBeCloseTo(((10_000_000 * 365) / 30 / 500_000_000) * 100, 6);
    expect(row.estimatedPaybackDays).toBeCloseTo(1500, 6);
    void capital;
  });

  it("with the threshold met, the block is active and cost disappears", () => {
    const reached = assembleStockRow({
      catalog: entry(),
      shares: 1_200_000,
      bonus: bonus({ progress: 5, frequency: 30 }),
    });
    expect(reached.benefitReached).toBe(true);
    expect(reached.missingShares).toBeNull();
    expect(reached.estimatedCostToBenefit).toBeNull();
    expect(reached.timing?.kind).toBe("derived");
    expect(reached.timing?.daysRemaining).toBe(25);
  });
});

describe("assembleStockRow — honest states", () => {
  it("unowned rows expose the benefit but no holdings economics", () => {
    const row = assembleStockRow({ catalog: entry({ id: 2, acronym: "UNW" }), shares: null, bonus: null });
    expect(row.owned).toBe(false);
    expect(row.positionValue).toBeNull();
    expect(row.timing).toBeNull();
    expect(row.estimatedAnnualValue).not.toBeNull(); // catalog reward still valued
  });

  it("unvalued rewards produce null economics — never $0", () => {
    const row = assembleStockRow({
      catalog: entry({ benefit: { passive: true, frequency: 7, requirement: 1_500_000, description: "a 10% bank interest bonus" } }),
      shares: 2_000_000,
      bonus: bonus({ progress: 2 }),
    });
    expect(row.reward?.valuePerPayout).toBeNull();
    expect(row.estimatedAnnualValue).toBeNull();
    expect(row.estimatedYieldPct).toBeNull();
    expect(row.estimatedPaybackDays).toBeNull();
  });

  it("missing price or interval degrades yield/payback to null", () => {
    const noPrice = assembleStockRow({ catalog: entry({ price: null }), shares: 100, bonus: null });
    expect(noPrice.estimatedCostToBenefit).toBeNull();
    expect(noPrice.estimatedAnnualValue).not.toBeNull(); // cash reward: price-independent
    const noFrequency = assembleStockRow({
      catalog: entry({ benefit: { passive: false, frequency: null, requirement: 1_000_000, description: "$10,000,000" } }),
      shares: 2_000_000,
      bonus: null,
    });
    expect(noFrequency.estimatedAnnualValue).toBeNull();
    expect(noFrequency.estimatedYieldPct).toBeNull();
    expect(noFrequency.estimatedPaybackDays).toBeNull();
  });

  it("zero-reward and zero-capital paths never divide by zero", () => {
    const noRewardValue = assembleStockRow({
      catalog: entry({ benefit: { passive: false, frequency: 7, requirement: 350_000, description: "50 nerve" } }),
      shares: 400_000,
      bonus: null,
    });
    expect(noRewardValue.estimatedPaybackDays).toBeNull();
    const freeStock = assembleStockRow({
      catalog: entry({ price: 0 }),
      shares: 2_000_000,
      bonus: null,
    });
    expect(freeStock.estimatedYieldPct).toBeNull();
    expect(freeStock.estimatedPaybackDays).toBeNull();
  });

  it("a stock without any benefit says so", () => {
    const row = assembleStockRow({ catalog: entry({ benefit: null }), shares: 10_000, bonus: null });
    expect(row.benefitDescription).toBeNull();
    expect(row.reward).toBeNull();
    expect(row.benefitReached).toBe(false);
  });
});
