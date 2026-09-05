import { Queue, Worker, type ConnectionOptions, type Processor } from "bullmq";

/**
 * BullMQ wiring. Two queues:
 * - tornscope-sync: one job per (user, resource) sync, concurrency 1 to stay
 *   polite to the Torn API (the torn-api client limiter spaces requests too).
 * - tornscope-scheduler: a repeating tick that enqueues due resources.
 */

export const SYNC_QUEUE = "tornscope-sync";
export const SCHEDULER_QUEUE = "tornscope-scheduler";

export interface SyncJobData {
  userId: string;
  resource: string;
  manual?: boolean;
}

export function connectionOptions(redisUrl: string): ConnectionOptions {
  return { url: redisUrl };
}

export function createSyncQueue(redisUrl: string): Queue<SyncJobData> {
  return new Queue<SyncJobData>(SYNC_QUEUE, {
    connection: connectionOptions(redisUrl),
    defaultJobOptions: {
      removeOnComplete: 200,
      removeOnFail: 200,
      // A sync must not hang forever; Torn pagination is bounded per handler.
      attempts: 1,
    },
  });
}

export function createSyncWorker(redisUrl: string, processor: Processor<SyncJobData>): Worker {
  return new Worker<SyncJobData>(SYNC_QUEUE, processor, {
    connection: connectionOptions(redisUrl),
    concurrency: 1,
    lockDuration: 10 * 60_000,
  });
}

export function createSchedulerQueue(redisUrl: string): Queue {
  return new Queue(SCHEDULER_QUEUE, { connection: connectionOptions(redisUrl) });
}

export function createSchedulerWorker(redisUrl: string, processor: Processor): Worker {
  return new Worker(SCHEDULER_QUEUE, processor, {
    connection: connectionOptions(redisUrl),
    concurrency: 1,
  });
}

/** Register the repeating 60s tick (idempotent thanks to a fixed jobId). */
export async function registerSchedulerTick(schedulerQueue: Queue): Promise<void> {
  await schedulerQueue.add(
    "tick",
    {},
    {
      repeat: { every: 60_000 },
      jobId: "scheduler-tick",
      removeOnComplete: 10,
      removeOnFail: 10,
    }
  );
}
