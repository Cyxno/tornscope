import { TornApiError } from "@tornscope/torn-api";
import { claimResource, completeResource, progressResource, recordSyncRun, ensureSyncStates } from "@tornscope/database";
import type { SyncResource } from "@tornscope/shared";
import { SYNC_HANDLERS } from "./handlers.js";
import { getWorkerContext } from "../context.js";
import { logger } from "../env.js";

export interface SyncOutcome {
  ok: boolean;
  skipped?: boolean;
  records?: number;
  error?: string;
}

/**
 * Execute a resource sync for a user with claim/complete bookkeeping:
 * - claims the resource (prevents overlapping jobs, recovers stale runs)
 * - decrypts the API key only for the duration of the outgoing requests
 * - records a SyncRun history row and updates sync_state
 * - heartbeats progress (records written so far) so long initial backfills
 *   are visible in Sync Status and never mistaken for a dead worker
 */
export async function runResourceSync(userId: string, resource: SyncResource): Promise<SyncOutcome> {
  const ctx = getWorkerContext();
  const startedAt = new Date();
  logger.info({ userId, resource, stage: "job_received" }, "sync job received");

  const credential = await ctx.db.apiCredential.findFirst({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!credential) {
    logger.warn({ userId, resource }, "sync skipped: no active api key");
    return { ok: false, skipped: true, error: "no active api key" };
  }

  await ensureSyncStates(ctx.db, userId);
  const claim = await claimResource(ctx.db, userId, resource, startedAt);
  if (!claim.claimed || !claim.state) {
    logger.info({ userId, resource }, "sync skipped: resource busy or not claimable");
    return { ok: false, skipped: true, error: "resource busy or not claimable" };
  }
  logger.info({ userId, resource, stage: "job_started" }, "sync job started");

  const handler = SYNC_HANDLERS[resource];
  if (!handler) {
    await completeResource(ctx.db, userId, resource, { success: false, errorMessage: `no handler for ${resource}` });
    return { ok: false, error: `no handler for ${resource}` };
  }

  let apiKey: string;
  try {
    apiKey = await ctx.decryptCredential(credential);
  } catch (err) {
    const message = `failed to decrypt api key: ${(err as Error).message}`;
    await completeResource(ctx.db, userId, resource, { success: false, errorMessage: message });
    await recordSyncRun(ctx.db, userId, resource, { startedAt, finishedAt: new Date(), status: "failed", recordsCollected: 0, errorMessage: message });
    logger.error({ userId, resource, err: message }, "sync failed: credential decryption");
    return { ok: false, error: message };
  }

  // Progress bookkeeping: handlers report cumulative counts per page; we
  // commit the delta to sync_state so a crash mid-backfill leaves accurate
  // numbers and the cursor never advances past unstored data (the timestamp
  // cursor is only advanced by completeResource after the handler returns).
  let committed = 0;
  const onProgress = (recordsSoFar: number): void => {
    const delta = recordsSoFar - committed;
    if (delta > 0) {
      committed = recordsSoFar;
      void progressResource(ctx.db, userId, resource, delta).catch((err) =>
        logger.warn({ userId, resource, err: (err as Error).message }, "progress heartbeat failed")
      );
    }
  };

  try {
    const torn = ctx.torn(apiKey);
    logger.info({ userId, resource, stage: "torn_requests" }, "calling torn api");
    const result = await handler({
      userId,
      apiKey,
      torn,
      lastTimestamp: claim.state.lastTimestamp,
      onProgress,
    });
    logger.info({ userId, resource, stage: "records_written", records: result.records }, "torn responses normalized and written");

    // Commit whatever the handler counted beyond the last heartbeat.
    const tail = result.records - committed;
    if (tail > 0) await progressResource(ctx.db, userId, resource, tail);

    const frequency = claim.state.frequencySeconds;
    await completeResource(ctx.db, userId, resource, {
      success: true,
      recordsCollected: 0, // already committed through progress heartbeats
      lastTimestamp: result.lastTimestamp ?? undefined,
      stopReason: result.stopReason ?? null,
      sourceEarliestAt: result.sourceEarliestAt ?? null,
      nextRunAt: new Date(Date.now() + frequency * 1000),
      now: new Date(),
    });
    await recordSyncRun(ctx.db, userId, resource, {
      startedAt,
      finishedAt: new Date(),
      status: "success",
      recordsCollected: result.records,
    });
    logger.info({ userId, resource, stage: "job_completed", records: result.records, durationMs: Date.now() - startedAt.getTime() }, "sync success");
    return { ok: true, records: result.records };
  } catch (err) {
    const message =
      err instanceof TornApiError
        ? `torn api error (kind=${err.kind}${err.tornCode !== null ? `, code=${err.tornCode}` : ""}): ${err.message}`
        : (err as Error).message;
    await completeResource(ctx.db, userId, resource, {
      success: false,
      errorMessage: message,
      lastTimestamp: claim.state.lastTimestamp,
      // A failed run also failed its historical walk — record it so the
      // coverage view never mistakes an error for a complete history.
      stopReason: "api_error",
      nextRunAt: new Date(Date.now() + Math.min(claim.state.frequencySeconds, 600) * 1000),
      now: new Date(),
    });
    await recordSyncRun(ctx.db, userId, resource, {
      startedAt,
      finishedAt: new Date(),
      status: "failed",
      recordsCollected: 0,
      errorMessage: message,
    });

    const level = err instanceof TornApiError && err.kind === "key_invalid" ? "error" : "warn";
    logger[level]({ userId, resource, err: message, kind: err instanceof TornApiError ? err.kind : "unknown", stage: "job_failed" }, "sync failed");
    return { ok: false, error: message };
  }
}
