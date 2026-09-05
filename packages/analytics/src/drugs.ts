import type { Provenance } from "@tornscope/shared";
import { bucketAxis, bucketStart } from "./series.js";
import { filterByRange } from "./money.js";

/**
 * Drug usage analytics. Estimated spend uses the Torn item catalog market
 * price (provenance: estimated) - never presented as an exact figure.
 */

export interface DrugEventLike {
  occurredAt: number;
  drugItemId: number | null;
  drugName: string | null;
  outcome: "success" | "overdose";
}

export interface DrugDailyPoint {
  t: number;
  good: number;
  bad: number;
}

export interface DrugBreakdownRow {
  drug: string;
  uses: number;
  overdoses: number;
  estimatedCost: number | null;
  shareOfTotal: number;
}

export interface DrugStats {
  totalUses: number;
  overdoses: number;
  overdoseRate: number;
  dailySeries: DrugDailyPoint[];
  byDrug: DrugBreakdownRow[];
  estimatedSpend: number | null;
  averageCostPerUse: number | null;
  provenance: Provenance;
}

export function calculateDrugStats(
  events: readonly DrugEventLike[],
  marketPriceById: ReadonlyMap<number, number>,
  from: number,
  to: number,
  interval: "hour" | "day" | "week" | "month" = "day",
  drugFilter: ReadonlySet<string> | null = null
): DrugStats {
  const inRange = filterByRange(events, from, to);
  const visible = drugFilter && drugFilter.size > 0 ? inRange.filter((e) => e.drugName !== null && drugFilter.has(e.drugName)) : inRange;

  let overdoses = 0;
  let estimatedSpend = 0;
  let spendKnownCount = 0;
  const byDrug = new Map<string, { uses: number; overdoses: number; estimatedCost: number | null }>();
  const perBucket = new Map<number, { good: number; bad: number }>();

  for (const event of visible) {
    const good = event.outcome !== "overdose";
    if (!good) overdoses += 1;

    const key = event.drugName ?? (event.drugItemId !== null ? `item ${event.drugItemId}` : "Unknown");
    const row = byDrug.get(key) ?? byDrug.set(key, { uses: 0, overdoses: 0, estimatedCost: null }).get(key)!;
    row.uses += 1;
    if (!good) row.overdoses += 1;

    if (event.drugItemId !== null) {
      const price = marketPriceById.get(event.drugItemId);
      if (price !== undefined) {
        estimatedSpend += price;
        spendKnownCount += 1;
        row.estimatedCost = (row.estimatedCost ?? 0) + price;
      }
    }

    const b = bucketStart(event.occurredAt, interval);
    const bucket = perBucket.get(b) ?? perBucket.set(b, { good: 0, bad: 0 }).get(b)!;
    if (good) bucket.good += 1;
    else bucket.bad += 1;
  }

  const axis = bucketAxis(from, to, interval);
  const dailySeries = axis.map((t) => ({
    t,
    good: perBucket.get(t)?.good ?? 0,
    bad: perBucket.get(t)?.bad ?? 0,
  }));

  const totalUses = visible.length;
  const byDrugRows: DrugBreakdownRow[] = [...byDrug.entries()]
    .map(([drug, row]) => ({
      drug,
      uses: row.uses,
      overdoses: row.overdoses,
      estimatedCost: row.estimatedCost,
      shareOfTotal: totalUses > 0 ? row.uses / totalUses : 0,
    }))
    .sort((a, b) => b.uses - a.uses);

  return {
    totalUses,
    overdoses,
    overdoseRate: totalUses > 0 ? overdoses / totalUses : 0,
    dailySeries,
    byDrug: byDrugRows,
    estimatedSpend: spendKnownCount > 0 ? estimatedSpend : totalUses > 0 ? null : 0,
    averageCostPerUse: spendKnownCount > 0 && totalUses > 0 ? estimatedSpend / totalUses : null,
    provenance: "estimated",
  };
}
