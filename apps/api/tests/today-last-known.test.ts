import { describe, expect, it, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { getToday, buildDemoToday } from "../src/services/today.js";
import { deleteProfile } from "../src/services/me.js";

/**
 * GET /api/today — stale-while-revalidate regression guards (real-user
 * remediation for the 4–5s cold page load).
 *
 * Cold loads used to block on the full serialized upstream Torn refresh
 * (profile → bars/cooldowns/education/travel/money, spaced by the polite
 * request interval). The service now serves a PERSISTED last-known copy
 * immediately and revalidates in the background. These tests pin the
 * contract the UI depends on:
 *
 *   1. a fresh persisted copy is served as-is, instantly, with no "stale"
 *      marker and its original fetchedAt;
 *   2. a copy older than the cache window is still served, but honestly
 *      flagged `stale: true` with its original fetchedAt — staleness is
 *      never hidden and old data is never presented as current;
 *   3. a failing background refresh never evicts the last-known copy;
 *   4. with nothing persisted, the upstream refresh is awaited and its
 *      failure propagates — the service never fabricates a payload.
 *
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const cleanupUserIds: string[] = [];

const FULL_CAPS = {
  canReadUserBasic: true, canReadUserBars: true, canReadUserCooldowns: true, canReadUserEducation: true,
  canReadUserTravel: true, canReadUserMoney: true, canReadUserLogs: true, canReadUserAttacks: true,
  canReadUserNetworth: true, canReadUserEvents: true, canReadUserPersonalStats: true,
  canReadFactionBasic: false, canReadFactionMembers: false, canReadFactionRankedWars: false,
  canReadFactionChains: false, canReadFactionCrimes: false, canReadFactionArmoryNews: false,
  canReadFactionBalance: false, canReadFactionLogs: false,
};

/** The fixture payload is a complete valid TodayResponse; only its
 *  provenance is flipped from demo to a real fetch so the stored copy
 *  mirrors what fetchToday would have persisted. */
function lastKnownPayload(fetchedAtMs: number) {
  const demo = buildDemoToday(fetchedAtMs);
  return {
    ...demo,
    demo: false,
    player: { ...demo.player, name: "LASTKNOWN_FIXTURE" },
  };
}

async function makeProfile(name: string): Promise<string> {
  const user = await db.user.create({ data: { displayName: name, role: "user", timezone: "UTC" } });
  cleanupUserIds.push(user.id);
  await db.apiCredential.create({
    data: {
      userId: user.id,
      // Undecryptable with the test key on purpose: any background refresh
      // fails fast (locally, before any network call) and must be swallowed.
      encryptedKey: randomBytes(16).toString("hex"),
      iv: randomBytes(8).toString("hex"),
      authTag: randomBytes(8).toString("hex"),
      keyPreview: "TEST",
      accessLevel: 4,
      accessType: "Full Access",
      logAccessAvailable: true,
      capabilities: FULL_CAPS,
      validatedAt: new Date(),
    },
  });
  return user.id;
}

async function seedLastKnown(userId: string, fetchedAtMs: number): Promise<void> {
  await db.todayLastKnown.upsert({
    where: { userId },
    create: { userId, payload: lastKnownPayload(fetchedAtMs) as unknown as object, fetchedAt: new Date(fetchedAtMs) },
    update: { payload: lastKnownPayload(fetchedAtMs) as unknown as object, fetchedAt: new Date(fetchedAtMs) },
  });
}

/** Let an already-started background refresh reach its (guaranteed) failure. */
function settleBackground(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterAll(async () => {
  for (const id of cleanupUserIds.splice(0)) {
    await deleteProfile(id).catch(() => undefined);
  }
});

suite("today last-known (stale-while-revalidate)", () => {
  it("serves the persisted copy immediately — no upstream wait, no stale marker", async () => {
    const userId = await makeProfile("TODAY-SWR-FRESH");
    const fetchedAt = Date.now() - 1_000; // well inside the cache window
    await seedLastKnown(userId, fetchedAt);

    const t0 = Date.now();
    const res = await getToday({ id: userId, isDemo: false });
    // The persisted copy must answer without awaiting the serialized upstream
    // refresh (which, with this fixture's credential, cannot ever succeed).
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res.player.name).toBe("LASTKNOWN_FIXTURE");
    expect(res.fetchedAt).toBe(fetchedAt); // original freshness preserved
    expect(res.stale ?? false).toBe(false); // fresh window: honestly current
    expect(res.demo).toBe(false);
  });

  it("flags a copy older than the cache window as stale — never hides freshness", async () => {
    const userId = await makeProfile("TODAY-SWR-STALE");
    const fetchedAt = Date.now() - 120_000; // far beyond TODAY_CACHE_TTL_MS (30s)
    await seedLastKnown(userId, fetchedAt);

    const res = await getToday({ id: userId, isDemo: false });
    expect(res.stale).toBe(true); // the UI renders its "stale — refreshing" marker
    expect(res.fetchedAt).toBe(fetchedAt); // old data is never re-dated as current
    expect(res.player.name).toBe("LASTKNOWN_FIXTURE");
    await settleBackground(); // the kicked-off refresh must fail harmlessly
  });

  it("a failing background refresh never evicts the last-known copy", async () => {
    const userId = await makeProfile("TODAY-SWR-NO-EVICT");
    const fetchedAt = Date.now() - 120_000;
    await seedLastKnown(userId, fetchedAt);

    const first = await getToday({ id: userId, isDemo: false });
    await settleBackground(); // background refresh fails at credential decrypt

    // The copy is still there — served again instead of erroring or blocking.
    const second = await getToday({ id: userId, isDemo: false });
    expect(second.player.name).toBe("LASTKNOWN_FIXTURE");
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.stale).toBe(true);

    // The persisted row itself is untouched by the failed refresh.
    const row = await db.todayLastKnown.findUnique({ where: { userId } });
    expect(row?.fetchedAt.getTime()).toBe(fetchedAt);
  });

  it("with nothing persisted, the upstream refresh is awaited (failure propagates — no fabricated payload)", async () => {
    const userId = await makeProfile("TODAY-SWR-FIRST-EVER");
    await expect(getToday({ id: userId, isDemo: false })).rejects.toThrow();
    // No invented row appeared as a side effect of the failed refresh.
    expect(await db.todayLastKnown.findUnique({ where: { userId } })).toBeNull();
  });
});
