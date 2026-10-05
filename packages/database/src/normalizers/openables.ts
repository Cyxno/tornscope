import type { LogRecord } from "./extract.js";

/**
 * Openable registry (2.4.0) — recognizes supply packs / caches / wallets /
 * boxes opened via "Item use ..." logs and normalizes them into
 * ActivityEvent (domain "openable") with input + reward components.
 *
 * DETECTION (payload-driven, not title-keyword-driven): an item-use log is
 * an openable when its payload carries reward components — an `items` array
 * of {id, qty}, an `item2` id+quantity reward, or a `money` reward — which
 * plain consumables (candy, first aid kits, blood bags) never carry.
 * Unknown future openables therefore normalize gracefully via the same
 * payload shape: activityType falls back to the catalog item id and the
 * raw reward components are retained (never a crash, never dropped).
 *
 * VALUATION: reward cash is exact; reward items/points are exact quantities
 * with catalog-market valuation applied by the engine/service (provenance
 * "estimated" for the value, quantities stay exact). Unpriced rewards stay
 * unpriced — never silently $0.
 */

export interface OpenableActivity {
  activityType: string;
  activityLabel: string;
  outcome: "opened";
  /** The opened (input) item id from the payload. */
  inputItemId: number | null;
  /** Reward cash (exact). */
  cashReward: bigint | null;
  /** Reward items: {itemId, qty} pairs from `items[]` or `item2`. */
  rewardItems: Array<{ itemId: number; qty: number }>;
  /** Reward points (exact quantity, e.g. donator pack). */
  pointsReward: number | null;
  /** Non-priceable perks (e.g. donator days). */
  nonPriceable: string | null;
}

/** Known openable display labels, keyed by the payload `item` id when
 *  observed in the archive; unknown ids fall back to a generic label. */
const KNOWN_LABELS: Record<number, string> = {
  370: "Drug Pack",
  283: "Donator Pack",
  365: "Box of Medical Supplies",
  817: "Six Pack of Alcohol",
};

function labelFor(itemId: number | null, data: LogRecord): string {
  if (itemId !== null && KNOWN_LABELS[itemId]) return KNOWN_LABELS[itemId]!;
  const t = typeof data.item === "number" ? `Item #${data.item}` : "Openable";
  return t;
}

function collectRewardItems(data: LogRecord): Array<{ itemId: number; qty: number }> {
  const out: Array<{ itemId: number; qty: number }> = [];
  const items = data.items;
  if (Array.isArray(items)) {
    for (const entry of items) {
      if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "number") {
        const qty = typeof (entry as { qty?: unknown }).qty === "number" ? (entry as { qty: number }).qty : 1;
        out.push({ itemId: (entry as { id: number }).id, qty });
      }
    }
  }
  // `item2` shapes: {item2: 206, quantity: 10} or {item2: [{id: 67, qty: 30}]}
  if (typeof data.item2 === "number") {
    const qty = typeof data.quantity === "number" ? Math.max(1, Math.round(data.quantity)) : 1;
    out.push({ itemId: data.item2, qty });
  } else if (Array.isArray(data.item2)) {
    for (const entry of data.item2) {
      if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "number") {
        const qty = typeof (entry as { qty?: unknown }).qty === "number" ? (entry as { qty: number }).qty : 1;
        out.push({ itemId: (entry as { id: number }).id, qty });
      }
    }
  }
  return out;
}

/**
 * Normalize an "Item use" log into an OpenableActivity, or null when the
 * payload shows no reward components (plain consumable use).
 */
export function normalizeOpenableLog(title: string, data: LogRecord): OpenableActivity | null {
  if (!/^item use /i.test(title)) return null;
  const itemId = typeof data.item === "number" && Number.isFinite(data.item) ? data.item : null;

  const rewardItems = collectRewardItems(data);
  const cashReward = typeof data.money === "number" && Number.isFinite(data.money) && data.money !== 0 ? BigInt(Math.round(data.money)) : null;
  const pointsReward = typeof data.points === "number" && Number.isFinite(data.points) ? Math.round(data.points) : null;

  // An openable carries reward components. A wallet/stash box pays money;
  // packs/cache/boxes yield items. Note: plain consumables (candy, first
  // aid kit, blood bag, alcohol) have neither → null (stays a
  // ConsumptionEvent only).
  if (rewardItems.length === 0 && cashReward === null && pointsReward === null) return null;

  const nonPriceableBits: string[] = [];
  if (typeof data.donator_days === "number") nonPriceableBits.push(`${data.donator_days} donator days`);

  const label = labelFor(itemId, data);
  return {
    activityType: itemId !== null ? `openable-${itemId}` : "openable-unknown",
    activityLabel: label,
    outcome: "opened",
    inputItemId: itemId,
    cashReward,
    rewardItems,
    pointsReward,
    nonPriceable: nonPriceableBits.length > 0 ? nonPriceableBits.join(", ") : null,
  };
}
