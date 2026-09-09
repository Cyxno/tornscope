import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { getSyncHealth } from "../src/services/syncStatus.js";
import { getDashboard } from "../src/services/dashboard.js";
import { getEconomySummary } from "../src/services/economy.js";
import { deleteProfile } from "../src/services/me.js";

/**
 * Data-confidence regressions (v0.2 roadmap item #1).
 *
 * DB-backed: they create synthetic profiles and delete them afterwards.
 * Covers the acceptance matrix: complete / actual zero / unavailable /
 * stale_permission / partial range / capability downgrade retention /
 * multi-user isolation.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();

const FULL_CAPS = {
  canReadUserBasic: true,
  canReadUserBars: true,
  canReadUserCooldowns: true,
  canReadUserEducation: true,
  canReadUserTravel: true,
  canReadUserMoney: true,
  canReadUserLogs: true,
  canReadUserAttacks: true,
  canReadUserNetworth: true,
  canReadUserEvents: true,
  canReadUserPersonalStats: true,
  canReadFactionBasic: false,
  canReadFactionMembers: false,
  canReadFactionRankedWars: false,
  canReadFactionChains: false,
  canReadFactionCrimes: false,
  canReadFactionArmoryNews: false,
  canReadFactionBalance: false,
  canReadFactionLogs: false,
};

const DAY = 86_400;
const nowSec = Math.floor(Date.now() / 1000);
const cleanupIds: string[] = [];

async function makeProfile(name: string, caps: object): Promise<string> {
  const user = await db.user.create({ data: { displayName: name, role: "user" } });
  cleanupIds.push(user.id);
  await db.apiCredential.create({
    data: {
      userId: user.id,
      encryptedKey: randomBytes(16).toString("hex"),
      iv: randomBytes(8).toString("hex"),
      authTag: randomBytes(8).toString("hex"),
      keyPreview: "TEST",
      accessLevel: 3,
      accessType: "Limited",
      logAccessAvailable: true,
      capabilities: caps,
      validatedAt: new Date(),
    },
  });
  return user.id;
}

async function caughtUpState(userId: string, resource: string, records: number, from: number, to: number): Promise<void> {
  await db.syncState.upsert({
    where: { userId_resource: { userId, resource } },
    create: {
      userId,
      resource,
      status: "idle",
      lastSuccessAt: new Date(to * 1000),
      lastAttemptAt: new Date(to * 1000),
      lastCompletedAt: new Date(to * 1000),
      recordsCollected: records,
      stopReason: "history_boundary_reached",
      sourceEarliestAt: BigInt(from),
      lastTimestamp: BigInt(to),
      nextRunAt: new Date((to + 600) * 1000),
    },
    update: {
      status: "idle",
      lastSuccessAt: new Date(to * 1000),
      recordsCollected: records,
      stopReason: "history_boundary_reached",
      sourceEarliestAt: BigInt(from),
      lastTimestamp: BigInt(to),
    },
  });
}

async function capabilityDeniedState(userId: string, resource: string, records: number): Promise<void> {
  await db.syncState.upsert({
    where: { userId_resource: { userId, resource } },
    create: {
      userId,
      resource,
      status: "capability_denied",
      recordsCollected: records,
      stopReason: "history_boundary_reached",
      errorMessage: "Permission required",
      nextRunAt: new Date(Date.now() + 6 * 3600 * 1000),
    },
    update: {
      status: "capability_denied",
      recordsCollected: records,
      errorMessage: "Permission required",
    },
  });
}

suite("data confidence — sync health (canonical surface)", () => {
  let userId: string;

  beforeAll(async () => {
    userId = await makeProfile("CONF-A", FULL_CAPS);
    // money_logs: caught up with real coverage → complete
    await caughtUpState(userId, "money_logs", 800, nowSec - 30 * DAY, nowSec - 300);
    // drugs: runtime capability_denied WITH retained history → stale_permission
    await capabilityDeniedState(userId, "drugs", 400);
    // rehab: allowed but never synced with nothing stored → unavailable
    await db.syncState.upsert({
      where: { userId_resource: { userId, resource: "rehab" } },
      create: { userId, resource: "rehab" },
      update: {},
    });
  });

  afterAll(async () => {
    for (const id of cleanupIds.splice(0)) await deleteProfile(id);
  });

  it("money_logs caught up + covered range → complete", async () => {
    const health = await getSyncHealth(userId);
    const row = health.resources.find((r) => r.resource === "money_logs")!;
    expect(row.confidence.confidence).toBe("complete");
    expect(row.confidence.reason).toBeNull();
    expect(row.confidence.lastRefreshedAt).toBe(nowSec - 300);
    expect(row.confidence.coverage.from).not.toBeNull();
  });

  it("drugs capability_denied with history → stale_permission, data retained", async () => {
    const health = await getSyncHealth(userId);
    const row = health.resources.find((r) => r.resource === "drugs")!;
    expect(row.confidence.confidence).toBe("stale_permission");
    expect(row.confidence.reason).toBe("historical_permission_lost");
    // History is retained — the stored row bound is still exposed.
    expect(row.recordsCollected).toBe(400);
  });

  it("rehab never synced → unavailable/never_synced (never a zero)", async () => {
    const health = await getSyncHealth(userId);
    const row = health.resources.find((r) => r.resource === "rehab")!;
    expect(row.confidence.confidence).toBe("unavailable");
    expect(row.confidence.reason).toBe("never_synced");
  });

  it("operational phase stays distinct from confidence", async () => {
    const health = await getSyncHealth(userId);
    const drugs = health.resources.find((r) => r.resource === "drugs")!;
    // Operational vocabulary: permission_required phase (worker functioning
    // question). Confidence vocabulary: stale_permission. Never merged.
    expect(drugs.phase).toBe("permission_required");
    expect(drugs.confidence.confidence).toBe("stale_permission");
  });

  it("capability downgrade: removing logs caps flips money_logs to stale_permission, keeps rows", async () => {
    const healthBefore = await getSyncHealth(userId);
    expect(healthBefore.resources.find((r) => r.resource === "money_logs")!.confidence.confidence).toBe("complete");

    await db.apiCredential.update({
      where: { userId },
      data: { capabilities: { ...FULL_CAPS, canReadUserLogs: false } },
    });
    const healthAfter = await getSyncHealth(userId);
    const row = healthAfter.resources.find((r) => r.resource === "money_logs")!;
    expect(row.confidence.confidence).toBe("stale_permission");
    expect(row.confidence.reason).toBe("historical_permission_lost");
    // Nothing was deleted.
    expect(row.recordsCollected).toBe(800);
    // The collection coverage derived from sync state is still known.
    expect(row.confidence.coverage.from).not.toBeNull();

    // Restore for the later dashboard tests.
    await db.apiCredential.update({ where: { userId }, data: { capabilities: FULL_CAPS } });
  });

  it("multi-user isolation: another profile's sync state never leaks into this one", async () => {
    const otherId = await makeProfile("CONF-B", FULL_CAPS);
    await capabilityDeniedState(otherId, "money_logs", 10);
    const healthA = await getSyncHealth(userId);
    const healthB = await getSyncHealth(otherId);
    // A stays complete even though B is permission-blocked.
    expect(healthA.resources.find((r) => r.resource === "money_logs")!.confidence.confidence).toBe("complete");
    expect(healthB.resources.find((r) => r.resource === "money_logs")!.confidence.confidence).toBe("stale_permission");
    await db.apiCredential.delete({ where: { userId: otherId } });
    const idx = cleanupIds.indexOf(otherId);
    if (idx >= 0) cleanupIds.splice(idx, 1);
    await deleteProfile(otherId);
  });
});

suite("data confidence — Overview & Economy integration", () => {
  let userId: string;

  beforeAll(async () => {
    userId = await makeProfile("CONF-C", FULL_CAPS);
    await caughtUpState(userId, "money_logs", 500, nowSec - 30 * DAY, nowSec - 300);
  });

  afterAll(async () => {
    for (const id of cleanupIds.splice(0)) await deleteProfile(id);
  });

  it("valid zero: covered range with zero money rows renders 0 with 'ok', not null", async () => {
    const range = { preset: "custom" as const, from: nowSec - 7 * DAY, to: nowSec - 60 };
    const dash = await getDashboard(userId, range);
    // money_logs coverage is complete for the range — $0 is a CONFIRMED zero.
    expect(dash.confidence.cashFlow.confidence).toBe("complete");
    expect(dash.income.value).toBe(0);
    expect(dash.income.availability).toBe("ok");
    expect(dash.expenses.value).toBe(0);
    expect(dash.expenses.availability).toBe("ok");
  });

  it("unavailable: money_logs denied with nothing stored → null value, 'unavailable', confidence unavailable", async () => {
    const emptyId = await makeProfile("CONF-D", { ...FULL_CAPS, canReadUserLogs: false });
    const range = { preset: "custom" as const, from: nowSec - 7 * DAY, to: nowSec - 60 };
    const dash = await getDashboard(emptyId, range);
    expect(dash.confidence.cashFlow.confidence).toBe("unavailable");
    expect(dash.income.value).toBeNull();
    expect(dash.income.availability).toBe("unavailable");
    // Economy agrees with Overview — one derivation, no divergent heuristics.
    const econ = await getEconomySummary(emptyId, range);
    expect(econ.confidence.cashFlow.confidence).toBe("unavailable");
    expect(econ.cashFlow.income.value).toBeNull();
    expect(econ.cashFlow.income.availability).toBe("unavailable");
    await db.apiCredential.delete({ where: { userId: emptyId } });
    const idx = cleanupIds.indexOf(emptyId);
    if (idx >= 0) cleanupIds.splice(idx, 1);
    await deleteProfile(emptyId);
  });

  it("partial range: range starting before coverage → partial/range_before_coverage", async () => {
    const range = { preset: "custom" as const, from: nowSec - 400 * DAY, to: nowSec - 60 };
    const dash = await getDashboard(userId, range);
    expect(dash.confidence.cashFlow.confidence).toBe("partial");
    expect(dash.confidence.cashFlow.reason).toBe("range_before_coverage");
    expect(dash.confidence.cashFlow.coverage.from).not.toBeNull();
  });

  it("backfill running → values may change: importing, not ok", async () => {
    await db.syncState.update({
      where: { userId_resource: { userId, resource: "money_logs" } },
      data: { status: "running", lastStartedAt: new Date(), lastHeartbeatAt: new Date() },
    });
    const range = { preset: "custom" as const, from: nowSec - 7 * DAY, to: nowSec - 60 };
    const dash = await getDashboard(userId, range);
    expect(dash.confidence.cashFlow.reason).toBe("backfill_in_progress");
    expect(dash.income.availability).toBe("importing");
    await db.syncState.update({
      where: { userId_resource: { userId, resource: "money_logs" } },
      data: { status: "idle", lastStartedAt: null, lastHeartbeatAt: null },
    });
  });

  it("demo dataset never reports stale_permission", async () => {
    // Demo user is seeded in CI (demo.ts) with fabricated healthy states and
    // NO credential — the derivation must read it as complete, not as a
    // permission problem caused by the missing key.
    const demoUser = await db.user.findUnique({ where: { email: "demo@tornscope.local" } });
    if (!demoUser) return; // demo seed not present in this environment
    const health = await getSyncHealth(demoUser.id);
    const money = health.resources.find((r) => r.resource === "money_logs");
    if (!money || money.recordsCollected === 0) return; // demo variant without fabricated states
    expect(money.confidence.confidence).toBe("complete");
    expect(money.confidence.reason).not.toBe("historical_permission_lost");
  });
});
