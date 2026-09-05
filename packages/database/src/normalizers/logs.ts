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
import {
  routeLog,
  travelTransitionFor,
  drugNameFromTitle,
  isOverdoseTitle,
  moneyPlanFor,
  classifyMoneyCategory,
  INCOME_WORDS,
  EXPENSE_WORDS,
  TRANSFER_WORDS,
  MONEY_AMOUNT_KEYS,
  type TravelTransitionType,
} from "./titles.js";
import type { MoneyCategory, MoneyDirection } from "@tornscope/shared";

/**
 * Normalization layer: raw Torn log entries -> typed domain events.
 *
 * Routing is driven by the REAL category/title combinations observed in a
 * live 180-day backfill (see titles.ts for the mapping tables). Every entry
 * always lands on the unified timeline; structured tables are filled only
 * from recognized shapes, and unrecognized money movements are recorded with
 * direction "unknown" so they can be audited instead of silently inflating
 * income or expenses.
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

/** A single travel transition (step A); trips are assembled from these. */
export interface TravelTransitionInput {
  occurredAt: Date;
  type: TravelTransitionType;
  country: string | null;
  countryId: number | null;
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
  direction: MoneyDirection;
  amount: bigint; // signed: positive into the wallet, negative out
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
  /** Individual travel transitions (never full trips). */
  travelTransitions: TravelTransitionInput[];
  travelItemEvents: TravelItemEventInput[];
  moneyEvents: MoneyEventInput[];
  timelineEvents: TimelineEventInput[];
  /** Entries that produced no structured domain data (timeline-only). */
  unmapped: number;
}

export interface NormalizeContext {
  /** itemId -> item name, from the cached Torn item catalog. */
  itemNameById: Map<number, string>;
  /** itemId -> catalog type ("Plushie", "Flower", ...), when available. */
  itemTypeById?: Map<number, string>;
}

const DRUG_ITEM_KEYS = ["item", "drug", "item_id", "itemId", "drug_id"];
const ITEM_ID_KEYS = ["id", "item", "item_id", "itemId"];
const QTY_KEYS = ["qty", "quantity", "amount", "count"];
const COST_KEYS = ["cost_total", "cost", "price", "total", "money", "value"];
const PERCENT_KEYS = ["percentage", "percent", "rehab_percent", "progress"];
const COUNTRY_STRING_KEYS = ["country", "destination", "abroad_country"];

function isPlushieOrFlower(name: string | null, catalogType?: string | null): "plushie" | "flower" | "other" {
  // The catalog type is authoritative ("Teddy Bear" is a Plushie without the
  // word in its name); the name heuristic is only a fallback.
  const t = catalogType?.toLowerCase();
  if (t === "plushie") return "plushie";
  if (t === "flower") return "flower";
  if (name && /plushie/i.test(name)) return "plushie";
  if (name && /flower|rose|daffodil|orchid|heather|ceibo|edeweiss|peony|cherry blossom|african daisy|tribulus|banana orchid|crocus|kuala/i.test(name)) return "flower";
  return "other";
}

/**
 * Word-based fallback classification for old-style money titles the rule
 * table does not recognize ("Deposited money in the city bank"). Returns
 * "unknown" when nothing in the text indicates a direction — unknown money
 * must NEVER default to expense.
 */
function fallbackDirection(text: string): "income" | "expense" | "unknown" {
  if (EXPENSE_WORDS.test(text) && !INCOME_WORDS.test(text)) return "expense";
  if (INCOME_WORDS.test(text)) return "income";
  return "unknown";
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
    travelTransitions: [],
    travelItemEvents: [],
    moneyEvents: [],
    timelineEvents: [],
    unmapped: 0,
  };

  const occurredAt = new Date(log.timestamp * 1000);
  const categoryTitle = log.details.category;
  const logTitle = log.details.title;
  const ref = sourceRef(["torn_log", log.id]);

  // Unified timeline gets every entry (this is what makes the timeline page
  // complete even for categories we have not specialized yet).
  writes.timelineEvents.push({
    occurredAt,
    type: "log",
    category: categoryTitle,
    title: logTitle,
    description: null,
    amount: null,
    sourceRef: ref,
    raw: log,
  });

  const route = routeLog(categoryTitle, logTitle);
  if (route === "timeline") {
    writes.unmapped += 1;
    return writes;
  }

  const data: LogRecord = log.data ?? {};
  const params: LogRecord = log.params ?? {};

  switch (route) {
    case "drugs": {
      const itemId = pickNestedNumber(data, DRUG_ITEM_KEYS, ["id"]) ?? pickNumber(data, DRUG_ITEM_KEYS);
      const fromTitle = drugNameFromTitle(logTitle);
      const drugName =
        fromTitle ??
        (itemId !== null ? ctx.itemNameById.get(itemId) ?? null : null) ??
        pickNestedString(data, DRUG_ITEM_KEYS, ["name"]) ??
        pickString(data, ["drug_name", "name"]);
      writes.drugEvents.push({
        occurredAt,
        drugItemId: itemId,
        drugName,
        outcome: isOverdoseTitle(logTitle) ? "overdose" : "success",
        sourceRef: ref,
        raw: log,
      });
      break;
    }

    case "rehab": {
      // Real payload (category "Travel", title "Rehab"):
      // {cost, addiction, rehab_times, happy_increased} — there is no
      // rehab-percentage field; `addiction` is the addiction level at visit.
      const cost = pickNumber(data, COST_KEYS) ?? pickNumber(params, COST_KEYS);
      const percent = pickNumber(data, PERCENT_KEYS) ?? pickNumber(params, PERCENT_KEYS);
      const points = pickNumber(data, ["points_removed", "addiction_removed", "addiction_points"]) ?? pickNumber(params, ["points_removed", "addiction_removed", "addiction_points"]);
      writes.rehabEvents.push({
        occurredAt,
        rehabPercent: percent,
        cost: cost !== null ? BigInt(Math.round(cost)) : null,
        addictionPointsRemoved: points,
        sourceRef: ref,
        raw: log,
      });
      if (cost !== null && cost !== 0) {
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
      const countryString =
        pickString(data, COUNTRY_STRING_KEYS) ??
        pickNestedString(data, ["country", "destination"], ["name", "title"]) ??
        pickString(params, COUNTRY_STRING_KEYS);

      const transition = travelTransitionFor(logTitle, data);
      if (transition === null) break;

      if (transition.type === "ITEM_PURCHASE") {
        // Items bought while abroad: {area, item, quantity, cost_each, cost_total}
        const itemId = pickNestedNumber(data, DRUG_ITEM_KEYS, ["id"]) ?? pickNumber(data, ITEM_ID_KEYS);
        writes.travelTransitions.push({
          occurredAt,
          type: transition.type,
          country: countryString ?? transition.country,
          countryId: transition.countryId,
          sourceRef: ref,
          raw: log,
        });
        if (itemId !== null) {
          const rawQty = pickNumber(data, QTY_KEYS) ?? 1;
          // Guard: a non-positive quantity must never reach analytics or a
          // divide-by-zero unit cost.
          const quantity = Math.max(1, Math.round(rawQty));
          const totalCost = pickNumber(data, COST_KEYS);
          const name = ctx.itemNameById.get(itemId) ?? pickNestedString(data, DRUG_ITEM_KEYS, ["name"]);
          const unit = totalCost !== null ? Math.round(totalCost / quantity) : 0;
          const itemCategory = isPlushieOrFlower(name, ctx.itemTypeById?.get(itemId));
          writes.travelItemEvents.push({
            occurredAt,
            destination: countryString ?? transition.country,
            category: itemCategory,
            itemId,
            itemName: name,
            quantity,
            unitCost: BigInt(Math.max(0, unit)),
            totalCost: BigInt(Math.max(0, Math.round(totalCost ?? 0))),
            sourceRef: ref,
            raw: log,
          });
          if (totalCost !== null && totalCost > 0) {
            writes.moneyEvents.push({
              occurredAt,
              category: itemCategory === "plushie" ? "plushie" : itemCategory === "flower" ? "flower" : "travel",
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
        writes.travelTransitions.push({
          occurredAt,
          type: transition.type,
          country: transition.country ?? countryString,
          countryId: transition.countryId,
          sourceRef: ref,
          raw: log,
        });
      }
      break;
    }

    case "money": {
      const amount = pickNumber(data, [...MONEY_AMOUNT_KEYS]) ?? pickNumber(params, [...MONEY_AMOUNT_KEYS]);
      if (amount === null || amount === 0) break;
      const magnitude = BigInt(Math.round(Math.abs(amount)));
      const text = `${logTitle} ${categoryTitle}`;
      const plan = moneyPlanFor(categoryTitle, logTitle);

      if (plan?.skip) break; // definitively not a cash movement

      let direction: MoneyDirection;
      let signed: bigint;
      if (plan) {
        if (plan.transfer) {
          // Own-pool movement (bank investments, withdrawals, faction vault):
          // keep a signed ledger row but never count it as income/expense.
          direction = "neutral";
          signed = /withdrew|withdraw|withdrawing|receive|received|payout/i.test(text) ? magnitude : -magnitude;
        } else {
          direction = plan.direction;
          signed = plan.direction === "expense" ? -magnitude : magnitude;
        }
      } else {
        // Fallback classification for old-style titles; unknown stays unknown.
        const isTransfer =
          TRANSFER_WORDS.test(text) &&
          ["city_bank", "cayman_bank", "faction"].includes(classifyMoneyCategory(text));
        if (isTransfer) {
          direction = "neutral";
          signed = /withdrew|withdraw|withdrawing|receive|received/i.test(text) ? magnitude : -magnitude;
        } else {
          direction = fallbackDirection(text);
          signed = direction === "expense" ? -magnitude : direction === "income" ? magnitude : magnitude;
        }
      }

      writes.moneyEvents.push({
        occurredAt,
        category: plan?.category ?? classifyMoneyCategory(text),
        subcategory: logTitle,
        direction,
        amount: signed,
        sourceRef: ref,
        description: logTitle,
        raw: log,
      });
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
