import type { ApiKeyStatusResponse, MeResponse } from "@tornscope/shared";
import { deriveSetupPhase, SYNC_RESOURCES, buildSyncJobId, SYNC_JOB_NAME, DEMO_USER_EMAIL, deriveKeyCapabilities, type KeyCapabilities } from "@tornscope/shared";
import { normalizeDonatorStatus } from "@tornscope/torn-api";
import { ensureSyncStates, getPrismaClient, upsertTornAccount } from "@tornscope/database";
import { ownerBindAvailable } from "../auth.js";
import { getApiContext } from "../context.js";
import { errors, AppError } from "../errors.js";

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
    // Clear ONLY this profile's flag: with browser-bound profiles, another
    // profile's demo toggle is none of this request's business.
    await db.appSetting.deleteMany({ where: { userId: user.id, key: DEMO_VIEW_KEY } });
  }
}

/** Deployed build commit — injected at Docker build time (never hand-edited). */
function buildCommit(): string {
  return process.env.GIT_SHA ?? "dev";
}

/**
 * Clear the demo-view flag for ONE owner user only — never globally. With
 * several local owner accounts, toggling one must not touch the others.
 */
async function clearDemoViewFlag(db: ReturnType<typeof getPrismaClient>, userId?: string): Promise<void> {
  if (userId) {
    await db.appSetting.deleteMany({ where: { userId, key: DEMO_VIEW_KEY } });
    return;
  }
  // No explicit owner passed (legacy callers): clear every owner's flag but
  // never the demo user's own row.
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

  const capabilitiesRaw = (credential?.capabilities ?? null) as KeyCapabilities | null;

  return {
    userId: user.id,
    displayName: user.displayName,
    timezone: user.timezone,
    isDemo: user.isDemo,
    capabilities: capabilitiesRaw,
    ownerBindAvailable: await ownerBindAvailable(),
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
    return { hasKey: false, keyPreview: null, accessLevel: null, accessType: null, validatedAt: null, tornId: null, tornName: null, logAccessAvailable: false, capabilities: null };
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
    capabilities: (credential.capabilities ?? null) as KeyCapabilities | null,
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
export async function saveApiKey(
  user: { id: string },
  apiKey: string,
  opts: { confirmNewProfile?: boolean } = {}
): Promise<{ status: ApiKeyStatusResponse; newProfileId: string | null }> {
  return saveApiKeyInner(user, apiKey, opts);
}

/** Detect key capabilities from /key/info — never trusts a UI-declared level. */
function capabilitiesFromInfo(info: {
  info: { selections?: unknown; access: { level?: number | null } };
}): KeyCapabilities {
  const raw = (info.info.selections ?? {}) as { user?: unknown; faction?: unknown };
  const asStrings = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  return deriveKeyCapabilities(
    { user: asStrings(raw.user), faction: asStrings(raw.faction) },
    typeof info.info.access.level === "number" ? info.info.access.level : null
  );
}

async function saveApiKeyInner(
  user: { id: string },
  apiKey: string,
  opts: { confirmNewProfile?: boolean }
): Promise<{ status: ApiKeyStatusResponse; newProfileId: string | null }> {
  let createdNewProfile = false;
  const ctx = getApiContext();
  const db = ctx.db;

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
  const capabilities = capabilitiesFromInfo(info);

  // Identity guard: a key for a DIFFERENT Torn account must never silently
  // merge into this profile's history. The client must explicitly choose to
  // start a new profile/data context.
  const existingAccount = await db.tornAccount.findUnique({ where: { userId: user.id }, select: { tornId: true, name: true } });
  const incomingId = info.info.user?.id ?? null;
  if (existingAccount && incomingId !== null && incomingId !== existingAccount.tornId) {
    if (!opts.confirmNewProfile) {
      let incomingName = "unknown player";
      try {
        const basic = await torn.userBasic();
        incomingName = basic.profile.name ?? incomingName;
      } catch {
        // name is cosmetic; the id comparison already decided the conflict
      }
      throw new AppError(
        "identity_conflict",
        "This key belongs to a different Torn player than the one linked to this profile. Start a new profile to keep both histories separate.",
        409,
        {
          identityConflict: true,
          existing: { tornId: existingAccount.tornId, name: existingAccount.name },
          incoming: { tornId: incomingId, name: incomingName },
        }
      );
    }
    // Explicit choice: rebind this browser session to a brand-new profile.
    // The old profile and its history stay untouched (not merged, not deleted).
    const { randomBytes } = await import("node:crypto");
    createdNewProfile = true;
    const fresh = await db.user.create({ data: { displayName: `Guest ${randomBytes(3).toString("hex")}`, role: "user" } });
    user = { id: fresh.id };
    // The route rebinds the current browser session to `fresh.id` (the cookie
    // keeps working; the old profile stays orphaned but intact).
  }

  const enc = ctx.encryptApiKey(apiKey);
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
  // New credentials: access-denied categories may retry promptly (cursor kept).
  await resetAccessDeniedCategories(db, user.id);
  // A real key always takes precedence over the demo view (this owner only).
  await clearDemoViewFlag(db, user.id);

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

  return {
    // Set when an identity conflict was confirmed: the route rebinds the
    // current browser session to this brand-new profile.
    status: await getApiKeyStatus(user.id),
    newProfileId: createdNewProfile ? user.id : null,
  };
}

/** DELETE /api/settings/api-key: revoke (data history is kept). */
/** New credentials: let access-denied categories retry promptly (cursor kept). */
async function resetAccessDeniedCategories(db: ReturnType<typeof getPrismaClient>, userId: string): Promise<void> {
  await db.syncCategoryState.updateMany({
    where: { userId, status: "access_denied" },
    data: { status: "active", errorMessage: null, nextRunAt: new Date(), consecutiveEmptyRuns: 0 },
  });
}

export async function deleteApiKey(userId: string): Promise<void> {
  const db = getPrismaClient();
  await db.apiCredential.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await resetAccessDeniedCategories(db, userId);
}

/**
 * Destructive: delete THIS browser profile — encrypted key, sync state,
 * settings and every personal data row (user delete cascades). Other
 * profiles are never touched.
 */
export async function deleteProfile(userId: string): Promise<void> {
  const db = getPrismaClient();
  // ApiCredential/AppSetting may lack FK cascades (global settings table) —
  // remove them explicitly before the user row.
  await db.apiCredential.deleteMany({ where: { userId } });
  await db.appSetting.deleteMany({ where: { userId } });
  await db.userSession.deleteMany({ where: { userId } });
  await db.user.delete({ where: { id: userId } });
}
