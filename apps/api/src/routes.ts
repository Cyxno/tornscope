import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DateRangeSchema, PaginationQuerySchema, TORN_DRUG_NAMES, resolveDateRange, type DateRangePreset } from "@tornscope/shared";import { resolveSessionUser, assertSameOrigin, bindLegacyOwner, rebindCurrentSession, clearSessionCookie, requestIsSecure, type SessionUser } from "./auth.js";
import { checkRateLimit, clientIp } from "./ratelimit.js";
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
import { getEconomySummary } from "./services/economy.js";
import { getCrimesSummary, getCrimesTimeline, getCombatSummary, getCombatTimeline } from "./services/crimesCombat.js";
import { getFactionOverview, getFactionRankedWars, getFactionMembers, getFactionChains, getFactionOcs, getFactionLedger } from "./services/faction.js";
import { getTimeline } from "./services/timeline.js";
import { getDashboard } from "./services/dashboard.js";
import { getToday } from "./services/today.js";
import { getMe, getApiKeyStatus, saveApiKey, deleteApiKey, setDemoView, deleteProfile } from "./services/me.js";
import { getSyncStatus, getSyncHealth, requestManualSync, retryFailedSyncs, restartBackfill } from "./services/syncStatus.js";
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

/** Sync accessor for the profile resolved by the preHandler hook. */
function currentUser(req: FastifyRequest): SessionUser {
  const user = (req as unknown as { currentUserValue: SessionUser | null }).currentUserValue;
  if (!user) throw errors.internal("Session identity was not resolved for this request.");
  return user;
}

/** Register all API routes. */
export function registerRoutes(app: FastifyInstance): void {
  // Resolve the browser-bound profile once per request (creates an anonymous
  // profile + session cookie on first visit) and guard mutations against
  // cross-origin calls. Ownership ALWAYS comes from this — never the body.
  app.addHook("preHandler", async (req, reply) => {
    (req as unknown as { currentUserValue: SessionUser | null }).currentUserValue = await resolveSessionUser(req, reply);
    assertSameOrigin(req);
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  app.get("/api/me", async (req) => {
    const user = currentUser(req);
    return getMe(user);
  });

  app.post("/api/demo-view", async (req, reply) => {
    const user = currentUser(req);
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    await setDemoView(user, body.data.enabled);
    const current = await resolveSessionUser(req, reply);
    return getMe(current);
  });

  app.get("/api/dashboard", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getDashboard(user.id, range);
  });

  // Live status: absolute timestamps + client-side countdowns; short-lived
  // server cache keeps Torn API request volume low.
  app.get("/api/today", async (req) => {
    const user = currentUser(req);
    return getToday(user);
  });

  app.get("/api/networth", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getNetworth(user.id, range);
  });

  app.get("/api/money/summary", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getMoneySummary(user.id, range);
  });

  // Economy view: cash flow + consumption + networth + travel, separated.
  app.get("/api/economy", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getEconomySummary(user.id, range);
  });

  app.get("/api/money/events", async (req) => {
    const user = currentUser(req);
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
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    const q = req.query as { drugs?: string };
    const drugFilter = q.drugs ? q.drugs.split(",").map((d) => d.trim()).filter(Boolean) : null;
    return getDrugsSummary(user.id, range, drugFilter);
  });

  app.get("/api/drugs/history", async (req) => {
    const user = currentUser(req);
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

  app.get("/api/crimes/summary", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getCrimesSummary(user.id, range);
  });

  app.get("/api/crimes/timeline", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    const pagination = parsePagination(req.query as Record<string, unknown>);
    return getCrimesTimeline(user.id, range, pagination.limit, pagination.cursor);
  });

  app.get("/api/combat/summary", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getCombatSummary(user.id, range);
  });

  app.get("/api/combat/timeline", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    const pagination = parsePagination(req.query as Record<string, unknown>);
    return getCombatTimeline(user.id, range, pagination.limit, pagination.cursor);
  });

  app.get("/api/faction/overview", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getFactionOverview(user.id, range);
  });

  app.get("/api/faction/ranked-wars", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getFactionRankedWars(user.id, range);
  });

  app.get("/api/faction/members", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getFactionMembers(user.id, range);
  });

  app.get("/api/faction/chains", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getFactionChains(user.id, range);
  });

  app.get("/api/faction/organized-crimes", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    const q = req.query as Record<string, unknown>;
    return getFactionOcs(user.id, range, q.myId === undefined ? null : Number(q.myId));
  });

  app.get("/api/faction/ledger", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getFactionLedger(user.id, range);
  });

  app.get("/api/rehab", async (req) => {
    const user = currentUser(req);
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
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getTravelSummary(user.id, range);
  });

  app.get("/api/travel/history", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    const pagination = parsePagination(req.query as Record<string, unknown>);
    return getTravelHistory(user.id, range, pagination.limit, pagination.cursor);
  });

  app.get("/api/timeline", async (req) => {
    const user = currentUser(req);
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

  app.get("/api/sync/status", async (req) => {
    const user = currentUser(req);
    return getSyncStatus(user.id);
  });

  // Full sync + system health for the Sync Status page.
  app.get("/api/sync/health", async (req) => {
    const user = currentUser(req);
    return getSyncHealth(user.id);
  });

  app.post("/api/sync/run", async (req) => {
    const user = currentUser(req);
    const body = z.object({ resource: z.string().min(1).max(64), force: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    const result = await requestManualSync(user.id, body.data.resource, { force: body.data.force });
    if (!result.queued && result.retryAfterSeconds && result.retryAfterSeconds > 0) {
      throw errors.cooldown(`Sync for ${body.data.resource} was requested recently. Try again in ${result.retryAfterSeconds}s.`);
    }
    return { queued: result.queued };
  });

  app.post("/api/sync/retry-failed", async (req) => {
    const user = currentUser(req);
    return retryFailedSyncs(user.id);
  });

  app.post("/api/sync/backfill", async (req) => {
    const user = currentUser(req);
    const result = await restartBackfill(user.id);
    if (result.retryAfterSeconds && result.retryAfterSeconds > 0) {
      throw errors.cooldown(`Backfill was restarted recently. Try again in ${result.retryAfterSeconds}s.`);
    }
    return { queued: result.queued };
  });

  app.get("/api/settings/api-key", async (req) => {
    const user = currentUser(req);
    return getApiKeyStatus(user.id);
  });

  app.post("/api/settings/api-key", async (req, reply) => {
    const user = currentUser(req);
    // Rate limit: key validation hits the Torn API — never let it be spammed.
    const limit = checkRateLimit("key-save", clientIp(req), 10, 10 * 60_000);
    if (!limit.ok) {
      reply.header("Retry-After", limit.retryAfterSeconds);
      throw errors.validation({ formErrors: ["Too many key attempts — try again later."], fieldErrors: {} });
    }
    const body = z
      .object({
        key: z.string().regex(/^[A-Za-z0-9]{10,80}$/, "API key must be alphanumeric"),
        /** Set only after the user explicitly chose "start a new profile". */
        confirmNewProfile: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    try {
      const result = await saveApiKey(user, body.data.key, { confirmNewProfile: body.data.confirmNewProfile === true });
      // Identity-conflict resolution: rebind this browser to the new profile.
      if (result.newProfileId) await rebindCurrentSession(req, getPrismaClient(), result.newProfileId);
      return result.status;
    } catch (err) {
      handleRouteError(err);
    }
  });

  app.delete("/api/settings/api-key", async (req) => {
    const user = currentUser(req);
    const limit = checkRateLimit("key-delete", clientIp(req), 10, 10 * 60_000);
    if (!limit.ok) throw errors.validation({ formErrors: ["Too many attempts — try again later."], fieldErrors: {} });
    await deleteApiKey(user.id);
    return { deleted: true };
  });

  // One-time legacy owner binding (token lives in server env only).
  app.post("/api/session/bind-owner", async (req, reply) => {
    const limit = checkRateLimit("bind-owner", clientIp(req), 10, 60 * 60_000);
    if (!limit.ok) throw errors.validation({ formErrors: ["Too many attempts — try again later."], fieldErrors: {} });
    const body = z.object({ token: z.string().min(10).max(200) }).safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    await bindLegacyOwner(req, reply, body.data.token);
    const user = await resolveSessionUser(req, reply);
    return getMe(user);
  });

  // Destructive: deletes THIS browser profile, its encrypted key, sync state
  // and personal data. Never touches other profiles.
  app.post("/api/profile/delete", async (req, reply) => {
    const user = currentUser(req);
    const limit = checkRateLimit("profile-delete", clientIp(req), 5, 60 * 60_000);
    if (!limit.ok) throw errors.validation({ formErrors: ["Too many attempts — try again later."], fieldErrors: {} });
    await deleteProfile(user.id);
    reply.header("Set-Cookie", clearSessionCookie(requestIsSecure(req)));
    return { deleted: true };
  });

  app.get("/api/meta/drugs", async () => ({ drugs: TORN_DRUG_NAMES }));
}

export type { DateRangePreset };
