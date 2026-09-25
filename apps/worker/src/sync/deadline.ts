/**
 * Hard per-job deadline.
 *
 * The Torn API client bounds every HTTP round-trip (AbortSignal.timeout) and
 * every pagination walk is page-capped, but Prisma has NO statement timeout:
 * a half-open connection (network blip) can leave a DB await pending forever.
 * A never-settling processor promise keeps renewing its BullMQ lock (timers
 * still run), so the stalled checker never fires and one hung job blocked the
 * concurrency=1 sync queue for 18h (2026-09-24). This deadline guarantees the
 * worker always releases the slot: timeout => job fails (and retries), queue
 * continues.
 */

/** Default 15 min — the slowest legit sync ever recorded is ~3.5 min (money_logs backfill). */
export const SYNC_JOB_DEADLINE_MS = Math.max(60_000, Number(process.env.SYNC_JOB_DEADLINE_MS ?? 15 * 60_000));

/** Extra grace for the last-resort processor-level wrap (runner bookkeeping after deadline). */
export const PROCESSOR_DEADLINE_GRACE_MS = 2 * 60_000;

export class SyncDeadlineError extends Error {
  constructor(
    /** Where the run was when the deadline fired (last phase entered). */
    readonly phase: string,
    readonly elapsedMs: number
  ) {
    super(`sync job deadline exceeded after ${Math.round(elapsedMs / 1000)}s while in phase "${phase}"`);
    this.name = "SyncDeadlineError";
  }
}

/** Mutable current-phase marker; safe here because the sync worker runs jobs one at a time. */
export interface PhaseTracker {
  phase: string;
}

export function createPhaseTracker(initial: string): PhaseTracker {
  return { phase: initial };
}

/**
 * Reject with SyncDeadlineError if `promise` has not settled within `ms`.
 * The losing branch keeps running in the background (nothing to cancel
 * safely); the deadline only guarantees the worker stops WAITING on it.
 */
export function withDeadline<T>(promise: Promise<T>, tracker: PhaseTracker, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const startedAt = Date.now();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SyncDeadlineError(tracker.phase, Date.now() - startedAt)), ms);
  });
  // A late SyncDeadlineError after the winner settled must never crash the
  // process: drop it on the floor.
  timeout.catch(() => undefined);
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]) as Promise<T>;
}
