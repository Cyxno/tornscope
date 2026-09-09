import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { getSyncHealth, retrySyncNow } from "../src/services/syncStatus.js";

/**
 * Operational sync health over the Sync Status API (v0.2 roadmap item #3).
 *
 * DB-backed: creates synthetic profiles, deletes them afterwards. Covers:
 * operational states surface through /sync/health, operational health stays
 * SEPARATE from data confidence, incident history derives from SyncRun rows,
 * error payloads stay sanitized (machine codes, no raw internals), retry-now
 * refuses unsafe states, and multi-user isolation.
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

const LIMITED_CAPS = { ...FULL_CAPS, canReadUserLogs: false };

const MIN = 60_000;
const cleanupIds: string[] = [];

async function makeProfile(name: string, caps: object): Promise<string> {
  const user = await db.user.create({ data: { displayName: `${name}-${randomUUID().slice(0, 8)}`, role: "user" } });
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

async function setState(userId: string, resource: string, data: Record<string, unknown>): Promise<void> {
  await db.syncState.upsert({
    where: { userId_resource: { userId, resource } },
    create: { userId, resource, frequencySeconds: 600, ...data },
    update: data,
  });
}

async function addRun(userId: string, resource: string, status: string, minutesAgo: number, errorKind?: string): Promise<void> {
  const startedAt = new Date(Date.now() - minutesAgo * MIN);
  await db.syncRun.create({
    data: {
      userId,
      resource,
      status,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 2000),
      recordsCollected: status === "success" ? 10 : 0,
      stats: { durationMs: 2000, ...(errorKind ? { errorKind } : {}) },
    },
  });
}

function resourceOf(health: Awaited<ReturnType<typeof getSyncHealth>>, resource: string) {
  const row = health.resources.find((r) => r.resource === resource);
  if (!row) throw new Error(`resource ${resource} missing from health payload`);
  return row;
}

afterAll(async () => {
  for (const userId of cleanupIds) {
    await db.syncState.deleteMany({ where: { userId } }).catch(() => undefined);
    await db.syncRun.deleteMany({ where: { userId } }).catch(() => undefined);
    await db.apiCredential.deleteMany({ where: { userId } }).catch(() => undefined);
    await db.appSetting.deleteMany({ where: { userId } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }
  await db.$disconnect();
});

suite("sync health: operational states", () => {
  it("derives retrying / parked / delayed / stale_running / never_run from real rows", async () => {
    const userId = await makeProfile("op-states", FULL_CAPS);

    // retrying: one transient failure, retry scheduled within the ladder.
    await setState(userId, "money_logs", {
      status: "failed",
      lastAttemptAt: new Date(Date.now() - 2 * MIN),
      lastSuccessAt: new Date(Date.now() - 30 * MIN),
      nextRunAt: new Date(Date.now() + 3 * MIN),
      errorCount: 1,
      lastErrorKind: "timeout",
      stopReason: "history_boundary_reached",
    });
    // parked: key cannot access this resource at all.
    await setState(userId, "networth", {
      status: "capability_denied",
      lastAttemptAt: new Date(Date.now() - 30 * MIN),
      lastSuccessAt: new Date(Date.now() - 60 * MIN),
      nextRunAt: new Date(Date.now() + 5 * 3600_000),
      recordsCollected: 500,
    });
    // delayed: healthy but long overdue (way beyond the grace window).
    await setState(userId, "profile", {
      status: "idle",
      lastAttemptAt: new Date(Date.now() - 3 * 3600_000),
      lastSuccessAt: new Date(Date.now() - 3 * 3600_000),
      nextRunAt: new Date(Date.now() - 2 * 3600_000),
      recordsCollected: 50,
    });
    // stale_running: DB says running, heartbeat died 20 min ago.
    await setState(userId, "drugs", {
      status: "running",
      lastAttemptAt: new Date(Date.now() - 25 * MIN),
      lastStartedAt: new Date(Date.now() - 25 * MIN),
      lastHeartbeatAt: new Date(Date.now() - 20 * MIN),
      recordsCollected: 10,
    });
    // never_run: row exists, nothing attempted.
    await setState(userId, "events", { status: "idle" });

    const health = await getSyncHealth(userId);
    expect(resourceOf(health, "money_logs").operational).toMatchObject({ state: "retrying", reason: "timeout" });
    expect(resourceOf(health, "money_logs").operational.retryAt).not.toBeNull();
    expect(resourceOf(health, "networth").operational).toMatchObject({ state: "parked", reason: "capability_denied" });
    expect(resourceOf(health, "profile").operational.state).toBe("delayed");
    expect(resourceOf(health, "profile").operational.overdueBySeconds).toBeGreaterThan(0);
    expect(resourceOf(health, "drugs").operational).toMatchObject({ state: "stale_running", reason: "worker_interrupted" });
    expect(resourceOf(health, "events").operational.state).toBe("never_run");
  });

  it("operational health stays separate from confidence (transient retry does not overwrite coverage verdict)", async () => {
    const userId = await makeProfile("op-vs-conf", FULL_CAPS);
    await setState(userId, "money_logs", {
      status: "failed",
      lastAttemptAt: new Date(Date.now() - 2 * MIN),
      lastSuccessAt: new Date(Date.now() - 5 * MIN),
      nextRunAt: new Date(Date.now() + 3 * MIN),
      errorCount: 1,
      lastErrorKind: "rate_limited",
      stopReason: "history_boundary_reached",
    });
    const health = await getSyncHealth(userId);
    const row = resourceOf(health, "money_logs");
    expect(row.operational.state).toBe("retrying");
    expect(row.operational.reason).toBe("rate_limited");
    // Confidence keeps its own vocabulary and rules — never merged.
    expect(["complete", "partial"]).toContain(row.confidence.confidence);
    expect(row.lastErrorKind).toBe("rate_limited");
  });

  it("derives incidents from run history (auto-recovery + stale-run recovery)", async () => {
    const userId = await makeProfile("op-incidents", FULL_CAPS);
    await setState(userId, "money_logs", {
      status: "idle",
      lastAttemptAt: new Date(Date.now() - 5 * MIN),
      lastSuccessAt: new Date(Date.now() - 5 * MIN),
      nextRunAt: new Date(Date.now() + 5 * MIN),
      stopReason: "history_boundary_reached",
    });
    await addRun(userId, "money_logs", "failed", 50, "timeout");
    await addRun(userId, "money_logs", "success", 40);
    // Orphan incident: the scheduler wrote this "recovered" row.
    await addRun(userId, "money_logs", "recovered", 20);

    const health = await getSyncHealth(userId);
    const row = resourceOf(health, "money_logs");
    expect(row.recentIncidents.length).toBeGreaterThanOrEqual(2);
    const failures = row.recentIncidents.find((i) => i.kind === "sync_failures");
    expect(failures).toMatchObject({ autoRecovered: true, reason: "timeout", severity: "info" });
    const recovered = row.recentIncidents.find((i) => i.kind === "stale_recovered");
    expect(recovered?.reason).toBe("worker_interrupted");
    expect(row.metrics).not.toBeNull();
    expect(row.metrics?.recoveries24h).toBe(1);
  });

  it("error payloads stay sanitized: reason codes only, no raw error prose in codes", async () => {
    const userId = await makeProfile("op-sanitize", FULL_CAPS);
    await setState(userId, "money_logs", {
      status: "failed",
      lastAttemptAt: new Date(Date.now() - 2 * MIN),
      lastSuccessAt: new Date(Date.now() - 30 * MIN),
      nextRunAt: new Date(Date.now() + 3 * MIN),
      errorCount: 1,
      lastErrorKind: "network",
      errorMessage: "torn api error (kind=network): request failed with internal stack at Object.handler (/srv/app.ts:1:1)",
    });
    const health = await getSyncHealth(userId);
    const row = resourceOf(health, "money_logs");
    expect(row.operational.reason).toBe("network_error");
    // No stack traces anywhere in the operational payload.
    expect(JSON.stringify(row.operational)).not.toContain("at Object");
    expect(JSON.stringify(row.recentIncidents)).not.toContain("stack");
  });

  it("multi-user isolation: one user's failure does not leak into another's health", async () => {
    const userA = await makeProfile("op-iso-a", FULL_CAPS);
    const userB = await makeProfile("op-iso-b", FULL_CAPS);
    await setState(userA, "money_logs", {
      status: "failed",
      lastAttemptAt: new Date(Date.now() - 2 * MIN),
      nextRunAt: new Date(Date.now() + 3 * MIN),
      errorCount: 1,
      lastErrorKind: "timeout",
    });
    await setState(userB, "money_logs", {
      status: "idle",
      lastAttemptAt: new Date(Date.now() - 2 * MIN),
      lastSuccessAt: new Date(Date.now() - 2 * MIN),
      nextRunAt: new Date(Date.now() + 8 * MIN),
    });
    const healthA = await getSyncHealth(userA);
    const healthB = await getSyncHealth(userB);
    expect(resourceOf(healthA, "money_logs").operational.state).toBe("retrying");
    expect(resourceOf(healthB, "money_logs").operational.state).toBe("caught_up");
    expect(resourceOf(healthB, "money_logs").recentIncidents).toHaveLength(0);
  });
});

suite("sync health: retry now", () => {
  it("queues a retry for a troubled resource and refuses unsafe states", async () => {
    const userId = await makeProfile("op-retry", FULL_CAPS);
    const limited = await makeProfile("op-retry-limited", LIMITED_CAPS);

    // Failed resource → queued.
    await setState(userId, "money_logs", {
      status: "failed",
      lastAttemptAt: new Date(Date.now() - 10 * MIN),
      nextRunAt: new Date(Date.now() + 3 * MIN),
      errorCount: 1,
    });
    expect(await retrySyncNow(userId, "money_logs")).toEqual({ queued: true });

    // Currently running → refused.
    await setState(userId, "drugs", { status: "running", lastAttemptAt: new Date(Date.now() - MIN) });
    expect(await retrySyncNow(userId, "drugs")).toMatchObject({ queued: false, refused: "running" });

    // Parked with a key that cannot access it → refused (needs permission).
    await setState(limited, "money_logs", { status: "capability_denied", lastAttemptAt: new Date(Date.now() - 30 * MIN) });
    expect(await retrySyncNow(limited, "money_logs")).toMatchObject({ queued: false, refused: "parked" });

    // Cooldown: second retry within 30s of the last attempt.
    await setState(userId, "travel", { status: "failed", lastAttemptAt: new Date(), nextRunAt: new Date(Date.now() + MIN) });
    const cooldown = await retrySyncNow(userId, "travel");
    expect(cooldown).toMatchObject({ queued: false, refused: "cooldown" });
    expect(cooldown.retryAfterSeconds).toBeGreaterThan(0);

    // No credential → refused.
    const bare = await db.user.create({ data: { displayName: `op-retry-bare-${randomUUID().slice(0, 8)}` } });
    cleanupIds.push(bare.id);
    expect(await retrySyncNow(bare.id, "money_logs")).toMatchObject({ queued: false, refused: "no_key" });
  });
});
