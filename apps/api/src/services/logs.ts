import type { FastifyReply } from "fastify";
import { Prisma } from "@tornscope/database";
import {
  energyDeltaFromLog,
  getPrismaClient,
  signMoneyLog,
  type LogRecord,
} from "@tornscope/database";
import { resolveDateRange, type DateRangeInput, type LogEventDto, type LogsMetaResponse, type LogsResponse } from "@tornscope/shared";
import { cursorWhere, encodeCursor } from "../cursor.js";

/**
 * Log Explorer (2.1.0) — a filterable audit view over the user's OWN raw log
 * archive (TimelineEvent type="log", metadata = full Torn payload). All
 * reads are local; nothing here ever triggers a Torn fetch.
 *
 * Money values reuse the canonical signed-cash reading (signMoneyLog) so an
 * amount shown here can never contradict the money ledger; energy deltas
 * come from the payload's own energy_* fields (exact). The raw payload is
 * digested into bounded key/value details — never shipped wholesale.
 */

export interface LogsFilters {
  category?: string;
  type?: string;
  search?: string;
  outcome?: "gain" | "loss";
  minAmount?: number | null | undefined;
  maxAmount?: number | null | undefined;
  limit: number;
  cursor?: string;
}

/** Hard ceiling for one export — streaming keeps memory flat, the cap keeps
 *  runaway filters from hogging the DB. Documented in docs/ANALYTICS.md. */
export const EXPORT_MAX_ROWS = 50_000;
const DIGEST_MAX_KEYS = 6;
const DIGEST_VALUE_MAX = 80;

/** Payload keys that never add value in a details digest (noise/ids). */
const DIGEST_SKIP = /^(item|faction|params)$/i;

function dataOf(metadata: unknown): LogRecord {
  const data = (metadata as { data?: unknown } | null)?.data;
  return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as LogRecord) : {};
}

function digestValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : null;
  if (typeof value === "string") return value.trim() === "" ? null : value.slice(0, DIGEST_VALUE_MAX);
  if (typeof value === "boolean") return String(value);
  return null;
}

function buildDetails(metadata: unknown): Array<{ key: string; value: string }> {
  const data = dataOf(metadata);
  const out: Array<{ key: string; value: string }> = [];
  for (const [key, raw] of Object.entries(data)) {
    if (out.length >= DIGEST_MAX_KEYS) break;
    if (DIGEST_SKIP.test(key)) continue;
    const value = digestValue(raw);
    if (value !== null) out.push({ key, value });
  }
  return out;
}

function summaryFor(title: string, data: LogRecord): string | null {
  // Prefer the most telling payload facts, newest-first when present.
  const parts: string[] = [];
  const session = data.session_type;
  if (typeof session === "string" && session.trim() !== "") parts.push(session.trim());
  const skill = data.hunting_skill_gain;
  if (typeof skill === "string" && skill.trim() !== "") parts.push(skill.trim().replace(/^and /, ""));
  if (parts.length > 0) return parts.join(" — ");
  return title;
}

export async function getLogs(userId: string, rangeInput: DateRangeInput, filters: LogsFilters): Promise<LogsResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);

  const where: Prisma.TimelineEventWhereInput = {
    userId,
    type: "log",
    occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) },
    ...(filters.category ? { category: { equals: filters.category, mode: "insensitive" as const } } : {}),
    ...(filters.type ? { title: { equals: filters.type, mode: "insensitive" as const } } : {}),
    ...(filters.search
      ? {
          OR: [
            { title: { contains: filters.search, mode: "insensitive" as const } },
            { category: { contains: filters.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...cursorWhere(filters.cursor),
  };

  // Amount/outcome filters need the payload — applied after the bounded page
  // fetch on the shaped DTO (post-filtering a keyset page only risks a
  // shorter page; totals stay honest because no total is claimed for
  // payload-filtered queries).
  const needsPayload =
    filters.outcome !== undefined || filters.minAmount !== undefined || filters.maxAmount !== undefined;

  const fetchLimit = needsPayload ? filters.limit * 4 + 100 : filters.limit;
  const rows = await db.timelineEvent.findMany({
    where,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: fetchLimit,
    select: { id: true, occurredAt: true, category: true, title: true, metadata: true },
  });

  const shaped = rows
    .map((row) => shapeLogRow(row))
    .filter((dto): dto is LogEventDto => {
      if (!needsPayload) return true;
      if (dto.money === null) return false;
      if (filters.outcome === "gain" && dto.money <= 0) return false;
      if (filters.outcome === "loss" && dto.money >= 0) return false;
      if (filters.minAmount !== undefined && filters.minAmount !== null && Math.abs(dto.money) < filters.minAmount) return false;
      if (filters.maxAmount !== undefined && filters.maxAmount !== null && Math.abs(dto.money) > filters.maxAmount) return false;
      return true;
    })
    .slice(0, filters.limit);

  // "Has more" detection: without payload filters the page fetch decides
  // (short page = end); with payload filters a full overfetch page that
  // produced a full shaped page may still be followed by more.
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const lastShaped = shaped[shaped.length - 1];
  const lastRow = lastShaped ? rowById.get(lastShaped.id) : undefined;
  let nextCursor: string | null = null;
  if (lastRow) {
    const sourceExhausted = needsPayload ? false : rows.length < fetchLimit;
    if (!sourceExhausted && (needsPayload ? shaped.length === filters.limit : true)) {
      nextCursor = encodeCursor({ occurredAt: Math.floor(lastRow.occurredAt.getTime() / 1000), id: lastRow.id });
    }
  }

  return {
    range: { from: range.from, to: range.to },
    items: shaped,
    nextCursor,
  };
}

function shapeLogRow(row: { id: string; occurredAt: Date; category: string | null; title: string; metadata: unknown }): LogEventDto {
  const data = dataOf(row.metadata);
  const money = signMoneyLog(row.category ?? "", row.title, data, {});
  const energy = energyDeltaFromLog(data);
  return {
    id: row.id,
    occurredAt: Math.floor(row.occurredAt.getTime() / 1000),
    category: row.category,
    title: row.title,
    summary: summaryFor(row.title, data),
    value: null,
    // Transfers (bank moves) show their signed movement too — the explorer
    // is an audit view, not a P&L. Unknown-direction money shows NO amount:
    // same rule as the ledger, unknown never becomes income.
    money: money.direction === "unknown" ? null : money.amount,
    energy,
    details: buildDetails(row.metadata),
    // The archive rows are Torn's own records — verbatim exact.
    provenance: "exact",
  };
}

export async function getLogsMeta(userId: string, rangeInput: DateRangeInput): Promise<LogsMetaResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const occurredAt = { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) };

  const [categories, titles, total, oldest] = await Promise.all([
    db.timelineEvent.groupBy({
      by: ["category"],
      where: { userId, type: "log", occurredAt },
      _count: { _all: true },
      orderBy: { _count: { category: "desc" } },
      take: 60,
    }),
    db.timelineEvent.groupBy({
      by: ["title"],
      where: { userId, type: "log", occurredAt },
      _count: { _all: true },
      orderBy: { _count: { title: "desc" } },
      take: 400,
    }),
    db.timelineEvent.count({ where: { userId, type: "log", occurredAt } }),
    db.timelineEvent.findFirst({
      where: { userId, type: "log" },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
  ]);

  return {
    categories: categories
      .filter((c) => c.category !== null)
      .map((c) => ({ category: c.category as string, count: c._count._all })),
    titles: titles.map((t) => ({ title: t.title, count: t._count._all })),
    totalLogs: total,
    oldestAt: oldest ? Math.floor(oldest.occurredAt.getTime() / 1000) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Streaming export                                                            */
/* -------------------------------------------------------------------------- */

export interface LogExportOptions {
  format: "csv" | "json";
  category?: string;
  type?: string;
  search?: string;
  outcome?: "gain" | "loss";
  minAmount?: number | null | undefined;
  maxAmount?: number | null | undefined;
}

const CSV_HEADERS = ["timestamp", "category", "type", "summary", "energy", "money", "details"] as const;

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Stream the filtered archive as CSV or JSON. Batched keyset reads keep
 * memory flat; the row cap bounds worst-case DB time. The payload contains
 * ONLY the user's own log data — never API keys, credentials or settings.
 */
export async function exportLogs(
  reply: FastifyReply,
  userId: string,
  rangeInput: DateRangeInput,
  opts: LogExportOptions
): Promise<FastifyReply> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const filename = `tornscope-logs-${new Date().toISOString().slice(0, 10)}.${opts.format}`;
  reply.header("Content-Disposition", `attachment; filename="${filename}"`);
  reply.header("Cache-Control", "no-store");

  const where: Prisma.TimelineEventWhereInput = {
    userId,
    type: "log",
    occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) },
    ...(opts.category ? { category: { equals: opts.category, mode: "insensitive" as const } } : {}),
    ...(opts.type ? { title: { equals: opts.type, mode: "insensitive" as const } } : {}),
    ...(opts.search
      ? {
          OR: [
            { title: { contains: opts.search, mode: "insensitive" as const } },
            { category: { contains: opts.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const PAGE = 500;
  let cursor: { occurredAt: number; id: string } | null = null;
  let sent = 0;

  if (opts.format === "csv") {
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.send(`${CSV_HEADERS.join(",")}\n`);
  } else {
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.send("[");
  }

  for (;;) {
    const pageWhere: Prisma.TimelineEventWhereInput = cursor
      ? { ...where, AND: [cursorWhere(encode(cursor)) as Prisma.TimelineEventWhereInput] }
      : where;
    const rows = await db.timelineEvent.findMany({
      where: pageWhere,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: PAGE,
      select: { id: true, occurredAt: true, category: true, title: true, metadata: true },
    });
    if (rows.length === 0) break;

    const dtos = rows
      .map((row) => shapeLogRow(row))
      .filter((dto) => {
        if (opts.outcome === undefined && opts.minAmount === undefined && opts.maxAmount === undefined) return true;
        if (dto.money === null) return false;
        if (opts.outcome === "gain" && dto.money <= 0) return false;
        if (opts.outcome === "loss" && dto.money >= 0) return false;
        if (opts.minAmount !== undefined && opts.minAmount !== null && Math.abs(dto.money) < opts.minAmount) return false;
        if (opts.maxAmount !== undefined && opts.maxAmount !== null && Math.abs(dto.money) > opts.maxAmount) return false;
        return true;
      });

    if (dtos.length > 0) {
      if (opts.format === "csv") {
        const lines = dtos.map((dto) =>
          [
            new Date(dto.occurredAt * 1000).toISOString(),
            dto.category,
            dto.title,
            dto.summary,
            dto.energy,
            dto.money,
            dto.details.map((d) => `${d.key}=${d.value}`).join("; "),
          ]
            .map((cell) => csvCell(cell as string | number | null))
            .join(",")
        );
        reply.send(`${lines.join("\n")}\n`);
      } else {
        const prefix = sent > 0 ? ",\n" : "";
        reply.send(prefix + dtos.map((dto) => JSON.stringify(dto)).join(",\n"));
      }
      sent += dtos.length;
    }

    if (sent >= EXPORT_MAX_ROWS) break;
    const lastRow = rows[rows.length - 1]!;
    cursor = { occurredAt: Math.floor(lastRow.occurredAt.getTime() / 1000), id: lastRow.id };
    if (rows.length < PAGE) break;
  }

  if (opts.format === "json") reply.send("]");
  return reply;
}

function encode(cursor: { occurredAt: number; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
