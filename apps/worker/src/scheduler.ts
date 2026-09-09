import type { Queue } from "bullmq";
import type { SyncJobData } from "./queues.js";
import { ensureSyncStates, getSyncStates, setSetting, getSetting, recordSyncRun } from "@tornscope/database";
import { CAPABILITY_RECHECK_SECONDS, hasCompleteCapabilityShape, normalizeCapabilitiesWithFallback, resourceAllowed, SYNC_HEALTH_POLICY, SYNC_RESOURCES, SYNC_JOB_NAME, buildSyncJobId, type SyncResource } from "@tornscope/shared";
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
          // Liveness is `lastHeartbeatAt` (claim/progress writes only) — the
          // nextRunAt update below auto-touches `updatedAt`, which must never
          // reset the staleness window of a dead run.
          if (state.status === "running") {
            const lastTouch = state.lastHeartbeatAt?.getTime() ?? state.lastStartedAt?.getTime() ?? 0;
            if (now - lastTouch < SYNC_HEALTH_POLICY.RUNNING_STALE_AFTER_SECONDS * 1000) continue;
            logger.warn(
              { userId, resource, orphanedForSeconds: Math.round((now - lastTouch) / 1000), orphanStartedAt: state.lastStartedAt?.getTime() ?? null },
              "re-enqueuing stale running sync (orphan recovered)"
            );
            // Incident record: the orphaned run becomes a "recovered" row in
            // the existing SyncRun history, so Sync Status can show
            // "recovered stale worker run" without any new schema. Written
            // ONCE per orphan period: while the re-enqueued job waits in a
            // busy queue, the state stays "running" and every further tick
            // would otherwise duplicate both the row and the incident.
            const orphanStart = state.lastStartedAt ?? null;
            const alreadyRecorded = await db.syncRun.findFirst({
              where: {
                userId,
                resource,
                status: "recovered",
                OR: [
                  ...(orphanStart ? [{ startedAt: orphanStart }] : []),
                  // Rows without a known start fall back to a recent-recovery
                  // window (one tick = 60s; a NEW orphan needs ≥15 min stale).
                  { finishedAt: { gte: new Date(now - 2 * 60_000) } },
                ],
              },
              select: { id: true },
            });
            if (!alreadyRecorded) {
              await recordSyncRun(db, userId, resource, {
                startedAt: state.lastStartedAt ?? new Date(now - SYNC_HEALTH_POLICY.RUNNING_STALE_AFTER_SECONDS * 1000),
                finishedAt: new Date(now),
                status: "recovered",
                recordsCollected: 0,
                errorMessage: "previous run interrupted (worker restart/crash); re-enqueued automatically",
                stats: { recovered: true, reason: "worker_interrupted", orphanHeartbeatAt: state.lastHeartbeatAt?.getTime() ?? null },
              });
            }
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
