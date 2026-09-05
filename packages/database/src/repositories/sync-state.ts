import type { PrismaClientType } from "../client.js";
import type { SyncResource } from "@tornscope/shared";
import { DEFAULT_SYNC_FREQUENCIES_SECONDS } from "@tornscope/shared";

/**
 * Sync state repository. The worker claims resources through this table to
 * prevent overlapping runs; the API reads it for the Sync Status page.
 */

export type SyncStateRow = {
  resource: string;
  status: string;
  lastAttemptAt: Date | null;
  lastStartedAt: Date | null;
  lastCompletedAt: Date | null;
  lastSuccessAt: Date | null;
  nextRunAt: Date | null;
  lastTimestamp: bigint | null;
  cursor: string | null;
  recordsCollected: number;
  errorCount: number;
  errorMessage: string | null;
  frequencySeconds: number;
};

/** Ensure sync_state rows exist for every resource of a user. */
export async function ensureSyncStates(db: PrismaClientType, userId: string, frequencies?: Partial<Record<SyncResource, number>>): Promise<void> {
  const defaults = { ...DEFAULT_SYNC_FREQUENCIES_SECONDS, ...frequencies };
  await db.$transaction(
    Object.entries(defaults).map(([resource, frequencySeconds]) =>
      db.syncState.upsert({
        where: { userId_resource: { userId, resource } },
        create: { userId, resource, frequencySeconds },
        update: {},
      })
    )
  );
}

/** Read stale "running" states: a run older than this is considered crashed. */
export const RUNNING_STALE_AFTER_MS = 15 * 60_000;

export interface ClaimResult {
  claimed: boolean;
  state: SyncStateRow | null;
}

/**
 * Atomically claim a resource for syncing (guards against overlapping jobs
 * and recovers after crashes by treating stale runs as failed).
 */
export async function claimResource(db: PrismaClientType, userId: string, resource: SyncResource, now = new Date()): Promise<ClaimResult> {
  return db.$transaction(async (tx) => {
    const state = await tx.syncState.findUnique({
      where: { userId_resource: { userId, resource } },
    });
    if (!state) return { claimed: false, state: null };

    if (state.status === "running") {
      const started = state.lastStartedAt?.getTime() ?? 0;
      if (now.getTime() - started < RUNNING_STALE_AFTER_MS) {
        return { claimed: false, state };
      }
      // Stale run from a crashed worker - recover.
      await tx.syncState.update({
        where: { id: state.id },
        data: { status: "failed", errorMessage: "previous run timed out (recovered)" },
      });
    }

    const updated = await tx.syncState.update({
      where: { id: state.id },
      data: { status: "running", lastStartedAt: now, lastAttemptAt: now, errorMessage: null },
    });
    return { claimed: true, state: updated };
  });
}

export interface CompletionUpdate {
  success: boolean;
  recordsCollected?: number;
  errorMessage?: string | null;
  lastTimestamp?: bigint | null;
  cursor?: string | null;
  nextRunAt?: Date | null;
  now?: Date;
}

export async function completeResource(db: PrismaClientType, userId: string, resource: SyncResource, update: CompletionUpdate): Promise<void> {
  const now = update.now ?? new Date();
  await db.syncState.update({
    where: { userId_resource: { userId, resource } },
    data: {
      status: update.success ? "idle" : "failed",
      lastCompletedAt: now,
      lastSuccessAt: update.success ? now : undefined,
      recordsCollected: update.recordsCollected ? { increment: update.recordsCollected } : undefined,
      errorMessage: update.success ? null : (update.errorMessage ?? "unknown error"),
      errorCount: update.success ? 0 : { increment: 1 },
      lastTimestamp: update.lastTimestamp ?? undefined,
      cursor: update.cursor ?? undefined,
      nextRunAt: update.nextRunAt ?? undefined,
    },
  });
}

export async function recordSyncRun(
  db: PrismaClientType,
  userId: string,
  resource: SyncResource,
  run: { startedAt: Date; finishedAt: Date | null; status: string; recordsCollected: number; errorMessage?: string | null }
): Promise<void> {
  await db.syncRun.create({
    data: {
      userId,
      resource,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      status: run.status,
      recordsCollected: run.recordsCollected,
      errorMessage: run.errorMessage ?? null,
    },
  });
}

export async function getSyncStates(db: PrismaClientType, userId: string): Promise<SyncStateRow[]> {
  const rows = await db.syncState.findMany({ where: { userId }, orderBy: { resource: "asc" } });
  return rows.map((r) => ({
    resource: r.resource,
    status: r.status,
    lastAttemptAt: r.lastAttemptAt,
    lastStartedAt: r.lastStartedAt,
    lastCompletedAt: r.lastCompletedAt,
    lastSuccessAt: r.lastSuccessAt,
    nextRunAt: r.nextRunAt,
    lastTimestamp: r.lastTimestamp,
    cursor: r.cursor,
    recordsCollected: r.recordsCollected,
    errorCount: r.errorCount,
    errorMessage: r.errorMessage,
    frequencySeconds: r.frequencySeconds,
  }));
}

/** Update schedule frequencies from user settings. */
export async function updateSyncFrequencies(db: PrismaClientType, userId: string, frequencies: Partial<Record<SyncResource, number>>): Promise<void> {
  await db.$transaction(
    Object.entries(frequencies).map(([resource, seconds]) =>
      db.syncState.updateMany({
        where: { userId, resource },
        data: { frequencySeconds: Math.max(60, Math.min(86_400 * 7, seconds ?? 600)) },
      })
    )
  );
}
