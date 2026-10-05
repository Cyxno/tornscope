import {
  resolveDateRange,
  type DateRangeInput,
  type RewardsSummaryResponse,
} from "@tornscope/shared";
import { bigintToNumber, getPrismaClient, loadItemNameMap, loadMarketPrices } from "@tornscope/database";
import { loadAvailabilityContext, sectionAvailability } from "./availability.js";

/**
 * Openables / Rewards Analytics (2.4.0) — openings, reward components and
 * valuations over normalized ActivityEvents (domain = openable). Bounded
 * SQL aggregation; no Torn calls, no MoneyEvent double counting.
 *
 * Valuation classes (docs/ACTIVITY-REWARDS.md):
 * - cash rewards: exact (payload money).
 * - item rewards/inputs: quantities exact; monetary value is an ESTIMATE
 *   from the current catalog market price (never presented as exact
 *   historical value, and never silently $0 — unpriced quantities are
 *   reported separately).
 */

interface ItemQtyRow {
  item_id: number;
  qty: string;
}

/** Merge (itemId → qty) rows from several aggregate sources. */
function mergeQty(map: Map<number, number>, rows: ItemQtyRow[]): void {
  for (const r of rows) {
    map.set(r.item_id, (map.get(r.item_id) ?? 0) + Number(r.qty));
  }
}

export async function getRewardsSummary(userId: string, rangeInput: DateRangeInput): Promise<RewardsSummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const availCtx = await loadAvailabilityContext(userId);
  const fromDate = new Date(range.from * 1000);
  const toDate = new Date(range.to * 1000);

  const where = {
    userId,
    domain: "openable",
    occurredAt: { gte: fromDate, lte: toDate },
  };

  const [byType, totals, openings, oldest, lastOpenedRows, itemsRewardRows, item2RewardRows, inputItemRows] = await Promise.all([
    db.activityEvent.groupBy({
      by: ["activityType", "activityLabel"],
      where,
      _count: { _all: true },
      _sum: { cashReward: true },
    }),
    db.activityEvent.aggregate({
      where,
      _count: { _all: true },
      _sum: { cashReward: true },
    }),
    db.activityEvent.count({ where }),
    db.activityEvent.findFirst({ where: { userId, domain: "openable" }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    // Last opened per type: one bounded groupBy (never per-type queries).
    db.activityEvent.groupBy({ by: ["activityType"], where, _max: { occurredAt: true } }),
    // Reward item quantities across all payload shapes (items[] array,
    // scalar item2 + quantity, array item2) — server-side jsonb
    // aggregation, one bounded scan per shape.
    db.$queryRawUnsafe<ItemQtyRow[]>(
      `SELECT (e->>'id')::int AS item_id, SUM(COALESCE((e->>'qty')::int, 1))::bigint AS qty
       FROM "ActivityEvent" ae, jsonb_array_elements(COALESCE(ae.metadata->'items', '[]'::jsonb)) e
       WHERE ae."userId" = $1 AND ae.domain = 'openable' AND ae."occurredAt" BETWEEN $2 AND $3
       GROUP BY 1`,
      userId, fromDate, toDate,
    ),
    db.$queryRawUnsafe<ItemQtyRow[]>(
      `SELECT item_id, SUM(qty)::bigint AS qty FROM (
         SELECT (ae.metadata->>'item2')::int AS item_id,
                GREATEST(COALESCE((ae.metadata->>'quantity')::int, 1), 1) AS qty
         FROM "ActivityEvent" ae
         WHERE ae."userId" = $1 AND ae.domain = 'openable' AND ae."occurredAt" BETWEEN $2 AND $3
           AND jsonb_typeof(ae.metadata->'item2') = 'number'
         UNION ALL
         SELECT (e->>'id')::int AS item_id,
                GREATEST(COALESCE((e->>'qty')::int, 1), 1) AS qty
         FROM "ActivityEvent" ae, jsonb_array_elements(COALESCE(ae.metadata->'item2', '[]'::jsonb)) e
         WHERE ae."userId" = $1 AND ae.domain = 'openable' AND ae."occurredAt" BETWEEN $2 AND $3
           AND jsonb_typeof(ae.metadata->'item2') = 'array'
       ) q GROUP BY item_id`,
      userId, fromDate, toDate,
    ),
    // The opened (input) item per opening — quantities for input valuation.
    db.$queryRawUnsafe<ItemQtyRow[]>(
      `SELECT (ae.metadata->>'item')::int AS item_id, COUNT(*)::bigint AS qty
       FROM "ActivityEvent" ae
       WHERE ae."userId" = $1 AND ae.domain = 'openable' AND ae."occurredAt" BETWEEN $2 AND $3
         AND ae.metadata->>'item' IS NOT NULL
       GROUP BY 1`,
      userId, fromDate, toDate,
    ),
  ]);

  const toNum = (v: bigint | null | undefined): number | null => (v === null || v === undefined ? null : bigintToNumber(v));

  const lastOpenedByType = new Map(lastOpenedRows.map((r) => [r.activityType, r._max.occurredAt]));
  const types = byType
    .map((t) => {
      const last = lastOpenedByType.get(t.activityType);
      return {
        activityType: t.activityType,
        label: t.activityLabel,
        openings: t._count._all,
        cashReward: toNum(t._sum.cashReward),
        lastOpenedAt: last ? Math.floor(last.getTime() / 1000) : null,
      };
    })
    .sort((a, b) => b.openings - a.openings);

  // --- valuation (current catalog market prices; clearly an estimate) ---
  const [prices, names] = await Promise.all([loadMarketPrices(db), loadItemNameMap(db)]);
  const rewardQty = new Map<number, number>();
  mergeQty(rewardQty, itemsRewardRows);
  mergeQty(rewardQty, item2RewardRows);

  let itemValueEstimate = 0n;
  let unpricedItemQty = 0;
  const topItemRewards = [...rewardQty.entries()]
    .map(([itemId, qty]) => {
      const price = prices.get(itemId) ?? null;
      const valueEstimate = price !== null ? price * BigInt(qty) : null;
      if (valueEstimate !== null) itemValueEstimate += valueEstimate;
      else unpricedItemQty += qty;
      return {
        itemId,
        label: names.get(itemId) ?? null,
        qty,
        unitPriceEstimate: price !== null ? bigintToNumber(price) : null,
        valueEstimate: valueEstimate !== null ? bigintToNumber(valueEstimate) : null,
      };
    })
    .sort((a, b) => (b.valueEstimate ?? -1) - (a.valueEstimate ?? -1))
    .slice(0, 12);

  let inputValueEstimate = 0n;
  let unpricedInputQty = 0;
  for (const r of inputItemRows) {
    const price = prices.get(r.item_id) ?? null;
    if (price !== null) inputValueEstimate += price * BigInt(Number(r.qty));
    else unpricedInputQty += Number(r.qty);
  }

  const cashReceived = toNum(totals._sum.cashReward);
  const itemValue = itemValueEstimate !== 0n || rewardQty.size > 0 ? bigintToNumber(itemValueEstimate) : null;
  const inputEstimate = inputValueEstimate !== 0n || inputItemRows.length > 0 ? bigintToNumber(inputValueEstimate) : null;
  // Estimated net: cash (exact) + item rewards (est) − input value (est).
  // Null unless at least one component is defensibly valued.
  const netComponents: number[] = [];
  if (cashReceived !== null) netComponents.push(cashReceived);
  if (itemValue !== null) netComponents.push(itemValue);
  if (inputEstimate !== null) netComponents.push(-inputEstimate);
  const estimatedNet = netComponents.length > 0 ? netComponents.reduce((a, b) => a + b, 0) : null;

  return {
    range: { from: range.from, to: range.to },
    openings,
    containerTypes: byType.length,
    cashReceived,
    inputValueEstimate: { value: inputEstimate, provenance: "estimated" },
    itemValueEstimate: { value: itemValue, provenance: "estimated" },
    estimatedNet: { value: estimatedNet, provenance: estimatedNet !== null ? "estimated" : "unpriced" },
    topItemRewards,
    unpricedItemQty: unpricedItemQty + unpricedInputQty,
    types,
    coverage: {
      openings,
      trackingSince: oldest ? Math.floor(oldest.occurredAt.getTime() / 1000) : null,
    },
    availability: {
      history: sectionAvailability(availCtx, "timeline_history", "events"),
    },
  };
}
