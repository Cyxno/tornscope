import type {
  ApiKeyStatusResponse,
  ApiKeyValidationResponse,
  ExistingProfileInfo,
  MeResponse,
  ProfileLinkResult,
} from "@tornscope/shared";
import {
  CAPABILITY_RECHECK_SECONDS,
  compareCapabilities,
  deriveKeyCapabilities,
  deriveSetupPhase,
  normalizeCapabilitiesWithFallback,
  resourceAllowed,
  resourceRequirementLabel,
  SYNC_RESOURCES,
  buildSyncJobId,
  SYNC_JOB_NAME,
  DEMO_USER_EMAIL,
  normalizeTypeConfig,
  type CapabilityChange,
  type KeyCapabilities,
  type SyncResource,
} from "@tornscope/shared";
import { normalizeDonatorStatus, type TornEndpoints } from "@tornscope/torn-api";
import {
  deleteEmptyProfile,
  ensureSyncStates,
  findNonDemoProfileByTornId,
  getPrismaClient,
  upsertTornAccount,
} from "@tornscope/database";
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

/**
 * Clear the demo-view flag for ONE user only. With browser-bound profiles,
 * another profile's demo toggle is none of this request's business — an
 * unscoped delete across every profile is never legitimate.
 */
async function clearDemoViewFlag(db: ReturnType<typeof getPrismaClient>, userId: string): Promise<void> {
  await db.appSetting.deleteMany({ where: { userId, key: DEMO_VIEW_KEY } });
}

/** GET /api/me */
export async function getMe(user: { id: string; displayName: string; timezone: string; isDemo: boolean; role?: string }): Promise<MeResponse> {
  const db = getPrismaClient();
  const [account, credential, syncStates, demoUser, activeSessions, notifPrefs] = await Promise.all([
    db.tornAccount.findUnique({ where: { userId: user.id } }),
    db.apiCredential.findUnique({ where: { userId: user.id } }),
    db.syncState.findMany({ where: { userId: user.id } }),
    db.user.findUnique({ where: { email: DEMO_USER_EMAIL }, select: { id: true } }),
    db.userSession.count({ where: { userId: user.id, revokedAt: null } }),
    db.notificationPreference.findUnique({ where: { userId: user.id }, select: { typeConfig: true } }),
  ]);
  // Heads-up thresholds (2.0.5): profile-level, defaults filled in by the
  // shared normalizer so the cockpit never reads a partial config.
  const typeConfig = normalizeTypeConfig(notifPrefs?.typeConfig);

  const factionId = account?.factionId ?? null;
  const factionName = factionId
    ? (await db.faction.findUnique({ where: { id: factionId }, select: { name: true } }))?.name ?? null
    : null;

  const running = syncStates.some((s) => s.status === "running");
  const errorCount = syncStates.reduce((sum, s) => sum + s.errorCount, 0);
  const lastSuccess = syncStates
    .map((s) => s.lastSuccessAt?.getTime() ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);

  const capabilitiesRaw = credential
    ? normalizeCapabilitiesWithFallback(credential.capabilities, credential.accessLevel)
    : null;

  return {
    userId: user.id,
    displayName: user.displayName,
    timezone: user.timezone,
    isDemo: user.isDemo,
    capabilities: capabilitiesRaw,
    accessType: credential && !credential.revokedAt ? credential.accessType : null,
    accessLevel: credential && !credential.revokedAt ? credential.accessLevel : null,
    activeSessions,
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
    headsUp: {
      travelPreMin: typeConfig.travelPreMin,
      drugPreMin: typeConfig.drugPreMin,
      boosterPreMin: typeConfig.boosterPreMin,
      medicalPreMin: typeConfig.medicalPreMin,
      ocPreMin: typeConfig.ocPreMin,
      bankPreMin: typeConfig.bankPreMin,
    },
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
    capabilities: normalizeCapabilitiesWithFallback(credential.capabilities, credential.accessLevel),
  };
}

/** Detect key capabilities from /key/info — never trusts a UI-declared level. */
function capabilitiesFromInfo(info: {
  info: { selections?: unknown; access: { level?: number | null; type?: string | null; faction?: boolean | null } };
}): KeyCapabilities {
  const raw = (info.info.selections ?? {}) as { user?: unknown; faction?: unknown };
  const asStrings = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  return deriveKeyCapabilities(
    {
      user: asStrings(raw.user),
      faction: asStrings(raw.faction),
      factionAccess: typeof info.info.access.faction === "boolean" ? info.info.access.faction : null,
    },
    typeof info.info.access.level === "number" ? info.info.access.level : null
  );
}

/** Best-effort player name for messages; never blocks a flow on failure. */
async function resolvePlayerName(torn: TornEndpoints): Promise<string | null> {
  try {
    const basic = await torn.userBasic();
    return basic.profile.name ?? null;
  } catch {
    return null;
  }
}

interface ValidatedKey {
  info: Awaited<ReturnType<TornEndpoints["keyInfo"]>>;
  capabilities: KeyCapabilities;
  incomingId: number | null;
}

/** Validate a key live against Torn (/key/info) — the only identity source. */
async function validateKeyLive(ctx: ReturnType<typeof getApiContext>, apiKey: string): Promise<ValidatedKey> {
  const torn = ctx.torn(apiKey);
  try {
    const info = await torn.keyInfo();
    return { info, capabilities: capabilitiesFromInfo(info), incomingId: info.info.user?.id ?? null };
  } catch (err) {
    const kind = (err as { kind?: string }).kind;
    if (kind === "key_invalid") throw errors.invalidApiKey("Torn rejected this API key. Check that it is correct and not paused.");
    if (kind === "access_denied") throw errors.accessDenied("This key does not grant basic access.");
    throw errors.tornUnavailable((err as Error).message);
  }
}

/**
 * POST /api/settings/api-key/validate — validate a key WITHOUT storing it.
 * Returns the Torn-detected access level/type and per-selection capabilities
 * plus the capability change against the currently stored key, so the UI can
 * warn about a downgrade BEFORE the user commits to replacing a stored key.
 */
export async function validateApiKey(user: { id: string; isDemo: boolean }, apiKey: string): Promise<ApiKeyValidationResponse> {
  if (user.isDemo) throw errors.forbidden("Leave demo view before validating a key.");
  const ctx = getApiContext();
  const db = ctx.db;
  const { info, capabilities, incomingId } = await validateKeyLive(ctx, apiKey);

  const credential = await db.apiCredential.findUnique({ where: { userId: user.id } });
  const hasActiveCredential = Boolean(credential && !credential.revokedAt);
  const previousCaps = (hasActiveCredential ? (credential!.capabilities ?? null) : null) as KeyCapabilities | null;
  const change = hasActiveCredential ? compareCapabilities(previousCaps, capabilities) : null;
  const downgrade = change !== null && change.newlyUnavailable.length > 0 && change.newlyAvailable.length === 0;
  const upgrade = change !== null && change.newlyAvailable.length > 0;

  return {
    valid: true,
    tornId: incomingId,
    tornName: await resolvePlayerName(ctx.torn(apiKey)),
    accessLevel: info.info.access.level ?? null,
    accessType: info.info.access.type ?? null,
    capabilities,
    capabilityChange: change ? { newlyAvailable: change.newlyAvailable, newlyUnavailable: change.newlyUnavailable } : null,
    downgrade,
    upgrade,
  };
}

/** Details for the "existing TornScope profile found" flow. */
function existingProfileInfoFromMatch(match: NonNullable<Awaited<ReturnType<typeof findNonDemoProfileByTornId>>>): ExistingProfileInfo {
  return {
    tornId: match.tornId,
    name: match.tornName,
    level: match.level,
    factionName: match.factionName,
    storedAccess: match.storedAccess ? { level: match.storedAccess.level, type: match.storedAccess.type } : null,
    history: {
      earliestAt: match.history.earliestAt ? Math.floor(match.history.earliestAt.getTime() / 1000) : null,
      timelineEvents: match.history.timelineEvents,
      moneyEvents: match.history.moneyEvents,
      drugEvents: match.history.drugEvents,
      crimeEvents: match.history.crimeEvents,
      combatEvents: match.history.combatEvents,
      travelTrips: match.history.travelTrips,
    },
  };
}

export type SaveApiKeyOptions = {
  /** Explicit user choice to start a NEW profile for a different identity. */
  confirmNewProfile?: boolean;
};

export interface SaveApiKeyResult {
  status: ApiKeyStatusResponse;
  /** Set when an identity conflict was confirmed: the route rebinds this
   * browser session to the brand-new profile. */
  newProfileId: string | null;
}

/**
 * POST /api/settings/api-key: validate against Torn, then store encrypted.
 * The key is decrypted only for the validation request and never persisted
 * in plaintext or logged.
 *
 * Identity resolution (server-side; a Torn ID from the browser is never
 * trusted):
 * - the key is validated live via /key/info, which yields the real Torn
 *   player id, access level/type and per-selection capabilities;
 * - a key for a DIFFERENT Torn identity than the profile's never merges —
 *   the client must explicitly confirm a brand-new profile;
 * - a key whose identity already owns a non-demo profile raises
 *   `profile_exists`: the browser is offered a link to the EXISTING profile
 *   (no duplicate import, no duplicate credential);
 * - a fresh identity attaches to the current (guest) profile and starts the
 *   initial backfill exactly once. Replacing the stored key on an
 *   already-connected profile NEVER restarts the import.
 */
export async function saveApiKey(
  user: { id: string; isDemo: boolean },
  apiKey: string,
  opts: SaveApiKeyOptions = {}
): Promise<SaveApiKeyResult> {
  // The demo profile is a shared synthetic dataset: a real key must never be
  // attached to it (it would overwrite the demo identity, start Torn syncing
  // for the demo user and put the key on a profile no session can revoke).
  if (user.isDemo) {
    throw errors.forbidden("Leave demo view before connecting a real API key.");
  }
  const ctx = getApiContext();
  const db = ctx.db;
  let createdNewProfile = false;

  const { info, capabilities, incomingId } = await validateKeyLive(ctx, apiKey);
  const access = info.info.access;

  // Identity guard: a key for a DIFFERENT Torn account must never silently
  // merge into this profile's history. The client must explicitly choose to
  // start a new profile/data context.
  const existingAccount = await db.tornAccount.findUnique({ where: { userId: user.id }, select: { tornId: true, name: true } });
  if (existingAccount && incomingId !== null && incomingId !== existingAccount.tornId) {
    if (!opts.confirmNewProfile) {
      const incomingName = await resolvePlayerName(ctx.torn(apiKey));
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
    user = { id: fresh.id, isDemo: false };
    // The route rebinds the current browser session to `fresh.id` (the cookie
    // keeps working; the old profile stays orphaned but intact).
  } else if (!existingAccount && incomingId !== null) {
    // Profile reuse: a NEW browser presenting a valid key for an identity
    // that already has a non-demo TornScope profile must NOT duplicate it
    // (no second profile, no second import). Offer the link flow instead.
    const match = await findNonDemoProfileByTornId(db, incomingId);
    if (match && match.userId !== user.id) {
      const incomingName = await resolvePlayerName(ctx.torn(apiKey));
      throw new AppError(
        "profile_exists",
        "An existing TornScope profile already holds this Torn identity and its collected history. You can link this browser to it — linking does not change the stored API key.",
        409,
        {
          profileExists: true,
          existing: existingProfileInfoFromMatch(match),
          incoming: {
            tornId: incomingId,
            name: incomingName,
            accessLevel: access.level ?? null,
            accessType: access.type ?? null,
            capabilities,
          },
          /** True when the verification key is weaker than the stored one. */
          downgrade:
            match.storedAccess?.level !== null &&
            match.storedAccess?.level !== undefined &&
            access.level !== null &&
            access.level !== undefined &&
            access.level < match.storedAccess.level,
        }
      );
    }
  }

  // The initial backfill belongs to a profile receiving its FIRST identity —
  // replacing a stored key (same Torn ID) never re-imports history.
  const hadIdentityBefore = existingAccount !== null;

  const enc = ctx.encryptApiKey(apiKey);

  await db.apiCredential.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      encryptedKey: enc.encryptedKey,
      iv: enc.iv,
      authTag: enc.authTag,
      keyPreview: `••••${apiKey.slice(-4)}`,
      accessLevel: access.level ?? null,
      accessType: access.type ?? null,
      logAccessAvailable: capabilities.canReadUserLogs,
      capabilities: capabilities as never,
      validatedAt: new Date(),
      revokedAt: null,
    },
    update: {
      encryptedKey: enc.encryptedKey,
      iv: enc.iv,
      authTag: enc.authTag,
      keyPreview: `••••${apiKey.slice(-4)}`,
      accessLevel: access.level ?? null,
      accessType: access.type ?? null,
      logAccessAvailable: capabilities.canReadUserLogs,
      capabilities: capabilities as never,
      validatedAt: new Date(),
      revokedAt: null,
    },
  });

  // Sync schedules exist per user from the first valid key onward.
  await ensureSyncStates(db, user.id);
  // A key UPGRADE must immediately re-enable resources a previous (weaker)
  // key parked as capability_denied — otherwise upgraded profiles would stay
  // limited for up to one re-check interval.
  await resetCapabilityDeniedStates(db, user.id, capabilities);
  // New credentials: access-denied categories may retry promptly (cursor kept).
  await resetAccessDeniedCategories(db, user.id);
  // A real key always takes precedence over the demo view (this owner only).
  await clearDemoViewFlag(db, user.id);

  // Detect the player NOW (basic is public) so needsOnboarding flips and the
  // user can enter the app while the historical backfill runs in background.
  try {
    const basic = await ctx.torn(apiKey).userBasic();
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

  if (!hadIdentityBefore) {
    await enqueueInitialBackfill(ctx, user.id, capabilities);
  }

  return { status: await getApiKeyStatus(user.id), newProfileId: createdNewProfile ? user.id : null };
}

/**
 * Enqueue the initial backfill server-side — CAPABILITY-AWARE:
 * - resources the key cannot answer are never enqueued at all (they would
 *   only burn claim/decrypt/DB-write cycles on the serialized worker);
 * - they are marked capability_denied IMMEDIATELY, so the first-run screen
 *   shows "Skipped — permission unavailable" without waiting for every job
 *   to be processed by the worker first.
 */
async function enqueueInitialBackfill(ctx: ReturnType<typeof getApiContext>, userId: string, capabilities: KeyCapabilities): Promise<void> {
  const enqueueErrors: string[] = [];
  const deniedResources: SyncResource[] = [];
  for (const resource of SYNC_RESOURCES) {
    if (!resourceAllowed(capabilities, resource)) {
      deniedResources.push(resource);
      continue;
    }
    try {
      await ctx.syncQueue.add(
        SYNC_JOB_NAME,
        { userId, resource, manual: true },
        { jobId: buildSyncJobId(userId, resource, `init${Date.now()}`) }
      );
    } catch (err) {
      enqueueErrors.push(`${resource}: ${(err as Error).message}`);
    }
  }
  const allowedCount = SYNC_RESOURCES.length - deniedResources.length;
  if (enqueueErrors.length > 0 && enqueueErrors.length === allowedCount) {
    throw errors.internal(`Could not queue the initial sync: ${enqueueErrors[0] ?? "unknown queue error"}`);
  }
  for (const resource of deniedResources) {
    const message = `Permission required: this key does not include ${resourceRequirementLabel(resource)}. Grant it in Torn to sync this resource.`;
    await ctx.db.syncState.updateMany({
      where: { userId, resource, status: { not: "running" } },
      data: {
        status: "capability_denied",
        errorMessage: message,
        nextRunAt: new Date(Date.now() + CAPABILITY_RECHECK_SECONDS * 1000),
      },
    });
  }
}

/**
 * Key upgrades: resources parked as capability_denied by a WEAKER previous
 * key become due again immediately. Only currently-allowed resources are
 * touched — denied ones keep their parked state.
 */
async function resetCapabilityDeniedStates(db: ReturnType<typeof getPrismaClient>, userId: string, capabilities: KeyCapabilities): Promise<void> {
  const nowAllowed = SYNC_RESOURCES.filter((resource) => resourceAllowed(capabilities, resource));
  if (nowAllowed.length === 0) return;
  await db.syncState.updateMany({
    where: { userId, resource: { in: nowAllowed }, status: "capability_denied" },
    data: { status: "idle", errorMessage: null, errorCount: 0, nextRunAt: new Date() },
  });
}

/** What the route must do after a successful linkProfile call. */
export interface ProfileLinkHandoff {
  result: ProfileLinkResult;
  /** Move the current browser session to this profile (rotate the token). */
  linkToUserId: string | null;
  /** Delete this (provably empty) guest profile after the rebind. */
  cleanupGuestUserId: string | null;
}

/**
 * POST /api/profile/link — bind this browser to the EXISTING profile of the
 * Torn identity a freshly validated key resolves to.
 *
 * Identity proof (V1): possession of a valid Torn API key that resolves to
 * the Torn ID server-side. A Limited key is sufficient — the stored (possibly
 * stronger) key is never required for linking and NEVER replaced by it. The
 * key is re-validated live here so no client can link with unproven identity.
 */
export async function linkProfile(current: { id: string; isDemo: boolean }, apiKey: string): Promise<ProfileLinkHandoff> {
  if (current.isDemo) {
    throw errors.forbidden("Leave demo view before linking a profile.");
  }
  const ctx = getApiContext();
  const db = ctx.db;

  const { incomingId } = await validateKeyLive(ctx, apiKey);
  if (incomingId === null) throw errors.invalidApiKey("Torn did not report the key's owner.");

  const currentAccount = await db.tornAccount.findUnique({ where: { userId: current.id }, select: { tornId: true } });
  if (currentAccount && currentAccount.tornId !== incomingId) {
    // Cross-identity linking is never allowed: use the explicit new-profile
    // flow (identity conflict) to keep both histories separate.
    throw new AppError(
      "identity_conflict",
      "This browser is already linked to a different Torn player than this key belongs to.",
      409,
      {
        identityConflict: true,
        existing: { tornId: currentAccount.tornId, name: null },
        incoming: { tornId: incomingId, name: null },
      }
    );
  }

  const match = await findNonDemoProfileByTornId(db, incomingId);
  if (!match) {
    throw new AppError(
      "profile_not_found",
      "No existing TornScope profile holds this Torn identity. Connect the key normally instead.",
      404,
      { profileNotFound: true }
    );
  }
  if (currentAccount?.tornId === incomingId || match.userId === current.id) {
    // Already the same identity on this profile — linking is a no-op.
    return { result: { linked: false, alreadyLinked: true, profile: existingProfileInfoFromMatch(match), storedKeyUntouched: true }, linkToUserId: null, cleanupGuestUserId: null };
  }

  return {
    result: {
      linked: true,
      alreadyLinked: false,
      profile: existingProfileInfoFromMatch(match),
      // Explicit guarantee: linking never replaces the stored credential.
      storedKeyUntouched: true,
    },
    linkToUserId: match.userId,
    cleanupGuestUserId: current.id,
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
  const target = await db.user.findUnique({ where: { id: userId }, select: { role: true, isDemo: true } });
  if (target?.role === "owner" || target?.isDemo) {
    // The legacy owner profile holds the original dataset and the demo
    // profile is the SHARED synthetic dataset — one-click deletion through
    // the normal flow must never be possible for either.
    throw errors.forbidden("This profile cannot be deleted through this action.");
  }
  // ApiCredential/AppSetting may lack FK cascades (global settings table) —
  // remove them explicitly before the user row.
  await db.apiCredential.deleteMany({ where: { userId } });
  await db.appSetting.deleteMany({ where: { userId } });
  await db.userSession.deleteMany({ where: { userId } });
  await db.user.delete({ where: { id: userId } });
}

/** Sign out every OTHER active browser session of this profile (Phase 31). */
export async function signOutOtherSessions(userId: string, currentTokenHash: string): Promise<{ revoked: number }> {
  const db = getPrismaClient();
  const result = await db.userSession.updateMany({
    where: { userId, revokedAt: null, tokenHash: { not: currentTokenHash } },
    data: { revokedAt: new Date() },
  });
  return { revoked: result.count };
}
