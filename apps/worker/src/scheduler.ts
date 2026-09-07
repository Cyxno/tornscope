import type { Queue } from "bullmq";
import type { SyncJobData } from "./queues.js";
import { ensureSyncStates, getSyncStates, setSetting, getSetting } from "@tornscope/database";
import { CAPABILITY_RECHECK_SECONDS, hasCompleteCapabilityShape, normalizeCapabilitiesWithFallback, resourceAllowed, SYNC_RESOURCES, SYNC_JOB_NAME, buildSyncJobId, type SyncResource } from "@tornscope/shared";
import { getPrismaClient } from "@tornscope/database";
import { logger } from "./env.js";

/**
 * Scheduler tick: for every user with an active credential, ensure sync
 * state rows exist and enqueue due resources.
 *
 * Every user is processed inside its own try/catch: one broken user must not
 * kill the tick for everyone (a failed repeat-job used to vanish into BullMQ
 * without any log line).
 */

const BOOTSTRAP_FLAG = "scheduler_bootstrap_done";

/**
 * Known-denied resources are never claimed, decrypted or handed to a handler
 * — the tick just advances their next re-check (CAPABILITY_RECHECK_SECONDS).
 * This keeps a Limited key from paying claim+decrypt+write overhead for every
 * denied resource on every cycle.
 */

export async function enqueueDueSyncs(syncQueue: Queue<SyncJobData>): Promise<void> {
  const db = getPrismaClient();

  const credentials = await db.apiCredential.findMany({
    where: { revokedAt: null },
    select: { userId: true, accessLevel: true, capabilities: true },
  });
  const userIds = [...new Set(credentials.map((c) => c.userId))];
  if (userIds.length === 0) return;

  const now = Date.now();

  for (const userId of userIds) {
    try {
      // One-time bootstrap: create sync_state rows for all resources.
      const bootstrapped = await getSetting<boolean>(db, BOOTSTRAP_FLAG, userId);
      if (!bootstrapped) {
        await ensureSyncStates(db, userId);
        await setSetting(db, BOOTSTRAP_FLAG, true, userId);
      }

      // Authoritative capability blob only: an incomplete/stale blob must NOT
      // gate at the scheduler (the runner detects and backfills it instead).
      const credential = credentials.find((c) => c.userId === userId);
      const caps = credential && hasCompleteCapabilityShape(credential.capabilities)
        ? normalizeCapabilitiesWithFallback(credential.capabilities, credential.accessLevel)
        : null;

      const states = await getSyncStates(db, userId);
      for (const state of states) {
        // One failed resource must not skip all later resources for this
        // user, so every resource is guarded individually.
        try {
          const resource = state.resource as SyncResource;
          if (!SYNC_RESOURCES.includes(resource)) continue;

          // Running resources are skipped only while they are alive: a run
          // without a progress heartbeat for 15 minutes is an orphan (worker
          // crash/restart) and must be re-enqueued so backfills resume.
          if (state.status === "running") {
            const lastTouch = state.updatedAt?.getTime() ?? state.lastStartedAt?.getTime() ?? 0;
            if (now - lastTouch < 15 * 60_000) continue;
            logger.warn({ userId, resource }, "re-enqueuing stale running sync (orphan recovered)");
          }

          const dueAt = state.nextRunAt?.getTime() ?? 0;
          if (state.status !== "running" && dueAt > now) continue;

          // Capability gate BEFORE enqueueing: a resource the stored key can
          // never answer is not claimed/decrypted/processed — the tick just
          // pushes its next re-check out. A capability upgrade resets these
          // states immediately (saveApiKey), so nothing is parked wrongly.
          if (caps && !resourceAllowed(caps, resource)) {
            await db.syncState.update({
              where: { userId_resource: { userId, resource } },
              data: {
                status: "capability_denied",
                nextRunAt: new Date(now + CAPABILITY_RECHECK_SECONDS * 1000),
              },
            });
            continue;
          }

          // Enqueue FIRST, advance nextRunAt only on success: if the queue
          // add throws, the resource stays due instead of being silently
          // skipped for a whole frequency period.
          await syncQueue.add(
            SYNC_JOB_NAME,
            { userId, resource },
            // BullMQ rejects ":" in custom job ids — ids must always be built
            // through the shared helper (this silently killed all scheduling).
            { jobId: buildSyncJobId(userId, resource, now), delay: 0 }
          );
          const nextAt = new Date(now + Math.max(state.frequencySeconds, 60) * 1000);
          await db.syncState.update({ where: { userId_resource: { userId, resource } }, data: { nextRunAt: nextAt } });
          logger.debug({ userId, resource }, "enqueued due sync");
        } catch (err) {
          logger.error({ userId, resource: state.resource, err: (err as Error).message }, "scheduler failed for resource");
        }
      }
    } catch (err) {
      logger.error({ userId, err: (err as Error).message }, "scheduler tick failed for user");
    }
  }
}
