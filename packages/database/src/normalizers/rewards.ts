import type { LogRecord } from "./extract.js";

/**
 * Generic non-cash reward-component parser (2.7.0).
 *
 * Built ONLY from shapes proven in the stored raw archive (audited live
 * 2026-10-08 against production TimelineEvent payloads):
 *
 * - Crime item gains:   `items_gained: { "<itemId>": qty }` (object map)
 * - Job special:        `item: <itemId>`, `quantity: <qty>`
 * - Company special /
 *   Stock special item: `item: { "<itemId>": qty }` (object map)
 * - Subscription:       `first_item: <id>`, `second_item: <id>` (qty 1 each)
 * - Casino wheel item:  `item: <itemId>` (qty 1)
 * - Casino wheel prop.: `property: <propertyTypeId>` — no catalog value
 *                       exists for properties → unpriced by construction
 * - Crime ammo gains:   `ammo_gained: { "<typeId>": { "<classId>": qty } }`
 *                       — the payload carries Torn's internal ammo type/
 *                       class codes, NOT catalog item ids → unpriced, label
 *                       shows the raw codes (never guessed into an item id)
 *
 * NOTHING else is claimed. Vehicles: the archive contains NO vehicle-reward
 * shape (racing car logs are the player's own car/upgrade costs) — no key is
 * invented for them. Cash components (money/money_gained/cost/...) are
 * deliberately NOT parsed here: they belong to the existing exact-cash
 * columns (cashInput/cashReward) and the MoneyEvent ledger — never doubled.
 *
 * Storage is SEMANTIC and UNPRICED: components carry kind/label/itemId/qty.
 * Monetary value is resolved at READ time from the current item catalog;
 * anything the catalog cannot price stays visible as unpriced — never 0.
 */

export type RewardComponentKind = "item" | "ammo" | "property" | "other";

export interface StoredRewardComponent {
  kind: RewardComponentKind;
  /** Catalog item id when the component resolves to one; null otherwise. */
  itemId: number | null;
  /** null when the name resolves from the catalog at read time. */
  label: string | null;
  quantity: number;
}

export interface ParsedRewardComponents {
  components: StoredRewardComponent[];
  /** Reward-carrying keys whose payload no longer parses (drift) — counted,
   *  never priced, never silently dropped. */
  malformed: number;
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Positive integer quantity from a JSON value; null when not one. */
function positiveInt(v: unknown): number | null {
  return isFiniteInt(v) && Number.isInteger(v) && v >= 1 ? v : null;
}

/**
 * Object-map item form: { "<itemId>": qty } — quantities default to 1 ONLY
 * when the value is absent (proven shape: wheel/stock payloads omit qty for
 * single items); a PRESENT non-integer quantity is malformed, never defaulted.
 */
function pushItemMap(
  out: ParsedRewardComponents,
  map: Record<string, unknown>,
): void {
  for (const [key, qtyValue] of Object.entries(map)) {
    const itemId = Number(key);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      out.malformed += 1;
      continue;
    }
    const quantity = qtyValue === undefined ? 1 : positiveInt(qtyValue);
    if (quantity === null) {
      out.malformed += 1;
      continue;
    }
    out.components.push({ kind: "item", itemId, label: null, quantity });
  }
}

/** Parse the generic non-cash reward components from one raw log payload. */
export function parseRewardComponents(data: LogRecord): ParsedRewardComponents {
  const out: ParsedRewardComponents = { components: [], malformed: 0 };

  // Crime item gains: items_gained object map.
  const itemsGained = data["items_gained"];
  if (itemsGained !== undefined && itemsGained !== null) {
    if (typeof itemsGained === "object" && !Array.isArray(itemsGained)) {
      pushItemMap(out, itemsGained as Record<string, unknown>);
    } else {
      out.malformed += 1;
    }
  }

  // Item forms: scalar id (Job special / wheel win item) or object map
  // (Company special / Stock special). Quantity: explicit `quantity` key
  // when present (Job special proven shape), else 1 / map values.
  const item = data["item"];
  if (item !== undefined && item !== null) {
    if (isFiniteInt(item) && Number.isInteger(item) && item > 0) {
      const explicitQty = data["quantity"] === undefined ? 1 : positiveInt(data["quantity"]);
      if (explicitQty === null) {
        out.malformed += 1;
      } else {
        out.components.push({ kind: "item", itemId: item, label: null, quantity: explicitQty });
      }
    } else if (typeof item === "object" && !Array.isArray(item)) {
      pushItemMap(out, item as Record<string, unknown>);
    } else {
      out.malformed += 1;
    }
  }

  // Subscription rewards: two distinct item slots, qty 1 each (proven).
  for (const key of ["first_item", "second_item"] as const) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (isFiniteInt(value) && Number.isInteger(value) && value > 0) {
      out.components.push({ kind: "item", itemId: value, label: null, quantity: 1 });
    } else {
      out.malformed += 1;
    }
  }

  // Crime ammo gains: { "<typeId>": { "<classId>": qty } } — Torn's internal
  // ammo codes, NOT catalog item ids. Label keeps the raw codes; unpriced by
  // construction (no defensible id mapping exists in stored data).
  const ammoGained = data["ammo_gained"];
  if (ammoGained !== undefined && ammoGained !== null) {
    if (typeof ammoGained === "object" && !Array.isArray(ammoGained)) {
      for (const [typeId, classes] of Object.entries(ammoGained as Record<string, unknown>)) {
        if (typeof classes !== "object" || classes === null || Array.isArray(classes)) {
          out.malformed += 1;
          continue;
        }
        for (const [classId, qtyValue] of Object.entries(classes as Record<string, unknown>)) {
          const quantity = positiveInt(qtyValue);
          if (quantity === null) {
            out.malformed += 1;
            continue;
          }
          out.components.push({
            kind: "ammo",
            itemId: null,
            label: `Ammo (type ${typeId} · class ${classId})`,
            quantity,
          });
        }
      }
    } else {
      out.malformed += 1;
    }
  }

  // Casino wheel property win: `property: <propertyTypeId>` — an opaque
  // property id with no catalog value in stored data → unpriced by design.
  const property = data["property"];
  if (property !== undefined && property !== null) {
    if (isFiniteInt(property) && Number.isInteger(property) && property > 0) {
      out.components.push({ kind: "property", itemId: null, label: `Property #${property}`, quantity: 1 });
    } else {
      out.malformed += 1;
    }
  }

  return out;
}

/** A stored component rendered for the API: catalog-priced when possible. */
export function priceRewardComponent(
  component: StoredRewardComponent,
  itemNameById: Map<number, string> | null,
  marketPriceById: Map<number, bigint> | null
): {
  kind: string;
  label: string;
  itemId: number | null;
  quantity: number;
  unitValueEstimate: number | null;
  valueEstimate: number | null;
  valuation: "estimated" | "unpriced";
} {
  const label =
    component.label ??
    (component.itemId !== null ? itemNameById?.get(component.itemId) ?? null : null) ??
    (component.itemId !== null ? `Item #${component.itemId}` : "Reward");
  if (component.itemId === null || marketPriceById === null) {
    return { ...component, label, unitValueEstimate: null, valueEstimate: null, valuation: "unpriced" as const };
  }
  const unit = marketPriceById.get(component.itemId);
  if (unit === undefined || unit <= 0n) {
    return { ...component, label, unitValueEstimate: null, valueEstimate: null, valuation: "unpriced" as const };
  }
  const unitValue = Number(unit);
  return {
    ...component,
    label,
    unitValueEstimate: unitValue,
    valueEstimate: unitValue * component.quantity,
    valuation: "estimated" as const,
  };
}

/**
 * Special reward families (2.7.0) — the EXACT (category, title) pairs routed
 * by titles.ts, with the semantic claim used by both the live normalizer and
 * the historical repair. Null when the payload carries no parseable reward
 * component (the caller keeps the row timeline-only, never fabricates).
 */
export function normalizeSpecialRewardLog(
  category: string,
  title: string,
  data: LogRecord
): { activityType: string; activityLabel: string; components: StoredRewardComponent[] } | null {
  const c = category.toLowerCase();
  const t = title.toLowerCase();
  const recognized =
    (c === "company" && t === "company special gain item") ||
    (c === "job" && t === "job special gain item") ||
    (c === "stocks" && t === "stock special item") ||
    (c === "donator" && t === "subscription reward");
  if (!recognized) return null;
  const parsed = parseRewardComponents(data);
  if (parsed.components.length === 0) return null;
  const activityLabel =
    t === "company special gain item" ? "Company perk" :
    t === "job special gain item" ? "Job perk" :
    t === "stock special item" ? "Stock benefit" :
    "Subscription reward";
  return { activityType: title, activityLabel, components: parsed.components };
}
