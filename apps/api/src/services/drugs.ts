import {
  resolveDateRange,
  type DateRangeInput,
  type DrugsSummaryResponse,
} from "@tornscope/shared";
import { calculateDrugStats, calculateRehabStats } from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, loadMarketPrices } from "@tornscope/database";

/** Drugs + rehab analytics. Drug costs are estimated from market prices. */
export async function getDrugsSummary(userId: string, rangeInput: DateRangeInput, drugFilter: string[] | null): Promise<DrugsSummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);

  const [drugRows, rehabRows, marketPrices] = await Promise.all([
    db.drugEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true, drugItemId: true, drugName: true, outcome: true },
    }),
    db.rehabEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true, rehabPercent: true, cost: true },
    }),
    loadMarketPrices(db),
  ]);

  const drugEvents = drugRows.map((r) => ({
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    drugItemId: r.drugItemId,
    drugName: r.drugName,
    outcome: r.outcome as "success" | "overdose",
  }));
  const priceMap = new Map<number, number>([...marketPrices].map(([k, v]) => [k, Number(v)]));

  const stats = calculateDrugStats(drugEvents, priceMap, range.from, range.to, "day", drugFilter ? new Set(drugFilter) : null);

  const rehabEvents = rehabRows.map((r) => ({
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    cost: bigintToNumber(r.cost),
    rehabPercent: r.rehabPercent,
  }));
  const rehab = calculateRehabStats(rehabEvents, range.from, range.to);

  return {
    range: { from: range.from, to: range.to },
    overall: {
      totalUses: stats.totalUses,
      overdoses: stats.overdoses,
      overdoseRate: stats.overdoseRate,
      estimatedSpend: { value: stats.estimatedSpend, provenance: "estimated" },
      averageCostPerUse: { value: stats.averageCostPerUse, provenance: "estimated" },
    },
    byDrug: stats.byDrug.map((row) => ({
      drug: row.drug,
      uses: row.uses,
      overdoses: row.overdoses,
      estimatedCost: row.estimatedCost,
      shareOfTotal: row.shareOfTotal,
    })),
    dailySeries: stats.dailySeries,
    rehab: {
      totalSpend: { value: rehab.totalSpend, provenance: rehab.provenance },
      trips: rehab.trips,
      latestAt: rehab.latestAt,
      averageSpend: { value: rehab.averageSpend, provenance: rehab.provenance },
      recent: rehab.history.slice(0, 10).map((h) => ({
        occurredAt: h.occurredAt,
        rehabPercent: h.rehabPercent,
        cost: h.cost,
      })),
    },
  };
}
