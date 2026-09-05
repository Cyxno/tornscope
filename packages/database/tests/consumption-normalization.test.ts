import { describe, expect, it } from "vitest";
import { consumptionCategoryFor, itemNameFromUseTitle, normalizeLogEntry } from "../src/normalizers/logs.js";
import { routeLog } from "../src/normalizers/titles.js";
import type { TornUserLog } from "@tornscope/torn-api";

/**
 * Consumption event normalization: drugs, EDVD (happy jump), energy drinks,
 * candy, boosters and medical items. Valuation uses the cached Torn catalog
 * market price; prices are never invented — without a price source the event
 * records valuationMethod/provenance "unknown" with a null value.
 */

const XANAX_ID = 206;
const ERGO_ID = 1491;

interface CtxSpec {
  prices?: Record<number, number>;
  names?: Record<number, string>;
  types?: Record<number, string>;
}

function ctx(spec: CtxSpec = {}) {
  return {
    itemNameById: new Map<number, string>(Object.entries(spec.names ?? {}).map(([k, v]) => [Number(k), v])),
    itemTypeById: new Map<number, string>(Object.entries(spec.types ?? {}).map(([k, v]) => [Number(k), v])),
    itemMarketPriceById: new Map<number, bigint>(Object.entries(spec.prices ?? {}).map(([k, v]) => [Number(k), BigInt(v)])),
    itemIdByName: new Map<string, number>(Object.entries(spec.names ?? {}).map(([k, v]) => [v.toLowerCase(), Number(k)])),
  };
}

function normalize(title: string, category: string, data: Record<string, unknown>, context: ReturnType<typeof ctx> = ctx()) {
  return normalizeLogEntry({ id: 1, timestamp: 1_000, details: { id: 1, title, category }, data, params: {} } as unknown as TornUserLog, context);
}

describe("drug use creates consumption events", () => {
  it("Item use xanax (item id present) is valued from the catalog market price", () => {
    const writes = normalize("Item use xanax", "Drugs", { item: XANAX_ID, faction: 0 }, ctx({ prices: { [XANAX_ID]: 840_000 }, names: { [XANAX_ID]: "Xanax" }, types: { [XANAX_ID]: "Drug" } }));
    expect(writes.drugEvents).toHaveLength(1);
    expect(writes.drugEvents[0]!.drugItemId).toBe(XANAX_ID);
    expect(writes.consumptionEvents).toHaveLength(1);
    const c = writes.consumptionEvents[0]!;
    expect(c.category).toBe("drug");
    expect(c.itemId).toBe(XANAX_ID);
    expect(c.quantity).toBe(1);
    expect(c.unitValue).toBe(840_000n);
    expect(c.totalValue).toBe(840_000n);
    expect(c.valuationMethod).toBe("catalog_market_price");
    expect(c.provenance).toBe("estimated");
    expect(c.source).toBe("torn_log");
  });

  it("old-style Used Xanax (no item id in payload) resolves the id from the drug name", () => {
    const writes = normalize("Used Xanax", "Item use drug", {}, ctx({ prices: { [XANAX_ID]: 840_000 }, names: { [XANAX_ID]: "Xanax" }, types: { [XANAX_ID]: "Drug" } }));
    expect(writes.drugEvents).toHaveLength(1);
    expect(writes.drugEvents[0]!.drugItemId).toBe(XANAX_ID);
    expect(writes.drugEvents[0]!.drugName).toBe("Xanax");
    expect(writes.consumptionEvents).toHaveLength(1);
    expect(writes.consumptionEvents[0]!.totalValue).toBe(840_000n);
  });

  it("an overdose is still a consumption event", () => {
    const writes = normalize("Overdosed on Xanax", "Item use drug", {}, ctx({ names: { [XANAX_ID]: "Xanax" } }));
    expect(writes.drugEvents[0]!.outcome).toBe("overdose");
    expect(writes.consumptionEvents).toHaveLength(1);
    expect(writes.consumptionEvents[0]!.category).toBe("drug");
  });
});

describe("consumption valuation fallback", () => {
  it("without a price the event records unknown valuation and null value", () => {
    const writes = normalize("Item use xanax", "Drugs", { item: 999 }, ctx());
    const c = writes.consumptionEvents[0]!;
    expect(c.itemId).toBe(999);
    expect(c.unitValue).toBeNull();
    expect(c.totalValue).toBeNull();
    expect(c.valuationMethod).toBe("unknown");
    expect(c.provenance).toBe("unknown");
  });
});

describe("EDVD and other consumable item use", () => {
  it("Erotic DVD use becomes a happy_jump consumption event", () => {
    const EDVD = 470;
    const writes = normalize("Item use erotic dvd", "Item use special", { item: EDVD }, ctx({ names: { [EDVD]: "Erotic DVD" }, types: { [EDVD]: "Special" }, prices: { [EDVD]: 2_500_000 } }));
    expect(writes.consumptionEvents).toHaveLength(1);
    const c = writes.consumptionEvents[0]!;
    expect(c.category).toBe("happy_jump");
    expect(c.itemName).toBe("Erotic DVD");
    expect(c.totalValue).toBe(2_500_000n);
  });

  it("energy drinks, candy, boosters and medical items map from catalog types", () => {
    expect(consumptionCategoryFor("Energy Drink", "Energy Drink", 5_000n)).toBe("energy");
    expect(consumptionCategoryFor("Candy", "Sweet Candy", 500n)).toBe("candy");
    expect(consumptionCategoryFor("Booster", "Stupid Sense Enhancement", 12_000n)).toBe("booster");
    expect(consumptionCategoryFor("Medical", "Morphine", 30_000n)).toBe("medical");
    expect(consumptionCategoryFor("Special", "Erotic DVD", null)).toBe("happy_jump");
    expect(consumptionCategoryFor("Special", "Box of Torn Handkerchiefs", null)).toBe("temporary");
  });

  it("name-only fallback tracks recognizable consumables and skips the rest", () => {
    expect(consumptionCategoryFor(undefined, "Erotic DVD", null)).toBe("happy_jump");
    expect(consumptionCategoryFor(undefined, "Energy Drink", null)).toBe("energy");
    expect(consumptionCategoryFor(undefined, "Some Mystery Item", null)).toBeNull();
  });

  it("unknown (unresolvable) item use produces no consumption event and no invention", () => {
    const writes = normalize("Item use whatever-thing", "Item use other", {}, ctx());
    expect(writes.consumptionEvents).toHaveLength(0);
    expect(writes.unmapped).toBe(1);
  });
});

describe("routing keeps non-consumable item use away from consumption", () => {
  it("stash box use stays on the money route (its use pays out cash)", () => {
    expect(routeLog("Item use", "Item use stash box")).toBe("money");
    const writes = normalize("Item use stash box", "Item use", { item: 1239, money: 74_000, faction: 0 }, ctx({ names: { 1239: "Stash Box" }, types: { 1239: "Supply Pack" } }));
    expect(writes.consumptionEvents).toHaveLength(0);
    expect(writes.moneyEvents).toHaveLength(1);
    expect(writes.moneyEvents[0]!.direction).toBe("income");
  });

  it("generic item-use titles route to the itemuse handler", () => {
    expect(routeLog("Item use special", "Item use erotic dvd")).toBe("itemuse");
    expect(routeLog("Item use drug", "Used Ecstasy")).toBe("drugs");
    expect(routeLog("Drugs", "Item use xanax")).toBe("drugs");
  });
});

describe("itemNameFromUseTitle", () => {
  it("strips the use prefix", () => {
    expect(itemNameFromUseTitle("Item use erotic dvd")).toBe("erotic dvd");
    expect(itemNameFromUseTitle("Used Ecstasy")).toBe("Ecstasy");
    expect(itemNameFromUseTitle("Money receive")).toBeNull();
  });
});

describe("Xanax purchase then use is not double counted", () => {
  it("the purchase is a cash expense; the use creates consumption, not another expense", () => {
    const priceCtx = ctx({ prices: { [XANAX_ID]: 840_000 }, names: { [XANAX_ID]: "Xanax" }, types: { [XANAX_ID]: "Drug" } });
    const purchase = normalize("Item market buy", "Item market", { item: XANAX_ID, cost_total: 840_000 }, priceCtx);
    const use = normalize("Item use xanax", "Drugs", { item: XANAX_ID, faction: 0 }, priceCtx);

    // Purchase: real cash outflow.
    expect(purchase.moneyEvents).toHaveLength(1);
    expect(purchase.moneyEvents[0]!.amount).toBe(-840_000n);
    expect(purchase.consumptionEvents).toHaveLength(0);

    // Use: consumption value with NO additional cash movement.
    expect(use.moneyEvents).toHaveLength(0);
    expect(use.consumptionEvents[0]!.totalValue).toBe(840_000n);
  });
});

describe("travel item purchases are not consumption", () => {
  it("abroad plushie buys stay in the travel domain", () => {
    const writes = normalize("Item abroad buy", "Travel", { area: 8, item: 273, quantity: 28, cost_each: 5000, cost_total: 140_000 }, ctx({ names: { 273: "Chamois Plushie" }, types: { 273: "Plushie" }, prices: { [ERGO_ID]: 0 } }));
    expect(writes.consumptionEvents).toHaveLength(0);
    expect(writes.travelItemEvents).toHaveLength(1);
    expect(writes.moneyEvents).toHaveLength(1);
  });
});
