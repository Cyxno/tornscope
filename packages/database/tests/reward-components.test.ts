import { describe, expect, it } from "vitest";
import { parseRewardComponents, priceRewardComponent, normalizeSpecialRewardLog } from "../src/normalizers/rewards.js";
import { CrimeEventDtoSchema, RewardComponentSchema } from "@tornscope/shared";

/**
 * Generic non-cash reward components (2.7.0) — parser semantics built ONLY
 * from shapes proven in the stored raw archive (audited live 2026-10-08):
 *
 *   Crime item gains:   items_gained: {"14": 1}
 *   Crime ammo gains:   ammo_gained: {"12": {"1": 200}}
 *   Crime points gain:  points_gained: 7          (NOT a component — CrimeEvent
 *                                                  has no reward column for
 *                                                  it; rendered from raw)
 *   Job special:        item: 66, quantity: 367
 *   Company special:    item: {"335": 4, ...}
 *   Stock special item: item: {"370": 1}
 *   Subscription:       first_item: 745, second_item: 818
 *   Wheel item win:     item: 791
 *   Wheel property win: property: 7
 *
 * Cash keys (money/money_gained/cost/...) are deliberately NOT parsed here:
 * they belong to the exact-cash columns and the MoneyEvent ledger.
 */

const PRICES = new Map<number, bigint>([
  [14, 5_000n],
  [335, 2_500n],
  [66, 10_000n],
  [745, 0n], // priced at 0 in the catalog — treated as unpriced, never $0
]);
const NAMES = new Map<number, string>([[14, "Radio"], [66, "Morphine"]]);

describe("cash-only payloads", () => {
  it("cash results produce NO components (cash never doubles into otherRewards)", () => {
    // Real shape: Crime success money gain (new)
    expect(parseRewardComponents({ money_gained: 4_250 })).toEqual({ components: [], malformed: 0 });
    // Real shape: casino wheel win money
    expect(parseRewardComponents({ wheel: "the Wheel of Lame", money: 2_500 })).toEqual({ components: [], malformed: 0 });
    // Real shape: hunting session (cost + income — exact-cash columns only)
    expect(parseRewardComponents({ cost: 50_000, income: 62_000 })).toEqual({ components: [], malformed: 0 });
  });
});

describe("cash + item payloads", () => {
  it("parses the item component; cash stays in its own columns", () => {
    // Real shape family: Crime success bootlegging sell DVDs (money_gained)
    // combined with an item-bearing success — cash must NOT become a component.
    const parsed = parseRewardComponents({ money_gained: 12_500, items_gained: { 14: 2 } });
    expect(parsed.malformed).toBe(0);
    expect(parsed.components).toEqual([{ kind: "item", itemId: 14, label: null, quantity: 2 }]);
    const priced = parsed.components.map((c) => priceRewardComponent(c, NAMES, PRICES));
    expect(priced[0]).toMatchObject({ label: "Radio", valuation: "estimated", unitValueEstimate: 5_000, valueEstimate: 10_000 });
  });
});

describe("property rewards", () => {
  it("wheel property wins render as unpriced property components", () => {
    // Real shape: Casino spin the wheel win property
    const parsed = parseRewardComponents({ wheel: "the Wheel of Mediocrity", property: 7 });
    expect(parsed.components).toEqual([{ kind: "property", itemId: null, label: "Property #7", quantity: 1 }]);
    // No catalog value exists for properties — unpriced BY CONSTRUCTION.
    const priced = parsed.components.map((c) => priceRewardComponent(c, NAMES, PRICES));
    expect(priced[0]).toMatchObject({ valuation: "unpriced", valueEstimate: null, unitValueEstimate: null });
  });
});

describe("vehicle rewards", () => {
  it("no vehicle shape exists in the archive — nothing is invented", () => {
    // Racing car logs are the player's own car/upgrade COSTS; the archive
    // contains no vehicle-reward payload. Any hypothetical key stays unparsed
    // (never guessed) and produces no component.
    expect(parseRewardComponents({ car: "Mercedes", racing_points: "2 racing points" }).components).toEqual([]);
    expect(parseRewardComponents({ vehicle_gained: { 10: 1 } }).components).toEqual([]);
  });
});

describe("token / point rewards", () => {
  it("wheel points/tokens stay in their EXISTING columns — never doubled as components", () => {
    // Real shapes: Casino spin the wheel win points / win casino tokens
    // (pointsReward/tokensReward already carry them; parseRewardComponents
    // must not emit them a second time).
    expect(parseRewardComponents({ wheel: "the Wheel of Awesome", points: 25 })).toEqual({ components: [], malformed: 0 });
    expect(parseRewardComponents({ wheel: "the Wheel of Lame", casino_tokens_increased: 5 })).toEqual({ components: [], malformed: 0 });
  });
  it("mission credits map to tokensReward (existing column), not to components", () => {
    // Real shape: Missions complete
    expect(parseRewardComponents({ type: "Duke", agent: "Eduardo", money: 5_000, credits: 3 })).toEqual({ components: [], malformed: 0 });
  });
});

describe("unknown / unpriced rewards", () => {
  it("catalog-missing items stay unpriced — never zero", () => {
    // Real shape: Crime success item gain (new) with an id absent from prices
    const parsed = parseRewardComponents({ items_gained: { 65: 2 } });
    const priced = parsed.components.map((c) => priceRewardComponent(c, NAMES, PRICES));
    expect(priced[0]).toMatchObject({ itemId: 65, label: "Item #65", valuation: "unpriced", valueEstimate: null });
  });
  it("a catalog price of 0 is NOT a valuation — unpriced, never $0", () => {
    const parsed = parseRewardComponents({ items_gained: { 745: 1 } });
    const priced = parsed.components.map((c) => priceRewardComponent(c, NAMES, PRICES));
    expect(priced[0].valuation).toBe("unpriced");
    expect(priced[0].valueEstimate).toBeNull();
  });
  it("ammo gains keep the raw type/class codes and are unpriced by construction", () => {
    // Real shape: Crime success ammo gain
    const parsed = parseRewardComponents({ ammo_gained: { 12: { 1: 200 } } });
    expect(parsed.components).toEqual([{ kind: "ammo", itemId: null, label: "Ammo (type 12 · class 1)", quantity: 200 }]);
    const priced = parsed.components.map((c) => priceRewardComponent(c, NAMES, PRICES));
    expect(priced[0].valuation).toBe("unpriced");
  });
});

describe("malformed payloads", () => {
  it("reward keys with drifted shapes are counted malformed, never priced, never defaulted", () => {
    expect(parseRewardComponents({ items_gained: "14" }).malformed).toBe(1);
    expect(parseRewardComponents({ items_gained: { "not-a-number": 1 } }).malformed).toBe(1);
    expect(parseRewardComponents({ items_gained: { 14: "many" } }).malformed).toBe(1);
    expect(parseRewardComponents({ item: true }).malformed).toBe(1);
    expect(parseRewardComponents({ item: 14, quantity: 0 }).malformed).toBe(1);
    expect(parseRewardComponents({ first_item: "745" }).malformed).toBe(1);
    expect(parseRewardComponents({ ammo_gained: { 12: 200 } }).malformed).toBe(1);
    expect(parseRewardComponents({ property: "the penthouse" }).malformed).toBe(1);
    // Malformed components never fabricate a priced component.
    expect(parseRewardComponents({ items_gained: { "x": 1 } }).components).toEqual([]);
  });
});

describe("special reward families", () => {
  it("claims the four proven (category, title) pairs only", () => {
    // Real shapes from the stored archive:
    expect(normalizeSpecialRewardLog("Job", "Job special gain item", { item: 66, quantity: 367 })?.components).toEqual([
      { kind: "item", itemId: 66, label: null, quantity: 367 },
    ]);
    expect(normalizeSpecialRewardLog("Company", "Company special gain item", { item: { 335: 4, 1227: 2 } })?.components).toHaveLength(2);
    expect(normalizeSpecialRewardLog("Stocks", "Stock special item", { item: { 370: 1 }, stock: 16 })?.components).toEqual([
      { kind: "item", itemId: 370, label: null, quantity: 1 },
    ]);
    expect(normalizeSpecialRewardLog("Donator", "Subscription reward", { first_item: 745, second_item: 818 })?.components).toEqual([
      { kind: "item", itemId: 745, label: null, quantity: 1 },
      { kind: "item", itemId: 818, label: null, quantity: 1 },
    ]);
    // NOT claimed: cash-bearing or unrelated siblings (never guessed).
    expect(normalizeSpecialRewardLog("Job", "Job pay", { pay: 1_200 })).toBeNull();
    expect(normalizeSpecialRewardLog("Company", "Company special gain item", { job_points: 21 })).toBeNull();
    expect(normalizeSpecialRewardLog("Casino", "Casino spin the wheel win item", { item: 791 })).toBeNull();
  });
});

describe("contract shape", () => {
  it("CrimeEventDto carries otherRewards; cash fields unchanged and separated", () => {
    const dto = CrimeEventDtoSchema.parse({
      id: "c1",
      occurredAt: 1_791_477_945,
      crimeName: "shoplifting from Big Al's Gun Shop",
      crimeCategory: "new",
      success: true,
      nerveUsed: 4,
      moneyDelta: 1_250,          // exact cash — untouched by reward parsing
      itemsValue: 5_000,          // existing ingest-time estimate — untouched
      jailSeconds: null,
      otherRewards: [
        RewardComponentSchema.parse({ kind: "item", label: "Radio", itemId: 14, quantity: 1, unitValueEstimate: 5_000, valueEstimate: 5_000, valuation: "estimated" }),
        RewardComponentSchema.parse({ kind: "property", label: "Property #7", itemId: null, quantity: 1, unitValueEstimate: null, valueEstimate: null, valuation: "unpriced" }),
      ],
    });
    expect(dto.otherRewards).toHaveLength(2);
    // Default: rows without components parse to [] — never undefined.
    expect(CrimeEventDtoSchema.parse({ id: "c2", occurredAt: 1, crimeName: null, crimeCategory: null, success: false, nerveUsed: null, moneyDelta: null, itemsValue: null, jailSeconds: null }).otherRewards).toEqual([]);
  });

  it("no double count: components and cash describe DISJOINT value sets", () => {
    // A money+items payload: money_gained is the ledger's canonical row and
    // cashReward's source; the component list must contain ONLY the item —
    // summing both views never counts the same value twice.
    const parsed = parseRewardComponents({ money_gained: 12_500, items_gained: { 14: 2 } });
    expect(parsed.components.every((c) => c.kind !== "other" || !String(c.label).match(/\$/))).toBe(true);
    expect(parsed.components).toHaveLength(1);
    expect(parsed.components[0]!.kind).toBe("item");
  });
});
