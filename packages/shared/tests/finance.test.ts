import { describe, expect, it } from "vitest";
import { explainWealthStory, sentimentFor } from "../src/finance.js";
import { formatSignedMoneyCompact } from "../src/format.js";

/**
 * Financial semantics contract (V1.0 financial-semantics rework).
 *
 * SIGN IS NOT SENTIMENT: red/green are reserved for economic meaning
 * (wealth, economic result, valuation). Conversions (cash↔assets, bank),
 * liquidity transport (wallet in/out/movement) and unresolved figures are
 * NEUTRAL regardless of sign or magnitude.
 *
 * The canonical fixtures below are the acceptance cases for the whole
 * product: every surface that shows these shapes must classify them the
 * same way (Phase: cross-page semantic contract).
 */

describe("sentimentFor — the single sign-vs-sentiment authority", () => {
  it("wealth, economic and valuation figures keep gain/loss sentiment", () => {
    expect(sentimentFor("wealth", 5_040_000)).toBe("positive");
    expect(sentimentFor("wealth", -100_000)).toBe("negative");
    expect(sentimentFor("economic", 4_770_000)).toBe("positive"); // true income
    expect(sentimentFor("economic", -4_720_000)).toBe("negative"); // true costs
    expect(sentimentFor("valuation", 5_000_000)).toBe("positive"); // stock price up
    expect(sentimentFor("valuation", -2_000_000)).toBe("negative");
  });

  it("conversion and liquidity figures are NEUTRAL however large or negative", () => {
    // The acceptance case: $8m of purchases is movement, not a loss.
    expect(sentimentFor("conversion", -8_000_000)).toBe("neutral");
    expect(sentimentFor("conversion", 10_000_000)).toBe("neutral"); // sale proceeds ≠ profit
    expect(sentimentFor("liquidity", -8_590_000)).toBe("neutral"); // net wallet movement
    expect(sentimentFor("liquidity", 8_170_000)).toBe("neutral");
    expect(sentimentFor("unresolved", -12_345)).toBe("neutral");
    expect(sentimentFor("conversion", 0)).toBe("neutral");
  });

  it("null/unknown stays neutral even for economic meanings", () => {
    expect(sentimentFor("wealth", null)).toBe("neutral");
    expect(sentimentFor("economic", undefined)).toBe("neutral");
  });
});

describe("canonical conversion fixtures (Phase: test fixtures)", () => {
  // Helper mirroring what a page derives from the dashboard/economy
  // contracts: gross outflow = wallet inflow + |net movement| when inflow
  // is known; here we pass the pieces explicitly.
  const story = (i: Omit<Parameters<typeof explainWealthStory>[0], never>) => explainWealthStory(i);

  it("A: cash −8m, items +7.9m, NW −100k → mostly conversion, NOT an $8m loss", () => {
    const s = story({
      netWorthChange: -100_000,
      trueIncome: 200_000,
      trueCosts: 300_000,
      movedIntoAssets: 8_000_000,
      movedBackToCash: 0,
      walletOutflow: 8_300_000,
      walletMovement: -8_000_000,
    });
    expect(s.walletDeclineWasConversion).toBe(true);
    expect(s.headline).toContain("moved into assets");
    expect(s.headline).not.toContain("lost");
    // The actual wealth change is the small residual, stated approximately.
    expect(s.headline).toContain("100k");
  });

  it("B: cash −8m, no asset increase, NW −8m → real loss, no conversion narrative", () => {
    const s = story({
      netWorthChange: -8_000_000,
      trueIncome: 500_000,
      trueCosts: 8_500_000,
      movedIntoAssets: 0,
      movedBackToCash: 0,
      walletOutflow: 8_500_000,
      walletMovement: -8_000_000,
    });
    expect(s.walletDeclineWasConversion).toBe(false);
    expect(s.headline).toBeNull(); // say nothing rather than misframe
  });

  it("C: cash +10m, items −10m, NW ~0 → asset sale conversion, NOT +10m profit", () => {
    // Sentiment: the +10m proceeds are liquidity/conversion — neutral.
    expect(sentimentFor("liquidity", 10_000_000)).toBe("neutral");
    expect(sentimentFor("conversion", 10_000_000)).toBe("neutral");
    // And no wealth-rose story may fire on proceeds alone.
    const s = story({
      netWorthChange: 0,
      trueIncome: 0,
      trueCosts: 0,
      movedIntoAssets: 0,
      movedBackToCash: 10_000_000,
      walletOutflow: 0,
      walletMovement: 10_000_000,
    });
    expect(s.walletDeclineWasConversion).toBe(false);
    expect(s.headline).toBeNull();
  });

  it("D: salary +5m straight to cash, NW +5m → true income (economic, positive)", () => {
    expect(sentimentFor("economic", 5_000_000)).toBe("positive");
    const s = story({
      netWorthChange: 5_000_000,
      trueIncome: 5_000_000,
      trueCosts: 0,
      movedIntoAssets: 0,
      movedBackToCash: 0,
      walletOutflow: 0,
      walletMovement: 5_000_000,
    });
    expect(s.headline).toBeNull(); // no conversion story; wealth rose plainly
  });

  it("E: buy stocks −10m cash, stocks +10m, NW ~0 → neutral conversion", () => {
    expect(sentimentFor("conversion", -10_000_000)).toBe("neutral");
    const s = story({
      netWorthChange: 0,
      trueIncome: 0,
      trueCosts: 0,
      movedIntoAssets: 10_000_000,
      movedBackToCash: 0,
      walletOutflow: 10_000_000,
      walletMovement: -10_000_000,
    });
    expect(s.walletDeclineWasConversion).toBe(true);
    // NW ~0: the "wealth rose" phrasing must not fire; the movement phrasing may.
    expect(s.headline).not.toContain("Wealth rose");
  });

  it("F: stock market value +5m, cash unchanged, NW +5m → valuation gain (positive)", () => {
    expect(sentimentFor("valuation", 5_000_000)).toBe("positive");
    expect(sentimentFor("wealth", 5_000_000)).toBe("positive");
  });

  it("G: rehab −1.25m cash, NW −1.25m → true cost (economic, negative)", () => {
    expect(sentimentFor("economic", -1_250_000)).toBe("negative");
    const s = story({
      netWorthChange: -1_250_000,
      trueIncome: 0,
      trueCosts: 1_250_000,
      movedIntoAssets: 0,
      movedBackToCash: 0,
      walletOutflow: 1_250_000,
      walletMovement: -1_250_000,
    });
    expect(s.walletDeclineWasConversion).toBe(false);
    expect(s.headline).toBeNull();
  });

  it("H: bank withdrawal +10m cash, bank −10m, NW ~0 → neutral conversion", () => {
    expect(sentimentFor("conversion", 10_000_000)).toBe("neutral");
  });
});

describe("defensibility guardrails (Phase: conversion inference)", () => {
  it("a small purchase beside a large real loss must NOT read as movement", () => {
    const s = explainWealthStory({
      netWorthChange: -8_000_000,
      trueIncome: 0,
      trueCosts: 8_000_000,
      movedIntoAssets: 100_000, // token purchase
      movedBackToCash: 0,
      walletOutflow: 8_100_000,
      walletMovement: -8_000_000,
    });
    expect(s.walletDeclineWasConversion).toBe(false);
    expect(s.headline).toBeNull();
  });

  it("the acceptance pairing never claims an exact moved amount or a bad purchase", () => {
    const s = explainWealthStory({
      netWorthChange: -100_000,
      trueIncome: 200_000,
      trueCosts: 300_000,
      movedIntoAssets: 7_900_000,
      movedBackToCash: 0,
      walletOutflow: 8_000_000,
      walletMovement: -8_000_000,
    });
    expect(s.headline).toBeTruthy();
    expect(s.headline!).not.toMatch(/exactly/i);
    expect(s.headline!).not.toMatch(/bad purchase/i);
    expect(s.headline!).not.toMatch(/fees/i);
  });

  it("wealth up + cash down is a valid, describable state (dual reconciliation)", () => {
    const s = explainWealthStory({
      netWorthChange: 5_040_000,
      trueIncome: 4_770_000,
      trueCosts: 4_720_000,
      movedIntoAssets: 12_040_000,
      movedBackToCash: 3_410_000,
      walletOutflow: 16_760_000,
      walletMovement: -8_590_000,
    });
    expect(s.wealthRoseWhileCashFell).toBe(true);
    expect(s.headline).toContain("Wealth rose");
    // Sanity of the real-profile shape: the signed texts tell the numbers,
    // the tones tell the meaning.
    expect(formatSignedMoneyCompact(5_040_000)).toBe("+$5.04m");
    expect(formatSignedMoneyCompact(-8_590_000)).toBe("-$8.59m");
    expect(sentimentFor("wealth", 5_040_000)).toBe("positive");
    expect(sentimentFor("liquidity", -8_590_000)).toBe("neutral");
  });
});
