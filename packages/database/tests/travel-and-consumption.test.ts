import { describe, expect, it } from "vitest";
import { normalizeLogEntry } from "../src/normalizers/logs.js";
import type { TornUserLog } from "@tornscope/torn-api";

/**
 * Travel commodity classification: XANAX IS A TOP-LEVEL TRAVEL CATEGORY.
 * Xanax bought abroad must never disappear inside "other" — its haul rows
 * carry category "xanax" so Travel analytics can rank it against plushies
 * and flowers by spend and profit.
 */

const XANAX_ID = 206;

function ctx(names: Record<number, string> = {}, types: Record<number, string> = {}, prices: Record<number, number> = {}) {
  return {
    itemNameById: new Map<number, string>(Object.entries(names).map(([k, v]) => [Number(k), v])),
    itemTypeById: new Map<number, string>(Object.entries(types).map(([k, v]) => [Number(k), v])),
    itemMarketPriceById: new Map<number, bigint>(Object.entries(prices).map(([k, v]) => [Number(k), BigInt(v)])),
    itemIdByName: new Map<string, number>(Object.entries(names).map(([k, v]) => [v.toLowerCase(), Number(k)])),
  };
}

function normalize(data: Record<string, unknown>, context: ReturnType<typeof ctx>, title = "Item abroad buy", category = "Travel") {
  const log = { id: 1, timestamp: 1_000, details: { id: 1, title, category }, data, params: {} };
  return normalizeLogEntry(log as unknown as TornUserLog, context);
}

describe("travel xanax classification", () => {
  it("classifies Xanax bought abroad as its own category, not other", () => {
    const writes = normalize({ area: 11, item: XANAX_ID, quantity: 100, cost_each: 840_000, cost_total: 84_000_000 }, ctx({ [XANAX_ID]: "Xanax" }, { [XANAX_ID]: "Drug" }));
    expect(writes.travelItemEvents).toHaveLength(1);
    expect(writes.travelItemEvents[0]!.category).toBe("xanax");
    expect(writes.travelItemEvents[0]!.quantity).toBe(100);
  });

  it("keeps plushies and flowers in their own categories", () => {
    const plushie = normalize({ area: 3, item: 384, quantity: 28, cost_each: 14_000, cost_total: 392_000 }, ctx({ 384: "Chamois Plushie" }, { 384: "Plushie" }));
    expect(plushie.travelItemEvents[0]!.category).toBe("plushie");
    const flower = normalize({ area: 3, item: 260, quantity: 9, cost_each: 12_000, cost_total: 108_000 }, ctx({ 260: "Ceibo Flower" }, { 260: "Flower" }));
    expect(flower.travelItemEvents[0]!.category).toBe("flower");
  });

  it("an unnamed item without a known drug name still falls back to other", () => {
    const writes = normalize({ area: 2, item: 999_999, quantity: 3, cost_each: 500, cost_total: 1_500 }, ctx());
    expect(writes.travelItemEvents[0]!.category).toBe("other");
  });
});

/* -------------------------------------------------------------------------- */
/* Container uses: item2 payloads count YIELD, not containers consumed        */
/* -------------------------------------------------------------------------- */

describe("container consumption valuation (Drug Pack bug)", () => {
  it("one Drug Pack use with quantity 10 values ONE pack, never pack price × 10", () => {
    // Live raw payload: {"item":370,"item2":206,"faction":0,"quantity":10}
    // — the player used ONE pack and received 10 units of item2 (Xanax).
    const writes = normalize({ item: 370, item2: 206, faction: 0, quantity: 10 }, ctx({ 370: "Drug Pack", 206: "Xanax" }, { 370: "Supply Pack" }), "Item use drug pack", "Item use");
    expect(writes.consumptionEvents).toHaveLength(1);
    const c = writes.consumptionEvents[0]!;
    expect(c.itemId).toBe(370);
    expect(c.quantity).toBe(1); // yield count must NOT multiply the container
    expect(c.totalValue).toBe(c.unitValue); // exactly one pack's price
    const meta = c.metadata as { containerUse?: boolean };
    expect(meta.containerUse).toBe(true);
  });

  it("regular multi-quantity uses (no item2) still count quantity normally", () => {
    const writes = normalize({ item: 890, quantity: 3 }, ctx({ 890: "Energy Drink" }, { 890: "Energy Drink" }, { 890: 1_000 }), "Item use energy drink", "Item use");
    expect(writes.consumptionEvents[0]!.quantity).toBe(3);
    expect(writes.consumptionEvents[0]!.totalValue).toBe(3_000n);
  });

  it("a consumable USE never produces a cash money event (no double counting)", () => {
    const use = normalize({ item: 206, faction: 0 }, ctx({ 206: "Xanax" }, { 206: "Drug" }), "Item use xanax", "Drugs");
    expect(use.consumptionEvents.length).toBeGreaterThan(0);
    expect(use.moneyEvents).toHaveLength(0);
  });
});
