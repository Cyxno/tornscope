import type { ApiKeyStatusResponse, MeResponse } from "@tornscope/shared";
import { ensureSyncStates, getPrismaClient } from "@tornscope/database";
import { DEMO_USER_EMAIL } from "@tornscope/shared";
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
    // The flag lives under the OWNER's id even while requests resolve to the
    // demo account, so clear it for every non-demo user.
    await db.appSetting.deleteMany({ where: { key: DEMO_VIEW_KEY, user: { isDemo: false } } });
  }
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
  // A real key always takes precedence over the demo view (flag lives under
  // the owner's id, which may differ from the resolving user).
  await db.appSetting.deleteMany({ where: { key: DEMO_VIEW_KEY, user: { isDemo: false } } });

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
