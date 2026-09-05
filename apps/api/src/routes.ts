import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DateRangeSchema, PaginationQuerySchema, TORN_DRUG_NAMES, resolveDateRange, type DateRangePreset } from "@tornscope/shared";import { resolveCurrentUser } from "./auth.js";
import { errors, mapTornError, AppError } from "./errors.js";
import { getMoneyEvents, getMoneySummary } from "./services/money.js";
import { cursorWhere, encodeCursor } from "./cursor.js";

/** Prisma options continuing after a keyset cursor (merge into where.AND). */
function cursorPrisma(cursor: string): Record<string, unknown> | undefined {
  return cursorWhere(cursor);
}

/** Cursor for a page of rows ordered by occurredAt desc, id desc. */
function encodeLast(rows: Array<{ occurredAt: Date; id: string }>): string | null {
  const last = rows[rows.length - 1];
  if (!last) return null;
  return encodeCursor({ occurredAt: Math.floor(last.occurredAt.getTime() / 1000), id: last.id });
}
import { getDrugsSummary } from "./services/drugs.js";
import { getTravelHistory, getTravelSummary } from "./services/travel.js";
import { getNetworth } from "./services/networth.js";
import { getTimeline } from "./services/timeline.js";
import { getDashboard } from "./services/dashboard.js";
import { getMe, getApiKeyStatus, saveApiKey, deleteApiKey, setDemoView } from "./services/me.js";
import { getSyncStatus, requestManualSync } from "./services/syncStatus.js";
import { getPrismaClient } from "@tornscope/database";

function parseRange(query: Record<string, unknown>) {
  const parsed = DateRangeSchema.safeParse(query);
  if (!parsed.success) throw errors.validation(parsed.error.flatten());
  return parsed.data;
}

function parsePagination(query: Record<string, unknown>) {
  const parsed = PaginationQuerySchema.safeParse(query);
  if (!parsed.success) throw errors.validation(parsed.error.flatten());
  return parsed.data;
}

function handleRouteError(err: unknown): never {
  if (err instanceof AppError) throw err;
  throw mapTornError(err);
}

/** Register all API routes. */
export function registerRoutes(app: FastifyInstance): void {
  app.get("/api/health", async () => ({ status: "ok" }));

  app.get("/api/me", async () => {
    const user = await resolveCurrentUser();
    return getMe(user);
  });

  app.post("/api/demo-view", async (req) => {
    const user = await resolveCurrentUser();
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    await setDemoView(user, body.data.enabled);
    const current = await resolveCurrentUser();
    return getMe(current);
  });

  app.get("/api/dashboard", async (req) => {
    const user = await resolveCurrentUser();
    const range = parseRange(req.query as Record<string, unknown>);
    return getDashboard(user.id, range);
  });

  app.get("/api/networth", async (req) => {
    const user = await resolveCurrentUser();
    const range = parseRange(req.query as Record<string, unknown>);
    return getNetworth(user.id, range);
  });

  app.get("/api/money/summary", async (req) => {
    const user = await resolveCurrentUser();
    const range = parseRange(req.query as Record<string, unknown>);
    return getMoneySummary(user.id, range);
  });

  app.get("/api/money/events", async (req) => {
    const user = await resolveCurrentUser();
    const range = parseRange(req.query as Record<string, unknown>);
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const q = req.query as { category?: string; direction?: string; search?: string };
    if (q.direction && !["income", "expense"].includes(q.direction)) throw errors.validation("direction must be income or expense");
    return getMoneyEvents(user.id, range, {
      category: q.category,
      direction: q.direction as "income" | "expense" | undefined,
      search: q.search,
      limit: pagination.limit,
      cursor: pagination.cursor,
    });
  });

  app.get("/api/drugs/summary", async (req) => {
    const user = await resolveCurrentUser();
    const range = parseRange(req.query as Record<string, unknown>);
    const q = req.query as { drugs?: string };
    const drugFilter = q.drugs ? q.drugs.split(",").map((d) => d.trim()).filter(Boolean) : null;
    return getDrugsSummary(user.id, range, drugFilter);
  });

  app.get("/api/drugs/history", async (req) => {
    const user = await resolveCurrentUser();
    const range = parseRange(req.query as Record<string, unknown>);
    const q = req.query as { drugs?: string };
    const drugFilter = q.drugs ? q.drugs.split(",").map((d) => d.trim()).filter(Boolean) : null;
    const summary = await getDrugsSummary(user.id, range, drugFilter);
    return {
      range: summary.range,
      dailySeries: summary.dailySeries,
      byDrug: summary.byDrug,
    };
  });

  app.get("/api/rehab", async (req) => {
    const user = await resolveCurrentUser();
    const rangeInput = parseRange(req.query as Record<string, unknown>);
    const resolved = resolveDateRange(rangeInput);
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const db = getPrismaClient();
    const cursorCondition = pagination.cursor ? cursorPrisma(pagination.cursor) : undefined;
    const rows = await db.rehabEvent.findMany({
      where: {
        userId: user.id,
        occurredAt: { gte: new Date(resolved.from * 1000), lte: new Date(resolved.to * 1000) },
        ...(cursorCondition ? { AND: [cursorCondition] } : {}),
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: pagination.limit,
    });
    return {
      range: { from: resolved.from, to: resolved.to },
      items: rows.map((r) => ({
        id: r.id,
        occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
        rehabPercent: r.rehabPercent,
        cost: r.cost === null ? null : Number(r.cost),
        addictionPointsRemoved: r.addictionPointsRemoved,
      })),
      nextCursor: rows.length < pagination.limit ? null : encodeLast(rows),
    };
  });

  app.get("/api/travel/summary", async (req) => {
    const user = await resolveCurrentUser();
    const range = parseRange(req.query as Record<string, unknown>);
    return getTravelSummary(user.id, range);
  });

  app.get("/api/travel/history", async (req) => {
    const user = await resolveCurrentUser();
    const range = parseRange(req.query as Record<string, unknown>);
    const pagination = parsePagination(req.query as Record<string, unknown>);
    return getTravelHistory(user.id, range, pagination.limit, pagination.cursor);
  });

  app.get("/api/timeline", async (req) => {
    const user = await resolveCurrentUser();
    const range = parseRange(req.query as Record<string, unknown>);
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const q = req.query as { type?: string; category?: string; search?: string };
    return getTimeline(user.id, range, {
      type: q.type,
      category: q.category,
      search: q.search,
      limit: pagination.limit,
      cursor: pagination.cursor,
    });
  });

  app.get("/api/sync/status", async () => {
    const user = await resolveCurrentUser();
    return getSyncStatus(user.id);
  });

  app.post("/api/sync/run", async (req) => {
    const user = await resolveCurrentUser();
    const body = z.object({ resource: z.string().min(1).max(64) }).safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    const result = await requestManualSync(user.id, body.data.resource);
    if (!result.queued && result.retryAfterSeconds && result.retryAfterSeconds > 0) {
      throw errors.cooldown(`Sync for ${body.data.resource} was requested recently. Try again in ${result.retryAfterSeconds}s.`);
    }
    return { queued: result.queued };
  });

  app.get("/api/settings/api-key", async () => {
    const user = await resolveCurrentUser();
    return getApiKeyStatus(user.id);
  });

  app.post("/api/settings/api-key", async (req) => {
    const user = await resolveCurrentUser();
    const body = z.object({ key: z.string().regex(/^[A-Za-z0-9]{10,80}$/, "API key must be alphanumeric") }).safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    try {
      return await saveApiKey(user, body.data.key);
    } catch (err) {
      handleRouteError(err);
    }
  });

  app.delete("/api/settings/api-key", async () => {
    const user = await resolveCurrentUser();
    await deleteApiKey(user.id);
    return { deleted: true };
  });

  app.get("/api/meta/drugs", async () => ({ drugs: TORN_DRUG_NAMES }));
}

export type { DateRangePreset };
