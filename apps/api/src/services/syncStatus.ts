import { getSyncStates, type SyncStateRow } from "@tornscope/database";
import { getPrismaClient } from "@tornscope/database";
import { getApiContext } from "../context.js";

/** Sync status page data (per-resource health). */
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
 * Manual "Sync now": enqueue a sync job with a 60s cooldown per resource to
 * prevent Torn API spam. The worker enforces the real execution lock.
 */
const MANUAL_COOLDOWN_MS = 60_000;

export async function requestManualSync(userId: string, resource: string): Promise<{ queued: boolean; retryAfterSeconds?: number }> {
  const db = getPrismaClient();
  const state = await db.syncState.findUnique({ where: { userId_resource: { userId, resource } } });
  if (state) {
    if (state.status === "running") {
      return { queued: false, retryAfterSeconds: 0 };
    }
    const lastAttempt = state.lastAttemptAt?.getTime() ?? 0;
    const elapsed = Date.now() - lastAttempt;
    if (lastAttempt > 0 && elapsed < MANUAL_COOLDOWN_MS) {
      return { queued: false, retryAfterSeconds: Math.ceil((MANUAL_COOLDOWN_MS - elapsed) / 1000) };
    }
  }

  const ctx = getApiContext();
  await ctx.syncQueue.add(
    "sync-resource",
    { userId, resource, manual: true },
    { jobId: `sync:${userId}:${resource}:manual:${Date.now()}` }
  );
  return { queued: true };
}
