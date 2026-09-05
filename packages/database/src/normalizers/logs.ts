import type { TornUserLog } from "@tornscope/torn-api";
import {
  sourceRef,
  pickNumber,
  pickString,
  pickNestedNumber,
  pickNestedString,
  stripHtml,
  type LogRecord,
} from "./extract.js";
import { LOG_CATEGORY_ROUTES, type MoneyCategory } from "@tornscope/shared";

/**
 * Normalization layer: raw Torn log entries -> typed domain events.
 *
 * Routing is driven by the log entry's own `details.category` title (each
 * entry carries it), matched against the LOG_CATEGORY_ROUTES keywords.
 * Category -> money-category mapping is keyword based and intentionally
 * conservative: unknown categories still land on the unified timeline, so no
 * information is lost, but nothing is presented as structured data that we
 * cannot actually derive.
 */

export interface DrugEventInput {
  occurredAt: Date;
  drugItemId: number | null;
  drugName: string | null;
  outcome: "success" | "overdose";
  sourceRef: string;
  raw: unknown;
}

export interface RehabEventInput {
  occurredAt: Date;
  rehabPercent: number | null;
  cost: bigint | null;
  addictionPointsRemoved: number | null;
  sourceRef: string;
  raw: unknown;
}

export interface TravelEventInput {
  destination: string;
  departedAt: Date;
  arrivedAt: Date | null;
  returnedAt: Date | null;
  durationSeconds: number | null;
  status: string;
  sourceRef: string;
  raw: unknown;
}

export interface TravelItemEventInput {
  occurredAt: Date;
  destination: string | null;
  category: "plushie" | "flower" | "other";
  itemId: number;
  itemName: string | null;
  quantity: number;
  unitCost: bigint;
  totalCost: bigint;
  sourceRef: string;
  raw: unknown;
}

export interface MoneyEventInput {
  occurredAt: Date;
  category: MoneyCategory;
  subcategory: string | null;
  direction: "income" | "expense" | "neutral";
  amount: bigint; // signed
  sourceRef: string;
  description: string | null;
  raw: unknown;
}

export interface TimelineEventInput {
  occurredAt: Date;
  type: string;
  category: string | null;
  title: string;
  description: string | null;
  amount: bigint | null;
  sourceRef: string;
  raw: unknown;
}

export interface NormalizedLogWrites {
  drugEvents: DrugEventInput[];
  rehabEvents: RehabEventInput[];
  travelEvents: TravelEventInput[];
  travelItemEvents: TravelItemEventInput[];
  moneyEvents: MoneyEventInput[];
  timelineEvents: TimelineEventInput[];
  unmapped: number;
}

export interface NormalizeContext {
  /** itemId -> item name, from the cached Torn item catalog. */
  itemNameById: Map<number, string>;
}

const DRUG_ITEM_KEYS = ["item", "drug", "item_id", "itemId", "drug_id"];
const ITEM_ID_KEYS = ["id", "item", "item_id", "itemId"];
const QTY_KEYS = ["qty", "quantity", "amount", "count"];
const COST_KEYS = ["cost", "price", "total", "amount", "money", "value"];
const MONEY_AMOUNT_KEYS = ["amount", "money", "total", "value", "gain", "profit"];
const PERCENT_KEYS = ["percentage", "percent", "rehab", "rehab_percent", "progress"];
const COUNTRY_KEYS = ["country", "destination", "abroad_country"];

const INCOME_WORDS = /gain|gained|received?|won|sold|income|payout|payou|reward|refund|mugg(ed)?|steal|profit|interest|withdrew|withdrawing|sold/i;
const EXPENSE_WORDS = /spent|spend|paid|pay|bought|purchase|lost|loss|fee|fine|cost|donat|invested/i;
/** Money moving between own accounts/pools: a transfer, never income/expense. */
const TRANSFER_WORDS = /deposit|withdraw|withdrew|withdrawing|transferr|invest(ed|ing)?|savings/i;

export function classifyMoneyCategory(text: string): MoneyCategory {
  const t = text.toLowerCase();
  if (/plushie/.test(t)) return "plushie";
  if (/flower/.test(t)) return "flower";
  if (/mug/.test(t)) return "mugging";
  if (/ranked.?war/.test(t)) return "ranked_war";
  if (/faction/.test(t)) return "faction";
  if (/crime/.test(t)) return "crime";
  if (/rehab/.test(t)) return "rehab";
  if (/drug/.test(t)) return "drugs";
  if (/stock/.test(t)) return "stock";
  if (/casino|bookie|bet|lottery|slots|roulette|blackjack|poker|high.?low/.test(t)) return "casino";
  if (/point/.test(t)) return "points";
  if (/bazaar/.test(t)) return "bazaar";
  if (/auction/.test(t)) return "auction";
  if (/cayman|swiss|abroad.*bank/.test(t)) return "cayman_bank";
  if (/city.?bank|\bbank\b|savings|deposit|withdraw/.test(t)) return "city_bank";
  if (/salary|job|paycheck|wage/.test(t)) return "salary";
  if (/education|course/.test(t)) return "education";
  if (/hospital|surgery|medical/.test(t)) return "hospital";
  if (/jail|bail/.test(t)) return "jail";
  if (/travel|fly|abroad/.test(t)) return "travel";
  if (/trade|sold|sell/.test(t)) return "trading";
  if (/item/.test(t)) return "items";
  return "other";
}

function routeForCategoryTitle(categoryTitle: string): keyof typeof LOG_CATEGORY_ROUTES | null {
  const t = categoryTitle.toLowerCase();
  for (const [route, keywords] of Object.entries(LOG_CATEGORY_ROUTES)) {
    if (keywords.some((kw) => t.includes(kw))) return route as keyof typeof LOG_CATEGORY_ROUTES;
  }
  return null;
}

function directionFor(text: string): "income" | "expense" {
  if (EXPENSE_WORDS.test(text) && !INCOME_WORDS.test(text)) return "expense";
  if (INCOME_WORDS.test(text)) return "income";
  return "expense"; // Torn money log entries default to outflows for most categories
}

function isPlushieOrFlower(name: string | null): "plushie" | "flower" | "other" {
  if (name && /plushie/i.test(name)) return "plushie";
  if (name && /flower|rose|daffodil|orchid|heather|ceibo|edeweiss|peony|cherry blossom|african daisy|tribulus|banana orchid/i.test(name)) return "flower";
  return "other";
}

/**
 * Normalize a single Torn log entry into typed event writes.
 * Every entry always produces a timeline event; category-specific tables are
 * filled only when their shape is recognized.
 */
export function normalizeLogEntry(log: TornUserLog, ctx: NormalizeContext): NormalizedLogWrites {
  const writes: NormalizedLogWrites = {
    drugEvents: [],
    rehabEvents: [],
    travelEvents: [],
    travelItemEvents: [],
    moneyEvents: [],
    timelineEvents: [],
    unmapped: 0,
  };

  const occurredAt = new Date(log.timestamp * 1000);
  const categoryTitle = log.details.category;
  const ref = sourceRef(["torn_log", log.id]);

  // Unified timeline gets every entry (this is what makes the timeline page
  // complete even for categories we have not specialized yet).
  writes.timelineEvents.push({
    occurredAt,
    type: "log",
    category: categoryTitle,
    title: log.details.title,
    description: null,
    amount: null,
    sourceRef: ref,
    raw: log,
  });

  const route = routeForCategoryTitle(categoryTitle);
  if (!route) {
    writes.unmapped += 1;
    return writes;
  }

  const data: LogRecord = log.data ?? {};
  const params: LogRecord = log.params ?? {};

  switch (route) {
    case "drugs": {
      const itemId = pickNestedNumber(data, DRUG_ITEM_KEYS, ["id"]) ?? pickNumber(data, DRUG_ITEM_KEYS);
      const drugName =
        (itemId !== null ? ctx.itemNameById.get(itemId) ?? null : null) ??
        pickNestedString(data, DRUG_ITEM_KEYS, ["name"]) ??
        pickString(data, ["drug_name", "name"]);
      const overdosed = /overdos/i.test(log.details.title) || /overdos/i.test(categoryTitle);
      writes.drugEvents.push({
        occurredAt,
        drugItemId: itemId,
        drugName,
        outcome: overdosed ? "overdose" : "success",
        sourceRef: ref,
        raw: log,
      });
      break;
    }
    case "rehab": {
      const cost = pickNumber(data, COST_KEYS) ?? pickNumber(params, COST_KEYS);
      const percent = pickNumber(data, PERCENT_KEYS) ?? pickNumber(params, PERCENT_KEYS);
      const points = pickNumber(data, ["points", "addiction_points", "ap"]) ?? pickNumber(params, ["points", "addiction_points", "ap"]);
      writes.rehabEvents.push({
        occurredAt,
        rehabPercent: percent,
        cost: cost !== null ? BigInt(Math.round(cost)) : null,
        addictionPointsRemoved: points,
        sourceRef: ref,
        raw: log,
      });
      if (cost !== null) {
        writes.moneyEvents.push({
          occurredAt,
          category: "rehab",
          subcategory: null,
          direction: "expense",
          amount: -BigInt(Math.round(cost)),
          sourceRef: ref,
          description: `Rehabilitation (${categoryTitle})`,
          raw: log,
        });
      }
      break;
    }
    case "travel": {
      const country =
        pickString(data, COUNTRY_KEYS) ??
        pickNestedString(data, ["country", "destination"], ["name", "title"]) ??
        pickString(params, COUNTRY_KEYS);

      const itemPurchase =
        /item|bought|purchase|buy|shop/i.test(log.details.title + " " + categoryTitle) &&
        !/depart|fly|travel(ed)?|leav|went|arriv|return/i.test(log.details.title);

      if (itemPurchase) {
        // Items bought while abroad.
        const itemId = pickNestedNumber(data, DRUG_ITEM_KEYS, ["id"]) ?? pickNumber(data, ITEM_ID_KEYS);
        if (itemId !== null) {
          const quantity = pickNumber(data, QTY_KEYS) ?? 1;
          const totalCost = pickNumber(data, COST_KEYS);
          const name = (itemId !== null ? ctx.itemNameById.get(itemId) ?? null : null) ?? pickNestedString(data, DRUG_ITEM_KEYS, ["name"]);
          const unit = totalCost !== null ? Math.round(totalCost / quantity) : 0;
          writes.travelItemEvents.push({
            occurredAt,
            destination: country,
            category: isPlushieOrFlower(name),
            itemId,
            itemName: name,
            quantity,
            unitCost: BigInt(unit),
            totalCost: BigInt(Math.round(totalCost ?? 0)),
            sourceRef: ref,
            raw: log,
          });
          if (totalCost !== null && totalCost > 0) {
            writes.moneyEvents.push({
              occurredAt,
              category: isPlushieOrFlower(name) === "plushie" ? "plushie" : isPlushieOrFlower(name) === "flower" ? "flower" : "travel",
              subcategory: name,
              direction: "expense",
              amount: -BigInt(Math.round(totalCost)),
              sourceRef: ref,
              description: `Purchased ${quantity}x ${name ?? `item ${itemId}`} abroad`,
              raw: log,
            });
          }
        }
      } else {
        const isArrival = /arriv|return|back|land/i.test(log.details.title);
        const isDeparture = /depart|fly|travel|leav|went|abroad/i.test(log.details.title) || /abroad/i.test(categoryTitle);

        if (country && (isDeparture || isArrival)) {
          writes.travelEvents.push({
            destination: country,
            departedAt: isDeparture ? occurredAt : new Date(log.timestamp * 1000),
            arrivedAt: isArrival ? occurredAt : null,
            returnedAt: /return|back to torn|home/i.test(log.details.title) ? occurredAt : null,
            durationSeconds: pickNumber(data, ["duration", "time", "flight_time"]),
            status: isArrival ? "arrived" : isDeparture ? "departed" : "unknown",
            sourceRef: ref,
            raw: log,
          });
        }
      }
      break;
    }
    case "money": {
      const amount = pickNumber(data, MONEY_AMOUNT_KEYS) ?? pickNumber(params, MONEY_AMOUNT_KEYS);
      const text = `${log.details.title} ${categoryTitle}`;
      if (amount !== null && amount !== 0) {
        const magnitude = BigInt(Math.round(Math.abs(amount)));
        const category = classifyMoneyCategory(text);

        // Bank movements (city/cayman) and faction pool deposits/withdrawals
        // are TRANSFERS: the money stays the player's, so they must never
        // inflate income or spending. They keep a signed amount (out of the
        // wallet on deposit/invest, back in on withdrawal) with direction
        // "neutral", which the flow aggregations exclude.
        const isTransfer =
          TRANSFER_WORDS.test(text) &&
          (category === "city_bank" || category === "cayman_bank" || category === "faction");

        let direction: "income" | "expense" | "neutral";
        let signed: bigint;
        if (isTransfer) {
          direction = "neutral";
          // Money coming back to the player (withdrawals, receives) is positive.
          signed = /withdrew|withdraw|withdrawing|receive|received/i.test(text) ? magnitude : -magnitude;
        } else {
          direction = directionFor(text);
          signed = direction === "income" ? magnitude : -magnitude;
        }

        writes.moneyEvents.push({
          occurredAt,
          category,
          subcategory: categoryTitle,
          direction,
          amount: signed,
          sourceRef: ref,
          description: log.details.title,
          raw: log,
        });
      }
      break;
    }
  }

  return writes;
}

/** Build a timeline event from a Torn event (HTML text). Live v2 ids are strings. */
export function normalizeTornEvent(event: { id: number | string; timestamp: number; event: string }): TimelineEventInput {
  const text = stripHtml(event.event);
  return {
    occurredAt: new Date(event.timestamp * 1000),
    type: "torn_event",
    category: null,
    title: text.length > 120 ? `${text.slice(0, 117)}...` : text,
    description: text,
    amount: null,
    sourceRef: sourceRef(["torn_event", event.id]),
    raw: event,
  };
}
