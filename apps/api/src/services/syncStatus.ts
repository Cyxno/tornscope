import { getSyncStates, getSyncCategoryStates, getPrismaClient, type SyncStateRow } from "@tornscope/database";
import { deriveSetupPhase, normalizeCapabilitiesWithFallback, resourceAllowed, resourceRequirementLabel, SYNC_JOB_NAME, buildSyncJobId, SYNC_RESOURCES, deriveSyncOperationalState, deriveResourceIncidents, summarizeSyncMetrics, buildDataFreshness, type SyncIncident, type SyncOperationalMeta, type SyncResource, type SyncRunFact, type SyncRunMetrics } from "@tornscope/shared";
import { AppError } from "../errors.js";
import { getApiContext } from "../context.js";
import { resourceConfidence } from "./confidence.js";

const BACKFILL_FLAG = "backfill_restart_at";

/** Basic per-resource sync status (used by the welcome progress view). */
export async function getSyncStatus(userId: string) {
  const db = getPrismaClient();
  const states: SyncStateRow[] = await getSyncStates(db, userId);
  return {
    running: states.some((s) => s.status === "running"),
    resources: states.map((s) => ({
      resource: s.resource,
      status: s.status,
      lastAttemptAt: s.lastAttemptAt ? Math.floor(s.lastAttemptAt.getTime() / 1000) : null,
      lastSuccessAt: s.lastSuccessAt ? Math.floor(s.lastSuccessAt.getTime() / 1000) : null,
      nextRunAt: s.nextRunAt ? Math.floor(s.nextRunAt.getTime() / 1000) : null,
      recordsCollected: s.recordsCollected,
      errorMessage: s.errorMessage,
    })),
  };
}

/**
 * Full sync health for the Sync Status page: the caller's OWN per-resource
 * rows with phase, cursor state and last safe error. Infrastructure topology
 * (PostgreSQL/Redis/worker/queues) and the deployed build identity are NOT
 * part of any user-facing payload — infrastructure is monitored through
 * server logs, Docker and Unraid, not through the product.
 */
export async function getSyncHealth(userId: string): Promise<Awaited<ReturnType<typeof buildSyncHealth>>> {
  return buildSyncHealth(userId);
}

async function buildSyncHealth(userId: string) {
  const db = getPrismaClient();
  const states: SyncStateRow[] = await getSyncStates(db, userId);

  const [credential, user] = await Promise.all([
    db.apiCredential.findUnique({ where: { userId }, select: { revokedAt: true, capabilities: true, accessLevel: true } }),
    db.user.findUnique({ where: { id: userId }, select: { isDemo: true } }),
  ]);
  const caps = credential && !credential.revokedAt
    ? normalizeCapabilitiesWithFallback(credential.capabilities, credential.accessLevel)
    : null;
  const confidenceCtx = {
    caps,
    states: new Map(states.map((s) => [s.resource, s])),
    isDemo: Boolean(user?.isDemo),
  };

  // Earliest/latest STRUCTURED row per resource — the real stored coverage,
  // shown next to what Torn still exposes (sourceEarliestAt) so it is obvious
  // why a domain covers 7, 30 or 180 days.
  const [drugW, rehabW, moneyW, travelW, eventW, networthW] = await Promise.all([
    db.drugEvent.aggregate({ where: { userId }, _min: { occurredAt: true }, _max: { occurredAt: true } }),
    db.rehabEvent.aggregate({ where: { userId }, _min: { occurredAt: true }, _max: { occurredAt: true } }),
    db.moneyEvent.aggregate({ where: { userId }, _min: { occurredAt: true }, _max: { occurredAt: true } }),
    db.travelTransition.aggregate({ where: { userId }, _min: { occurredAt: true }, _max: { occurredAt: true } }),
    db.timelineEvent.aggregate({ where: { userId, type: "torn_event" }, _min: { occurredAt: true }, _max: { occurredAt: true } }),
    db.networthSnapshot.aggregate({ where: { userId }, _min: { capturedAt: true }, _max: { capturedAt: true } }),
  ]);
  const storedWindows: Record<string, { earliest: Date | null; latest: Date | null }> = {
    drugs: { earliest: drugW._min.occurredAt, latest: drugW._max.occurredAt },
    rehab: { earliest: rehabW._min.occurredAt, latest: rehabW._max.occurredAt },
    money_logs: { earliest: moneyW._min.occurredAt, latest: moneyW._max.occurredAt },
    travel: { earliest: travelW._min.occurredAt, latest: travelW._max.occurredAt },
    events: { earliest: eventW._min.occurredAt, latest: eventW._max.occurredAt },
    networth: { earliest: networthW._min.capturedAt, latest: networthW._max.capturedAt },
  };
  const sec = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null);

  // Per-category cursor detail for walk resources (money, drugs, ...).
  // Batched in one parallel pass — never one query per row.
  const WALK_RESOURCES = ["drugs", "rehab", "money_logs", "travel"];
  const categoryStates = new Map<string, Awaited<ReturnType<typeof getSyncCategoryStates>>>();
  await Promise.all(
    WALK_RESOURCES.map(async (resource) => {
      categoryStates.set(resource, await getSyncCategoryStates(db, userId, resource));
    })
  );
  const hasCategoryProblems = (resource: string): boolean =>
    (categoryStates.get(resource) ?? []).some((c) => c.status === "failed" || c.status === "access_denied");

  // Recent run history for incident/degraded/metric derivation: ONE query for
  // all resources (48h fetch so streaks spanning the 24h incident window stay
  // one episode), then grouped in memory — no BullMQ reads, no per-row queries.
  const nowMs = Date.now();
  const runs = await db.syncRun.findMany({
    where: { userId, startedAt: { gte: new Date(nowMs - 48 * 3600_000) } },
    orderBy: { startedAt: "asc" },
  });
  const runsByResource = new Map<string, SyncRunFact[]>();
  for (const run of runs) {
    const list = runsByResource.get(run.resource) ?? [];
    list.push({
      status: run.status,
      startedAt: Math.floor(run.startedAt.getTime() / 1000),
      finishedAt: run.finishedAt ? Math.floor(run.finishedAt.getTime() / 1000) : null,
      errorKind: typeof (run.stats as { errorKind?: unknown } | null)?.errorKind === "string" ? ((run.stats as { errorKind: string }).errorKind) : null,
    });
    runsByResource.set(run.resource, list);
  }
  const nowSec = Math.floor(nowMs / 1000);
  const operationalFor = (s: SyncStateRow): SyncOperationalMeta =>
    deriveSyncOperationalState(
      {
        status: s.status,
        lastAttemptAt: s.lastAttemptAt ? Math.floor(s.lastAttemptAt.getTime() / 1000) : null,
        lastStartedAt: s.lastStartedAt ? Math.floor(s.lastStartedAt.getTime() / 1000) : null,
        lastHeartbeatAt: s.lastHeartbeatAt ? Math.floor(s.lastHeartbeatAt.getTime() / 1000) : null,
        lastSuccessAt: s.lastSuccessAt ? Math.floor(s.lastSuccessAt.getTime() / 1000) : null,
        nextRunAt: s.nextRunAt ? Math.floor(s.nextRunAt.getTime() / 1000) : null,
        frequencySeconds: s.frequencySeconds,
        errorCount: s.errorCount,
        lastErrorKind: s.lastErrorKind,
        hasCategoryProblems: hasCategoryProblems(s.resource),
      },
      nowSec
    );
  const incidentsFor = (resource: string): SyncIncident[] => deriveResourceIncidents(runsByResource.get(resource) ?? [], nowSec);
  const metricsFor = (resource: string): SyncRunMetrics | null => {
    const resourceRuns = runsByResource.get(resource) ?? [];
    return resourceRuns.length > 0 ? summarizeSyncMetrics(resourceRuns, nowSec) : null;
  };

  return {
    running: states.some((s) => s.status === "running"),
    setupPhase: deriveSetupPhase({
      hasApiKey: Boolean(credential && !credential.revokedAt),
      resources: states.map((s) => ({
        status: s.status,
        lastSuccessAt: s.lastSuccessAt ? Math.floor(s.lastSuccessAt.getTime() / 1000) : null,
        lastAttemptAt: s.lastAttemptAt ? Math.floor(s.lastAttemptAt.getTime() / 1000) : null,
      })),
    }),
    /** User-facing per-domain data freshness (2.0) — derived from the same facts. */
    freshness: buildDataFreshness(
      states.map((s) => ({
        resource: s.resource,
        status: s.status,
        lastAttemptAt: s.lastAttemptAt ? Math.floor(s.lastAttemptAt.getTime() / 1000) : null,
        lastSuccessAt: s.lastSuccessAt ? Math.floor(s.lastSuccessAt.getTime() / 1000) : null,
        nextRunAt: s.nextRunAt ? Math.floor(s.nextRunAt.getTime() / 1000) : null,
        frequencySeconds: s.frequencySeconds,
        errorCount: s.errorCount,
        lastErrorKind: s.lastErrorKind,
      })),
      nowSec
    ),
    resources: states.map((s) => ({
      resource: s.resource,
      status: s.status,
      phase: deriveResourcePhase(s, categoryStates.get(s.resource) ?? []),
      lastAttemptAt: s.lastAttemptAt ? Math.floor(s.lastAttemptAt.getTime() / 1000) : null,
      lastSuccessAt: s.lastSuccessAt ? Math.floor(s.lastSuccessAt.getTime() / 1000) : null,
      nextRunAt: s.nextRunAt ? Math.floor(s.nextRunAt.getTime() / 1000) : null,
      lastTimestamp: s.lastTimestamp !== null ? Number(s.lastTimestamp) : null,
      cursor: s.cursor,
      recordsCollected: s.recordsCollected,
      errorCount: s.errorCount,
      errorMessage: s.errorMessage,
      stopReason: s.stopReason,
      sourceEarliestAt: s.sourceEarliestAt !== null ? Number(s.sourceEarliestAt) : null,
      lastWalkPages: s.lastWalkPages,
      storedEarliestAt: sec(storedWindows[s.resource]?.earliest ?? null),
      storedLatestAt: sec(storedWindows[s.resource]?.latest ?? null),
      // Data confidence — deliberately separate from the operational phase.
      confidence: resourceConfidence(confidenceCtx, s.resource as SyncResource, {
        coverageTo: sec(storedWindows[s.resource]?.latest ?? null),
        hasCategoryProblems: hasCategoryProblems(s.resource),
      }),
      // Operational sync health — separate vocabulary, central derivation.
      operational: operationalFor(s),
      lastErrorKind: s.lastErrorKind,
      recentIncidents: incidentsFor(s.resource),
      metrics: metricsFor(s.resource),
      categories: (categoryStates.get(s.resource) ?? []).map((c) => ({
        categoryId: c.categoryId,
        title: c.categoryTitle,
        status: c.status,
        lastTimestamp: c.lastTimestamp !== null ? Number(c.lastTimestamp) : null,
        lastSuccessAt: sec(c.lastSuccessAt),
        lastWalkPages: c.lastWalkPages,
        lastRecordsInserted: c.lastRecordsInserted,
        errorMessage: c.errorMessage,
        lastActivityAt: sec(c.lastActivityAt),
        frequencySeconds: c.frequencySeconds,
        nextRunAt: sec(c.nextRunAt),
      })),
      scheduleSummary: summarizeSchedule(categoryStates.get(s.resource) ?? [], nowSec),
    })),
    /** Requested history window (worker env default) — coverage is judged against it. */
    requestedHistoryDays: Number(process.env.TORN_SYNC_INITIAL_HISTORY_DAYS ?? 180),
  };
}

/**
 * Resource phase derived from sync_state (no invented percentages):
 * queued / running / backfilling / caught_up / failed.
 *
 * For backward-walk resources (the log domains) "caught_up" requires the
 * historical walk to have finished cleanly (history_boundary_reached /
 * source_exhausted) — max_pages, stalls and API errors stay "backfilling".
 * Snapshot resources (networth, profile, ...) have no history walk; they are
 * caught up once they have ever succeeded.
 */
const WALK_RESOURCES = new Set(["drugs", "rehab", "money_logs", "travel", "events"]);

type CategoryStateLike = { status: string; lastSuccessAt: Date | null };

interface ScheduleStateLike {
  status: string;
  nextRunAt: Date | null;
  lastActivityAt: Date | null;
}

/** Aggregate adaptive-schedule tiers for a resource (Sync Status summary). */
function summarizeSchedule(categories: ScheduleStateLike[], nowSec: number) {
  const due = categories.filter((c) => c.nextRunAt === null || Math.floor(c.nextRunAt.getTime() / 1000) <= nowSec).length;
  const hot = categories.filter((c) => c.lastActivityAt !== null && nowSec - Math.floor(c.lastActivityAt.getTime() / 1000) <= 3600).length;
  const warm = categories.filter((c) => c.lastActivityAt !== null && nowSec - Math.floor(c.lastActivityAt.getTime() / 1000) > 3600 && nowSec - Math.floor(c.lastActivityAt.getTime() / 1000) <= 6 * 3600).length;
  const cold = categories.filter((c) => c.lastActivityAt !== null && nowSec - Math.floor(c.lastActivityAt.getTime() / 1000) > 6 * 3600 && nowSec - Math.floor(c.lastActivityAt.getTime() / 1000) <= 48 * 3600).length;
  const veryCold = categories.filter((c) => c.lastActivityAt === null || nowSec - Math.floor(c.lastActivityAt.getTime() / 1000) > 48 * 3600).length;
  const retry = categories.filter((c) => c.status === "failed").length;
  const accessDenied = categories.filter((c) => c.status === "access_denied").length;
  return { total: categories.length, due, hot, warm, cold, veryCold, retry, accessDenied };
}

export function deriveResourcePhase(s: SyncStateRow, categories: CategoryStateLike[] = []): "queued" | "running" | "backfilling" | "caught_up" | "partial" | "failed" | "permission_required" {
  if (s.status === "capability_denied") {
    // The connected key cannot access this resource at all — a permission
    // state, never a generic sync failure.
    return "permission_required";
  }
  if (s.status === "running") {
    // A resource that never succeeded yet is part of the initial backfill.
    return s.lastSuccessAt === null ? "backfilling" : "running";
  }
  if (s.status === "failed") return "failed";
  if (s.lastSuccessAt === null) return "queued";
  if (!WALK_RESOURCES.has(s.resource)) return "caught_up";
  // Per-category truth beats the resource-level summary: if any category
  // failed (or is access-denied) the resource is only PARTIAL — successful
  // categories keep their progress and are never rolled back.
  const failed = categories.filter((c) => c.status === "failed" || c.status === "access_denied").length;
  if (categories.length > 0 && failed > 0) return failed === categories.length ? "failed" : "partial";
  if (s.stopReason === null) return "backfilling"; // pre-coverage state; wait for next walk
  if (s.stopReason === "history_boundary_reached" || s.stopReason === "source_exhausted") return "caught_up";
  // max_pages / cursor_stalled / api_error — history incomplete.
  return "backfilling";
}

/**
 * Manual "Sync now": enqueue a sync job with a 60s cooldown per resource to
 * prevent Torn API spam. The worker enforces the real execution lock.
 * `force` skips the cooldown (used by the explicit retry action).
 */
const MANUAL_COOLDOWN_MS = 60_000;

export async function requestManualSync(
  userId: string,
  resource: string,
  opts: { force?: boolean } = {}
): Promise<{ queued: boolean; retryAfterSeconds?: number }> {
  const db = getPrismaClient();
  if (!SYNC_RESOURCES.includes(resource as SyncResource)) {
    return { queued: false, retryAfterSeconds: 0 };
  }
  // Abuse/cost control: no credential -> no Torn API work, ever.
  const credential = await db.apiCredential.findUnique({ where: { userId } });
  if (!credential || credential.revokedAt) {
    return { queued: false, retryAfterSeconds: 0 };
  }
  // Capability gate: "Sync now" must respect what the key can access.
  if (!resourceAllowed(normalizeCapabilitiesWithFallback(credential.capabilities, credential.accessLevel), resource as SyncResource)) {
    throw new AppError(
      "permission_required",
      `Your API key does not include ${resourceRequirementLabel(resource as SyncResource)} — this resource cannot be synced with the current key.`,
      409,
      { resource, requirement: resourceRequirementLabel(resource as SyncResource) }
    );
  }
  const state = await db.syncState.findUnique({ where: { userId_resource: { userId, resource } } });
  if (state) {
    if (state.status === "running") {
      return { queued: false, retryAfterSeconds: 0 };
    }
    const lastAttempt = state.lastAttemptAt?.getTime() ?? 0;
    const elapsed = Date.now() - lastAttempt;
    if (!opts.force && lastAttempt > 0 && elapsed < MANUAL_COOLDOWN_MS) {
      return { queued: false, retryAfterSeconds: Math.ceil((MANUAL_COOLDOWN_MS - elapsed) / 1000) };
    }
  }

  const ctx = getApiContext();
  await ctx.syncQueue.add(
    SYNC_JOB_NAME,
    { userId, resource, manual: true },
    // BullMQ forbids ":" in custom job ids — build ids via the shared helper.
    { jobId: buildSyncJobId(userId, resource, `manual${Date.now()}`) }
  );
  return { queued: true };
}

/**
 * Safe per-resource "Retry now" (Sync Status action): user-scoped, refuses a
 * healthy-running resource (the claim lock alone would swallow the job),
 * never touches cursors/history, and keeps a short cooldown even on the
 * force path so a broken resource cannot be hammered. Overlap safety stays
 * with the worker's claim lock; no duplicate history is written here.
 */
const RETRY_COOLDOWN_MS = 30_000;

export async function retrySyncNow(
  userId: string,
  resource: string
): Promise<{ queued: boolean; refused?: "running" | "parked" | "no_key" | "cooldown"; retryAfterSeconds?: number }> {
  const db = getPrismaClient();
  if (!SYNC_RESOURCES.includes(resource as SyncResource)) {
    return { queued: false, refused: "no_key" };
  }
  const credential = await db.apiCredential.findUnique({ where: { userId } });
  if (!credential || credential.revokedAt) {
    return { queued: false, refused: "no_key" };
  }
  // A parked resource needs a permission change, not a retry — retrying
  // without the selection would only burn the re-check cycle.
  if (!resourceAllowed(normalizeCapabilitiesWithFallback(credential.capabilities, credential.accessLevel), resource as SyncResource)) {
    return { queued: false, refused: "parked" };
  }
  const state = await db.syncState.findUnique({ where: { userId_resource: { userId, resource } } });
  if (state?.status === "running") {
    return { queued: false, refused: "running" };
  }
  if (state?.status === "capability_denied") {
    return { queued: false, refused: "parked" };
  }
  const lastAttempt = state?.lastAttemptAt?.getTime() ?? 0;
  const elapsed = Date.now() - lastAttempt;
  if (lastAttempt > 0 && elapsed < RETRY_COOLDOWN_MS) {
    return { queued: false, refused: "cooldown", retryAfterSeconds: Math.ceil((RETRY_COOLDOWN_MS - elapsed) / 1000) };
  }

  const ctx = getApiContext();
  await ctx.syncQueue.add(
    SYNC_JOB_NAME,
    { userId, resource, manual: true },
    { jobId: buildSyncJobId(userId, resource, `retrynow${Date.now()}`) }
  );
  return { queued: true };
}

/** Retry every failed resource in one go (still guarded by the claim lock). */
export async function retryFailedSyncs(userId: string): Promise<{ queued: string[] }> {  const db = getPrismaClient();
  const credential = await db.apiCredential.findUnique({ where: { userId } });
  if (!credential || credential.revokedAt) {
    return { queued: [] };
  }
  const caps = normalizeCapabilitiesWithFallback(credential.capabilities, credential.accessLevel);
  const states = await db.syncState.findMany({ where: { userId, status: "failed" } });
  const ctx = getApiContext();
  const queued: string[] = [];
  for (const state of states) {
    if (!SYNC_RESOURCES.includes(state.resource as SyncResource)) continue;
    // Capability-blocked resources are not "failed" — retrying them without
    // the permission would only hammer denied endpoints.
    if (!resourceAllowed(caps, state.resource as SyncResource)) continue;
    await ctx.syncQueue.add(
      SYNC_JOB_NAME,
      { userId, resource: state.resource, manual: true },
      { jobId: buildSyncJobId(userId, state.resource, `retry${Date.now()}`) }
    );
    queued.push(state.resource);
  }
  return { queued };
}

/**
 * Restart the initial backfill: clear cursors and re-enqueue every resource.
 * Dedup (unique constraints) makes replay safe; rate-limited to once per
 * 5 minutes. Never touches stored history.
 */
const BACKFILL_COOLDOWN_MS = 5 * 60_000;

export async function restartBackfill(userId: string): Promise<{ queued: number; retryAfterSeconds?: number }> {
  const db = getPrismaClient();
  const credential = await db.apiCredential.findUnique({ where: { userId } });
  if (!credential || credential.revokedAt) {
    return { queued: 0, retryAfterSeconds: 0 };
  }
  // Capability-aware: resources the key cannot answer are never enqueued and
  // stay parked at their re-check interval instead of cycling through the
  // worker as instant capability_denied jobs.
  const caps = normalizeCapabilitiesWithFallback(credential.capabilities, credential.accessLevel);
  const allowedResources = SYNC_RESOURCES.filter((resource) => resourceAllowed(caps, resource));
  const last = await db.appSetting.findUnique({ where: { userId_key: { userId, key: BACKFILL_FLAG } } });
  const lastAt = Number(last?.value ?? 0);
  if (Number.isFinite(lastAt) && lastAt > 0 && Date.now() - lastAt < BACKFILL_COOLDOWN_MS) {
    return { queued: 0, retryAfterSeconds: Math.ceil((BACKFILL_COOLDOWN_MS - (Date.now() - lastAt)) / 1000) };
  }
  await db.appSetting.upsert({
    where: { userId_key: { userId, key: BACKFILL_FLAG } },
    create: { userId, key: BACKFILL_FLAG, value: Date.now() },
    update: { value: Date.now() },
  });

  await db.syncState.updateMany({
    where: { userId, resource: { in: allowedResources }, status: { not: "running" } },
    data: { lastTimestamp: null, cursor: null, nextRunAt: new Date() },
  });
  // A real historical backfill ignores adaptive scheduling: every category
  // re-walks the configured window immediately. Cursors reset, history kept.
  await db.syncCategoryState.updateMany({
    where: { userId },
    data: { lastTimestamp: null, nextRunAt: new Date(), consecutiveEmptyRuns: 0, status: "active" },
  });

  const ctx = getApiContext();
  let queued = 0;
  for (const resource of allowedResources) {
    try {
      await ctx.syncQueue.add(
        SYNC_JOB_NAME,
        { userId, resource, manual: true },
        { jobId: buildSyncJobId(userId, resource, `backfill${Date.now()}`) }
      );
      queued += 1;
    } catch {
      // The scheduler picks up anything we failed to enqueue (nextRunAt=now).
    }
  }
  return { queued };
}
