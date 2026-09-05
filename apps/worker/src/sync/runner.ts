import { TornApiError } from "@tornscope/torn-api";
import { claimResource, completeResource, recordSyncRun, ensureSyncStates } from "@tornscope/database";
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
 */
export async function runResourceSync(userId: string, resource: SyncResource): Promise<SyncOutcome> {
  const ctx = getWorkerContext();
  const startedAt = new Date();

  const credential = await ctx.db.apiCredential.findFirst({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!credential) {
    return { ok: false, skipped: true, error: "no active api key" };
  }

  await ensureSyncStates(ctx.db, userId);
  const claim = await claimResource(ctx.db, userId, resource, startedAt);
  if (!claim.claimed || !claim.state) {
    return { ok: false, skipped: true, error: "resource busy or not claimable" };
  }

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
    logger.error({ userId, resource, err: message }, "sync failed");
    return { ok: false, error: message };
  }

  try {
    const torn = ctx.torn(apiKey);
    const result = await handler({
      userId,
      apiKey,
      torn,
      lastTimestamp: claim.state.lastTimestamp,
    });

    const frequency = claim.state.frequencySeconds;
    await completeResource(ctx.db, userId, resource, {
      success: true,
      recordsCollected: result.records,
      lastTimestamp: result.lastTimestamp ?? undefined,
      nextRunAt: new Date(Date.now() + frequency * 1000),
      now: new Date(),
    });
    await recordSyncRun(ctx.db, userId, resource, {
      startedAt,
      finishedAt: new Date(),
      status: "success",
      recordsCollected: result.records,
    });
    logger.info({ userId, resource, records: result.records, durationMs: Date.now() - startedAt.getTime() }, "sync success");
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
    logger[level]({ userId, resource, err: message, kind: err instanceof TornApiError ? err.kind : "unknown" }, "sync failed");
    return { ok: false, error: message };
  }
}
