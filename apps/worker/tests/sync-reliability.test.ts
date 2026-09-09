import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import { claimResource, completeResource, progressResource, ensureSyncStates, getSyncStates, setSetting, getPrismaClient, RUNNING_STALE_AFTER_MS } from "@tornscope/database";
import { enqueueDueSyncs } from "../src/scheduler.js";
import type { SyncJobData } from "../src/queues.js";

/**
 * Sync reliability & recovery (v0.2 roadmap item #3) — DB-backed.
 *
 * Covers: orphan recovery writes a machine-readable reason + a "recovered"
 * incident row in the EXISTING SyncRun history, the heartbeat is time-based
 * (zero-record progress still counts as alive), error reason codes persist
 * through completeResource and clear on success, cursors survive recovery,
 * and one broken resource never blocks unrelated resources in the scheduler.
 *
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const userIds: string[] = [];

async function makeUser(): Promise<string> {
  const userId = `sync-rel-${randomUUID()}`;
  userIds.push(userId);
  await db.user.create({ data: { id: userId, displayName: "sync-reliability-test" } });
  // No capabilities blob → the scheduler's capability gate is skipped and
  // every due resource is enqueued (gate behavior is covered elsewhere).
  await db.apiCredential.create({
    data: {
      userId,
      encryptedKey: "00",
      iv: "00",
      authTag: "00",
      keyPreview: "TEST",
      accessLevel: 3,
      accessType: "Limited",
      logAccessAvailable: false,
      validatedAt: new Date(),
    },
  });
  // Pre-bootstrap the way the scheduler would on a user's first tick, then
  // push every resource's next run an hour out so tests opt resources IN to
  // a tick explicitly (the real first tick enqueues all 15 resources).
  await ensureSyncStates(db, userId);
  await setSetting(db, "scheduler_bootstrap_done", true, userId);
  await db.syncState.updateMany({
    where: { userId },
    data: { nextRunAt: new Date(Date.now() + 3600_000), lastAttemptAt: new Date() },
  });
  return userId;
}

function stubQueue(onAdd: (userId: string, resource: string) => void | Promise<void>): Queue<SyncJobData> {
  return {
    add: async (_name: string, data: SyncJobData) => {
      await onAdd(data.userId, data.resource);
      return {} as never;
    },
  } as unknown as Queue<SyncJobData>;
}

/** The scheduler iterates EVERY user in the database — only assert on ours. */
const added: Array<{ userId: string; resource: string }> = [];
function addedFor(userId: string): string[] {
  return added.filter((a) => a.userId === userId).map((a) => a.resource);
}

async function setState(userId: string, resource: string, data: Record<string, unknown> = {}): Promise<void> {
  await db.syncState.upsert({
    where: { userId_resource: { userId, resource } },
    create: { userId, resource, ...data },
    update: data,
  });
}

afterAll(async () => {
  for (const userId of userIds) {
    await db.syncState.deleteMany({ where: { userId } }).catch(() => undefined);
    await db.syncRun.deleteMany({ where: { userId } }).catch(() => undefined);
    await db.apiCredential.deleteMany({ where: { userId } }).catch(() => undefined);
    await db.appSetting.deleteMany({ where: { userId } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }
  await db.$disconnect();
});

suite("sync reliability & recovery", () => {
  it("claiming a stale run records worker_interrupted as the machine reason", async () => {
    const userId = await makeUser();
    await setState(userId, "money_logs", {
      status: "running",
      lastStartedAt: new Date(Date.now() - 20 * 60_000),
      lastHeartbeatAt: new Date(Date.now() - 20 * 60_000),
      lastAttemptAt: new Date(Date.now() - 20 * 60_000),
    });
    const claim = await claimResource(db, userId, "money_logs");
    expect(claim.claimed).toBe(true);
    const state = await db.syncState.findUnique({ where: { userId_resource: { userId, resource: "money_logs" } } });
    expect(state?.lastErrorKind).toBe("worker_interrupted");
  });

  it("zero-record progress still refreshes the heartbeat (time-based liveness)", async () => {
    const userId = await makeUser();
    await setState(userId, "drugs", {
      status: "running",
      lastStartedAt: new Date(Date.now() - 10 * 60_000),
      lastHeartbeatAt: new Date(Date.now() - 10 * 60_000),
      lastAttemptAt: new Date(Date.now() - 10 * 60_000),
    });
    await progressResource(db, userId, "drugs", 0);
    const state = await db.syncState.findUnique({ where: { userId_resource: { userId, resource: "drugs" } } });
    expect(state?.lastHeartbeatAt?.getTime()).toBeGreaterThan(Date.now() - 30_000);
    expect(state?.recordsCollected).toBe(0);
  });

  it("failure reason codes persist and clear on success; cursor survives recovery", async () => {
    const userId = await makeUser();
    await setState(userId, "travel", {
      status: "running",
      cursor: "1700000000",
      lastStartedAt: new Date(Date.now() - 20 * 60_000),
      lastHeartbeatAt: new Date(Date.now() - 20 * 60_000),
      lastAttemptAt: new Date(Date.now() - 20 * 60_000),
    });
    // Recovery claim keeps the cursor intact (never reset automatically).
    const claim = await claimResource(db, userId, "travel");
    expect(claim.claimed).toBe(true);

    await completeResource(db, userId, "travel", { success: false, errorMessage: "torn api error", errorKind: "timeout" });
    let state = await db.syncState.findUnique({ where: { userId_resource: { userId, resource: "travel" } } });
    expect(state?.status).toBe("failed");
    expect(state?.lastErrorKind).toBe("timeout");
    expect(state?.errorCount).toBe(1);
    expect(state?.cursor).toBe("1700000000");

    await completeResource(db, userId, "travel", { success: true });
    state = await db.syncState.findUnique({ where: { userId_resource: { userId, resource: "travel" } } });
    expect(state?.status).toBe("idle");
    expect(state?.lastErrorKind).toBeNull();
    expect(state?.errorCount).toBe(0);
    expect(state?.cursor).toBe("1700000000");
  });

  it("scheduler orphan recovery re-enqueues and writes a recovered incident row", async () => {
    const userId = await makeUser();
    await setState(userId, "money_logs", {
      status: "running",
      nextRunAt: new Date(Date.now() + 5 * 60_000),
      lastStartedAt: new Date(Date.now() - 20 * 60_000),
      lastHeartbeatAt: new Date(Date.now() - RUNNING_STALE_AFTER_MS - 60_000),
      lastAttemptAt: new Date(Date.now() - 20 * 60_000),
    });
    await enqueueDueSyncs(stubQueue((uid, resource) => void added.push({ userId: uid, resource })));

    expect(addedFor(userId)).toEqual(["money_logs"]);
    const run = await db.syncRun.findFirst({ where: { userId, resource: "money_logs", status: "recovered" } });
    expect(run).not.toBeNull();
    const stats = run?.stats as { reason?: string } | null;
    expect(stats?.reason).toBe("worker_interrupted");
    const state = await db.syncState.findUnique({ where: { userId_resource: { userId, resource: "money_logs" } } });
    expect(state?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("one broken resource does not block unrelated resources in the same tick", async () => {
    const userId = await makeUser();
    const due = { status: "idle", nextRunAt: new Date(Date.now() - 60_000), lastAttemptAt: new Date() };
    await setState(userId, "money_logs", { ...due });
    await setState(userId, "drugs", { ...due });
    await setState(userId, "travel", { ...due });

    const queue = stubQueue((uid, resource) => {
      if (uid === userId && resource === "money_logs") throw new Error("redis unavailable");
      added.push({ userId: uid, resource });
    });
    await enqueueDueSyncs(queue);
    expect(addedFor(userId)).toEqual(["drugs", "travel"]);
  });

  it("a due resource is enqueued exactly once per tick (no duplicate jobs)", async () => {
    const userId = await makeUser();
    await setState(userId, "networth", { status: "idle", nextRunAt: new Date(Date.now() - 60_000), lastAttemptAt: new Date() });
    await enqueueDueSyncs(stubQueue((uid, resource) => void added.push({ userId: uid, resource })));
    expect(addedFor(userId)).toEqual(["networth"]);
  });
});
