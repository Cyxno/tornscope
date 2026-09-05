import { describe, expect, it } from "vitest";
import { normalizeLogEntry } from "../src/normalizers/logs.js";
import { routeLog } from "../src/normalizers/titles.js";
import type { TornUserLog } from "@tornscope/torn-api";

/**
 * Crime normalization against the REAL payload shapes observed in the live
 * account (titles like "Crime success money gain (new)", payloads with nerve /
 * outcome / crime_action / money_gained / items_gained / jail_time_increased).
 */

function ctx(prices: Record<number, number> = {}) {
  return {
    itemNameById: new Map<number, string>(),
    itemTypeById: new Map<number, string>(),
    itemMarketPriceById: new Map<number, bigint>(Object.entries(prices).map(([k, v]) => [Number(k), BigInt(v)])),
    itemIdByName: new Map<string, number>(),
  };
}

function normalize(title: string, data: Record<string, unknown>, context = ctx()) {
  return normalizeLogEntry({ id: 1, timestamp: 1_000, details: { id: 1, title, category: "Crimes" }, data, params: {} } as unknown as TornUserLog, context);
}

describe("crime routing", () => {
  it("routes the Crimes category to the crimes domain", () => {
    expect(routeLog("Crimes", "Crime success money gain (new)")).toBe("crimes");
    expect(routeLog("Crimes", "Crime fail (new)")).toBe("crimes");
    expect(routeLog("Crimes", "Crime critical fail jail")).toBe("crimes");
  });
});

describe("crime success normalization", () => {
  it("money gain: success, nerve, money delta + canonical MoneyEvent", () => {
    const writes = normalize("Crime success money gain (new)", { nerve: 4, outcome: 12861, crime_action: "shoplifting from the Jewelry Store", money_gained: 700 });
    expect(writes.crimeEvents).toHaveLength(1);
    const c = writes.crimeEvents[0]!;
    expect(c.success).toBe(true);
    expect(c.nerveUsed).toBe(4);
    expect(c.crimeId).toBe(12861);
    expect(c.crimeName).toBe("shoplifting from the Jewelry Store");
    expect(c.crimeCategory).toBe("new");
    expect(c.moneyDelta).toBe(700n);
    // Exactly one canonical cash ledger row, same sourceRef.
    expect(writes.moneyEvents).toHaveLength(1);
    expect(writes.moneyEvents[0]!.category).toBe("crime");
    expect(writes.moneyEvents[0]!.direction).toBe("income");
    expect(writes.moneyEvents[0]!.amount).toBe(700n);
  });

  it("item gain: estimated value from the catalog, raw items kept in metadata", () => {
    const writes = normalize("Crime success item gain (new)", { nerve: 5, outcome: 11764, crime_action: "selling counterfeit DVDs", items_gained: { 819: 2 } }, ctx({ 819: 4_200 }));
    const c = writes.crimeEvents[0]!;
    expect(c.success).toBe(true);
    expect(c.moneyDelta).toBeNull();
    expect(c.itemsValue).toBe(8_400n);
    // No cash movement: no MoneyEvent.
    expect(writes.moneyEvents).toHaveLength(0);
  });

  it("nerve unavailable stays null (never invented)", () => {
    const writes = normalize("Crime success", { outcome: 13192, crime_action: "installing a skimmer at a gas station" });
    const c = writes.crimeEvents[0]!;
    expect(c.nerveUsed).toBeNull();
    expect(c.success).toBe(true);
  });
});

describe("crime failure normalization", () => {
  it("plain failure has no money and produces no ledger row", () => {
    const writes = normalize("Crime fail (new)", { nerve: 2, outcome: 1341, crime_action: "copying DVDs" });
    const c = writes.crimeEvents[0]!;
    expect(c.success).toBe(false);
    expect(c.moneyDelta).toBeNull();
    expect(writes.moneyEvents).toHaveLength(0);
  });

  it("critical fail jail records jail seconds", () => {
    const writes = normalize("Crime critical fail jail", { nerve: 2, outcome: 1350, crime_action: "copying DVDs", jail_time_increased: 10_369 });
    const c = writes.crimeEvents[0]!;
    expect(c.success).toBe(false);
    expect(c.jailSeconds).toBe(10_369);
  });

  it("money lost becomes a negative delta and an expense ledger row", () => {
    const writes = normalize("Crime fail (new)", { nerve: 2, outcome: 1341, crime_action: "big heist", money_lost: 5_000 });
    const c = writes.crimeEvents[0]!;
    expect(c.moneyDelta).toBe(-5_000n);
    expect(writes.moneyEvents).toHaveLength(1);
    expect(writes.moneyEvents[0]!.direction).toBe("expense");
    expect(writes.moneyEvents[0]!.amount).toBe(-5_000n);
  });
});

describe("non-attempt crime logs stay on the timeline only", () => {
  it("skill changes, item deposits and hints produce no CrimeEvent", () => {
    for (const [title, data] of [
      ["Crime skill level up", { crime: "bootlegging", skill_level: 86 }],
      ["Crime item add blank DVDs", { items_added: 956 }],
      ["Crime graffiti reputation up", { area: "Red-Light District", reputation: 3 }],
    ] as Array<[string, Record<string, unknown>]>) {
      const writes = normalize(title, data);
      expect(writes.crimeEvents, title).toHaveLength(0);
    }
  });
});
