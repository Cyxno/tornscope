/**
 * Centralized BullMQ queue configuration — the single source of truth for
 * queue names, job names and job ids, shared by the API (producer) and the
 * worker (consumer).
 *
 * History: job ids used to embed ":" separators ("sync:<user>:<resource>"),
 * which BullMQ rejects ("Custom Id cannot contain :"), so NO sync job was ever
 * accepted and the first-run flow hung on "Initial sync queued" forever. All
 * producers must build ids through the helpers below.
 */

export const SYNC_QUEUE = "tornscope-sync";
export const SCHEDULER_QUEUE = "tornscope-scheduler";

export const SYNC_JOB_NAME = "sync-resource";
export const SCHEDULER_TICK_JOB_NAME = "tick";
export const SCHEDULER_TICK_JOB_ID = "scheduler-tick";

export interface SyncJobData {
  userId: string;
  resource: string;
  manual?: boolean;
}

/**
 * BullMQ custom job ids may not contain ":". Use "." separators and keep ids
 * unique per attempt (the trailing timestamp makes retries distinct).
 */
export function buildSyncJobId(userId: string, resource: string, attempt: string | number): string {
  return `sync.${userId}.${resource}.${attempt}`;
}

/** Parse a sync job id back into its parts (null when not a sync id). */
export function parseSyncJobId(jobId: string): { userId: string; resource: string; attempt: string } | null {
  const parts = jobId.split(".");
  if (parts.length !== 4 || parts[0] !== "sync") return null;
  return { userId: parts[1] ?? "", resource: parts[2] ?? "", attempt: parts[3] ?? "" };
}
