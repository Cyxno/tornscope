import { TornApiError, TornNetworkError } from "@tornscope/torn-api";
import { claimResource, completeResource, progressResource, recordSyncRun, ensureSyncStates } from "@tornscope/database";
import { CAPABILITY_RECHECK_SECONDS, deriveKeyCapabilities, hasCompleteCapabilityShape, normalizeCapabilitiesWithFallback, resourceAllowed, resourceRequirementLabel, tornKindToReason, TtlMap, type KeyCapabilities, type SyncResource } from "@tornscope/shared";
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
 * How long a live /key/info capability detection stays cached per credential.
 * Legacy/stale capability blobs would otherwise force one /key/info call per
 * resource job — a purely metadata round-trip (rate-limited, serialized)
 * multiplied by 15 resources, which made the whole pipeline visibly slower.
 */
const CAPABILITY_DETECTION_TTL_MS = 10 * 60_000;

// TTL-bounded (TtlMap): expired credential detections are swept lazily, so
// credentials from deleted profiles cannot accumulate forever. Ceiling 1_000
// covers every plausible credential count on a single node many times over.
const capabilityDetectionCache = new TtlMap<KeyCapabilities>({
  ttlMs: CAPABILITY_DETECTION_TTL_MS,
  maxEntries: 1_000,
  sweepEvery: 16,
});

/**
 * Time-based liveness heartbeat for the CURRENT run: refreshes
 * lastHeartbeatAt even when a walk inserts nothing (full re-fetch of quiet
 * history must not read as a dead worker). The run-scoped interval is always
 * cleared in the runner's finally paths; writes are guarded by
 * status="running" so a late tick can never touch a finished resource.
 */
const RUN_HEARTBEAT_INTERVAL_MS = 60_000;

/** Classify a failure into the machine reason code stored on sync_state. */
function failureReason(err: unknown): string {
  if (err instanceof TornNetworkError) return tornKindToReason("network", err.timedOut);
  if (err instanceof TornApiError) return tornKindToReason(err.kind);
  return "unknown_error";
}

/**
 * Resolve the credential's capabilities. Credentials stored before capability
 * persistence carried no detection, and blobs from the earlier 13-key model
 * are stale (their missing keys would wrongly read as false) — both trigger a
 * one-time re-detection from /key/info so gating works for every existing
 * profile without a manual re-save.
 *
 * Failure handling: a transient /key/info error must NEVER disable gating for
 * every resource (that used to mass-mark resources capability_denied for 6h).
 * The detection is cached per credential and, when unavailable, the stored
 * blob is level-normalized as a read-only fallback (never persisted).
 */
async function resolveCapabilities(
  ctx: ReturnType<typeof getWorkerContext>,
  userId: string,
  credential: { id: string; accessLevel: number | null; accessType: string | null; capabilities: unknown },
  apiKey: string
): Promise<KeyCapabilities | null> {
  // Read paths fall back to the numeric level for legacy blobs; the GATE,
  // however, needs the real selections — so stale blobs force re-detection.
  const storedComplete = hasCompleteCapabilityShape(credential.capabilities);
  const stored = storedComplete ? normalizeCapabilitiesWithFallback(credential.capabilities, credential.accessLevel) : null;
  if (stored) return stored;

  const cached = capabilityDetectionCache.get(credential.id);
  if (cached) return cached;
  try {
    const info = await ctx.torn(apiKey).keyInfo();
    const raw = (info.info.selections ?? {}) as { user?: unknown; faction?: unknown };
    const asStrings = (v: unknown): string[] | null =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
    const caps = deriveKeyCapabilities(
      {
        user: asStrings(raw.user),
        faction: asStrings(raw.faction),
        factionAccess: typeof info.info.access.faction === "boolean" ? info.info.access.faction : null,
      },
      typeof info.info.access.level === "number" ? info.info.access.level : null
    );
    capabilityDetectionCache.set(credential.id, caps);
    await ctx.db.apiCredential.update({ where: { id: credential.id }, data: { capabilities: caps as never } });
    logger.info({ userId }, "capabilities backfilled from /key/info");
    return caps;
  } catch (err) {
    // Degrade to the numeric level instead of null (null would deny every
    // non-public resource and park them for 6h off one metadata hiccup).
    const fallback = normalizeCapabilitiesWithFallback(null, credential.accessLevel);
    logger.warn({ userId, err: (err as Error).message }, "capability detection failed; falling back to stored access level for this run");
    return fallback;
  }
}

/**
 * Execute a resource sync for a user with claim/complete bookkeeping:
 * - claims the resource (prevents overlapping jobs, recovers stale runs)
 * - decrypts the API key only for the duration of the outgoing requests
 * - records a SyncRun history row and updates sync_state
 * - heartbeats progress (records written so far) so long initial backfills
 *   are visible in Sync Status and never mistaken for a dead worker
 */
export async function runResourceSync(
  userId: string,
  resource: SyncResource,
  opts: { /** Manual "Sync Now": ignore adaptive per-category schedules. */ force?: boolean } = {}
): Promise<SyncOutcome> {
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

  // Time-based liveness for the whole run (cleared on every exit path below).
  const runHeartbeat = setInterval(() => {
    void progressResource(ctx.db, userId, resource, 0).catch(() => undefined);
  }, RUN_HEARTBEAT_INTERVAL_MS);
  const stopRunHeartbeat = (): void => clearInterval(runHeartbeat);

  const handler = SYNC_HANDLERS[resource];
  if (!handler) {
    stopRunHeartbeat();
    await completeResource(ctx.db, userId, resource, { success: false, errorMessage: `no handler for ${resource}`, errorKind: "unknown_error" });
    return { ok: false, error: `no handler for ${resource}` };
  }

  let apiKey: string;
  try {
    apiKey = await ctx.decryptCredential(credential);
  } catch (err) {
    stopRunHeartbeat();
    const message = `failed to decrypt api key: ${(err as Error).message}`;
    await completeResource(ctx.db, userId, resource, { success: false, errorMessage: message, errorKind: "unknown_error" });
    await recordSyncRun(ctx.db, userId, resource, { startedAt, finishedAt: new Date(), status: "failed", recordsCollected: 0, errorMessage: message });
    logger.error({ userId, resource, err: message }, "sync failed: credential decryption");
    return { ok: false, error: message };
  }

  // Capability gate: a key that lacks the required Torn selection must never
  // hammer an endpoint known to be unavailable. The resource is marked
  // capability_denied (NOT failed) and re-checked only infrequently — manual
  // syncs surface a "permission required" state instead of a sync error, and
  // replacing the key re-enables the resource immediately.
  const caps = await resolveCapabilities(ctx, userId, credential, apiKey);
  if (!resourceAllowed(caps, resource)) {
    stopRunHeartbeat();
    const requirement = resourceRequirementLabel(resource);
    const message = `Permission required: this key does not include ${requirement}. Grant it in Torn to sync this resource.`;
    await completeResource(ctx.db, userId, resource, {
      success: false,
      status: "capability_denied",
      errorMessage: message,
      errorKind: "capability_denied",
      lastTimestamp: claim.state.lastTimestamp,
      nextRunAt: new Date(Date.now() + CAPABILITY_RECHECK_SECONDS * 1000),
      now: new Date(),
    });
    await recordSyncRun(ctx.db, userId, resource, {
      startedAt,
      finishedAt: new Date(),
      status: "skipped",
      recordsCollected: 0,
      errorMessage: message,
    });
    logger.info({ userId, resource, requirement }, "sync skipped: capability denied by key");
    return { ok: false, skipped: true, error: message };
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
    const { endpoints: torn, metrics } = ctx.createTorn(apiKey);
    logger.info({ userId, resource, stage: "torn_requests" }, "calling torn api");
    const result = await handler({
      userId,
      apiKey,
      torn,
      lastTimestamp: claim.state.lastTimestamp,
      force: opts.force === true,
      capabilities: caps,
      onProgress,
    });
    logger.info({ userId, resource, stage: "records_written", records: result.records }, "torn responses normalized and written");

    // Commit whatever the handler counted beyond the last heartbeat.
    const tail = result.records - committed;
    if (tail > 0) await progressResource(ctx.db, userId, resource, tail);

    const frequency = claim.state.frequencySeconds;
    stopRunHeartbeat();
    await completeResource(ctx.db, userId, resource, {
      success: true,
      recordsCollected: 0, // already committed through progress heartbeats
      // Zero-due adaptive cycles omit these — the last full walk's coverage
      // data stays visible instead of being overwritten with nulls.
      lastTimestamp: result.lastTimestamp ?? undefined,
      stopReason: result.stopReason,
      sourceEarliestAt: result.sourceEarliestAt,
      lastWalkPages: result.pagesWalked,
      nextRunAt: new Date(Date.now() + frequency * 1000),
      now: new Date(),
    });
    await recordSyncRun(ctx.db, userId, resource, {
      startedAt,
      finishedAt: new Date(),
      status: "success",
      recordsCollected: result.records,
      stats: {
        categoriesTotal: result.totalCategories ?? null,
        categoriesDue: result.categoriesDue ?? null,
        categoriesProcessed: result.categoriesProcessed ?? null,
        categoriesSkipped: result.categoriesSkipped ?? null,
        pagesWalked: result.pagesWalked ?? null,
        recordsInserted: result.records,
        durationMs: Date.now() - startedAt.getTime(),
        tornRequests: metrics.requests,
        deniedRequests: metrics.denied,
        timeouts: metrics.timeouts,
        retries: metrics.retries,
        errorKind: null,
      },
    });
    logger.info(
      {
        userId,
        resource,
        stage: "job_completed",
        records: result.records,
        durationMs: Date.now() - startedAt.getTime(),
        tornRequests: metrics.requests,
        deniedRequests: metrics.denied,
        timeouts: metrics.timeouts,
        retries: metrics.retries,
      },
      "sync success"
    );
    return { ok: true, records: result.records };
  } catch (err) {
    stopRunHeartbeat();
    const reason = failureReason(err);
    // Torn rejected the request because the key's access level is too low:
    // the stored capability blob is stale relative to reality. Record the
    // resource as capability_denied (NOT failed) — previously collected
    // history stays intact, confidence reads stale_permission, and the next
    // check happens at the shared re-check interval instead of hot-retrying.
    if (err instanceof TornApiError && err.kind === "access_denied") {
      const requirement = resourceRequirementLabel(resource);
      const message = `Permission denied by Torn during sync: the key no longer includes ${requirement}. History is retained; grant the selection in Torn to resume.`;
      await completeResource(ctx.db, userId, resource, {
        success: false,
        status: "capability_denied",
        errorMessage: message,
        errorKind: "capability_denied",
        lastTimestamp: claim.state.lastTimestamp,
        nextRunAt: new Date(Date.now() + CAPABILITY_RECHECK_SECONDS * 1000),
        now: new Date(),
      });
      await recordSyncRun(ctx.db, userId, resource, {
        startedAt,
        finishedAt: new Date(),
        status: "skipped",
        recordsCollected: 0,
        errorMessage: message,
      });
      logger.warn({ userId, resource, stage: "job_denied" }, "sync skipped: runtime capability denied by Torn");
      return { ok: false, skipped: true, error: message };
    }
    const message =
      err instanceof TornApiError
        ? `torn api error (kind=${err.kind}${err.tornCode !== null ? `, code=${err.tornCode}` : ""}): ${err.message}`
        : (err as Error).message;
    await completeResource(ctx.db, userId, resource, {
      success: false,
      errorMessage: message,
      errorKind: reason,
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
      stats: { durationMs: Date.now() - startedAt.getTime(), errorKind: reason },
    });

    const level = err instanceof TornApiError && err.kind === "key_invalid" ? "error" : "warn";
    logger[level]({ userId, resource, err: message, kind: err instanceof TornApiError ? err.kind : "unknown", reason, stage: "job_failed" }, "sync failed");
    return { ok: false, error: message };
  }
}
