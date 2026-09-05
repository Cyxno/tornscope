import { resolveDateRange, type DateRangeInput } from "@tornscope/shared";
import { calculateNetworthChanges } from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient } from "@tornscope/database";

/** Net worth history + period changes (all values exact, Torn-provided). */
export async function getNetworth(userId: string, rangeInput: DateRangeInput) {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);

  const rows = await db.networthSnapshot.findMany({
    where: { userId, capturedAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
    orderBy: { capturedAt: "asc" },
    select: { capturedAt: true, total: true, wallet: true, cityBank: true, caymanBank: true, points: true, property: true, stockMarket: true, company: true },
  });

  const allRows = await db.networthSnapshot.findMany({
    where: { userId },
    orderBy: { capturedAt: "asc" },
    select: { capturedAt: true, total: true },
  });

  const now = Math.floor(Date.now() / 1000);
  const yearStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000);
  const changes = calculateNetworthChanges(
    allRows.map((r) => ({ capturedAt: Math.floor(r.capturedAt.getTime() / 1000), total: bigintToNumber(r.total) ?? 0 })),
    now,
    yearStart
  );

  const series = rows.map((r) => ({
    t: Math.floor(r.capturedAt.getTime() / 1000),
    total: bigintToNumber(r.total) ?? 0,
    breakdown: {
      cash: bigintToNumber(r.wallet) ?? 0,
      banks: (bigintToNumber(r.cityBank) ?? 0) + (bigintToNumber(r.caymanBank) ?? 0),
      points: bigintToNumber(r.points) ?? 0,
      property: bigintToNumber(r.property) ?? 0,
      stocks: bigintToNumber(r.stockMarket) ?? 0,
      company: bigintToNumber(r.company) ?? 0,
    },
  }));

  return {
    range,
    series,
    changes,
  };
}

/** Latest net worth snapshot (KPI source). */
export async function getLatestNetworth(userId: string) {
  const db = getPrismaClient();
  const row = await db.networthSnapshot.findFirst({
    where: { userId },
    orderBy: { capturedAt: "desc" },
    select: { capturedAt: true, total: true, wallet: true, vault: true },
  });
  if (!row) return null;
  return {
    capturedAt: Math.floor(row.capturedAt.getTime() / 1000),
    total: bigintToNumber(row.total),
    cash: (bigintToNumber(row.wallet) ?? 0) + (bigintToNumber(row.vault) ?? 0),
  };
}
