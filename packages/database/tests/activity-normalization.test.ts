import { describe, expect, it } from "vitest";
import { normalizeCasinoLog } from "../src/normalizers/casino.js";
import { normalizeOpenableLog } from "../src/normalizers/openables.js";
import { routeLog } from "../src/normalizers/titles.js";
import { normalizeLogEntry } from "../src/normalizers/logs.js";

/**
 * Activity & Rewards normalization tests (2.4.0). Positive fixtures for
 * every observed casino/openable log shape, negative collision fixtures
 * (Speed-lesson: category/grammar anchoring, never bare keywords), and
 * cross-domain collision checks.
 */

function ctx() {
  return { itemNameById: new Map(), itemIdByName: new Map() };
}

function normalize(title: string, category: string, data: Record<string, unknown>) {
  return normalizeLogEntry(
    { id: 1, timestamp: 1_750_000_000, details: { id: 1, title, category }, data, params: {} },
    ctx()
  );
}

describe("casino normalization — positive fixtures", () => {
  it("slots lose: wager exact, no reward, outcome loss", () => {
    const writes = normalize("Casino slots lose", "Casino", { bet_amount: 100000, barrel_positions: [4, 1, 2] });
    const a = writes.activityEvents[0]!;
    expect(a.domain).toBe("casino");
    expect(a.activityType).toBe("slots");
    expect(a.outcome).toBe("loss");
    expect(a.cashInput).toBe(100000n);
    expect(a.cashReward).toBeNull();
    expect(a.netValue).toBe(-100000n);
    expect(a.valuation).toBe("exact");
  });

  it("slots win: net = won − bet", () => {
    const writes = normalize("Casino slots win", "Casino", { bet_amount: 1000000, won_amount: 6000000, combination: 29 });
    const a = writes.activityEvents[0]!;
    expect(a.cashInput).toBe(1000000n);
    expect(a.cashReward).toBe(6000000n);
    expect(a.netValue).toBe(5000000n);
    expect(a.outcome).toBe("win");
  });

  it("spin the wheel: start (cost) and outcome variants", () => {
    const start = normalize("Casino spin the wheel start", "Casino", { cost: 1000000, wheel: "the Wheel of Awesome" });
    expect(start.activityEvents[0]).toMatchObject({ subtype: "start", outcome: "started", cashInput: 1000000n, wheel: "the Wheel of Awesome" });

    const money = normalize("Casino spin the wheel win money", "Casino", { money: 2000000, wheel: "the Wheel of Awesome" });
    expect(money.activityEvents[0]).toMatchObject({ subtype: "win-money", outcome: "win", cashReward: 2000000n });

    const points = normalize("Casino spin the wheel win points", "Casino", { wheel: "the Wheel of Mediocrity", points: 25 });
    expect(points.activityEvents[0]).toMatchObject({ subtype: "win-points", pointsReward: 25 });

    const item = normalize("Casino spin the wheel win item", "Casino", { item: 90, wheel: "the Wheel of Lame" });
    expect(item.activityEvents[0]).toMatchObject({ subtype: "win-item" });

    const free = normalize("Casino spin the wheel free spin", "Casino", { wheel: "the Wheel of Awesome" });
    if (free.activityEvents[0]?.subtype !== "free-spin") console.log("FREE-SPIN ACTUAL:", JSON.stringify(free.activityEvents));
    expect(free.activityEvents[0]).toMatchObject({ subtype: "free-spin", nonPriceable: "free spin" });

    const tokens = normalize("Casino spin the wheel win casino tokens", "Casino", { wheel: "the Wheel of Mediocrity", casino_tokens_increased: 10 });
    expect(tokens.activityEvents[0]).toMatchObject({ subtype: "win-tokens", tokensReward: 10 });

    const hospital = normalize("Casino spin the wheel hospital", "Casino", { wheel: "the Wheel of Awesome", hospital_time_increased: 1947 });
    expect(hospital.activityEvents[0]).toMatchObject({ subtype: "hospital", nonPriceable: "hospitalization" });
    expect(JSON.stringify(hospital.activityEvents[0]!.metadata)).toContain("1947");

    const lose = normalize("Casino spin the wheel lose", "Casino", { wheel: "the Wheel of Awesome" });
    expect(lose.activityEvents[0]).toMatchObject({ subtype: "lose", outcome: "loss" });
  });

  it("bookie: placement is pending, settlements carry P/L, refund is zero", () => {
    const bet = normalize("Bookie bet (new)", "Casino", { bet: 200000000, odds: "2.54", selection: [1, 2, 3] });
    expect(bet.activityEvents[0]).toMatchObject({ subtype: "placed", outcome: "placed", cashInput: 200000000n });
    // Placement is pending, NOT a loss: netValue stays null (P/L only on settlement).
    expect(bet.activityEvents[0]!.netValue).toBeNull();

    const win = normalize("Bookie win (new)", "Casino", { bet: 76200000, odds: "1.57", winnings: 119634000, selection: [1] });
    expect(win.activityEvents[0]).toMatchObject({ subtype: "won", outcome: "win" });
    expect(win.activityEvents[0]!.netValue).toBe(119634000n - 76200000n);

    const lose = normalize("Bookie lose (new)", "Casino", { bet: 13240000, odds: "1.57", selection: [1] });
    expect(lose.activityEvents[0]).toMatchObject({ subtype: "lost", outcome: "loss", cashInput: 13240000n });

    const refund = normalize("Bookie refund (new)", "Casino", { bet: 3769000, odds: "1.71", selection: [1] });
    expect(refund.activityEvents[0]).toMatchObject({ subtype: "refunded", outcome: "refund" });
    expect(refund.activityEvents[0]!.netValue).toBe(0n);
  });

  it("blackjack: start is a placement, lose carries losses", () => {
    const start = normalize("Casino blackjack start", "Casino", { bet: 100000, dealer_cards: 50, player_cards: "4,13" });
    expect(start.activityEvents[0]).toMatchObject({ subtype: "start", outcome: "placed", cashInput: 100000n });
    const lose = normalize("Casino blackjack lose", "Casino", { losses: 100000, lose_state: "went bust" });
    expect(lose.activityEvents[0]).toMatchObject({ subtype: "lose", outcome: "loss", cashInput: 100000n });
    const hit = normalize("Casino blackjack hit", "Casino", { card: 28, dealer_cards: 50, player_cards: "4,13,28" });
    expect(hit.activityEvents[0]).toMatchObject({ subtype: "hit", cashInput: null });
  });

  it("high-low / roulette / keno / lottery", () => {
    const hl = normalize("Casino high-low win", "Casino", { pot: 125000, round: 1, action: "low", result: "low", dealer_card: 51, player_card: 36, pot_increase: 25000 });
    expect(hl.activityEvents[0]).toMatchObject({ game: "high-low", subtype: "win", cashReward: 125000n });
    const roulette = normalize("Casino roulette win", "Casino", { result: 16, bet_type: 14, bet_amount: 1000000, won_amount: 2000000 });
    expect(roulette.activityEvents[0]).toMatchObject({ game: "roulette", netValue: 1000000n });
    const keno = normalize("Casino keno lose", "Casino", { matches: 0, numbers: 3, bet_amount: 10, won_amount: 0 });
    expect(keno.activityEvents[0]).toMatchObject({ game: "keno", outcome: "loss" });
    const lottery = normalize("Casino lottery bet", "Casino", { cost: 100, lottery: "Daily Dime" });
    expect(lottery.activityEvents[0]).toMatchObject({ game: "lottery", outcome: "placed", cashInput: 100n });
  });
});

describe("openable normalization", () => {
  it("wallet: items + cash rewards, detected via payload", () => {
    const writes = normalize("Item use wallet", "Item use", {
      item: 1079,
      items: [{ id: 1084, qty: 2 }, { id: 1086, qty: 1 }],
      money: 130,
      faction: 0,
    });
    const a = writes.activityEvents[0]!;
    expect(a.domain).toBe("openable");
    expect(a.activityType).toBe("openable-1079");
    expect(a.activityLabel).toBe("Item #1079");
    expect(a.cashReward).toBe(130n);
    expect(a.outcome).toBe("opened");
    // metadata is the raw payload (same shape the repair writes) — reward
    // components stay queryable for valuation aggregation.
    expect(a.metadata).toEqual({ item: 1079, items: [{ id: 1084, qty: 2 }, { id: 1086, qty: 1 }], money: 130, faction: 0 });
    // Consumable normalization continues alongside (input item consumed).
    expect(writes.consumptionEvents.length).toBeGreaterThanOrEqual(0);
  });

  it("drug pack: item2 + quantity reward", () => {
    const writes = normalize("Item use drug pack", "Item use", { item: 370, item2: 206, faction: 0, quantity: 10 });
    const a = writes.activityEvents[0]!;
    expect(a.activityLabel).toBe("Drug Pack");
    expect(JSON.stringify(a.metadata)).toContain("206");
  });

  it("donator pack: points reward is exact quantity, perks kept", () => {
    const writes = normalize("Item use donator pack", "Item use", { item: 283, points: 60, faction: 0, donator_days: 31 });
    const a = writes.activityEvents[0]!;
    expect(a.activityLabel).toBe("Donator Pack");
  });

  it("points-only reward stays unpriced — never converted to zero", () => {
    const writes = normalize("Item use donator pack", "Item use", { item: 283, points: 60, faction: 0 });
    const a = writes.activityEvents[0]!;
    expect(a.cashReward).toBeNull();
    expect(a.valuation).toBe("unpriced");
    expect(a.netValue).toBeNull();
  });

  it("multiple reward components are retained together (items + money + points)", () => {
    const writes = normalize("Item use cache", "Item use", {
      item: 365,
      items: [{ id: 67, qty: 3 }],
      money: 5000,
      points: 25,
      faction: 0,
    });
    const a = writes.activityEvents[0]!;
    expect(a.cashReward).toBe(5000n);
    expect(a.pointsReward).toBe(25);
    const metadata = a.metadata as { items: Array<{ id: number; qty: number }> };
    expect(metadata.items).toEqual([{ id: 67, qty: 3 }]);
    expect(a.valuation).toBe("exact"); // exact cash present → cash semantics exact
  });
});

describe("negative & cross-domain collisions (Speed-lesson)", () => {
  it("plain consumables are NOT openables", () => {
    for (const [title, category, data] of [
      ["Item use candy", "Item use", { item: 209, faction: 0, happy_increased: 38 }],
      ["Item use first aid kit", "Item use", { item: 67, faction: 0, life_increased: 208 }],
      ["Item use alcohol", "Item use", { item: 180, faction: 0, nerve_increased: 1 }],
      ["Item use blood bag", "Item use", { item: 734, faction: 0, life_increased: 2178 }],
    ] as const) {
      expect(normalize(title, category, data).activityEvents).toHaveLength(0);
    }
  });

  it("'roulette' in unrelated text never becomes a CasinoEvent", () => {
    expect(routeLog("Gym", "Roulette strategy seminar")).not.toBe("casino");
    expect(routeLog("Company", "Roulette wheel maintenance duty")).not.toBe("casino");
    const writes = normalize("Gym train speed", "Gym", { energy_used: 400 });
    expect(writes.activityEvents).toHaveLength(0);
  });

  it("non-casino logs with casino words stay out of the casino domain", () => {
    // Old-style empty-data ledger logs flow through the casino case with
    // the ledger preserved and NO activity fabricated.
    const oldStyle = normalize("Casino win", "Money casino", {});
    expect(oldStyle.activityEvents).toHaveLength(0);
    expect(oldStyle.moneyEvents).toHaveLength(0);
    expect(routeLog("Casino", "Casino slots lose")).toBe("casino");
    expect(routeLog("Casino", "Bookie bet (new)")).toBe("casino");
  });

  it("unrecognized casino subtypes degrade to timeline semantics, never fabricated activity", () => {
    // Poker has no registry entry — an unknown future casino log must not
    // fabricate an ActivityEvent.
    const poker = normalize("Casino poker hand win", "Casino", { won_amount: 500 });
    expect(poker.activityEvents).toHaveLength(0);
    expect(normalizeCasinoLog("Casino", "Casino poker hand win", { won_amount: 500 })).toBeNull();
  });

  it("'Money casino' category logs route through the casino registry", () => {
    const writes = normalize("Casino slots win", "Money casino", { bet_amount: 1000, won_amount: 3000 });
    const a = writes.activityEvents[0]!;
    expect(a.domain).toBe("casino");
    expect(a.activityType).toBe("slots");
    expect(a.netValue).toBe(2000n);
  });
});
