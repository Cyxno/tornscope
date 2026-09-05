import type { Provenance } from "@tornscope/shared";
import { filterByRange } from "./money.js";

/**
 * Consumption aggregation: the value of items USED UP (drugs, boosters,
 * medical items, energy drinks, candy, happy-jump items, other consumables).
 *
 * Consumption is intentionally separate from cash flow: a Xanax purchase is a
 * cash expense (MoneyEvent) at buy time, and the later use is recorded here
 * with no cash movement. Aggregates never feed the cash P&L.
 */

export interface ConsumptionEventLike {
  occurredAt: number;
  category: string;
  quantity: number;
  /** Known consumed value; null when no price source was available. */
  totalValue: number | null;
  valuationMethod?: string;
}

export interface ConsumptionCategoryRow {
  category: string;
  uses: number;
  items: number;
  /** Sum of known values; null when every event in the category lacks value. */
  totalValue: number | null;
  valueKnownCount: number;
  valueUnknownCount: number;
}

export interface ConsumptionAggregate {
  uses: number;
  items: number;
  /** Total consumed value across events with a known value. */
  totalValue: number;
  valueKnownCount: number;
  valueUnknownCount: number;
  byCategory: ConsumptionCategoryRow[];
  provenance: Provenance;
}

/** Canonical consumption category display order (drugs first, as asked). */
export const CONSUMPTION_CATEGORY_ORDER = ["drug", "booster", "medical", "happy_jump", "energy", "candy", "temporary", "other"] as const;

export function aggregateConsumption(events: readonly ConsumptionEventLike[], from: number, to: number): ConsumptionAggregate {
  const inRange = filterByRange(events, from, to);

  let totalValue = 0;
  let valueKnownCount = 0;
  let valueUnknownCount = 0;
  let items = 0;
  const byCat = new Map<string, { uses: number; items: number; totalValue: number; known: number; unknown: number }>();

  for (const event of inRange) {
    const cat = byCat.get(event.category) ?? byCat.set(event.category, { uses: 0, items: 0, totalValue: 0, known: 0, unknown: 0 }).get(event.category)!;
    cat.uses += 1;
    cat.items += Math.max(1, event.quantity);
    items += Math.max(1, event.quantity);
    if (event.totalValue !== null && event.totalValue !== undefined) {
      totalValue += event.totalValue;
      valueKnownCount += 1;
      cat.totalValue += event.totalValue;
      cat.known += 1;
    } else {
      valueUnknownCount += 1;
      cat.unknown += 1;
    }
  }

  const orderIndex = (c: string): number => {
    const i = (CONSUMPTION_CATEGORY_ORDER as readonly string[]).indexOf(c);
    return i === -1 ? CONSUMPTION_CATEGORY_ORDER.length : i;
  };
  const byCategory: ConsumptionCategoryRow[] = [...byCat.entries()]
    .map(([category, v]) => ({
      category,
      uses: v.uses,
      items: v.items,
      totalValue: v.known > 0 ? v.totalValue : null,
      valueKnownCount: v.known,
      valueUnknownCount: v.unknown,
    }))
    .sort((a, b) => orderIndex(a.category) - orderIndex(b.category) || b.uses - a.uses);

  return {
    uses: inRange.length,
    items,
    totalValue,
    valueKnownCount,
    valueUnknownCount,
    byCategory,
    provenance: "estimated",
  };
}
