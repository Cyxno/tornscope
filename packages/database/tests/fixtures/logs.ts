import type { TornUserLog } from "@tornscope/torn-api";

/**
 * Sanitized fixtures mirroring the REAL Torn log payloads captured in a live
 * 180-day backfill (audit 2026-09). Field names and shapes are exactly as
 * Torn sends them; user ids and messages are replaced with dummies.
 */

let nextId = 50_000;

export function fixtureLog(title: string, category: string, data: Record<string, unknown>): TornUserLog {
  const id = nextId++;
  return {
    id,
    timestamp: 1_756_000_000 + id,
    details: { id, title, category },
    data,
    params: {},
  } as unknown as TornUserLog;
}

/* ------------------------------- money ---------------------------------- */

export const moneyReceive = fixtureLog("Money receive", "Money sending", {
  money: 10_000_000,
  sender: 111_111,
  message: "Thanks for spending your time with us!",
  anonymous: 0,
});

export const moneySend = fixtureLog("Money send", "Money sending", {
  money: 20_000_000,
  receiver: 222_222,
  message: "Thx!",
  anonymous: 0,
});

export const bankInvest = fixtureLog("Bank invest", "Bank", {
  worth: 151_552_000,
  amount: 148_000_000,
  percent: 2.4,
  duration: 1_209_600,
});

export const bankWithdraw = fixtureLog("Bank withdraw", "Bank", { amount: 151_552_000 });

export const companyEmployeePay = fixtureLog("Company employee pay", "Company", {
  pay: 750_000,
  company: 113_212,
  job_points: 7,
  working_stats_received: "0,26,51",
});

export const jobPay = fixtureLog("Job pay", "Job", {
  job: "Law",
  pay: 2_500,
  job_points: 5,
  working_stats_received: "27,30,38",
});

export const propertyUpkeep = fixtureLog("Property upkeep", "Property", {
  property: 13,
  ownership: "rented",
  upkeep_due: 352_500,
  property_id: 3_577_982,
  upkeep_paid: 352_500,
});

export const factionPayoutBalanceReceive = fixtureLog("Faction payout money balance receive", "Faction", {
  role: "Imitator",
  replay: 2_045_222,
  sender: 333_333,
  faction: 51_200,
  scenario: "Gaslight the Way",
  percentage: 13.33333333333333,
  balance_after: 10_002_688,
  balance_before: 8_913_934,
  balance_change: 1_088_754,
});

export const bazaarSell = fixtureLog("Bazaar sell", "Bazaars", {
  buyer: 444_444,
  items: [{ id: 385, qty: 252, uid: null }],
  cost_each: 61_061,
  cost_total: 15_387_372,
});

export const bazaarAdd = fixtureLog("Bazaar add", "Bazaars", {
  items: [{ id: 13, qty: 1, uid: 19_882_403_380 }],
  price: 226,
});

export const itemMarketSell = fixtureLog("Item market sell", "Item market", {
  fee: 101_446,
  buyer: 555_555,
  items: [{ id: 384, qty: 28, uid: null }],
  anonymous: 0,
  cost_each: 72_461,
  cost_total: 1_927_462,
});

export const itemShopBuy = fixtureLog("Item shop buy", "Shops", {
  area: 101,
  item: 209,
  quantity: 100,
  cost_each: 500,
  cost_total: 50_000,
});

export const pointsMarketBuy = fixtureLog("Points market buy", "Points market", {
  seller: 666_666,
  quantity: 50,
  cost_each: 32_055,
  cost_total: 1_602_750,
  listing_id: 20_460_536,
});

export const pointsMarketSell = fixtureLog("Points market sell", "Points market", {
  buyer: 777_777,
  quantity: 600,
  cost_each: 34_642,
  cost_total: 20_785_200,
  listing_id: 20_210_224,
});

export const pointsMarketAdd = fixtureLog("Points market add", "Points market", {
  quantity: 600,
  listing_id: 20_210_226,
  price_each: 34_642,
  price_total: 20_785_200,
});

export const pointsEnergyRefillUse = fixtureLog("Points energy refill use", "Points building", {
  faction: " ",
  points_used: 30,
  energy_increased: 150,
});

export const casinoLotteryBet = fixtureLog("Casino lottery bet", "Casino", { cost: 100, lottery: "Daily Dime" });

export const casinoSpinStart = fixtureLog("Casino spin the wheel start", "Casino", {
  cost: 1_000_000,
  wheel: "the Wheel of Awesome",
});

export const casinoWinPoints = fixtureLog("Casino spin the wheel win points", "Casino", {
  wheel: "the Wheel of Awesome",
  points: 100,
});

export const stockBuy = fixtureLog("Stock buy", "Stocks", {
  price: "736.36",
  stock: 16,
  worth: 282_762_240,
  amount: 384_000,
});

export const crimeMoneyGain = fixtureLog("Crime success bootlegging sell DVDs", "Crimes", {
  dvds: 134,
  nerve: 5,
  unique: "",
  outcome: 1368,
  crime_action: "selling counterfeit DVDs",
  money_gained: 4_700,
});

export const crimeMoneyLoss = fixtureLog("Crime critical fail money loss", "Crimes", {
  nerve: 2,
  outcome: 11_624,
  money_lost: 666,
  crime_action: "copying DVDs",
});

export const tradeMoneyIncoming = fixtureLog("Trade money incoming", "Trades", {
  user: 888_888,
  money: 18_621_410,
  trade_id: "[view]",
  parsed_trade_id: 12_428_082,
});

export const tradeMoneyEscrowAdd = fixtureLog("Trade money add other user", "Trades", {
  user: 888_888,
  money: 18_621_410,
  total: 18_621_410,
  trade_id: "[view]",
  parsed_trade_id: 12_428_082,
});

export const stashBoxMoney = fixtureLog("Item use stash box", "Item use", {
  item: 1239,
  money: 74_000,
  faction: 0,
});

export const donatorSubscription = fixtureLog("Subscription success", "Donator", {
  email: "hidden",
  value: "4.09 EUR ($4.85)",
  points: 90,
  service: "PayPal",
  frequency: "monthly",
  donator_days: 31,
  transaction_id: "hidden",
  subscription_id: "hidden",
});

/** Old-style generic money log (legacy category titles). */
export const legacyUnknownMovement = fixtureLog("Money moved", "Money", { amount: 123_456 });

/* -------------------------------- rehab --------------------------------- */

export const rehabVisit = fixtureLog("Rehab", "Travel", {
  cost: 1_000_000,
  addiction: 100,
  rehab_times: 4,
  happy_increased: 79,
});

/* ------------------------------ travel ---------------------------------- */

export const travelDepartTorn = fixtureLog("Travel depart", "Travel", {
  origin: 1,
  duration: 10_860,
  destination: 11,
  travel_method: "personal",
});

export const travelArriveAbroad = fixtureLog("Travel arrive", "Travel", { destination: 11 });

export const travelDepartAbroad = fixtureLog("Travel depart", "Travel", {
  origin: 11,
  duration: 10_860,
  destination: 1,
  travel_method: "personal",
});

export const travelArriveTorn = fixtureLog("Travel arrive", "Travel", { destination: 1 });

export const itemAbroadBuy = fixtureLog("Item abroad buy", "Travel", {
  area: 11,
  item: 384,
  quantity: 28,
  cost_each: 14_000,
  cost_total: 392_000,
});

/** Non-positive quantity guard fixture (malformed). */
export const itemAbroadBuyZeroQty = fixtureLog("Item abroad buy", "Travel", {
  area: 8,
  item: 273,
  quantity: 0,
  cost_each: 400,
  cost_total: 11_200,
});

/* ------------------------------- drugs ---------------------------------- */

export const drugUseXanax = fixtureLog("Item use xanax", "Drugs", { item: 206, faction: 0 });

export const drugUseXanaxOverdose = fixtureLog("Item use xanax overdose", "Drugs", {
  item: 206,
  faction: 0,
  happy_decreased: 5_025,
  nerve_decreased: 1,
  energy_decreased: 150,
  hospital_time_increased: 300_000,
});

export const drugUseEcstasy = fixtureLog("Item use ecstasy", "Drugs", { item: 197, faction: 0, happy_increased: 6_200 });
