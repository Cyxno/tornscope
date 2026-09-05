import type { MoneyCategory } from "@tornscope/shared";
import type { LogRecord } from "./extract.js";

/**
 * Log-title driven routing, built from the ACTUAL Torn log shapes observed in
 * a real 180-day backfill (2026-09 audit) cross-checked against the official
 * /torn/logcategories catalog.
 *
 * Torn's per-log `details.category` does not always line up with the
 * logcategory catalog (e.g. rehab visits are filed under the "Travel"
 * category with the title "Rehab"), so routing always considers BOTH the
 * category and the title. Keyword-only routing provably dropped data:
 * - "Travel" / "Rehab" was routed to travel (rehab spend showed $0)
 * - travel logs carry numeric country IDS (destination: 8), not names, so
 *   string-only extraction dropped every transition (0 trips)
 * - real money payloads use keys like pay / cost_total / money_gained /
 *   balance_change / upkeep_paid which the old generic extractor missed.
 */

/* -------------------------------------------------------------------------- */
/* Countries                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Torn country ids as used by travel log payloads (`destination`, `origin`,
 * `area`).
 *
 * Source: the official Torn API v2 OpenAPI spec's `CountryEnum`, whose values
 * are declared in COUNTRY-ID ORDER (not alphabetical):
 *   Torn(1), Mexico(2), Hawaii(3), South Africa(4), Japan(5), China(6),
 *   Argentina(7), Switzerland(8), Canada(9), United Kingdom(10), UAE(11),
 *   Cayman Islands(12).
 *
 * Cross-checked against live 180-day account data (2026-09):
 * - id 8: "Chamois Plushie" + "Ergotamine Ampoule" bought abroad (Swiss
 *   exclusives) and a real flight to Switzerland — the previous alphabetical
 *   table mislabeled it "Mexico".
 * - id 9: "Wolverine Plushie" (Canada).
 * - id 10: "Heather" flower (United Kingdom).
 * - id 11: /v2/user/travel reports destination "UAE" for a departure log with
 *   destination 11; "Camel Plushie" + "Tribulus Omanense" bought in area 11.
 */
export const TORN_COUNTRY_NAMES: Record<number, string> = {
  1: "Torn",
  2: "Mexico",
  3: "Hawaii",
  4: "South Africa",
  5: "Japan",
  6: "China",
  7: "Argentina",
  8: "Switzerland",
  9: "Canada",
  10: "United Kingdom",
  11: "UAE",
  12: "Cayman Islands",
};

export const TORN_HOME_COUNTRY_ID = 1;

/** Country name for a Torn country id, or null when the id is unmapped. */
export function countryName(id: number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  return TORN_COUNTRY_NAMES[id] ?? null;
}

/**
 * Display label for a country id. Unknown ids are surfaced explicitly —
 * they are never silently mapped to a wrong (or placeholder) country.
 */
export function countryLabel(id: number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  return TORN_COUNTRY_NAMES[id] ?? `Unknown destination ID ${id}`;
}

/* -------------------------------------------------------------------------- */
/* Travel transitions                                                         */
/* -------------------------------------------------------------------------- */

export const TRAVEL_TRANSITION_TYPES = [
  "DEPARTED_TORN",
  "ARRIVED_ABROAD",
  "DEPARTED_ABROAD",
  "ARRIVED_TORN",
  "ITEM_PURCHASE",
] as const;

export type TravelTransitionType = (typeof TRAVEL_TRANSITION_TYPES)[number];

const COUNTRY_ID_KEYS = ["destination", "origin", "area", "country", "country_id"];

function pickCountryId(data: LogRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

/**
 * Map a travel-domain log (category/title) to the transition it evidences.
 *
 * Real forms seen in a 180-day history (category "Travel"):
 * - "Travel depart" data {origin, duration, destination, travel_method}
 *     origin = 1 (Torn)  -> DEPARTED_TORN  to country `destination`
 *     origin != 1         -> DEPARTED_ABROAD from country `origin`
 * - "Travel arrive" data {destination}
 *     destination = 1     -> ARRIVED_TORN (back home)
 *     destination != 1    -> ARRIVED_ABROAD in country `destination`
 * - "Item abroad buy" data {area, item, quantity, cost_each, cost_total}
 *                         -> ITEM_PURCHASE in country `area`
 */
export function travelTransitionFor(title: string, data: LogRecord): { type: TravelTransitionType; countryId: number | null; country: string | null } | null {
  const t = title.toLowerCase();

  if (/^travel depart\b/.test(t) || /\bdepart/.test(t) && /travel|fly/.test(t)) {
    const origin = pickCountryId(data, ["origin", "from"]);
    const destination = pickCountryId(data, ["destination", "to"]);
    if (origin !== null && origin !== TORN_HOME_COUNTRY_ID) {
      return { type: "DEPARTED_ABROAD", countryId: origin, country: countryLabel(origin) };
    }
    return { type: "DEPARTED_TORN", countryId: destination, country: countryLabel(destination) };
  }

  if (/^travel arrive\b/.test(t) || /\barriv|land(ed)?\b/.test(t)) {
    const destination = pickCountryId(data, ["destination", "country", "to"]);
    if (destination === TORN_HOME_COUNTRY_ID) {
      return { type: "ARRIVED_TORN", countryId: destination, country: countryLabel(destination) };
    }
    return { type: "ARRIVED_ABROAD", countryId: destination, country: countryLabel(destination) };
  }

  if (/\babroad\b.*\b(buy|bought|purchas\w*)\b|\b(buy|bought|purchas\w*)\b.*\babroad\b|^item abroad\b/.test(t)) {
    const area = pickCountryId(data, ["area", "country", "destination"]);
    return { type: "ITEM_PURCHASE", countryId: area, country: countryLabel(area) };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Drugs                                                                      */
/* -------------------------------------------------------------------------- */

const DRUG_NAME_ALIASES: Array<[RegExp, string]> = [
  [/\blove juice\b/i, "Love Juice"],
  [/\bxanax\b/i, "Xanax"],
  [/\becstasy\b|\bextacy\b/i, "Ecstasy"],
  [/\blsd\b/i, "LSD"],
  [/\bcannabis\b|\bweed\b|\bpot\b/i, "Cannabis"],
  [/\bketamine\b/i, "Ketamine"],
  [/\bopium\b/i, "Opium"],
  [/\bpcp\b|\bangel dust\b/i, "PCP"],
  [/\bshrooms?\b|\bmushrooms?\b/i, "Shrooms"],
  [/\bspeed\b|\bamphetamines?\b/i, "Speed"],
  [/\bvicodin\b/i, "Vicodin"],
];

/** Canonical drug name when the log title names one, else null. */
export function drugNameFromTitle(title: string): string | null {
  for (const [pattern, name] of DRUG_NAME_ALIASES) {
    if (pattern.test(title)) return name;
  }
  return null;
}

/** "Item use xanax" / "Item use xanax overdose" -> the used item part. */
export function isDrugUseTitle(title: string): boolean {
  return drugNameFromTitle(title) !== null;
}

export function isOverdoseTitle(title: string): boolean {
  return /overdos/i.test(title);
}

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Amount keys observed in real payloads, most specific first. `cost_total`
 * and friends beat generic keys: "Points market add" carries price_total for
 * a listing (not a movement) while "Points market buy" carries cost_total.
 */
export const MONEY_AMOUNT_KEYS = [
  "money",
  "money_gained",
  "money_lost",
  "money_mugged",
  "balance_change",
  "upkeep_paid",
  "cost_total",
  "cost",
  "pay",
  "amount",
  "price_total",
  "gain",
  "profit",
  "total",
  "value",
] as const;

export interface MoneyPlan {
  category: MoneyCategory;
  direction: "income" | "expense" | "neutral";
  /** true -> this log is definitively not a cash movement; no MoneyEvent. */
  skip: boolean;
  /** Money stays the player's own (bank/pool movement): never P&L. */
  transfer: boolean;
}

/**
 * Classify a money-bearing log by its REAL title/category.
 * Returns null when no specific rule matches — the caller then applies the
 * conservative fallback (generic keyword heuristics) and, if still
 * unclassifiable, records direction "unknown" which never enters P&L.
 *
 * Mappings documented from the live 180-day audit:
 *
 *  category        title                                  -> classification
 *  --------------- --------------------------------------  --------------------------
 *  Money sending   Money receive                          income  (data.money)
 *  Money sending   Money send                             expense (data.money)
 *  Bank            Bank invest                            transfer -amount (city bank)
 *  Bank            Bank withdraw                          transfer +amount (city bank)
 *  Faction         Faction payout money receive           income  (data.money)
 *  Faction         Faction payout money balance receive   income  (balance_change)
 *  Bazaars         Bazaar sell                            income  (cost_total)
 *  Bazaars         Bazaar add/remove/edit/open / close    none    (listing management)
 *  Item market     Item market sell                       income  (cost_total, net of fee)
 *  Item market     Item market buy                        expense (cost_total)
 *  Shops           Item shop buy                          expense (cost_total)
 *  Points market   Points market buy                      expense (cost_total)
 *  Points market   Points market sell                     income  (cost_total)
 *  Points market   Points market add/remove               none    (listing management)
 *  Points building Points energy refill use / unlocks     none    (points spent, cash already paid)
 *  Casino          Casino lottery bet / spin start        expense (cost)
 *  Casino          Casino spin the wheel win points       none    (Torn points, not cash)
 *  Casino          Casino spin the wheel win casino tokens none   (tokens, not cash)
 *  Stocks          Stock buy                              expense (amount)
 *  Stocks          Stock sell                             income  (amount)
 *  Company         Company employee pay                   income  (pay)
 *  Job             Job pay                                income  (pay)
 *  Property        Property upkeep                        expense (upkeep_paid)
 *  Crimes          Crime success ... sell ...             income  (money_gained)
 *  Crimes          Crime critical fail money loss         expense (money_lost)
 *  Trades          Trade money incoming                   income  (money, actual credit)
 *  Trades          Trade money add ... / outgoing         none    (escrow, credited on accept)
 *  Item use        Item use stash box                     income  (data.money)
 *  Donator         Subscription success                   none    (real-world purchase, not in-game cash)
 */
export function moneyPlanFor(category: string, title: string): MoneyPlan | null {
  const t = title.toLowerCase();
  const c = category.toLowerCase();
  const is = (pattern: RegExp): boolean => pattern.test(t);

  // --- explicit non-movements first (must not fall through to "unknown") ---
  if (is(/^bazaar (add|remove|edit|open \/ close|open|close)$/)) return { category: "bazaar", direction: "neutral", skip: true, transfer: false };
  if (is(/^points market (add|remove)$/)) return { category: "points", direction: "neutral", skip: true, transfer: false };
  if (is(/^points (energy refill use|bazaar unlock|merit reset use|nerve refill use)$/)) return { category: "points", direction: "neutral", skip: true, transfer: false };
  if (is(/casino spin the wheel win points$/)) return { category: "casino", direction: "neutral", skip: true, transfer: false };
  if (is(/win casino tokens$/)) return { category: "casino", direction: "neutral", skip: true, transfer: false };
  if (is(/^trade money (add|outgoing|remove)/)) return { category: "trading", direction: "neutral", skip: true, transfer: false };
  if (is(/^subscription success|^donator/)) return { category: "other", direction: "neutral", skip: true, transfer: false };

  // --- transfers: money moves between the player's own pools ---
  if (is(/^bank invest/)) return { category: "city_bank", direction: "neutral", skip: false, transfer: true };
  if (is(/^bank (withdraw|withdrawal)/)) return { category: "city_bank", direction: "neutral", skip: false, transfer: true };
  if (is(/^bank deposit/)) return { category: "city_bank", direction: "neutral", skip: false, transfer: true };
  if (is(/cayman|swiss bank|offshore/)) return { category: "cayman_bank", direction: "neutral", skip: false, transfer: true };
  if (is(/piggy bank/)) return { category: "city_bank", direction: "neutral", skip: false, transfer: true };

  // --- income with dedicated payload keys ---
  if (is(/^(money receive|money incoming)\b/)) return { category: "other", direction: "income", skip: false, transfer: false };
  if (is(/^(money send|money outgoing)\b/)) return { category: "other", direction: "expense", skip: false, transfer: false };
  if (is(/^faction payout money balance receive/)) return { category: "faction", direction: "income", skip: false, transfer: false };
  if (is(/^faction payout money receive/)) return { category: "faction", direction: "income", skip: false, transfer: false };
  if (is(/^faction (deposit|withdraw)/)) return { category: "faction", direction: "neutral", skip: false, transfer: true };
  if (is(/^bazaar sell/)) return { category: "bazaar", direction: "income", skip: false, transfer: false };
  if (is(/^bazaar buy/)) return { category: "bazaar", direction: "expense", skip: false, transfer: false };
  if (is(/^property buy/)) return { category: "housing", direction: "expense", skip: false, transfer: false };
  if (is(/^item market sell/)) return { category: "items", direction: "income", skip: false, transfer: false };
  if (is(/^item market buy/)) return { category: "items", direction: "expense", skip: false, transfer: false };
  if (is(/^item shop buy|^shops? /)) return { category: "items", direction: "expense", skip: false, transfer: false };
  if (is(/^points market buy/)) return { category: "points", direction: "expense", skip: false, transfer: false };
  if (is(/^points market sell/)) return { category: "points", direction: "income", skip: false, transfer: false };
  if (is(/^points purchase|points bought/)) return { category: "points", direction: "expense", skip: false, transfer: false };
  if (is(/^company employee pay|^company pay/)) return { category: "salary", direction: "income", skip: false, transfer: false };
  if (is(/^job pay/)) return { category: "salary", direction: "income", skip: false, transfer: false };
  if (is(/^property upkeep|^upkeep/)) return { category: "housing", direction: "expense", skip: false, transfer: false };
  if (is(/^stock buy/)) return { category: "stock", direction: "expense", skip: false, transfer: false };
  if (is(/^stock sell/)) return { category: "stock", direction: "income", skip: false, transfer: false };
  if (is(/^trade money incoming|^trade completed money/)) return { category: "trading", direction: "income", skip: false, transfer: false };
  if (is(/^item use stash box/)) return { category: "other", direction: "income", skip: false, transfer: false };
  if (is(/casino (lottery|spin the wheel) (bet|start)/)) return { category: "casino", direction: "expense", skip: false, transfer: false };
  if (is(/casino.*\bwin\b/) && !is(/points|tokens/)) return { category: "casino", direction: "income", skip: false, transfer: false };
  if (is(/casino|lottery|bet|blackjack|poker|roulette|slots|keno|craps|high.?low|bookie/)) return { category: "casino", direction: "expense", skip: false, transfer: false };

  // --- crime money side (crimes module itself is out of scope for now) ---
  if (is(/crime.*(money loss|money_lost)/) || is(/money loss/)) return { category: "crime", direction: "expense", skip: false, transfer: false };
  if (c.includes("crime") && is(/sell|reward|bounty|success/)) return { category: "crime", direction: "income", skip: false, transfer: false };
  if (is(/crime success/)) return { category: "crime", direction: "income", skip: false, transfer: false };

  // --- mugging ---
  // --- mugging (attack logs; "receive" = the user was mugged) ---
  if (is(/^attack mug receive/)) return { category: "mugging", direction: "expense", skip: false, transfer: false };
  if (is(/^attack mug/)) return { category: "mugging", direction: "income", skip: false, transfer: false };
  if (is(/mug(ged|ging)?/)) return { category: "mugging", direction: "income", skip: false, transfer: false };

  // --- generic older-style categories ("Money", "Money incoming/outgoing") ---
  if (c === "money incoming" || is(/\b(received|gained|won|sold|payout|reward|found)\b/)) return { category: "other", direction: "income", skip: false, transfer: false };
  if (c === "money outgoing" || is(/\b(bought|paid|spent|purchase|donat|fee|fine|bail)\b/)) return { category: "other", direction: "expense", skip: false, transfer: false };
  if (c === "bank") return { category: "city_bank", direction: "neutral", skip: false, transfer: true };

  return null;
}

/**
 * Fallback money category from free text (old-style log titles such as
 * "Deposited money in the city bank").
 */
export function classifyMoneyCategory(text: string): MoneyCategory {
  const t = text.toLowerCase();
  if (/plushie/.test(t)) return "plushie";
  if (/flower/.test(t)) return "flower";
  if (/mug/.test(t)) return "mugging";
  if (/ranked.?war/.test(t)) return "ranked_war";
  if (/rehab/.test(t)) return "rehab";
  if (/drug/.test(t)) return "drugs";
  if (/stock/.test(t)) return "stock";
  if (/casino|bookie|bet|lottery|slots|roulette|blackjack|poker|high.?low/.test(t)) return "casino";
  if (/point/.test(t)) return "points";
  if (/bazaar/.test(t)) return "bazaar";
  if (/auction/.test(t)) return "auction";
  if (/cayman|swiss|offshore|abroad.*bank/.test(t)) return "cayman_bank";
  if (/city.?bank|\bbank\b|savings|deposit|withdraw|piggy/.test(t)) return "city_bank";
  if (/salary|job|paycheck|wage|company/.test(t)) return "salary";
  if (/education|course/.test(t)) return "education";
  if (/hospital|surgery|medical/.test(t)) return "hospital";
  if (/jail|bail/.test(t)) return "jail";
  if (/trade|sold|sell/.test(t)) return "trading";
  if (/item|shop/.test(t)) return "items";
  if (/upkeep|property|rent/.test(t)) return "housing";
  if (/faction/.test(t)) return "faction";
  if (/crime/.test(t)) return "crime";
  if (/travel|fly|abroad/.test(t)) return "travel";
  return "other";
}

/** Movement words that mean the player received money (old-style titles). */
const INCOME_WORDS = /gain|gained|received?|won|sold|income|payout|payou|reward|refund|mugg(ed)?|steal|profit|interest|found|withdrew|withdrawing/i;
/** Words that mean the player paid money. */
const EXPENSE_WORDS = /spent|spend|paid|pay\b|paying|bought|purchase|lost|loss|fee|fine|cost|donat|invested/i;
/** Money moving between the player's own pools (never P&L). */
const TRANSFER_WORDS = /deposit|withdraw|withdrew|withdrawing|transferr|invest(ed|ing)?|savings|piggy/i;

export { INCOME_WORDS, EXPENSE_WORDS, TRANSFER_WORDS };

/* -------------------------------------------------------------------------- */
/* Domain routing                                                             */
/* -------------------------------------------------------------------------- */

export type LogRoute = "money" | "rehab" | "travel" | "drugs" | "itemuse" | "crimes" | "timeline";

/**
 * Route a raw log to its structured domain (or "timeline" for timeline-only
 * entries). Order matters: "Rehab" (filed under category "Travel") must hit
 * rehab before travel; "Item abroad buy" is a travel purchase, not a generic
 * item/money log.
 */
export function routeLog(category: string, title: string): LogRoute {
  const t = title.toLowerCase();
  const c = category.toLowerCase();

  // Rehab visits are titled "Rehab" but filed under the Travel category.
  if (t === "rehab" || c.includes("rehab") || t.includes("rehab") || c.includes("rehabilitation")) return "rehab";

  // Travel: transitions and abroad purchases.
  if (c.includes("travel") || c.includes("abroad") || t.includes("abroad")) return "travel";

  // Drug use (category "Drugs", titles like "Item use xanax").
  if (c.includes("drug") || isDrugUseTitle(title)) return "drugs";

  // Crime attempts and consequences (category "Crimes") — normalized to
  // CrimeEvents with the cash side mirrored into MoneyEvent.
  if (c === "crimes") return "crimes";

  // Generic consumable item use ("Item use erotic dvd", energy drinks, candy,
  // boosters, medical items). Stash boxes pay out cash at use and stay on the
  // money route; the normalizer skips anything that is not a tracked
  // consumable.
  if (/^(item use|used|consumed)\b/i.test(t) && !t.includes("stash")) return "itemuse";

  // Money: broad financial surface. Keyword set mirrors the worker's fetch
  // keywords plus the real category names ("Money sending", "Points market",
  // "Item market", "Company", "Job", "Property", "Shops", "Donator", ...).
  const MONEY_ROUTE_WORDS = [
    "money", "bank", "bazaar", "casino", "stock", "point", "auction", "crime",
    "mug", "payout", "faction", "trade", "salary", "job", "company", "property",
    "shop", "item market", "donator", "loan", "upkeep", "piggy", "offshore",
    "item use stash",
  ];
  if (MONEY_ROUTE_WORDS.some((kw) => c.includes(kw) || t.includes(kw))) return "money";

  return "timeline";
}
