import { describe, expect, it } from "vitest";
import { normalizeLogEntry, type NormalizeContext } from "../src/normalizers/logs.js";
import { routeLog } from "../src/normalizers/titles.js";
import {
  bankInvest,
  bankWithdraw,
  bazaarAdd,
  bazaarSell,
  casinoLotteryBet,
  casinoSpinStart,
  casinoWinPoints,
  companyEmployeePay,
  crimeMoneyGain,
  crimeMoneyLoss,
  donatorSubscription,
  drugUseEcstasy,
  drugUseXanax,
  drugUseXanaxOverdose,
  factionPayoutBalanceReceive,
  itemAbroadBuy,
  itemAbroadBuyZeroQty,
  itemMarketSell,
  itemShopBuy,
  jobPay,
  legacyUnknownMovement,
  moneyReceive,
  moneySend,
  pointsEnergyRefillUse,
  pointsMarketAdd,
  pointsMarketBuy,
  pointsMarketSell,
  propertyUpkeep,
  rehabVisit,
  stashBoxMoney,
  stockBuy,
  tradeMoneyEscrowAdd,
  tradeMoneyIncoming,
  travelArriveAbroad,
  travelArriveTorn,
  travelDepartAbroad,
  travelDepartTorn,
} from "./fixtures/logs.js";

/**
 * Money/travel/rehab/drug coverage against SANITIZED REAL Torn payloads
 * (captured from a live 180-day history). These pin the actual field names
 * and category/title pairs Torn sends — not our assumptions about them.
 */

const ctx: NormalizeContext = {
  itemNameById: new Map([[384, "Teddy Bear"], [273, "Banana Orchid"]]),
  itemTypeById: new Map([[384, "Plushie"], [273, "Flower"]]),
};

function moneyOf(log: Parameters<typeof normalizeLogEntry>[0]) {
  const writes = normalizeLogEntry(log, ctx);
  expect(writes.moneyEvents).toHaveLength(1);
  return writes.moneyEvents[0]!;
}

describe("money coverage over real log titles", () => {
  it("classifies Money receive as income", () => {
    expect(moneyOf(moneyReceive)).toMatchObject({ direction: "income", amount: 10_000_000n });
  });

  it("classifies Money send as expense", () => {
    expect(moneyOf(moneySend)).toMatchObject({ direction: "expense", amount: -20_000_000n });
  });

  it("treats Bank invest as a neutral transfer of the principal", () => {
    expect(moneyOf(bankInvest)).toMatchObject({ category: "city_bank", direction: "neutral", amount: -148_000_000n });
  });

  it("treats Bank withdraw as a neutral transfer back", () => {
    expect(moneyOf(bankWithdraw)).toMatchObject({ category: "city_bank", direction: "neutral", amount: 151_552_000n });
  });

  it("maps Company employee pay via the pay key to salary income", () => {
    expect(moneyOf(companyEmployeePay)).toMatchObject({ category: "salary", direction: "income", amount: 750_000n });
  });

  it("maps Job pay to salary income", () => {
    expect(moneyOf(jobPay)).toMatchObject({ category: "salary", direction: "income", amount: 2_500n });
  });

  it("maps Property upkeep via upkeep_paid to housing expense", () => {
    expect(moneyOf(propertyUpkeep)).toMatchObject({ category: "housing", direction: "expense", amount: -352_500n });
  });

  it("maps faction balance payouts via balance_change to faction income", () => {
    expect(moneyOf(factionPayoutBalanceReceive)).toMatchObject({ category: "faction", direction: "income", amount: 1_088_754n });
  });

  it("maps Bazaar sell via cost_total to bazaar income", () => {
    expect(moneyOf(bazaarSell)).toMatchObject({ category: "bazaar", direction: "income", amount: 15_387_372n });
  });

  it("does NOT create a money event for bazaar listing management", () => {
    const writes = normalizeLogEntry(bazaarAdd, ctx);
    expect(writes.moneyEvents).toHaveLength(0);
    expect(writes.timelineEvents).toHaveLength(1); // still on the timeline
  });

  it("maps Item market sell via cost_total (net of fee) to income", () => {
    expect(moneyOf(itemMarketSell)).toMatchObject({ category: "items", direction: "income", amount: 1_927_462n });
  });

  it("maps Item shop buy via cost_total to expense", () => {
    expect(moneyOf(itemShopBuy)).toMatchObject({ category: "items", direction: "expense", amount: -50_000n });
  });

  it("maps Points market buy/sell to expense/income and skips listing adds", () => {
    expect(moneyOf(pointsMarketBuy)).toMatchObject({ category: "points", direction: "expense", amount: -1_602_750n });
    expect(moneyOf(pointsMarketSell)).toMatchObject({ category: "points", direction: "income", amount: 20_785_200n });
    expect(normalizeLogEntry(pointsMarketAdd, ctx).moneyEvents).toHaveLength(0);
    expect(normalizeLogEntry(pointsEnergyRefillUse, ctx).moneyEvents).toHaveLength(0);
  });

  it("maps casino bets to expense and point/token wins to no cash movement", () => {
    expect(moneyOf(casinoLotteryBet)).toMatchObject({ category: "casino", direction: "expense", amount: -100n });
    expect(moneyOf(casinoSpinStart)).toMatchObject({ category: "casino", direction: "expense", amount: -1_000_000n });
    expect(normalizeLogEntry(casinoWinPoints, ctx).moneyEvents).toHaveLength(0);
  });

  it("maps Stock buy via amount to stock expense", () => {
    expect(moneyOf(stockBuy)).toMatchObject({ category: "stock", direction: "expense", amount: -384_000n });
  });

  it("maps crime money_gained / money_lost to crime income/expense", () => {
    expect(moneyOf(crimeMoneyGain)).toMatchObject({ category: "crime", direction: "income", amount: 4_700n });
    expect(moneyOf(crimeMoneyLoss)).toMatchObject({ category: "crime", direction: "expense", amount: -666n });
  });

  it("counts trade money incoming once and skips escrow adds", () => {
    expect(moneyOf(tradeMoneyIncoming)).toMatchObject({ category: "trading", direction: "income", amount: 18_621_410n });
    expect(normalizeLogEntry(tradeMoneyEscrowAdd, ctx).moneyEvents).toHaveLength(0);
  });

  it("maps stash box money to income", () => {
    expect(moneyOf(stashBoxMoney)).toMatchObject({ direction: "income", amount: 74_000n });
  });

  it("does not book donator subscriptions as in-game cash", () => {
    expect(normalizeLogEntry(donatorSubscription, ctx).moneyEvents).toHaveLength(0);
  });

  it("never defaults an unknown money movement to expense", () => {
    const m = moneyOf(legacyUnknownMovement);
    expect(m.direction).toBe("unknown");
    expect(m.amount).toBe(123_456n); // magnitude preserved, direction unresolved
    expect(m.category).toBe("other");
  });
});

describe("rehab under the Travel category (real Torn filing)", () => {
  it("routes the Rehab title to rehab + one expense, not travel", () => {
    const writes = normalizeLogEntry(rehabVisit, ctx);
    expect(writes.rehabEvents).toHaveLength(1);
    expect(writes.rehabEvents[0]).toMatchObject({ cost: 1_000_000n, rehabPercent: null });
    expect(writes.travelTransitions).toHaveLength(0);
    // Same sourceRef -> re-ingesting the same log can never duplicate the money side.
    expect(writes.moneyEvents[0]!.sourceRef).toBe(writes.rehabEvents[0]!.sourceRef);
    expect(writes.moneyEvents[0]).toMatchObject({ category: "rehab", direction: "expense", amount: -1_000_000n });
  });
});

describe("travel transitions from real numeric country payloads", () => {
  it("parses departure from Torn as DEPARTED_TORN with the destination country", () => {
    const writes = normalizeLogEntry(travelDepartTorn, ctx);
    expect(writes.travelTransitions[0]).toMatchObject({ type: "DEPARTED_TORN", country: "UAE", countryId: 11 });
    expect(writes.travelItemEvents).toHaveLength(0);
  });

  it("parses arrival abroad vs arrival home", () => {
    expect(normalizeLogEntry(travelArriveAbroad, ctx).travelTransitions[0]).toMatchObject({
      type: "ARRIVED_ABROAD",
      country: "UAE",
      countryId: 11,
    });
    expect(normalizeLogEntry(travelArriveTorn, ctx).travelTransitions[0]).toMatchObject({
      type: "ARRIVED_TORN",
      country: "Torn",
      countryId: 1,
    });
  });

  it("parses departure from abroad as DEPARTED_ABROAD", () => {
    expect(normalizeLogEntry(travelDepartAbroad, ctx).travelTransitions[0]).toMatchObject({
      type: "DEPARTED_ABROAD",
      country: "UAE",
      countryId: 11,
    });
  });

  it("parses abroad purchases into transitions + items + ledger expense", () => {
    const writes = normalizeLogEntry(itemAbroadBuy, ctx);
    expect(writes.travelTransitions[0]).toMatchObject({ type: "ITEM_PURCHASE", country: "UAE", countryId: 11 });
    expect(writes.travelItemEvents[0]).toMatchObject({
      itemId: 384,
      itemName: "Teddy Bear",
      quantity: 28,
      unitCost: 14_000n,
      totalCost: 392_000n,
      category: "plushie",
    });
    expect(writes.moneyEvents[0]).toMatchObject({ direction: "expense", amount: -392_000n });
  });

  it("guards against non-positive quantities when computing unit cost", () => {
    const writes = normalizeLogEntry(itemAbroadBuyZeroQty, ctx);
    const item = writes.travelItemEvents[0]!;
    expect(item.quantity).toBeGreaterThanOrEqual(1); // never 0 or negative
    expect(item.unitCost).toBe(11_200n); // totalCost instead of a division by zero
  });
});

describe("drug recognition over real titles", () => {
  it("recognizes xanax use and overdose variants", () => {
    expect(normalizeLogEntry(drugUseXanax, ctx).drugEvents[0]).toMatchObject({
      drugItemId: 206,
      drugName: "Xanax",
      outcome: "success",
    });
    expect(normalizeLogEntry(drugUseXanaxOverdose, ctx).drugEvents[0]).toMatchObject({
      drugItemId: 206,
      drugName: "Xanax",
      outcome: "overdose",
    });
    expect(normalizeLogEntry(drugUseEcstasy, ctx).drugEvents[0]).toMatchObject({
      drugItemId: 197,
      drugName: "Ecstasy",
      outcome: "success",
    });
  });

  it("does not mistake non-drug titles containing market words for drugs", () => {
    expect(routeLog("Points market", "Points market buy")).toBe("money");
    expect(routeLog("Item market", "Item market sell")).toBe("money");
  });
});

describe("every normalized entry lands on the timeline exactly once", () => {
  const all = [
    moneyReceive, moneySend, bankInvest, bankWithdraw, companyEmployeePay, jobPay,
    propertyUpkeep, factionPayoutBalanceReceive, bazaarSell, bazaarAdd, itemMarketSell,
    itemShopBuy, pointsMarketBuy, pointsMarketSell, pointsMarketAdd, casinoLotteryBet,
    casinoWinPoints, stockBuy, crimeMoneyGain, crimeMoneyLoss, tradeMoneyIncoming,
    tradeMoneyEscrowAdd, stashBoxMoney, donatorSubscription, rehabVisit,
    travelDepartTorn, travelArriveAbroad, travelDepartAbroad, travelArriveTorn, itemAbroadBuy,
    drugUseXanax, drugUseXanaxOverdose,
  ];
  for (const log of all) {
    it(`timeline entry for "${log.details.title}"`, () => {
      expect(normalizeLogEntry(log, ctx).timelineEvents).toHaveLength(1);
    });
  }
});
