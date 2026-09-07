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

function ctx(names: Record<number, string> = {}, types: Record<number, string> = {}) {
  return {
    itemNameById: new Map<number, string>(Object.entries(names).map(([k, v]) => [Number(k), v])),
    itemTypeById: new Map<number, string>(Object.entries(types).map(([k, v]) => [Number(k), v])),
    itemMarketPriceById: new Map<number, bigint>(),
    itemIdByName: new Map<string, number>(Object.entries(names).map(([k, v]) => [v.toLowerCase(), Number(k)])),
  };
}

function normalize(data: Record<string, unknown>, context: ReturnType<typeof ctx>) {
  const log = { id: 1, timestamp: 1_000, details: { id: 1, title: "Item abroad buy", category: "Travel" }, data, params: {} };
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
