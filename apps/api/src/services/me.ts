import type { ApiKeyStatusResponse, MeResponse } from "@tornscope/shared";
import { deriveSetupPhase, SYNC_RESOURCES, buildSyncJobId, SYNC_JOB_NAME, DEMO_USER_EMAIL } from "@tornscope/shared";
import { normalizeDonatorStatus } from "@tornscope/torn-api";
import { ensureSyncStates, getPrismaClient, upsertTornAccount } from "@tornscope/database";
import { getApiContext } from "../context.js";
import { errors } from "../errors.js";

const DEMO_VIEW_KEY = "demo_view";

/**
 * Demo view toggle: resolves subsequent requests to the dedicated demo
 * account. Automatically inert once a real API key is connected (auth.ts
 * skips the flag when a credential exists); saving a key clears the flag.
 */
export async function setDemoView(user: { id: string }, enabled: boolean): Promise<void> {
  const db = getPrismaClient();
  if (enabled) {
    const demoExists = await db.user.findUnique({ where: { email: DEMO_USER_EMAIL }, select: { id: true } });
    if (!demoExists) throw errors.conflict("No demo dataset is seeded on this server. Run `pnpm seed:demo` first.");
    await db.appSetting.upsert({
      where: { userId_key: { userId: user.id, key: DEMO_VIEW_KEY } },
      create: { userId: user.id, key: DEMO_VIEW_KEY, value: true },
      update: { value: true },
    });
  } else {
    await clearDemoViewFlag(db);
  }
}

/** Deployed build commit — injected at Docker build time (never hand-edited). */
function buildCommit(): string {
  return process.env.GIT_SHA ?? "dev";
}

/** The flag always lives under a non-demo (owner) user id. */
async function clearDemoViewFlag(db: ReturnType<typeof getPrismaClient>): Promise<void> {
  const demo = await db.user.findUnique({ where: { email: DEMO_USER_EMAIL }, select: { id: true } });
  await db.appSetting.deleteMany({
    where: { key: DEMO_VIEW_KEY, ...(demo ? { userId: { not: demo.id } } : {}) },
  });
}

/** GET /api/me */
export async function getMe(user: { id: string; displayName: string; timezone: string; isDemo: boolean }): Promise<MeResponse> {
  const db = getPrismaClient();
  const [account, credential, syncStates, demoUser] = await Promise.all([
    db.tornAccount.findUnique({ where: { userId: user.id } }),
    db.apiCredential.findUnique({ where: { userId: user.id } }),
    db.syncState.findMany({ where: { userId: user.id } }),
    db.user.findUnique({ where: { email: DEMO_USER_EMAIL }, select: { id: true } }),
  ]);

  const factionId = account?.factionId ?? null;
  const factionName = factionId
    ? (await db.faction.findUnique({ where: { id: factionId }, select: { name: true } }))?.name ?? null
    : null;

  const running = syncStates.some((s) => s.status === "running");
  const errorCount = syncStates.reduce((sum, s) => sum + s.errorCount, 0);
  const lastSuccess = syncStates
    .map((s) => s.lastSuccessAt?.getTime() ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);

  return {
    userId: user.id,
    displayName: user.displayName,
    timezone: user.timezone,
    isDemo: user.isDemo,
    torn: account
      ? {
          tornId: account.tornId,
          name: account.name,
          level: account.level,
          rank: account.rank,
          factionId: account.factionId,
          factionName,
        }
      : null,
    hasApiKey: Boolean(credential && !credential.revokedAt),
    needsOnboarding: !account,
    demoAvailable: Boolean(demoUser),
    syncHealth: {
      lastSuccessAt: lastSuccess > 0 ? Math.floor(lastSuccess / 1000) : null,
      running,
      errorCount,
    },
    setupPhase: deriveSetupPhase({
      hasApiKey: Boolean(credential && !credential.revokedAt),
      resources: syncStates.map((s) => ({
        status: s.status,
        lastSuccessAt: s.lastSuccessAt ? Math.floor(s.lastSuccessAt.getTime() / 1000) : null,
        lastAttemptAt: s.lastAttemptAt ? Math.floor(s.lastAttemptAt.getTime() / 1000) : null,
      })),
    }),
    build: { commit: buildCommit() },
  };
}

/** GET /api/settings/api-key */
export async function getApiKeyStatus(userId: string): Promise<ApiKeyStatusResponse> {
  const db = getPrismaClient();
  const credential = await db.apiCredential.findUnique({ where: { userId } });
  if (!credential || credential.revokedAt) {
    return { hasKey: false, keyPreview: null, accessLevel: null, accessType: null, validatedAt: null, tornId: null, tornName: null, logAccessAvailable: false };
  }
  const account = await db.tornAccount.findUnique({ where: { userId } });
  return {
    hasKey: true,
    keyPreview: credential.keyPreview,
    accessLevel: credential.accessLevel !== null ? String(credential.accessLevel) : null,
    accessType: credential.accessType,
    validatedAt: credential.validatedAt ? Math.floor(credential.validatedAt.getTime() / 1000) : null,
    tornId: account?.tornId ?? null,
    tornName: account?.name ?? null,
    logAccessAvailable: credential.logAccessAvailable,
  };
}

/**
 * POST /api/settings/api-key: validate against Torn, then store encrypted.
 * The key is decrypted only for the validation request and never persisted
 * in plaintext or logged.
 *
 * After storing, the player identity is fetched immediately (public access)
 * so the app is enterable right away, and the initial sync jobs are enqueued
 * server-side — the old frontend-driven fan-out hid enqueue failures behind
 * Promise.allSettled while BullMQ was rejecting every job id.
 */
export async function saveApiKey(user: { id: string }, apiKey: string): Promise<ApiKeyStatusResponse> {
  const ctx = getApiContext();

  // Validate the key by fetching key info (public access required).
  const torn = ctx.torn(apiKey);
  let info;
  try {
    info = await torn.keyInfo();
  } catch (err) {
    const kind = (err as { kind?: string }).kind;
    if (kind === "key_invalid") throw errors.invalidApiKey("Torn rejected this API key. Check that it is correct and not paused.");
    if (kind === "access_denied") throw errors.accessDenied("This key does not grant basic access.");
    throw errors.tornUnavailable((err as Error).message);
  }

  const enc = ctx.encryptApiKey(apiKey);
  const db = ctx.db;
  const access = info.info.access;
  const logAccess = access.log?.available !== undefined && access.log.available.length > 0;

  await db.apiCredential.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      encryptedKey: enc.encryptedKey,
      iv: enc.iv,
      authTag: enc.authTag,
      keyPreview: `••••${apiKey.slice(-4)}`,
      accessLevel: access.level,
      accessType: access.type,
      logAccessAvailable: logAccess,
      validatedAt: new Date(),
      revokedAt: null,
    },
    update: {
      encryptedKey: enc.encryptedKey,
      iv: enc.iv,
      authTag: enc.authTag,
      keyPreview: `••••${apiKey.slice(-4)}`,
      accessLevel: access.level,
      accessType: access.type,
      logAccessAvailable: logAccess,
      validatedAt: new Date(),
      revokedAt: null,
    },
  });

  // Sync schedules exist per user from the first valid key onward.
  await ensureSyncStates(db, user.id);
  // A real key always takes precedence over the demo view.
  await clearDemoViewFlag(db);

  // Detect the player NOW (basic is public) so needsOnboarding flips and the
  // user can enter the app while the historical backfill runs in background.
  try {
    const basic = await torn.userBasic();
    await upsertTornAccount(db, user.id, {
      tornId: basic.profile.id,
      name: basic.profile.name,
      level: basic.profile.level,
      rank: basic.profile.rank ?? null,
      donatorStatus: normalizeDonatorStatus(basic.profile.donator_status),
      gender: basic.profile.gender ?? null,
      property: null,
      factionId: null,
      // Rich status arrives with the profile sync seconds later.
      status: undefined,
      seenAt: new Date(),
    });
  } catch {
    // The profile sync will create the account shortly; saving the key
    // itself must not fail because of this.
  }

  // Enqueue the initial backfill for every resource, server-side, with real
  // error surfacing (was: 10 silent frontend POSTs that all failed inside
  // BullMQ's job-id validation).
  const enqueueErrors: string[] = [];
  for (const resource of SYNC_RESOURCES) {
    try {
      await ctx.syncQueue.add(
        SYNC_JOB_NAME,
        { userId: user.id, resource, manual: true },
        { jobId: buildSyncJobId(user.id, resource, `init${Date.now()}`) }
      );
    } catch (err) {
      enqueueErrors.push(`${resource}: ${(err as Error).message}`);
    }
  }
  if (enqueueErrors.length === SYNC_RESOURCES.length) {
    throw errors.internal(`Could not queue the initial sync: ${enqueueErrors[0] ?? "unknown queue error"}`);
  }

  return getApiKeyStatus(user.id);
}

/** DELETE /api/settings/api-key: revoke (data history is kept). */
export async function deleteApiKey(userId: string): Promise<void> {
  const db = getPrismaClient();
  await db.apiCredential.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
