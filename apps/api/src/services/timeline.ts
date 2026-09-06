import { resolveDateRange, type DateRangeInput, type Paginated, type TimelineEventDto } from "@tornscope/shared";
import { Prisma, bigintToNumber, getPrismaClient } from "@tornscope/database";
import { cursorWhere, nextPageCursor } from "../cursor.js";

export interface TimelineFilters {
  type?: string;
  category?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

export async function getTimeline(userId: string, rangeInput: DateRangeInput, filters: TimelineFilters): Promise<Paginated<TimelineEventDto>> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);

  const where: Prisma.TimelineEventWhereInput = {
    userId,
    occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) },
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.category ? { category: { contains: filters.category, mode: "insensitive" as const } } : {}),
    ...(filters.search ? { title: { contains: filters.search, mode: "insensitive" as const } } : {}),
    ...cursorWhere(filters.cursor),
  };

  const rows = await db.timelineEvent.findMany({
    where,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: filters.limit,
    // metadata is the raw Torn log payload (kept for renormalize) — never
    // shipped to the timeline page.
    select: { id: true, occurredAt: true, type: true, category: true, title: true, description: true, amount: true, source: true },
  });

  return {
    items: rows.map((row) => ({
      id: row.id,
      occurredAt: Math.floor(row.occurredAt.getTime() / 1000),
      type: row.type,
      category: row.category,
      title: row.title,
      description: row.description,
      amount: bigintToNumber(row.amount),
      source: row.source,
      provenance: row.source === "torn_log" || row.source === "torn_event" ? "exact" : "derived",
    })),
    nextCursor: nextPageCursor(rows, filters.limit),
  };
}
