import { describe, expect, it } from "vitest";
import { normalizeCasinoLog } from "../src/normalizers/casino.js";
import { normalizeOpenableLog } from "../src/normalizers/openables.js";
import { normalizeDomainLog, buildDomainMetadata } from "../src/normalizers/domains.js";
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

describe("domain normalization (2.5.0) — positive fixtures", () => {
  it("hunting session: exact cost/income/net + parsed skill", () => {
    const writes = normalize("Hunting", "Hunting", {
      cost: 500, income: 7985, session_type: "a beginners hunting session",
      hunting_skill: "56.781", hunting_skill_gain: "and gained 0.0865 hunting skill",
    });
    const a = writes.activityEvents[0]!;
    expect(a.domain).toBe("hunting");
    expect(a.subtype).toBe("beginners");
    expect(a.cashInput).toBe(500n);
    expect(a.cashReward).toBe(7985n);
    expect(a.netValue).toBe(7485n);
    expect(a.valuation).toBe("exact");
    const meta = a.metadata as { skillLevel?: number; skillGain?: number };
    expect(meta.skillLevel).toBeCloseTo(56.781, 4);
    expect(meta.skillGain).toBeCloseTo(0.0865, 4);
  });

  it("hunting skill level up: progression, no value fabricated", () => {
    const writes = normalize("Hunting skill level up", "Hunting", { skill_level: 55 });
    const a = writes.activityEvents[0]!;
    expect(a.subtype).toBe("skill-level-up");
    expect(a.outcome).toBe("progressed");
    expect(a.netValue).toBeNull();
    expect(a.valuation).toBe("unpriced");
  });

  it("missions complete: exact cash (zero stays zero) + credits as domain tokens", () => {
    const cash = normalize("Missions complete", "Missions", { type: "contract", agent: 3, money: 112000, credits: 67, mission: 51, difficulty: "vhard" });
    const a = cash.activityEvents[0]!;
    expect(a.domain).toBe("missions");
    expect(a.cashReward).toBe(112000n);
    expect(a.netValue).toBe(112000n);
    expect(a.tokensReward).toBe(67);
    expect(a.valuation).toBe("exact");

    const creditsOnly = normalize("Missions complete", "Missions", { type: "contract", money: 0, credits: 18, mission: 15, difficulty: "vhard" });
    const b = creditsOnly.activityEvents[0]!;
    expect(b.cashReward).toBe(0n);
    expect(b.tokensReward).toBe(18);
  });

  it("racing: finish ordinals + points grammar, upgrade cost exact", () => {
    const win = normalize("Racing finish official race", "Racing", { car: 82, track: 23, race_id: 20621581, position: "1st", racing_skill: "and gained 0.0228 racing skill", racing_points: "1 racing point" });
    const a = win.activityEvents[0]!;
    expect(a.domain).toBe("racing");
    expect(a.outcome).toBe("win");
    expect(a.pointsReward).toBe(1);
    expect(a.cashReward).toBeNull();
    expect(a.valuation).toBe("unpriced");
    const meta = a.metadata as { racingSkillGain?: number };
    expect(meta.racingSkillGain).toBeCloseTo(0.0228, 4);

    const mid = normalize("Racing finish official race", "Racing", { position: "3rd", racing_points: "0 racing points" });
    expect(mid.activityEvents[0]!.outcome).toBe("podium");
    expect(mid.activityEvents[0]!.pointsReward).toBe(0);

    const upgrade = normalize("Racing upgrade car", "Racing", { car: 82, cost: 3000, upgrade: 12, racing_points: "2 racing points" });
    const u = upgrade.activityEvents[0]!;
    expect(u.subtype).toBe("upgrade");
    expect(u.cashInput).toBe(3000n);
    expect(u.netValue).toBe(-3000n);
    expect(u.valuation).toBe("exact");
  });

  it("bounties: placement is a committed cost, claim is income — never one direction", () => {
    const place = normalize("Bounty place", "Bounties", { cost: 450000, reason: "", target: 3086444, quantity: 1, anonymous: null, bounty_reward: 300000 });
    const p = place.activityEvents[0]!;
    expect(p.subtype).toBe("placed");
    expect(p.cashInput).toBe(450000n);
    // bounty_reward belongs to the CLAIMER — never counted as placer income.
    expect(p.cashReward).toBeNull();
    expect(p.netValue).toBe(-450000n);
    expect(p.opponentId).toBe(3086444);

    const claim = normalize("Bounty claim", "Bounties", { lister: 3437615, target: 2135330, anonymous: 0, bounty_reward: 300000 });
    const c = claim.activityEvents[0]!;
    expect(c.subtype).toBe("claimed");
    expect(c.cashReward).toBe(300000n);
    expect(c.cashInput).toBeNull();
    expect(c.netValue).toBe(300000n);
    expect(c.opponentId).toBe(2135330);
  });

  it("education start: exact committed cost, no fabricated ROI", () => {
    const writes = normalize("Education start", "Education", { cost: 2880, course: 50, duration: 1270080 });
    const a = writes.activityEvents[0]!;
    expect(a.domain).toBe("education");
    expect(a.subtype).toBe("course-started");
    expect(a.cashInput).toBe(2880n);
    expect(a.netValue).toBe(-2880n);
    expect(a.cashReward).toBeNull();
  });
});

describe("domain normalization (2.5.0) — negative & collision fixtures", () => {
  it("missing semantic fields are never normalized", () => {
    expect(normalizeDomainLog("Hunting", "Hunting", {})).toBeNull();
    expect(normalizeDomainLog("Hunting", "Hunting skill level up", {})).toBeNull();
    expect(normalizeDomainLog("Missions", "Missions complete", {})).toBeNull();
    expect(normalizeDomainLog("Racing", "Racing upgrade car", {})).toBeNull();
    expect(normalizeDomainLog("Bounties", "Bounty place", {})).toBeNull();
    expect(normalizeDomainLog("Bounties", "Bounty claim", {})).toBeNull();
    expect(normalizeDomainLog("Education", "Education start", {})).toBeNull();
  });

  it("wrong titles inside domain categories stay unclaimed", () => {
    expect(normalizeDomainLog("Racing", "Racing finish custom race", { position: "1st" })).toBeNull();
    expect(routeLog("Racing", "Racing finish custom race")).toBe("racing"); // routed, sample-rejected → visible in diagnostics
    expect(normalizeDomainLog("Missions", "Missions dossier", { money: 5 })).toBeNull();
  });

  it("domain words outside their categories never become activities", () => {
    expect(normalize("Gym train hunting stance", "Gym", { energy_used: 200 }).activityEvents).toHaveLength(0);
    expect(normalize("Company racing team duty", "Company", {}).activityEvents).toHaveLength(0);
    expect(normalizeLogEntry(
      { id: 2, timestamp: 1_750_000_000, details: { id: 2, title: "Mission board", category: "Jobs" }, data: { money: 100 }, params: {} },
      { itemNameById: new Map(), itemIdByName: new Map() },
    ).activityEvents).toHaveLength(0);
  });

  it("unknown payload variants in domain categories degrade to diagnostics, not crashes", () => {
    const writes = normalize("Hunting", "Hunting", { session_type: "a beginners hunting session" });
    expect(writes.activityEvents).toHaveLength(0); // no cost AND no income → unclaimed
    expect(buildDomainMetadata("Hunting", "Hunting", { hunting_skill: "56.781", hunting_skill_gain: "and gained 0.0865 hunting skill" })).toMatchObject({ skillLevel: 56.781, skillGain: 0.0865 });
  });
});
