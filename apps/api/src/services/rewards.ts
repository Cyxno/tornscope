import {
  resolveDateRange,
  type DateRangeInput,
  type RewardsSummaryResponse,
} from "@tornscope/shared";
import { bigintToNumber, getPrismaClient, loadItemNameMap, loadMarketPrices } from "@tornscope/database";
import { loadAvailabilityContext, sectionAvailability } from "./availability.js";

/**
 * Openables / Rewards Analytics (2.5.1) — openings, reward components and
 * valuations over normalized ActivityEvents (domain = openable). Bounded
 * SQL aggregation; no Torn calls, no MoneyEvent double counting.
 *
 * Valuation classes (docs/DATA-CONFIDENCE.md):
 * - cash rewards: exact (payload money; 0 = known zero, distinct from null).
 * - item rewards/inputs: quantities exact; monetary value is an ESTIMATE
 *   from the current catalog market price.
 * - unpriced: quantities with no catalog price stay visible — never zeroed.
 * - malformed: reward components that no longer parse (future payload
 *   drift) are excluded from sums and counted as `malformedComponents` —
 *   never crash the endpoint, never silently priced.
 *
 * `valuationCoverage` tells the UI whether estimatedNet is complete
 * (everything valued), partial (some components unpriced) or unpriced
 * (rewards exist but nothing is defensibly valued).
 */

interface ItemQtyRow {
  item_id: number;
  qty: string;
  malformed: string;
}

/**
 * Defensive reward-quantity aggregation.
 *
 * Guards (all server-side):
 * - `items` must be a JSON array before expansion (jsonb_typeof) — a
 *   non-array `items` no longer crashes the scan;
 * - each element must be an object;
 * - `id` must be a JSON number with an integer text shape before ::int;
 * - `qty`, `quantity` must be integers ≥ 1 (else counted malformed, never
 *   defaulted to 1/0).
 */
const ITEMS_QTY_SQL = `
  SELECT item_id, SUM(qty)::bigint AS qty,
         count(*) FILTER (WHERE NOT id_ok OR NOT qty_ok)::bigint AS malformed
  FROM (
    SELECT CASE WHEN jsonb_typeof(e->'id') = 'number' AND (e->>'id')::text ~ '^-?[0-9]+$'
                THEN (e->>'id')::int END AS item_id,
           jsonb_typeof(e->'id') = 'number' AND (e->>'id')::text ~ '^-?[0-9]+$' AS id_ok,
           jsonb_typeof(e) = 'object' AS is_object,
           CASE WHEN jsonb_typeof(e->'qty') = 'number' AND (e->>'qty')::text ~ '^-?[0-9]+$'
                THEN GREATEST((e->>'qty')::int, 1) END AS qty,
           e->'qty' IS NULL OR (jsonb_typeof(e->'qty') = 'number' AND (e->>'qty')::text ~ '^-?[0-9]+$') AS qty_ok
    FROM "ActivityEvent" ae,
         jsonb_array_elements(CASE WHEN jsonb_typeof(COALESCE(ae.metadata->'items', '[]'::jsonb)) = 'array'
                                   THEN ae.metadata->'items' ELSE '[]'::jsonb END) e
    WHERE ae."userId" = $1 AND ae.domain = 'openable' AND ae."occurredAt" BETWEEN $2 AND $3
  ) q
  WHERE item_id IS NOT NULL
  GROUP BY item_id`;;

const ITEM2_QTY_SQL = `
  SELECT item_id, SUM(qty_valid)::bigint AS qty, count(*) FILTER (WHERE NOT qty_ok)::bigint AS malformed FROM (
    SELECT (ae.metadata->>'item2') AS item2_text,
           (ae.metadata->>'item2')::int AS item_id,
           CASE WHEN ae.metadata->>'quantity' ~ '^-?[0-9]+$' THEN GREATEST((ae.metadata->>'quantity')::int, 1) END AS qty_valid,
           NOT (ae.metadata->>'quantity' ~ '^-?[0-9]+$') AS qty_ok
    FROM "ActivityEvent" ae
    WHERE ae."userId" = $1 AND ae.domain = 'openable' AND ae."occurredAt" BETWEEN $2 AND $3
      AND jsonb_typeof(ae.metadata->'item2') = 'number' AND (ae.metadata->>'item2')::text ~ '^-?[0-9]+$'
    UNION ALL
    SELECT (e->>'id') AS item2_text,
           CASE WHEN jsonb_typeof(e->'id') = 'number' AND (e->>'id')::text ~ '^-?[0-9]+$' THEN (e->>'id')::int END AS item_id,
           CASE WHEN jsonb_typeof(e->'qty') = 'number' AND (e->>'qty')::text ~ '^-?[0-9]+$' THEN GREATEST((e->>'qty')::int, 1) END AS qty_valid,
           NOT (jsonb_typeof(e->'id') = 'number' AND (e->>'id')::text ~ '^-?[0-9]+$'
                AND jsonb_typeof(e->'qty') = 'number' AND (e->>'qty')::text ~ '^-?[0-9]+$') AS qty_ok
    FROM "ActivityEvent" ae,
         jsonb_array_elements(CASE WHEN jsonb_typeof(COALESCE(ae.metadata->'item2', '[]'::jsonb)) = 'array'
                                   THEN ae.metadata->'item2' ELSE '[]'::jsonb END) e
    WHERE ae."userId" = $1 AND ae.domain = 'openable' AND ae."occurredAt" BETWEEN $2 AND $3
      AND jsonb_typeof(ae.metadata->'item2') = 'array'
  ) q WHERE item_id IS NOT NULL GROUP BY item_id`;

const INPUT_QTY_SQL = `
  SELECT (ae.metadata->>'item')::int AS item_id, COUNT(*)::bigint AS qty, 0::bigint AS malformed
  FROM "ActivityEvent" ae
  WHERE ae."userId" = $1 AND ae.domain = 'openable' AND ae."occurredAt" BETWEEN $2 AND $3
    AND jsonb_typeof(ae.metadata->'item') = 'number' AND (ae.metadata->>'item')::text ~ '^-?[0-9]+$'
  GROUP BY 1`;

/** Counts reward components that no longer parse (payload drift):
 *  non-array containers, non-object/non-numeric elements, non-integer ids,
 *  bad quantities. Excluded from every sum; never priced, never zeroed. */
const MALFORMED_COMPONENTS_SQL = `
  SELECT (
    (SELECT count(*) FROM "ActivityEvent" ae
      WHERE ae."userId" = $1 AND ae.domain = 'openable' AND ae."occurredAt" BETWEEN $2 AND $3
        AND ae.metadata ? 'items' AND jsonb_typeof(ae.metadata->'items') <> 'array')
  + (SELECT count(*) FROM "ActivityEvent" ae,
         jsonb_array_elements(CASE WHEN jsonb_typeof(COALESCE(ae.metadata->'items', '[]'::jsonb)) = 'array'
                                   THEN ae.metadata->'items' ELSE '[]'::jsonb END) e
      WHERE ae."userId" = $1 AND ae.domain = 'openable' AND ae."occurredAt" BETWEEN $2 AND $3
        AND NOT (jsonb_typeof(e) = 'object'
                 AND jsonb_typeof(e->'id') = 'number' AND (e->>'id')::text ~ '^-?[0-9]+$'
                 AND (e->'qty' IS NULL OR (jsonb_typeof(e->'qty') = 'number' AND (e->>'qty')::text ~ '^-?[0-9]+$'))))
  + (SELECT count(*) FROM "ActivityEvent" ae
      WHERE ae."userId" = $1 AND ae.domain = 'openable' AND ae."occurredAt" BETWEEN $2 AND $3
        AND ae.metadata ? 'item2' AND jsonb_typeof(ae.metadata->'item2') NOT IN ('number', 'array'))
  + (SELECT count(*) FROM "ActivityEvent" ae
      WHERE ae."userId" = $1 AND ae.domain = 'openable' AND ae."occurredAt" BETWEEN $2 AND $3
        AND jsonb_typeof(ae.metadata->'item2') = 'number' AND (ae.metadata->>'item2')::text !~ '^-?[0-9]+$')
  + (SELECT count(*) FROM "ActivityEvent" ae,
         jsonb_array_elements(CASE WHEN jsonb_typeof(COALESCE(ae.metadata->'item2', '[]'::jsonb)) = 'array'
                                   THEN ae.metadata->'item2' ELSE '[]'::jsonb END) e
      WHERE ae."userId" = $1 AND ae.domain = 'openable' AND ae."occurredAt" BETWEEN $2 AND $3
        AND jsonb_typeof(ae.metadata->'item2') = 'array'
        AND NOT (jsonb_typeof(e) = 'object'
                 AND jsonb_typeof(e->'id') = 'number' AND (e->>'id')::text ~ '^-?[0-9]+$'
                 AND jsonb_typeof(e->'qty') = 'number' AND (e->>'qty')::text ~ '^-?[0-9]+$'))
  + (SELECT count(*) FROM "ActivityEvent" ae
      WHERE ae."userId" = $1 AND ae.domain = 'openable' AND ae."occurredAt" BETWEEN $2 AND $3
        AND ae.metadata ? 'item' AND NOT (jsonb_typeof(ae.metadata->'item') = 'number' AND (ae.metadata->>'item')::text ~ '^-?[0-9]+$'))
  )::bigint AS malformed`;

function mergeQty(map: Map<number, number>, rows: ItemQtyRow[]): void {
  for (const r of rows) {
    if (r.qty !== null) map.set(r.item_id, (map.get(r.item_id) ?? 0) + Number(r.qty));
  }
}

export interface OpenableItemValuation {
  rewardValueEstimate: number | null;
  inputValueEstimate: number | null;
  unpricedQty: number;
  anyItems: boolean;
  malformedComponents: number;
}

/** Compact valuation totals for the cross-domain view (the /rewards page
 *  computes its detailed per-item breakdown separately). */
export async function estimateOpenableItemValuation(
  userId: string,
  fromDate: Date,
  toDate: Date,
): Promise<OpenableItemValuation> {
  const db = getPrismaClient();
  const [itemsRewardRows, item2RewardRows, inputItemRows, prices, malformedRows] = await Promise.all([
    db.$queryRawUnsafe<ItemQtyRow[]>(ITEMS_QTY_SQL, userId, fromDate, toDate),
    db.$queryRawUnsafe<ItemQtyRow[]>(ITEM2_QTY_SQL, userId, fromDate, toDate),
    db.$queryRawUnsafe<ItemQtyRow[]>(INPUT_QTY_SQL, userId, fromDate, toDate),
    loadMarketPrices(db),
    db.$queryRawUnsafe<Array<{ malformed: string }>>(MALFORMED_COMPONENTS_SQL, userId, fromDate, toDate),
  ]);

  const rewardQty = new Map<number, number>();
  mergeQty(rewardQty, itemsRewardRows);
  mergeQty(rewardQty, item2RewardRows);
  const malformedComponents = Number(malformedRows[0]?.malformed ?? 0);

  let rewardEstimate = 0n;
  let inputEstimateBig = 0n;
  let unpricedQty = 0;
  for (const [itemId, qty] of rewardQty) {
    const price = prices.get(itemId) ?? null;
    if (price !== null) rewardEstimate += price * BigInt(qty);
    else unpricedQty += qty;
  }
  for (const r of inputItemRows) {
    const price = prices.get(r.item_id) ?? null;
    if (price !== null) inputEstimateBig += price * BigInt(Number(r.qty));
    else unpricedQty += Number(r.qty);
  }
  const anyItems = rewardQty.size > 0 || inputItemRows.length > 0;
  return {
    rewardValueEstimate: !anyItems ? null : bigintToNumber(rewardEstimate),
    inputValueEstimate: !anyItems ? null : bigintToNumber(inputEstimateBig),
    unpricedQty,
    anyItems,
    malformedComponents,
  };
}

const toNum = (v: bigint | null | undefined): number | null => (v === null || v === undefined ? null : bigintToNumber(v));

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

  const [byType, totals, openings, oldest, lastOpenedRows, itemsRewardRows, item2RewardRows, inputItemRows, malformedRows] = await Promise.all([
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
    db.$queryRawUnsafe<ItemQtyRow[]>(ITEMS_QTY_SQL, userId, fromDate, toDate),
    db.$queryRawUnsafe<ItemQtyRow[]>(ITEM2_QTY_SQL, userId, fromDate, toDate),
    db.$queryRawUnsafe<ItemQtyRow[]>(INPUT_QTY_SQL, userId, fromDate, toDate),
    db.$queryRawUnsafe<Array<{ malformed: string }>>(MALFORMED_COMPONENTS_SQL, userId, fromDate, toDate),
  ]);

  const malformedComponents = Number(malformedRows[0]?.malformed ?? 0);

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
  const hasRewardComponents = rewardQty.size > 0 || inputItemRows.length > 0 || malformedComponents > 0;
  const itemValue = hasRewardComponents || itemValueEstimate !== 0n ? bigintToNumber(itemValueEstimate) : null;
  const inputEstimate = inputItemRows.length > 0 || inputValueEstimate !== 0n ? bigintToNumber(inputValueEstimate) : null;
  // Estimated net: cash (exact) + item rewards (est) − input value (est).
  // Null unless at least one component is defensibly valued.
  const netComponents: number[] = [];
  if (cashReceived !== null) netComponents.push(cashReceived);
  // A zero estimate (nothing priced / price 0) is not a valuation — when
  // only such components exist the net stays null (coverage 'unpriced').
  if (itemValue !== null && itemValueEstimate > 0n) netComponents.push(itemValue);
  if (inputEstimate !== null && inputValueEstimate > 0n) netComponents.push(-inputEstimate);
  const estimatedNet = netComponents.length > 0 ? netComponents.reduce((a, b) => a + b, 0) : null;

  // Coverage: complete = every reward/input component valued (or only exact
  // cash present); partial = valued AND unpriced components mixed; unpriced
  // = components exist but nothing defensibly valued.
  const unpricedTotal = unpricedItemQty + unpricedInputQty;
  const valuationCoverage: "complete" | "partial" | "unpriced" = !hasRewardComponents
    ? "complete"
    : itemValueEstimate === 0n && inputValueEstimate === 0n && unpricedTotal > 0
      ? "unpriced"
      : unpricedTotal > 0
        ? "partial"
        : "complete";

  // --- Other rewards (2.7.0): generic non-cash components from the OTHER
  // activity domains (casino wheel wins, special reward families). Stored
  // semantic + unpriced; priced here from the CURRENT catalog. Kind-level
  // grouping; unpriced quantity stays visible, never zeroed; malformed
  // components (drift) counted separately.
  const otherRows = await db.$queryRawUnsafe<Array<{ component: { kind: string; label: string | null; itemId: number | null; quantity: number }; events: string }>>(
    `SELECT c AS component, count(*)::text AS events
     FROM "ActivityEvent" ae, jsonb_array_elements(CASE
            WHEN jsonb_typeof(COALESCE(ae."otherRewards", '[]'::jsonb)) = 'array' THEN ae."otherRewards"
            ELSE '[]'::jsonb END) c
     WHERE ae."userId" = $1
       AND ae.domain IN ('casino', 'special')
       AND ae."occurredAt" BETWEEN $2 AND $3
       AND jsonb_typeof(ae."otherRewards") = 'array'
       AND jsonb_typeof(c) = 'object'
     GROUP BY 1
     ORDER BY 1
     LIMIT 500`,
    userId, fromDate, toDate,
  );
  const otherAgg = new Map<string, { kind: string; label: string | null; itemId: number | null; quantity: number; events: number }>();
  let otherMalformed = 0;
  for (const row of otherRows) {
    const c = row.component;
    const qty = Number.isFinite(c.quantity) && c.quantity >= 1 ? Math.round(c.quantity) : null;
    if (typeof c.kind !== "string" || qty === null) {
      otherMalformed += Number(row.events);
      continue;
    }
    const key = `${c.kind}|${c.itemId ?? ""}|${c.label ?? ""}`;
    const prev = otherAgg.get(key);
    if (prev) {
      prev.quantity += qty;
      prev.events += Number(row.events);
    } else {
      otherAgg.set(key, { kind: c.kind, label: c.label, itemId: c.itemId, quantity: qty, events: Number(row.events) });
    }
  }
  const otherComponents = [...otherAgg.values()].map((c) => {
    const priced =
      c.itemId !== null && prices.get(c.itemId) !== undefined && prices.get(c.itemId)! > 0n
        ? bigintToNumber(prices.get(c.itemId)!)
        : null;
    return {
      kind: c.kind,
      label: c.label ?? (c.itemId !== null ? names.get(c.itemId) ?? `Item #${c.itemId}` : "Reward"),
      itemId: c.itemId,
      quantity: c.quantity,
      valueEstimate: priced !== null ? priced * c.quantity : null,
      valuation: priced !== null ? ("estimated" as const) : ("unpriced" as const),
    };
  }).sort((a, b) => (b.valueEstimate ?? -1) - (a.valueEstimate ?? -1));
  const otherUnpricedQty = otherComponents.filter((c) => c.valuation === "unpriced").reduce((a, c) => a + c.quantity, 0);

  return {
    range: { from: range.from, to: range.to },
    openings,
    containerTypes: byType.length,
    cashReceived,
    inputValueEstimate: { value: inputEstimate, provenance: "estimated" },
    itemValueEstimate: { value: itemValue, provenance: "estimated" },
    estimatedNet: { value: estimatedNet, provenance: estimatedNet !== null ? (valuationCoverage === "complete" ? "estimated" : "partial-estimate") : "unpriced" },
    valuationCoverage,
    topItemRewards,
    unpricedItemQty: unpricedTotal,
    malformedComponents,
    otherRewards: {
      components: otherComponents,
      unpricedQty: otherUnpricedQty,
      malformed: otherMalformed,
      events: otherRows.length,
    },
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
