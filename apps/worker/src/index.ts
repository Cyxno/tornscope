import { enqueueDueSyncs } from "./scheduler.js";
import { maybeRunDailyMaintenance } from "./maintenance.js";
import { evaluateNotifications } from "./notifications/engine.js";
import { runResourceSync } from "./sync/runner.js";
import { env, logger } from "./env.js";
import { queueRedis } from "./redis.js";
import {
  createSchedulerQueue,
  createSchedulerWorker,
  createSyncQueue,
  createSyncWorker,
  registerSchedulerTick,
  type SyncJobData,
} from "./queues.js";

/**
 * Worker entry point.
 * - processes sync jobs (one at a time, politeness-limited)
 * - processes scheduler ticks that enqueue due resources per user
 * - writes a Redis heartbeat so the API can report worker health
 */

const WORKER_HEARTBEAT_KEY = "tornscope:worker:heartbeat";
const HEARTBEAT_TTL_SECONDS = 180;

async function main(): Promise<void> {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required");
  // Never log credentials possibly embedded in the URL (redis://:pass@host).
  const sanitizedRedisUrl = (() => {
    try {
      const u = new URL(env.redisUrl);
      if (u.password) u.password = "«redacted»";
      if (u.username && u.username !== "") u.username = "«redacted»";
      return u.toString();
    } catch {
      return "«unparseable»";
    }
  })();
  logger.info({ redisUrl: sanitizedRedisUrl }, "starting tornscope worker");

  const syncQueue = createSyncQueue(env.redisUrl);
  const schedulerQueue = createSchedulerQueue(env.redisUrl);

  const syncWorker = createSyncWorker(env.redisUrl, async (job) => {
    const data = job.data as SyncJobData;
    logger.info({ userId: data.userId, resource: data.resource, manual: data.manual === true, stage: "job_received" }, "sync job received");
    const outcome = await runResourceSync(data.userId, data.resource as never, { force: data.manual === true });
    if (!outcome.ok && !outcome.skipped) {
      // Job-level failure is already recorded in sync_state + sync_run;
      // do not retry automatically to respect the API budget.
      logger.warn({ userId: data.userId, resource: data.resource, error: outcome.error, stage: "job_failed" }, "sync job failed");
    }
    return outcome;
  });

  syncWorker.on("stalled", (jobId) => logger.warn({ jobId }, "sync job stalled (lock lost, will be retried by BullMQ)"));
  syncWorker.on("error", (err) => logger.error({ err: (err as Error).message }, "sync worker error"));
  syncWorker.on("completed", (job) => logger.debug({ jobId: job.id }, "sync job completed"));

  const schedulerWorker = createSchedulerWorker(env.redisUrl, async () => {
    await enqueueDueSyncs(syncQueue);
    await maybeRunDailyMaintenance();
    // Push notification evaluation: self-throttled (min 2 min), only for
    // profiles with an active device subscription. Never per-minute Torn
    // polling — timer checks are gated by stored next-eligible timestamps.
    await evaluateNotifications();
  });
  schedulerWorker.on("error", (err) => logger.error({ err: (err as Error).message }, "scheduler worker error"));

  await registerSchedulerTick(schedulerQueue);

  // Heartbeat: touched on every scheduler tick (60s), expired after 3 min.
  const redis = await queueRedis(syncQueue);
  const heartbeat = setInterval(() => {
    redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()), "EX", HEARTBEAT_TTL_SECONDS).catch((err: Error) =>
      logger.warn({ err: err.message }, "heartbeat write failed")
    );
  }, 60_000);
  redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()), "EX", HEARTBEAT_TTL_SECONDS).catch(() => undefined);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down worker");
    clearInterval(heartbeat);
    await Promise.allSettled([syncWorker.close(), schedulerWorker.close(), syncQueue.close(), schedulerQueue.close()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  logger.info("worker ready");
}

main().catch((err) => {
  logger.error({ err: (err as Error).stack ?? String(err) }, "worker crashed");
  process.exit(1);
});
