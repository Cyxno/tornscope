import { autoInterval, resolveDateRange, type DateRangeInput, type MoneyEventDto, type MoneySummaryResponse, type Paginated } from "@tornscope/shared";
import { aggregateMoneyEvents } from "@tornscope/analytics";
import { Prisma, bigintToNumber, getPrismaClient } from "@tornscope/database";
import { cursorWhere, nextPageCursor } from "../cursor.js";
import { loadAvailabilityContext, sectionAvailability } from "./availability.js";

/** Map a MoneyEvent row to the analytics DTO + analytics input shape. */
function toDto(row: { id: string; occurredAt: Date; category: string; subcategory: string | null; direction: string; amount: bigint; description: string | null; source: string }): MoneyEventDto {
  return {
    id: row.id,
    occurredAt: Math.floor(row.occurredAt.getTime() / 1000),
    category: row.category as MoneyEventDto["category"],
    subcategory: row.subcategory,
    direction: row.direction as MoneyEventDto["direction"],
    amount: bigintToNumber(row.amount) ?? 0,
    description: row.description,
    source: row.source,
    provenance: row.source === "torn_log" ? "exact" : "estimated",
  };
}

export async function getMoneySummary(userId: string, rangeInput: DateRangeInput): Promise<MoneySummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const where: Prisma.MoneyEventWhereInput = {
    userId,
    occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) },
  };
  const rows = await db.moneyEvent.findMany({ where, orderBy: { occurredAt: "asc" }, select: { id: true, occurredAt: true, category: true, subcategory: true, direction: true, amount: true, description: true, source: true } });

  const events = rows.map((row) => ({
    id: row.id,
    occurredAt: Math.floor(row.occurredAt.getTime() / 1000),
    category: row.category,
    subcategory: row.subcategory,
    direction: row.direction as "income" | "expense" | "neutral",
    amount: bigintToNumber(row.amount) ?? 0,
    description: row.description,
    source: row.source,
  }));

  const agg = aggregateMoneyEvents(events, range.from, range.to, autoInterval(range));

  // Unknown-direction rows in range mean the P&L may still change once
  // unclassified logs are mapped — surface that instead of a confident total.
  const unknownInRange = rows.filter((r) => r.direction === "unknown").length;
  const flowAvailability = unknownInRange > 0 ? ("incomplete" as const) : rows.length === 0 ? ("unavailable" as const) : ("ok" as const);

  const availCtx = await loadAvailabilityContext(userId);
  return {
    range: { from: range.from, to: range.to, interval: autoInterval(range) },
    availability: { cashFlow: sectionAvailability(availCtx, "money_cash_flow", "money_logs") },
    totalIncome: { value: flowAvailability === "unavailable" ? null : agg.totalIncome, provenance: agg.provenance, availability: flowAvailability },
    totalExpenses: { value: flowAvailability === "unavailable" ? null : agg.totalExpenses, provenance: agg.provenance, availability: flowAvailability },
    netProfit: { value: flowAvailability === "unavailable" ? null : agg.netProfit, provenance: agg.provenance, availability: flowAvailability },
    largestIncomeCategory: { category: (agg.largestIncomeCategory?.category as MoneySummaryResponse["largestIncomeCategory"]["category"]) ?? null, total: agg.largestIncomeCategory?.total ?? null },
    largestExpenseCategory: { category: (agg.largestExpenseCategory?.category as MoneySummaryResponse["largestExpenseCategory"]["category"]) ?? null, total: agg.largestExpenseCategory?.total ?? null },
    incomeByCategory: agg.incomeByCategory.map((c) => ({ category: c.category as MoneySummaryResponse["incomeByCategory"][number]["category"], total: c.total })),
    expensesByCategory: agg.expensesByCategory.map((c) => ({ category: c.category as MoneySummaryResponse["expensesByCategory"][number]["category"], total: c.total })),
    flowSeries: agg.flowSeries,
    cumulativeNetSeries: agg.cumulativeNetSeries,
  };
}

export interface MoneyEventFilters {
  category?: string;
  direction?: "income" | "expense";
  search?: string;
  limit: number;
  cursor?: string;
}

export async function getMoneyEvents(userId: string, rangeInput: DateRangeInput, filters: MoneyEventFilters): Promise<Paginated<MoneyEventDto>> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const where: Prisma.MoneyEventWhereInput = {
    userId,
    occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) },
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.direction ? { direction: filters.direction } : {}),
    ...(filters.search ? { description: { contains: filters.search, mode: "insensitive" as const } } : {}),
    ...cursorWhere(filters.cursor),
  };

  const rows = await db.moneyEvent.findMany({
    where,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: filters.limit,
    select: { id: true, occurredAt: true, category: true, subcategory: true, direction: true, amount: true, description: true, source: true },
  });

  return {
    items: rows.map(toDto),
    nextCursor: nextPageCursor(rows, filters.limit),
  };
}
