import type { Queue } from "bullmq";
import type { SyncJobData } from "./queues.js";
import { ensureSyncStates, getSyncStates, setSetting, getSetting } from "@tornscope/database";
import { SYNC_RESOURCES, type SyncResource } from "@tornscope/shared";
import { getPrismaClient } from "@tornscope/database";
import { logger } from "./env.js";

/**
 * Scheduler tick: for every user with an active credential, ensure sync
 * state rows exist and enqueue resources whose nextRunAt is due.
 */

const BOOTSTRAP_FLAG = "scheduler_bootstrap_done";

export async function enqueueDueSyncs(syncQueue: Queue<SyncJobData>): Promise<void> {
  const db = getPrismaClient();

  const credentials = await db.apiCredential.findMany({
    where: { revokedAt: null },
    select: { userId: true },
  });
  const userIds = [...new Set(credentials.map((c) => c.userId))];
  if (userIds.length === 0) return;

  const now = Date.now();

  for (const userId of userIds) {
    // One-time bootstrap: create sync_state rows for all resources.
    const bootstrapped = await getSetting<boolean>(db, BOOTSTRAP_FLAG, userId);
    if (!bootstrapped) {
      await ensureSyncStates(db, userId);
      await setSetting(db, BOOTSTRAP_FLAG, true, userId);
    }

    const states = await getSyncStates(db, userId);
    for (const state of states) {
      const resource = state.resource as SyncResource;
      if (!SYNC_RESOURCES.includes(resource)) continue;
      if (state.status === "running") continue;
      const dueAt = state.nextRunAt?.getTime() ?? 0;
      if (dueAt > now) continue;

      // Reserve the slot by pushing nextRunAt forward; claimResource still
      // guards the actual execution against overlap.
      const nextAt = new Date(now + Math.max(state.frequencySeconds, 60) * 1000);
      await db.syncState.update({ where: { userId_resource: { userId, resource } }, data: { nextRunAt: nextAt } });
      await syncQueue.add(
        "sync-resource",
        { userId, resource },
        { jobId: `sync:${userId}:${resource}:${now}`, delay: 0 }
      );
      logger.debug({ userId, resource }, "enqueued due sync");
    }
  }
}
