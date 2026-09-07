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
 *
 * Consumption events (ConsumptionEvent) record the ECONOMIC VALUE of used-up
 * items — drugs, boosters, medical items, energy drinks, candy and happy-jump
 * items (EDVD). They are deliberately kept out of the cash ledger: buying the
 * item is the cash movement (MoneyEvent); using it later consumes value but
 * moves no cash, so the two concepts are never summed into one number.
 */

export interface DrugEventInput {
  occurredAt: Date;
  drugItemId: number | null;
  drugName: string | null;
  outcome: "success" | "overdose";
  sourceRef: string;
  raw: unknown;
}

/** Consumption categories (consumables only — not a cash-flow category). */
export const CONSUMPTION_CATEGORIES = [
  "drug",
  "booster",
  "medical",
  "energy",
  "candy",
  "happy_jump",
  "temporary",
  "drug_pack",
  "other",
] as const;
export type ConsumptionCategory = (typeof CONSUMPTION_CATEGORIES)[number];

export const CONSUMPTION_VALUATION_METHODS = [
  "acquisition_cost",
  "market_price",
  "catalog_market_price",
  "unknown",
] as const;
export type ConsumptionValuationMethod = (typeof CONSUMPTION_VALUATION_METHODS)[number];

export const CONSUMPTION_PROVENANCE = ["exact", "derived", "estimated", "unknown"] as const;
export type ConsumptionProvenance = (typeof CONSUMPTION_PROVENANCE)[number];

export interface ConsumptionEventInput {
  occurredAt: Date;
  itemId: number | null;
  itemName: string | null;
  category: ConsumptionCategory;
  quantity: number;
  unitValue: bigint | null;
  totalValue: bigint | null;
  valuationMethod: ConsumptionValuationMethod;
  provenance: ConsumptionProvenance;
  source: string;
  sourceRef: string;
  raw: unknown;
  /** Optional structured notes (e.g. container/yield provenance). */
  metadata?: unknown;
}

/** Torn item-catalog types that map to tracked consumption categories. */
const CONSUMABLE_TYPE_CATEGORY: Record<string, ConsumptionCategory> = {
  drug: "drug",
  booster: "booster",
  medical: "medical",
  "energy drink": "energy",
  candy: "candy",
  special: "temporary",
};

/** Item-name based refinement for Special items (e.g. Erotic DVD). */
function specialItemCategory(name: string): ConsumptionCategory {
  if (/dvd/i.test(name)) return "happy_jump";
  return "temporary";
}

export interface RehabEventInput {
  occurredAt: Date;
  rehabPercent: number | null;
  cost: bigint | null;
  /** Explicit session count from Torn (`rehab_times`); null when absent. */
  sessions: number | null;
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
  category: "plushie" | "flower" | "xanax" | "other";
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

export interface CrimeEventInput {
  occurredAt: Date;
  crimeId: number | null;
  crimeName: string | null;
  crimeCategory: "new" | "legacy";
  success: boolean;
  nerveUsed: number | null;
  moneyDelta: bigint | null;
  itemsValue: bigint | null;
  jailSeconds: number | null;
  hospitalSeconds: number | null;
  skillGain: number | null;
  sourceRef: string;
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
  consumptionEvents: ConsumptionEventInput[];
  crimeEvents: CrimeEventInput[];
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
  /** itemId -> catalog market price, when available (consumption valuation). */
  itemMarketPriceById?: Map<number, bigint>;
  /** lowercase item name -> itemId, for title-only logs ("Used Xanax"). */
  itemIdByName?: Map<string, number>;
}

const DRUG_ITEM_KEYS = ["item", "drug", "item_id", "itemId", "drug_id"];
const ITEM_ID_KEYS = ["id", "item", "item_id", "itemId"];
const QTY_KEYS = ["qty", "quantity", "amount", "count"];
const COST_KEYS = ["cost_total", "cost", "price", "total", "money", "value"];
const PERCENT_KEYS = ["percentage", "percent", "rehab_percent", "progress"];
const COUNTRY_STRING_KEYS = ["country", "destination", "abroad_country"];

/**
 * Build a consumption event for a used item, valuing it from the cached Torn
 * item catalog market price when available. Valuation never invents prices:
 * without a price source the event is still recorded, but its value is null
 * with valuationMethod/provenance "unknown".
 */
function consumptionFromCatalog(
  ctx: NormalizeContext,
  itemId: number | null,
  itemName: string | null,
  category: ConsumptionCategory,
  quantity: number,
  occurredAt: Date,
  sourceRef: string,
  raw: unknown
): ConsumptionEventInput {
  const price = itemId !== null ? ctx.itemMarketPriceById?.get(itemId) ?? null : null;
  const qty = Math.max(1, Math.round(quantity));
  return {
    occurredAt,
    itemId,
    itemName,
    category,
    quantity: qty,
    unitValue: price,
    totalValue: price !== null ? price * BigInt(qty) : null,
    valuationMethod: price !== null ? "catalog_market_price" : "unknown",
    provenance: price !== null ? "estimated" : "unknown",
    source: "torn_log",
    sourceRef,
    raw,
  };
}

/**
 * Consumption category for a used item, or null when the item is not a tracked
 * consumable. The catalog type is authoritative; recognizable consumable names
 * are still tracked when the catalog lacks the item, and otherwise-priced
 * catalog items are recorded under "other" (valuable consumables). Items
 * without a type and without a recognizable name are skipped — never invented.
 */
export function consumptionCategoryFor(
  catalogType: string | undefined,
  itemName: string,
  catalogPrice: bigint | null
): ConsumptionCategory | null {
  const t = catalogType?.toLowerCase();
  if (t === "special") return specialItemCategory(itemName);
  // Named refinements first: high-value containers and multi-item boxes must
  // never dissolve into the unexplained "other" bucket.
  if (/drug pack/i.test(itemName)) return "drug_pack";
  if (/medical supplies/i.test(itemName)) return "medical";
  const mapped = t ? CONSUMABLE_TYPE_CATEGORY[t] : undefined;
  if (mapped) return mapped;
  if (t === undefined) {
    if (/dvd/i.test(itemName)) return "happy_jump";
    if (/energy drink/i.test(itemName)) return "energy";
    return null;
  }
  return catalogPrice !== null && catalogPrice > 0n ? "other" : null;
}

/** "Item use erotic dvd" / "Used Ecstasy" -> the used item part of the title. */
export function itemNameFromUseTitle(title: string): string | null {
  const m = /^(?:item use|used|consumed)\s+(.+)$/i.exec(title.trim());
  return m ? m[1]!.trim() : null;
}

function isPlushieOrFlower(name: string | null, catalogType?: string | null): "plushie" | "flower" | "xanax" | "other" {
  // The catalog type is authoritative ("Teddy Bear" is a Plushie without the
  // word in its name); the name heuristic is only a fallback.
  const t = catalogType?.toLowerCase();
  if (t === "plushie") return "plushie";
  if (t === "flower") return "flower";
  // Xanax is a top-level travel commodity, never folded into "other".
  if (name && /xanax/i.test(name)) return "xanax";
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
    consumptionEvents: [],
    crimeEvents: [],
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
      const fromTitle = drugNameFromTitle(logTitle);
      const itemId =
        pickNestedNumber(data, DRUG_ITEM_KEYS, ["id"]) ??
        pickNumber(data, DRUG_ITEM_KEYS) ??
        (fromTitle ? ctx.itemIdByName?.get(fromTitle.toLowerCase()) ?? null : null);
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
      // The use consumed one unit of the drug. This is a consumption-economy
      // event only: the cash side of buying the drug is (or was) a separate
      // MoneyEvent, and the use itself moves no cash.
      writes.consumptionEvents.push(consumptionFromCatalog(ctx, itemId, drugName, "drug", 1, occurredAt, ref, log));
      break;
    }

    case "crimes": {
      // Normalized crime attempts. Success/failure comes from the title;
      // money_gained/money_lost from the payload are ALSO written to
      // MoneyEvent (category crime) — exactly one canonical ledger row per
      // money-bearing crime log. Item rewards are valued from the catalog
      // (estimated) and never invented; unknown fields stay null.
      const t = logTitle.toLowerCase();
      const isSuccess = /success/.test(t);
      const isFail = /fail/.test(t);
      if (!isSuccess && !isFail) {
        // Skill changes, item deposits/withdrawals, graffiti, hints etc. are
        // progression bookkeeping, not attempts — timeline only.
        writes.unmapped += 1;
        break;
      }
      const nerve = pickNumber(data, ["nerve"]);
      const moneyGained = pickNumber(data, ["money_gained"]);
      const moneyLost = pickNumber(data, ["money_lost"]);
      const moneyDelta = moneyGained !== null ? BigInt(Math.round(moneyGained)) : moneyLost !== null ? -BigInt(Math.round(moneyLost)) : null;
      let itemsValue: bigint | null = null;
      const itemsGained = data["items_gained"];
      if (itemsGained !== null && itemsGained !== undefined && typeof itemsGained === "object") {
        let value = 0n;
        let any = false;
        for (const [itemId, qty] of Object.entries(itemsGained as Record<string, unknown>)) {
          const price = ctx.itemMarketPriceById?.get(Number(itemId));
          const quantity = typeof qty === "number" ? qty : 1;
          if (price !== undefined) {
            value += price * BigInt(Math.max(1, Math.round(quantity)));
            any = true;
          }
        }
        if (any) itemsValue = value;
      }
      const jailSeconds = pickNumber(data, ["jail_time_increased"]);
      writes.crimeEvents.push({
        occurredAt,
        crimeId: pickNumber(data, ["outcome"]),
        crimeName: pickString(data, ["crime_action"]) ?? null,
        crimeCategory: t.includes("(new)") ? "new" : "legacy",
        success: isSuccess,
        nerveUsed: nerve,
        moneyDelta,
        itemsValue,
        jailSeconds: jailSeconds !== null ? Math.round(jailSeconds) : null,
        hospitalSeconds: null,
        skillGain: null,
        sourceRef: ref,
        raw: log,
      });
      // Canonical cash ledger row for money-bearing crime logs.
      if (moneyGained !== null && moneyGained > 0) {
        writes.moneyEvents.push({
          occurredAt,
          category: "crime",
          subcategory: pickString(data, ["crime_action"]) ?? null,
          direction: "income",
          amount: BigInt(Math.round(moneyGained)),
          sourceRef: ref,
          description: logTitle,
          raw: log,
        });
      } else if (moneyLost !== null && moneyLost > 0) {
        writes.moneyEvents.push({
          occurredAt,
          category: "crime",
          subcategory: pickString(data, ["crime_action"]) ?? null,
          direction: "expense",
          amount: -BigInt(Math.round(moneyLost)),
          sourceRef: ref,
          description: logTitle,
          raw: log,
        });
      }
      break;
    }

    case "itemuse": {
      // Generic consumable use ("Item use erotic dvd", "Used Edvd Boosters",
      // energy drinks, candy, medical items). Drugs are claimed by the drugs
      // route above; stash boxes stay on the money route (their use pays out
      // cash). Unknown items are skipped, never guessed into consumption.
      const titleName = itemNameFromUseTitle(logTitle);
      const itemId =
        pickNestedNumber(data, ITEM_ID_KEYS, ["id"]) ??
        pickNumber(data, ITEM_ID_KEYS) ??
        (titleName ? ctx.itemIdByName?.get(titleName.toLowerCase()) ?? null : null);
      const name = itemId !== null ? ctx.itemNameById.get(itemId) ?? titleName : titleName;
      if (!name) {
        writes.unmapped += 1;
        break;
      }
      const price = itemId !== null ? ctx.itemMarketPriceById?.get(itemId) ?? null : null;
      const category = consumptionCategoryFor(itemId !== null ? ctx.itemTypeById?.get(itemId) : undefined, name, price);
      if (category === null) {
        writes.unmapped += 1;
        break;
      }
      // CONTAINER USES: when the payload carries `item2` (the yielded item —
      // a number or an array for multi-yield boxes), `quantity` counts the
      // YIELDED items, not containers used. One "Item use drug pack" with
      // quantity 10 = ONE pack (converted into 10 of some drug), so valuing
      // quantity × container price multiplied the pack price by its contents
      // count (5 packs showed as ~$213M instead of ~$21M). The container is
      // consumed exactly once; the yield rides along in the raw payload.
      const yieldPayload = (data as { item2?: unknown }).item2;
      if (yieldPayload !== undefined && yieldPayload !== null) {
        const yieldQuantity = pickNumber(data, QTY_KEYS);
        writes.consumptionEvents.push({
          ...consumptionFromCatalog(ctx, itemId, name, category, 1, occurredAt, ref, log),
          metadata: {
            containerUse: true,
            yieldQuantity: yieldQuantity ?? null,
            note: "Torn quantity counts the yielded items, not containers used",
          },
        });
        break;
      }
      const rawQty = pickNumber(data, QTY_KEYS) ?? 1;
      writes.consumptionEvents.push(consumptionFromCatalog(ctx, itemId, name, category, rawQty, occurredAt, ref, log));
      break;
    }

    case "rehab": {
      // Real payload (category "Travel", title "Rehab"):
      // {cost, addiction, rehab_times, happy_increased} — there is no
      // rehab-percentage field; `addiction` is the addiction level at visit.
      // ONE log row is ONE visit; `rehab_times` is the explicit number of
      // rehab sessions purchased during it (live-verified: 2–4 per visit).
      const cost = pickNumber(data, COST_KEYS) ?? pickNumber(params, COST_KEYS);
      const percent = pickNumber(data, PERCENT_KEYS) ?? pickNumber(params, PERCENT_KEYS);
      const points = pickNumber(data, ["points_removed", "addiction_removed", "addiction_points"]) ?? pickNumber(params, ["points_removed", "addiction_points"]);
      const sessionsRaw = pickNumber(data, ["rehab_times", "rehab_sessions", "sessions"]) ?? pickNumber(params, ["rehab_times", "rehab_sessions", "sessions"]);
      const sessions = sessionsRaw !== null ? Math.max(1, Math.round(sessionsRaw)) : null;
      writes.rehabEvents.push({
        occurredAt,
        rehabPercent: percent,
        cost: cost !== null ? BigInt(Math.round(cost)) : null,
        sessions,
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
