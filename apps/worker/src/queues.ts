import { Queue, Worker, type ConnectionOptions, type Processor } from "bullmq";
import {
  SCHEDULER_QUEUE,
  SCHEDULER_TICK_JOB_ID,
  SCHEDULER_TICK_JOB_NAME,
  SYNC_QUEUE,
  type SyncJobData as SharedSyncJobData,
} from "@tornscope/shared";

/**
 * BullMQ wiring. Two queues:
 * - tornscope-sync: one job per (user, resource) sync, concurrency 1 to stay
 *   polite to the Torn API (the torn-api client limiter spaces requests too).
 * - tornscope-scheduler: a repeating tick that enqueues due resources.
 *
 * Queue/job names live in @tornscope/shared (queues.ts) so the API and the
 * worker can never drift apart.
 */

export interface SyncJobData extends SharedSyncJobData {}

export function connectionOptions(redisUrl: string): ConnectionOptions {
  return { url: redisUrl };
}

export function createSyncQueue(redisUrl: string): Queue<SyncJobData> {
  return new Queue<SyncJobData>(SYNC_QUEUE, {
    connection: connectionOptions(redisUrl),
    defaultJobOptions: {
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 500 },
      // A sync must not hang forever; Torn pagination is bounded per handler
      // and the runner enforces a hard deadline (deadline.ts). One retry after
      // a fixed backoff so a transient failure (incl. deadline) is retried
      // while the queue keeps draining either way.
      attempts: 2,
      backoff: { type: "fixed", delay: 60_000 },
    },
  });
}

export function createSyncWorker(redisUrl: string, processor: Processor<SyncJobData>): Worker {
  return new Worker<SyncJobData>(SYNC_QUEUE, processor, {
    connection: connectionOptions(redisUrl),
    concurrency: 1,
    // Long initial backfills run far longer than the default 30s lock.
    lockDuration: 30 * 60_000,
    // Renew the lock while a job runs so long backfills are never stolen.
    lockRenewTime: 60_000,
  });
}

export function createSchedulerQueue(redisUrl: string): Queue {
  return new Queue(SCHEDULER_QUEUE, { connection: connectionOptions(redisUrl) });
}

export function createSchedulerWorker(redisUrl: string, processor: Processor): Worker {
  return new Worker(SCHEDULER_QUEUE, processor, {
    connection: connectionOptions(redisUrl),
    concurrency: 1,
    lockDuration: 5 * 60_000,
  });
}

/** Register the repeating 60s tick (idempotent thanks to a fixed jobId). */
export async function registerSchedulerTick(schedulerQueue: Queue): Promise<void> {
  await schedulerQueue.add(
    SCHEDULER_TICK_JOB_NAME,
    {},
    {
      repeat: { every: 60_000 },
      jobId: SCHEDULER_TICK_JOB_ID,
      removeOnComplete: 10,
      removeOnFail: 10,
    }
  );
}
