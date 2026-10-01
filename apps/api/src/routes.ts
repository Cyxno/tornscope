import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DateRangeSchema, PaginationQuerySchema, TORN_DRUG_NAMES, resolveBuildIdentity, resolveDateRange, TypeConfigSchema, type DateRangePreset } from "@tornscope/shared";import { resolveSessionUser, assertSameOrigin, rebindCurrentSession, clearSessionCookie, currentSessionTokenHash, requestIsSecure, type SessionUser } from "./auth.js";
import { checkRateLimit, clientIp } from "./ratelimit.js";
import { env } from "./env.js";
import { errors, mapTornError, AppError } from "./errors.js";
import { getMoneyEvents, getMoneySummary } from "./services/money.js";
import { getNotificationsStatus, subscribePush, unsubscribePush, disableDevice, updatePreferences, sendTestNotification, getNotificationHistory } from "./services/notifications.js";
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
import { getProgression } from "./services/progression.js";
import { getEnergySummary } from "./services/energy.js";
import { getLogs, getLogsMeta, exportLogs } from "./services/logs.js";
import { getCrimesSummary, getCrimesTimeline, getCombatSummary, getCombatTimeline } from "./services/crimesCombat.js";
import { getFactionOverview, getFactionRankedWars, getFactionMembers, getFactionChains, getFactionOcs, getFactionLedger } from "./services/faction.js";
import { getTimeline } from "./services/timeline.js";
import { getDashboard } from "./services/dashboard.js";
import { getToday } from "./services/today.js";
import { getMerits } from "./services/merits.js";
import { getStocks } from "./services/stocks.js";
import { getDailySummary } from "./services/dailySummary.js";
import { getMe, getApiKeyStatus, saveApiKey, validateApiKey, linkProfile, deleteApiKey, setDemoView, deleteProfile, signOutOtherSessions } from "./services/me.js";
import { deleteEmptyProfile } from "@tornscope/database";
import { getSyncStatus, getSyncHealth, requestManualSync, retryFailedSyncs, retrySyncNow, restartBackfill } from "./services/syncStatus.js";
import { listGoals, createGoal, updateGoal, deleteGoal } from "./services/goals.js";
import { getInsights } from "./services/insights.js";
import { getCommandCenter } from "./services/commandCenter.js";
import { getSystemHealth } from "./services/systemHealth.js";
import { GoalCreateInputSchema, GoalUpdateInputSchema } from "@tornscope/shared";
import { getApiContext } from "./context.js";
import { checkReadiness } from "./services/readiness.js";
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
    // Health checks (bots/monitors) never create profiles or need identity.
    const url = (req.raw.url ?? "").split("?")[0]!;
    if (url === "/api/health" || url === "/" || url === "/api/ready") {
      assertSameOrigin(req);
      return;
    }
    (req as unknown as { currentUserValue: SessionUser | null }).currentUserValue = await resolveSessionUser(req, reply);
    assertSameOrigin(req);
    // The demo profile is a SHARED synthetic dataset. While the session is
    // resolved to it, no mutation may reach route logic — leaving demo view
    // (the one toggle that acts on the visitor's real profile) is exempt.
    // This blocks key save/delete, sync triggers and profile deletion against
    // the demo identity.
    if (currentUser(req).isDemo && req.method !== "GET" && req.method !== "HEAD" && url !== "/api/demo-view") {
      throw errors.conflict("This is the shared demo view — leave demo mode before changing anything.");
    }
  });

  app.get("/api/health", async () => ({
    status: "ok",
    ...resolveBuildIdentity({ version: env.build.version, gitSha: process.env.GIT_SHA ?? "dev", environment: env.build.environment }),
  }));

  // Readiness: can the hosted application actually serve users? Checks
  // PostgreSQL, Redis and worker heartbeat — never Torn API. (Migration
  // state is implicit: the API only starts after the migrate service
  // completed.) Returns 503 when any dependency is unreachable. Response
  // carries no credentials, connection strings or topology details.
  app.get("/api/ready", async (_req, reply) => {
    const db = getPrismaClient();
    const ctx = getApiContext();
    const { queueRedis } = await import("./redis.js");
    const result = await checkReadiness({
      dbPing: () => db.$queryRaw`SELECT 1`,
      withRedis: (fn) => queueRedis(ctx.syncQueue).then(fn),
    });
    if (!result.ready) {
      reply.status(503);
      return { status: "not_ready", ...result.checks };
    }
    return { status: "ready", ...result.checks };
  });

  app.get("/api/me", async (req) => {
    const user = currentUser(req);
    return getMe(user);
  });

  app.post("/api/demo-view", async (req, reply) => {
    // Toggle the flag on the SESSION's real profile — not on the resolved
    // (demo) user — otherwise leaving demo mode is impossible. Bounded per
    // session: the toggle is exempt from the demo-mutation block, so a
    // scripted session could otherwise hammer it at the global cap.
    const limit = checkRateLimit("demo-view", currentUser(req).id, 20, 10 * 60_000);
    if (!limit.ok) throw errors.rateLimited("Too many demo-view toggles — try again later.", limit.retryAfterSeconds);
    const profileId = (req as unknown as { sessionProfileId?: string }).sessionProfileId ?? currentUser(req).id;
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    await setDemoView({ id: profileId }, body.data.enabled);
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

  // Merits: live merits + official catalog enrichment (see services/merits.ts).
  app.get("/api/merits", async (req) => {
    const user = currentUser(req);
    return getMerits(user);
  });

  // Stocks: holdings, benefit blocks, valuations (see services/stocks.ts).
  app.get("/api/stocks", async (req) => {
    const user = currentUser(req);
    return getStocks(user);
  });

  // Daily Summary: one calendar day (user timezone) — GET /api/daily-summary?date=YYYY-MM-DD
  app.get("/api/daily-summary", async (req) => {
    const user = currentUser(req);
    const q = req.query as Record<string, unknown>;
    const date = typeof q.date === "string" && q.date.trim() !== "" ? q.date.trim() : undefined;
    return getDailySummary(user, date);
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

  // Progression & Energy Intelligence: battlestats, energy ledger, training
  // sessions, happy jumps — every figure provenance-labeled.
  app.get("/api/progression", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getProgression(user.id, range);
  });

  // Deep Energy Analytics (2.1.0): sources / uses / losses accounting over
  // locally ingested history — never a page-triggered Torn fetch.
  app.get("/api/energy/summary", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getEnergySummary(user.id, range);
  });

  // Log Explorer (2.1.0): filterable audit view over the raw log archive.
  app.get("/api/logs", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const q = req.query as { category?: string; type?: string; search?: string; outcome?: string; minAmount?: string; maxAmount?: string };
    for (const [key, value] of Object.entries({ category: q.category, type: q.type, search: q.search })) {
      if ((value ?? "").length > 100) throw errors.validation(`${key} must be ≤100 characters`);
    }
    const parseAmount = (raw: string | undefined): number | null | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) throw errors.validation("amount filters must be numeric");
      return n;
    };
    return getLogs(user.id, range, {
      category: q.category,
      type: q.type,
      search: q.search,
      outcome: q.outcome === "gain" || q.outcome === "loss" ? q.outcome : undefined,
      minAmount: parseAmount(q.minAmount),
      maxAmount: parseAmount(q.maxAmount),
      limit: pagination.limit,
      cursor: pagination.cursor,
    });
  });

  // Filter options derived from the user's own archive (bounded).
  app.get("/api/logs/meta", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    return getLogsMeta(user.id, range);
  });

  // Streaming CSV/JSON export of the FILTERED archive — server-side, capped,
  // session-scoped and free of API keys/secrets. GET is deliberate: exports
  // are read-only downloads (auth is the session cookie; same-origin guard
  // still applies via the preHandler hook).
  app.get("/api/logs/export", async (req, reply) => {
    const user = currentUser(req);
    const limit = checkRateLimit("log-export", user.id, 10, 10 * 60_000);
    if (!limit.ok) throw errors.rateLimited("Too many exports — try again later.", limit.retryAfterSeconds);
    const range = parseRange(req.query as Record<string, unknown>);
    const q = req.query as { format?: string; category?: string; type?: string; search?: string; outcome?: string; minAmount?: string; maxAmount?: string };
    const format = q.format === "csv" || q.format === "json" ? q.format : null;
    if (!format) throw errors.validation("format must be csv or json");
    for (const [key, value] of Object.entries({ category: q.category, type: q.type, search: q.search })) {
      if ((value ?? "").length > 100) throw errors.validation(`${key} must be ≤100 characters`);
    }
    const parseAmount = (raw: string | undefined): number | null | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) throw errors.validation("amount filters must be numeric");
      return n;
    };
    const exportRange = { ...range, from: range.from, to: range.to };
    return exportLogs(reply, user.id, exportRange, {
      format,
      category: q.category,
      type: q.type,
      search: q.search,
      outcome: q.outcome === "gain" || q.outcome === "loss" ? q.outcome : undefined,
      minAmount: parseAmount(q.minAmount),
      maxAmount: parseAmount(q.maxAmount),
    });
  });

  app.get("/api/money/events", async (req) => {
    const user = currentUser(req);
    const range = parseRange(req.query as Record<string, unknown>);
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const q = req.query as { category?: string; direction?: string; search?: string };
    if (q.direction && !["income", "expense"].includes(q.direction)) throw errors.validation("direction must be income or expense");
    if ((q.category ?? "").length > 100 || (q.search ?? "").length > 100) throw errors.validation("category/search must be ≤100 characters");
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
    if ((q.drugs ?? "").length > 200) throw errors.validation("drugs filter must be ≤200 characters");
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
    // "My" identity comes ONLY from this profile's linked Torn account —
    // never from a query parameter (ownership is never client-supplied).
    return getFactionOcs(user.id, range);
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

  // Full sync health for the Sync Status page: the caller's own resource
  // rows only — infrastructure topology lives in server logs/Docker, never
  // in user-facing API payloads.
  app.get("/api/sync/health", async (req) => {
    const user = currentUser(req);
    return getSyncHealth(user.id);
  });

  /* ------------------------------- 2.0: intelligence --------------------- */

  // Command Center: one prioritized attention feed composed from cached
  // today state, active goals, insights, stored OC state and freshness.
  app.get("/api/command-center", async (req) => {
    return getCommandCenter(currentUser(req));
  });

  // Personal goals: list (with current values + projections), create,
  // update, delete. Mutations are rate-limited modestly (goal writes are
  // rare) and always scoped to the session profile.
  app.get("/api/goals", async (req) => {
    const query = z.object({ lookbackDays: z.coerce.number().int().refine((v) => [7, 30, 90].includes(v)).optional() }).safeParse(req.query);
    if (!query.success) throw errors.validation(query.error.flatten());
    return listGoals(currentUser(req).id, { lookbackDays: query.data.lookbackDays });
  });

  app.post("/api/goals", async (req) => {
    const limit = checkRateLimit("goal-write", currentUser(req).id, 30, 10 * 60_000);
    if (!limit.ok) throw errors.rateLimited("Too many goal changes — try again later.", limit.retryAfterSeconds);
    const body = GoalCreateInputSchema.safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    return createGoal(currentUser(req).id, body.data);
  });

  app.patch("/api/goals/:id", async (req) => {
    const limit = checkRateLimit("goal-write", currentUser(req).id, 30, 10 * 60_000);
    if (!limit.ok) throw errors.rateLimited("Too many goal changes — try again later.", limit.retryAfterSeconds);
    const params = z.object({ id: z.string().min(1).max(64) }).safeParse(req.params);
    if (!params.success) throw errors.validation(params.error.flatten());
    const body = GoalUpdateInputSchema.safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    return updateGoal(currentUser(req).id, params.data.id, body.data);
  });

  app.delete("/api/goals/:id", async (req) => {
    const limit = checkRateLimit("goal-write", currentUser(req).id, 30, 10 * 60_000);
    if (!limit.ok) throw errors.rateLimited("Too many goal changes — try again later.", limit.retryAfterSeconds);
    const params = z.object({ id: z.string().min(1).max(64) }).safeParse(req.params);
    if (!params.success) throw errors.validation(params.error.flatten());
    return deleteGoal(currentUser(req).id, params.data.id);
  });

  // Deterministic personal insights (curated rule set over stored history).
  app.get("/api/insights", async (req) => {
    return getInsights(currentUser(req).id);
  });

  // System health: services, queue state and per-domain data freshness.
  // Read-only, no secrets; safe to poll at page cadence.
  app.get("/api/system/health", async (req) => {
    return getSystemHealth(currentUser(req));
  });


  app.post("/api/sync/run", async (req) => {
    const runLimit = checkRateLimit("sync-action", currentUser(req).id, 20, 10 * 60_000);
    if (!runLimit.ok) throw errors.rateLimited("Too many sync actions — try again later.", runLimit.retryAfterSeconds);
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
    const runLimit = checkRateLimit("sync-action", currentUser(req).id, 20, 10 * 60_000);
    if (!runLimit.ok) throw errors.rateLimited("Too many sync actions — try again later.", runLimit.retryAfterSeconds);
    const user = currentUser(req);
    return retryFailedSyncs(user.id);
  });

  // Safe "Retry now" for a single resource (Sync Status action). Returns a
  // machine-refusal reason instead of a generic error so the UI can disable
  // the button state-appropriately next time.
  app.post("/api/sync/retry", async (req) => {
    const runLimit = checkRateLimit("sync-action", currentUser(req).id, 20, 10 * 60_000);
    if (!runLimit.ok) throw errors.rateLimited("Too many sync actions — try again later.", runLimit.retryAfterSeconds);
    const user = currentUser(req);
    const body = z.object({ resource: z.string().min(1).max(64) }).safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    const result = await retrySyncNow(user.id, body.data.resource);
    if (!result.queued && result.refused === "cooldown" && (result.retryAfterSeconds ?? 0) > 0) {
      throw errors.cooldown(`A retry was requested recently. Try again in ${result.retryAfterSeconds}s.`);
    }
    return result;
  });

  app.post("/api/sync/backfill", async (req) => {
    const runLimit = checkRateLimit("sync-action", currentUser(req).id, 20, 10 * 60_000);
    if (!runLimit.ok) throw errors.rateLimited("Too many sync actions — try again later.", runLimit.retryAfterSeconds);
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

  const API_KEY_SCHEMA = z
    .object({
      key: z.string().regex(/^[A-Za-z0-9]{10,80}$/, "API key must be alphanumeric"),
      /** Set only after the user explicitly chose "start a new profile". */
      confirmNewProfile: z.boolean().optional(),
    })
    .strict();

  app.post("/api/settings/api-key/validate", async (req) => {
    const user = currentUser(req);
    const limit = checkRateLimit("key-save", clientIp(req), 10, 10 * 60_000);
    if (!limit.ok) {
      throw errors.rateLimited("Too many key attempts — try again later.", limit.retryAfterSeconds);
    }
    const body = API_KEY_SCHEMA.safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    try {
      return await validateApiKey(user, body.data.key);
    } catch (err) {
      handleRouteError(err);
    }
  });

  app.post("/api/settings/api-key", async (req, reply) => {
    const user = currentUser(req);
    // Rate limit: key validation hits the Torn API — never let it be spammed.
    const limit = checkRateLimit("key-save", clientIp(req), 10, 10 * 60_000);
    if (!limit.ok) {
      reply.header("Retry-After", limit.retryAfterSeconds);
      throw errors.rateLimited("Too many key attempts — try again later.", limit.retryAfterSeconds);
    }
    const body = API_KEY_SCHEMA.safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    try {
      const result = await saveApiKey(user, body.data.key, { confirmNewProfile: body.data.confirmNewProfile === true });
      // Identity-conflict resolution: rebind this browser to the new profile.
      if (result.newProfileId) await rebindCurrentSession(req, reply, getPrismaClient(), result.newProfileId);
      return result.status;
    } catch (err) {
      handleRouteError(err);
    }
  });

  /**
   * Link this browser to the EXISTING profile of the Torn identity a valid
   * key resolves to (multi-device / profile-reuse flow). A Limited key is a
   * sufficient identity proof; the stored credential is never touched and no
   * historical import is (re)started. The session token rotates on success.
   */
  app.post("/api/profile/link", async (req, reply) => {
    const user = currentUser(req);
    const limit = checkRateLimit("profile-link", clientIp(req), 10, 10 * 60_000);
    if (!limit.ok) {
      reply.header("Retry-After", limit.retryAfterSeconds);
      throw errors.rateLimited("Too many attempts — try again later.", limit.retryAfterSeconds);
    }
    const body = z.object({ key: z.string().regex(/^[A-Za-z0-9]{10,80}$/, "API key must be alphanumeric") }).strict().safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    try {
      const handoff = await linkProfile(user, body.data.key);
      if (handoff.linkToUserId) {
        // Rotate the session token and move this browser to the target
        // profile; every other session of that profile stays valid.
        await rebindCurrentSession(req, reply, getPrismaClient(), handoff.linkToUserId);
        // The throwaway guest (never connected, never synced) is removed so
        // abandoned link attempts do not accumulate empty profiles.
        await deleteEmptyProfile(getPrismaClient(), handoff.cleanupGuestUserId!);
      }
      return handoff.result;
    } catch (err) {
      handleRouteError(err);
    }
  });

  /** Sign out every OTHER active browser session of this profile. */
  app.post("/api/session/sign-out-others", async (req) => {
    const user = currentUser(req);
    const limit = checkRateLimit("sign-out-others", clientIp(req), 10, 10 * 60_000);
    if (!limit.ok) throw errors.rateLimited("Too many attempts — try again later.", limit.retryAfterSeconds);
    const tokenHash = currentSessionTokenHash(req);
    if (!tokenHash) throw errors.conflict("No active session found for this browser.");
    return signOutOtherSessions(user.id, tokenHash);
  });

  app.delete("/api/settings/api-key", async (req) => {
    const user = currentUser(req);
    const limit = checkRateLimit("key-delete", clientIp(req), 10, 10 * 60_000);
    if (!limit.ok) throw errors.rateLimited("Too many attempts — try again later.", limit.retryAfterSeconds);
    await deleteApiKey(user.id);
    return { deleted: true };
  });

  // ---- Push notifications (browser-bound, per-profile) --------------------

  app.get("/api/notifications", async (req) => {
    const user = currentUser(req);
    // The current browser identifies itself by its (unique) endpoint URL via
    // query — headers would be stripped by the same-origin proxy.
    const q = z.object({ endpoint: z.string().url().max(1000).optional() }).safeParse(req.query);
    return getNotificationsStatus(user, q.success ? q.data.endpoint ?? null : null);
  });

  app.post("/api/notifications/subscribe", async (req, reply) => {
    const user = currentUser(req);
    // Dedicated subscribe limiter: endpoint registration is the one push
    // action that writes to the subscription table — never let it be
    // spammed from one address.
    const limit = checkRateLimit("push-subscribe", clientIp(req), 20, 10 * 60_000);
    if (!limit.ok) {
      reply.header("Retry-After", limit.retryAfterSeconds);
      throw errors.rateLimited("Too many notification attempts — try again later.", limit.retryAfterSeconds);
    }
    const body = z
      .object({
        endpoint: z.string().url().max(1000),
        keys: z.object({ p256dh: z.string().min(10).max(255), auth: z.string().min(10).max(255) }),
      })
      .safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    const ua = req.headers["user-agent"] ?? null;
    await subscribePush(user, body.data, typeof ua === "string" ? ua : null);
    return { ok: true };
  });

  app.post("/api/notifications/unsubscribe", async (req) => {
    const writeLimit = checkRateLimit("notif-write", currentUser(req).id, 30, 10 * 60_000);
    if (!writeLimit.ok) throw errors.rateLimited("Too many notification changes — try again later.", writeLimit.retryAfterSeconds);
    const user = currentUser(req);
    const body = z.object({ endpoint: z.string().url().max(1000) }).safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    return unsubscribePush(user, body.data.endpoint);
  });

  app.post("/api/notifications/disable-device", async (req) => {
    const writeLimit = checkRateLimit("notif-write", currentUser(req).id, 30, 10 * 60_000);
    if (!writeLimit.ok) throw errors.rateLimited("Too many notification changes — try again later.", writeLimit.retryAfterSeconds);
    const user = currentUser(req);
    const body = z.object({ id: z.string().min(1).max(64) }).safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    return disableDevice(user, body.data.id);
  });

  app.post("/api/notifications/preferences", async (req) => {
    const writeLimit = checkRateLimit("notif-write", currentUser(req).id, 30, 10 * 60_000);
    if (!writeLimit.ok) throw errors.rateLimited("Too many notification changes — try again later.", writeLimit.retryAfterSeconds);
    const user = currentUser(req);
    const body = z
      .object({
        categories: z.record(z.string(), z.boolean()).optional(),
        sensitiveDetails: z.boolean().optional(),
        quietStartMin: z.number().int().min(0).max(1439).nullable().optional(),
        quietEndMin: z.number().int().min(0).max(1439).nullable().optional(),
        bypassCritical: z.boolean().optional(),
        typeConfig: TypeConfigSchema.partial().optional(),
      })
      .safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    return updatePreferences(user, body.data);
  });

  // Delivery history: the visible "what fired / what didn't and why" ledger.
  app.get("/api/notifications/history", async (req) => {
    const user = currentUser(req);
    return getNotificationHistory(user);
  });

  app.post("/api/notifications/test", async (req) => {
    const user = currentUser(req);
    const limit = checkRateLimit("notif-test", user.id, 5, 60_000);
    if (!limit.ok) throw errors.rateLimited("Too many test notifications — wait a minute.", limit.retryAfterSeconds);
    const body = z.object({ endpoint: z.string().url().max(1000) }).safeParse(req.body);
    if (!body.success) throw errors.validation(body.error.flatten());
    return sendTestNotification(user, body.data.endpoint);
  });

  app.get("/api/notifications/vapid-public-key", async () => {
    return { publicKey: env.vapidPublicKey || null };
  });

  // Destructive: deletes THIS browser profile, its encrypted key, sync state
  // and personal data. Never touches other profiles.
  app.post("/api/profile/delete", async (req, reply) => {
    const user = currentUser(req);
    const limit = checkRateLimit("profile-delete", clientIp(req), 5, 60 * 60_000);
    if (!limit.ok) throw errors.rateLimited("Too many attempts — try again later.", limit.retryAfterSeconds);
    await deleteProfile(user.id);
    reply.header("Set-Cookie", clearSessionCookie(requestIsSecure(req)));
    return { deleted: true };
  });

  app.get("/api/meta/drugs", async () => ({ drugs: TORN_DRUG_NAMES }));
}

export type { DateRangePreset };
