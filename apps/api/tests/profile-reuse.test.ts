import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { getPrismaClient, deleteEmptyProfile, findNonDemoProfileByTornId, profileIsEmpty } from "@tornscope/database";
import { rebindCurrentSession } from "../src/auth.js";
import { saveApiKey, linkProfile, getApiKeyStatus, deleteProfile } from "../src/services/me.js";
import { deriveResourcePhase } from "../src/services/syncStatus.js";
import { AppError } from "../src/errors.js";

/**
 * Profile reuse + multi-device linking + credential semantics.
 *
 * These run against a real PostgreSQL when TEST_DATABASE_URL is set; Torn's
 * API is stubbed at the fetch level with canned /key/info + /user/basic
 * responses (no real key is fabricated or used — the key strings are test
 * fixtures that never leave the process). Without the variable the suite is
 * skipped so the pure-test suite stays hermetic.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

process.env.API_KEY_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.TORN_API_MIN_REQUEST_INTERVAL_MS = "0";

const db = getPrismaClient();

const sha = (t: string): string => createHash("sha256").update(t).digest("hex");
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** The real Torn identity under test. */
const TORN_ID = 55_500_001;
const TORN_NAME = "ReuseTestPlayer";
/** Full key stored on the existing profile. */
const FULL_KEY = "testfullkey0001";
/** A weaker (Limited) key for the SAME identity — used to verify a new browser. */
const LIMITED_KEY = "testlimitedkey01";
/** A different identity — must stay isolated forever. */
const OTHER_TORN_ID = 55_500_002;
const OTHER_KEY = "testotherkey0001";

interface MockKey { id: number; name?: string; level: number; type: string; user: string[]; faction?: string[] }
const MOCK_KEYS: Record<string, MockKey> = {
  [FULL_KEY]: { id: TORN_ID, name: TORN_NAME, level: 4, type: "Full Access", user: ["basic", "profile", "bars", "money", "log", "attacks", "networth", "events", "personalstats", "travel", "cooldowns", "education"], faction: ["basic", "members", "rankedwars", "chains", "crimes", "armorynews", "balance", "log"] },
  [LIMITED_KEY]: { id: TORN_ID, name: TORN_NAME, level: 3, type: "Limited Access", user: ["basic", "profile", "bars"] },
  [OTHER_KEY]: { id: OTHER_TORN_ID, name: "OtherPlayer", level: 4, type: "Full Access", user: ["basic", "profile", "bars", "money", "log", "attacks", "networth", "events", "personalstats"], faction: ["basic"] },
};

function installTornStub(): void {
  vi.stubGlobal("fetch", async (url: string | URL, init?: { headers?: Record<string, string> | Headers }) => {
    const headers = init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : (init?.headers ?? {});
    const auth = headers["Authorization"] ?? headers["authorization"] ?? "";
    const key = String(auth).replace(/^ApiKey\s+/i, "");
    const info = MOCK_KEYS[key];
    const path = new URL(String(url)).pathname;
    if (!info) return json({ error: { code: 2, error: "incorrect key" } });
    if (path.endsWith("/key/info")) {
      return json({
        info: {
          selections: { user: info.user, faction: info.faction ?? [], key: ["info"] },
          access: { level: info.level, type: info.type, faction: Boolean(info.faction?.length), log: { custom_permissions: false, available: [] } },
          user: { id: info.id, faction_id: null, company_id: null },
        },
      });
    }
    if (path.endsWith("/user/basic")) {
      return json({ profile: { id: info.id, name: info.name ?? `Player ${info.id}`, level: 30 } });
    }
    return json({ error: { code: 9, error: `unmocked path ${path}` } });
  });
}

function fakeReq(cookie?: string): any {
  return { headers: cookie ? { cookie } : {}, protocol: "http", ip: `test-link-${Date.now()}-${counter++}` };
}
let counter = 0;
function fakeReply(): any {
  return { __headers: {} as Record<string, string>, header(name: string, value: string) { this.__headers[name] = value; } };
}

/** Session cookie token for a profile (server stores only the hash). */
async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.userSession.create({ data: { userId, tokenHash: sha(token) } });
  return token;
}

async function activeCredential(userId: string) {
  return db.apiCredential.findFirst({ where: { userId, revokedAt: null } });
}

let ownerProfileId = "";
let secondBrowserSession = "";
let guestProfileId = "";
let guestSession = "";
const cleanupIds: string[] = [];

beforeAll(async () => {
  installTornStub();

  // The EXISTING profile (Browser A): real history, Full credential, sessions.
  const owner = await db.user.create({ data: { displayName: "ReuseOwner", role: "user" } });
  ownerProfileId = owner.id;
  cleanupIds.push(owner.id);
  const enc = (await import("../src/context.js")).getApiContext().encryptApiKey(FULL_KEY);
  await db.apiCredential.create({
    data: {
      userId: owner.id,
      encryptedKey: enc.encryptedKey,
      iv: enc.iv,
      authTag: enc.authTag,
      keyPreview: "•••0001",
      accessLevel: 4,
      accessType: "Full Access",
      logAccessAvailable: true,
      validatedAt: new Date(),
    },
  });
  await db.tornAccount.create({
    data: { userId: owner.id, tornId: TORN_ID, name: TORN_NAME, level: 40, firstSeenAt: new Date(), lastSeenAt: new Date() },
  });
  // Meaningful stored history on the existing profile.
  await db.timelineEvent.create({
    data: { userId: owner.id, occurredAt: new Date(), type: "log", category: "Travel", title: "Flight abroad", source: "test", sourceRef: "reuse:tl:1" },
  });
  await db.travelEvent.create({
    data: { userId: owner.id, destination: "Japan", departedAt: new Date(), status: "completed", source: "trip", sourceRef: "reuse:trip:1" },
  });
  await createSession(owner.id);
  secondBrowserSession = await createSession(owner.id); // a second device

  // Browser B: a fresh Guest profile (no identity, no credential).
  const guest = await db.user.create({ data: { displayName: "ReuseGuest", role: "user" } });
  guestProfileId = guest.id;
  cleanupIds.push(guest.id);
  guestSession = await createSession(guest.id);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const id of cleanupIds) {
    await db.apiCredential.deleteMany({ where: { userId: id } });
    await db.appSetting.deleteMany({ where: { userId: id } });
    await db.userSession.deleteMany({ where: { userId: id } });
    await db.user.deleteMany({ where: { id } }).catch(() => undefined);
  }
});

suite("profile reuse: new browser + same Torn ID", () => {
  it("saving a key for an existing identity raises profile_exists instead of duplicating", async () => {
    const guest = { id: guestProfileId, isDemo: false };
    const err = await saveApiKey(guest, LIMITED_KEY).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("profile_exists");
    expect(err.details.existing.tornId).toBe(TORN_ID);
    expect(err.details.existing.name).toBe(TORN_NAME);
    expect(err.details.existing.history.timelineEvents).toBeGreaterThanOrEqual(1);
    expect(err.details.existing.history.travelTrips).toBeGreaterThanOrEqual(1);
    expect(err.details.existing.storedAccess).toEqual({ level: 4, type: "Full Access" });
    expect(err.details.incoming.accessType).toBe("Limited Access");
    // Stored Full > verification Limited -> downgrade flagged for the UI.
    expect(err.details.downgrade).toBe(true);

    // Nothing was written to the guest profile.
    expect(await activeCredential(guestProfileId)).toBeNull();
    expect(await db.tornAccount.findUnique({ where: { userId: guestProfileId } })).toBeNull();
    expect(await db.syncState.findMany({ where: { userId: guestProfileId } })).toHaveLength(0);
  });

  it("linking with the Limited key binds the browser to the EXISTING profile", async () => {
    const guest = { id: guestProfileId, isDemo: false };
    const handoff = await linkProfile(guest, LIMITED_KEY);
    expect(handoff.result.linked).toBe(true);
    expect(handoff.result.storedKeyUntouched).toBe(true);
    expect(handoff.linkToUserId).toBe(ownerProfileId);
    expect(handoff.cleanupGuestUserId).toBe(guestProfileId);
  });

  it("linking never replaces the stored Full credential", async () => {
    const before = await activeCredential(ownerProfileId);
    const handoff = await linkProfile({ id: guestProfileId, isDemo: false }, LIMITED_KEY);
    // (route side-effect performed below in the session test)
    const after = await activeCredential(ownerProfileId);
    expect(after!.id).toBe(before!.id);
    expect(after!.accessLevel).toBe(4);
    expect(after!.accessType).toBe("Full Access");
    expect(after!.encryptedKey).toBe(before!.encryptedKey);
    expect(handoff.result.storedKeyUntouched).toBe(true);
  });

  it("the route-level link rotates the session token, keeps other sessions, and removes the empty guest", async () => {
    // The guest's session is claimed via its cookie.
    const req = fakeReq(`ts_session=${guestSession}`);
    const reply = fakeReply();
    await rebindCurrentSession(req, reply, db, ownerProfileId);

    // The old token is dead; the browser holds a fresh one.
    const newCookie = (reply.__headers["Set-Cookie"] as string) ?? "";
    expect(newCookie).toContain("ts_session=");
    const newToken = decodeURIComponent(newCookie.split(";")[0]!.split("=")[1]!);
    expect(await db.userSession.findUnique({ where: { tokenHash: sha(guestSession) } })).toBeNull();
    const moved = await db.userSession.findUnique({ where: { tokenHash: sha(newToken) } });
    expect(moved).not.toBeNull();
    expect(moved!.userId).toBe(ownerProfileId);
    expect(moved!.revokedAt).toBeNull();

    // Other sessions of the EXISTING profile remain active (multi-device).
    const ownerSessions = await db.userSession.findMany({ where: { userId: ownerProfileId, revokedAt: null } });
    expect(ownerSessions.some((s) => s.tokenHash === sha(secondBrowserSession))).toBe(true);

    // The guest profile is now provably empty and is cleaned up.
    expect(await profileIsEmpty(db, guestProfileId)).toBe(true);
    expect(await deleteEmptyProfile(db, guestProfileId)).toBe(true);
    expect(await db.user.findUnique({ where: { id: guestProfileId } })).toBeNull();
    // The moved session survived the guest deletion.
    expect(await db.userSession.findUnique({ where: { tokenHash: sha(newToken) } })).not.toBeNull();
  });

  it("after linking, Browser B sees the existing profile's key status and history identity", async () => {
    const status = await getApiKeyStatus(ownerProfileId);
    expect(status.hasKey).toBe(true);
    expect(status.accessType).toBe("Full Access");
    expect(status.tornId).toBe(TORN_ID);
  });

  it("no duplicate TornAccount and no duplicate import happened", async () => {
    const accounts = await db.tornAccount.findMany({ where: { tornId: TORN_ID, isDemo: false } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.userId).toBe(ownerProfileId);
    // The guest never got sync states (no initial backfill enqueued).
    const guestStates = await db.syncState.findMany({ where: { userId: guestProfileId } });
    expect(guestStates).toHaveLength(0);
  });
});

suite("uniqueness invariant: one real Torn ID -> one profile", () => {
  it("a second non-demo TornAccount with the same tornId violates the partial unique index", async () => {
    const dupe = await db.user.create({ data: { displayName: "DupeAttempt", role: "user" } });
    try {
      await db.tornAccount.create({
        data: { userId: dupe.id, tornId: TORN_ID, name: TORN_NAME, level: 1, firstSeenAt: new Date(), lastSeenAt: new Date() },
      });
      expect.unreachable("unique index should have blocked the duplicate");
    } catch (err) {
      expect((err as { code?: string }).code ?? "").toMatch(/P2002/);
    } finally {
      await db.user.delete({ where: { id: dupe.id } }).catch(() => undefined);
    }
  });

  it("demo profiles sit outside the invariant", async () => {
    const demo = await db.user.create({ data: { displayName: "DemoReuse", role: "owner", isDemo: true } });
    const demoTornId = 200_555_009;
    await db.tornAccount.create({
      data: { userId: demo.id, tornId: demoTornId, name: "DEMO_Reuse", level: 1, isDemo: true, firstSeenAt: new Date(), lastSeenAt: new Date() },
    });
    // A second demo TornAccount with the same tornId is allowed...
    const demo2 = await db.user.create({ data: { displayName: "DemoReuse2", role: "owner", isDemo: true } });
    await db.tornAccount.create({
      data: { userId: demo2.id, tornId: demoTornId, name: "DEMO_Reuse2", level: 1, isDemo: true, firstSeenAt: new Date(), lastSeenAt: new Date() },
    });
    // ...but the lookup for real profiles never returns demo rows.
    expect(await findNonDemoProfileByTornId(db, demoTornId)).toBeNull();
    await db.user.deleteMany({ where: { id: { in: [demo.id, demo2.id] } } });
  });
});

suite("cross-identity isolation", () => {
  it("a different Torn ID still triggers identity_conflict (never merges)", async () => {
    const err = await saveApiKey({ id: ownerProfileId, isDemo: false }, OTHER_KEY).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("identity_conflict");
    expect(err.details.existing.tornId).toBe(TORN_ID);
    expect(err.details.incoming.tornId).toBe(OTHER_TORN_ID);
    // The stored credential was not replaced by the other identity's key.
    expect((await activeCredential(ownerProfileId))!.accessLevel).toBe(4);
  });

  it("linking cannot cross identities: a browser bound to Cyxno cannot link to another player", async () => {
    const err = await linkProfile({ id: ownerProfileId, isDemo: false }, OTHER_KEY).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("identity_conflict");
  });

  it("demo is excluded: a key whose identity only exists on demo profiles cannot link", async () => {
    // The demo identity's tornId is filtered out of the lookup, so linking a
    // real browser to it is impossible.
    const guest = await db.user.create({ data: { displayName: "GuestDemoLink", role: "user" } });
    try {
      await db.tornAccount.create({
        data: { userId: guest.id, tornId: 200_555_010, name: "DemoOnly", level: 1, isDemo: true, firstSeenAt: new Date(), lastSeenAt: new Date() },
      });
      expect(await findNonDemoProfileByTornId(db, 200_555_010)).toBeNull();
    } finally {
      await db.user.delete({ where: { id: guest.id } }).catch(() => undefined);
    }
  });
});

suite("credential replacement semantics (same identity)", () => {
  it("replacing the stored key keeps ONE credential, keeps history, and persists detected capabilities", async () => {
    const historyBefore = await db.timelineEvent.count({ where: { userId: ownerProfileId } });
    const result = await saveApiKey({ id: ownerProfileId, isDemo: false }, FULL_KEY);
    expect(result.status.hasKey).toBe(true);
    expect(result.status.tornId).toBe(TORN_ID);

    const creds = await db.apiCredential.findMany({ where: { userId: ownerProfileId } });
    expect(creds).toHaveLength(1);
    expect(creds[0]!.revokedAt).toBeNull();
    // Capabilities are persisted now (previously a silent gap).
    const caps = creds[0]!.capabilities as Record<string, boolean> | null;
    expect(caps).not.toBeNull();
    expect(caps!.canReadUserLogs).toBe(true);
    expect(caps!.canReadFactionArmoryNews).toBe(true);

    const historyAfter = await db.timelineEvent.count({ where: { userId: ownerProfileId } });
    expect(historyAfter).toBe(historyBefore);
  });

  it("capability_denied resources report a permission phase, not a sync failure", () => {
    const phase = deriveResourcePhase(
      {
        resource: "drugs",
        status: "capability_denied",
        lastAttemptAt: null,
        lastStartedAt: null,
        lastCompletedAt: null,
        lastSuccessAt: null,
        nextRunAt: null,
        lastTimestamp: null,
        cursor: null,
        recordsCollected: 0,
        errorCount: 1,
        errorMessage: "Permission required: this key does not include User Logs.",
        stopReason: null,
        sourceEarliestAt: null,
        lastWalkPages: null,
        frequencySeconds: 600,
        updatedAt: null,
      },
      []
    );
    expect(phase).toBe("permission_required");
  });
});

suite("profile deletion guard", () => {
  it("deleteProfile refuses the canonical owner profile used in this suite's flow setup", async () => {
    // Sanity of the shared service: guest (role=user) deletes are allowed,
    // owner-role profiles are not.
    const ownerRole = await db.user.create({ data: { displayName: "OwnerRoleGuard", role: "owner" } });
    try {
      await expect(deleteProfile(ownerRole.id)).rejects.toBeInstanceOf(AppError);
      expect(await db.user.findUnique({ where: { id: ownerRole.id } })).not.toBeNull();
    } finally {
      await db.user.delete({ where: { id: ownerRole.id } }).catch(() => undefined);
    }
  });
});
