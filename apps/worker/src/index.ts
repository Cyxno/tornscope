import { enqueueDueSyncs } from "./scheduler.js";
import { maybeRunDailyMaintenance } from "./maintenance.js";
import { maybeTopUpDemoData } from "@tornscope/database";
import { evaluateNotifications } from "./notifications/engine.js";
import { runResourceSync } from "./sync/runner.js";
import { PROCESSOR_DEADLINE_GRACE_MS, SYNC_JOB_DEADLINE_MS, SyncDeadlineError, createPhaseTracker, withDeadline } from "./sync/deadline.js";
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
    // Last-resort hard wrap: runResourceSync already enforces a deadline on
    // the handler, but this guard also covers the runner's own bookkeeping
    // (e.g. failure writes to a wedged DB) so the worker slot is ALWAYS
    // released. Rejecting here fails the job in BullMQ (attempts: 2).
    const outcome = await withDeadline(
      runResourceSync(data.userId, data.resource as never, { force: data.manual === true }),
      createPhaseTracker("runResourceSync"),
      SYNC_JOB_DEADLINE_MS + PROCESSOR_DEADLINE_GRACE_MS
    );
    if (!outcome.ok && !outcome.skipped) {
      // Job-level failure is already recorded in sync_state + sync_run.
      // A deadline hit is rethrown so BullMQ records the failure and runs
      // its single retry; other failures are not retried (API budget).
      logger.warn({ userId: data.userId, resource: data.resource, error: outcome.error, stage: "job_failed" }, "sync job failed");
      if (outcome.deadlineExceeded) throw new SyncDeadlineError("runResourceSync", SYNC_JOB_DEADLINE_MS);
    }
    return outcome;
  });

  syncWorker.on("stalled", (jobId) => logger.warn({ jobId }, "sync job stalled (lock lost, will be retried by BullMQ)"));
  syncWorker.on("error", (err) => logger.error({ err: (err as Error).message }, "sync worker error"));
  syncWorker.on("completed", (job) => logger.debug({ jobId: job.id }, "sync job completed"));

  const schedulerWorker = createSchedulerWorker(env.redisUrl, async () => {
    await enqueueDueSyncs(syncQueue);
    await maybeRunDailyMaintenance();
    // Demo freshness (V1.0): extend the synthetic demo history toward now —
    // self-throttled (min 6h via the demo watermark), pure DB generation,
    // no Torn requests, no push. Cheap no-op while the demo is current.
    await maybeTopUpDemoData();
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
