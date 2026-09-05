import { enqueueDueSyncs } from "./scheduler.js";
import { runResourceSync } from "./sync/runner.js";
import { env, logger } from "./env.js";
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
 */
async function main(): Promise<void> {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is required");
  logger.info({ redisUrl: env.redisUrl }, "starting tornscope worker");

  const syncQueue = createSyncQueue(env.redisUrl);
  const schedulerQueue = createSchedulerQueue(env.redisUrl);

  const syncWorker = createSyncWorker(env.redisUrl, async (job) => {
    const data = job.data as SyncJobData;
    logger.info({ userId: data.userId, resource: data.resource, manual: data.manual === true }, "sync job started");
    const outcome = await runResourceSync(data.userId, data.resource as never);
    if (!outcome.ok && !outcome.skipped) {
      // Job-level failure is already recorded in sync_state + sync_run;
      // do not retry automatically to respect the API budget.
      logger.warn({ userId: data.userId, resource: data.resource, error: outcome.error }, "sync job failed");
    }
    return outcome;
  });

  const schedulerWorker = createSchedulerWorker(env.redisUrl, async () => {
    await enqueueDueSyncs(syncQueue);
  });

  await registerSchedulerTick(schedulerQueue);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down worker");
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
