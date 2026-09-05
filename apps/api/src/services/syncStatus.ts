import { getSyncStates, getPrismaClient, type SyncStateRow } from "@tornscope/database";
import { deriveSetupPhase, SYNC_JOB_NAME, SCHEDULER_QUEUE, buildSyncJobId, SYNC_RESOURCES, type SyncResource } from "@tornscope/shared";
import { getApiContext } from "../context.js";
import { queueRedis } from "../redis.js";

const WORKER_HEARTBEAT_KEY = "tornscope:worker:heartbeat";
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
 * Full sync + system health for the Sync Status page:
 * - per-resource rows with phase, cursor state and last safe error
 * - PostgreSQL / Redis reachability + worker heartbeat
 * - BullMQ queue depths (waiting/active/completed/failed/delayed)
 * - deployed build commit (injected at Docker build time, never hand-edited)
 */
export async function getSyncHealth(userId: string) {
  const db = getPrismaClient();
  const ctx = getApiContext();
  const states: SyncStateRow[] = await getSyncStates(db, userId);

  const countTypes = ["waiting", "active", "completed", "failed", "delayed"] as const;
  const redis = await queueRedis(ctx.syncQueue);
  const [syncCounts, schedulerCounts, postgresOk, redisOk, heartbeat, credential] = await Promise.all([
    ctx.syncQueue.getJobCounts(...countTypes).catch(() => null),
    ctx.schedulerQueue.getJobCounts(...countTypes).catch(() => null),
    db.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    redis.ping().then(() => true).catch(() => false),
    redis
      .get(WORKER_HEARTBEAT_KEY)
      .then((v: string | null) => (v ? Number(v) : null))
      .catch(() => null),
    db.apiCredential.findUnique({ where: { userId }, select: { revokedAt: true } }),
  ]);

  const lastErrorState = states.find((s) => s.errorMessage !== null);

  return {
    running: states.some((s) => s.status === "running"),
    build: { commit: process.env.GIT_SHA ?? "dev" },
    system: {
      postgres: postgresOk ? "up" : "down",
      redis: redisOk ? "up" : "down",
      worker: {
        online: heartbeat !== null && Date.now() - heartbeat < 180_000,
        lastHeartbeatAt: heartbeat !== null ? Math.floor(heartbeat / 1000) : null,
      },
      tornApi: {
        // No active probe (request budget); the last recorded sync error is
        // the reliable signal for Torn-side problems.
        lastError: lastErrorState ? { resource: lastErrorState.resource, message: lastErrorState.errorMessage } : null,
      },
    },
    queues: {
      sync: syncCounts,
      scheduler: schedulerCounts,
      note: "BullMQ re-queues stalled jobs automatically; they reappear under active/waiting.",
    },
    setupPhase: deriveSetupPhase({
      hasApiKey: Boolean(credential && !credential.revokedAt),
      resources: states.map((s) => ({
        status: s.status,
        lastSuccessAt: s.lastSuccessAt ? Math.floor(s.lastSuccessAt.getTime() / 1000) : null,
        lastAttemptAt: s.lastAttemptAt ? Math.floor(s.lastAttemptAt.getTime() / 1000) : null,
      })),
    }),
    resources: states.map((s) => ({
      resource: s.resource,
      status: s.status,
      phase: deriveResourcePhase(s),
      lastAttemptAt: s.lastAttemptAt ? Math.floor(s.lastAttemptAt.getTime() / 1000) : null,
      lastSuccessAt: s.lastSuccessAt ? Math.floor(s.lastSuccessAt.getTime() / 1000) : null,
      nextRunAt: s.nextRunAt ? Math.floor(s.nextRunAt.getTime() / 1000) : null,
      lastTimestamp: s.lastTimestamp !== null ? Number(s.lastTimestamp) : null,
      cursor: s.cursor,
      recordsCollected: s.recordsCollected,
      errorCount: s.errorCount,
      errorMessage: s.errorMessage,
    })),
  };
}

/**
 * Resource phase derived from sync_state (no invented percentages):
 * queued / running / backfilling / caught_up / failed.
 */
function deriveResourcePhase(s: SyncStateRow): "queued" | "running" | "backfilling" | "caught_up" | "failed" {
  if (s.status === "running") {
    // A resource that never succeeded yet is part of the initial backfill.
    return s.lastSuccessAt === null ? "backfilling" : "running";
  }
  if (s.status === "failed") return "failed";
  return s.lastSuccessAt !== null ? "caught_up" : "queued";
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

/** Retry every failed resource in one go (still guarded by the claim lock). */
export async function retryFailedSyncs(userId: string): Promise<{ queued: string[] }> {
  const db = getPrismaClient();
  const states = await db.syncState.findMany({ where: { userId, status: "failed" } });
  const ctx = getApiContext();
  const queued: string[] = [];
  for (const state of states) {
    if (!SYNC_RESOURCES.includes(state.resource as SyncResource)) continue;
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
    where: { userId, status: { not: "running" } },
    data: { lastTimestamp: null, cursor: null, nextRunAt: new Date() },
  });

  const ctx = getApiContext();
  let queued = 0;
  for (const resource of SYNC_RESOURCES) {
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
