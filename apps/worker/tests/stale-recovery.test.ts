import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { claimResource, completeResource, progressResource, RUNNING_STALE_AFTER_MS, getPrismaClient } from "@tornscope/database";

/**
 * Stale-run recovery regression tests (v0.1.3 fix).
 *
 * Contract: staleness is judged ONLY by the run liveness heartbeat
 * (`lastHeartbeatAt`), never by the generic `updatedAt` column. The
 * scheduler advances `nextRunAt` after enqueueing a recovery job, which
 * auto-touches `updatedAt`; with the old logic that touch reset the
 * staleness window before the job could claim, so a run killed by a worker
 * crash stayed "running" forever and the resource never synced again.
 *
 * Overlap protection must survive: a FRESH running resource (heartbeat
 * within the stale window) must still be rejected.
 *
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const userIds: string[] = [];

async function makeState(overrides: {
  status?: string;
  lastStartedAt?: Date | null;
  lastHeartbeatAt?: Date | null;
  updatedAt?: Date;
}) {
  const userId = `stale-rec-${randomUUID()}`;
  userIds.push(userId);
  await db.user.create({ data: { id: userId, displayName: "stale-recovery-test" } });
  const now = new Date();
  const state = await db.syncState.create({
    data: {
      userId,
      resource: "money_logs",
      status: overrides.status ?? "running",
      lastStartedAt: overrides.lastStartedAt ?? new Date(now.getTime() - 20 * 60_000),
      lastHeartbeatAt: overrides.lastHeartbeatAt ?? new Date(now.getTime() - 20 * 60_000),
      lastAttemptAt: new Date(now.getTime() - 20 * 60_000),
      // The bug scenario: bookkeeping kept refreshing updatedAt, so the old
      // updatedAt-based staleness check could never see the run as dead.
      updatedAt: overrides.updatedAt ?? now,
    },
  });
  return { userId, state };
}

afterAll(async () => {
  for (const userId of userIds) {
    await db.syncState.deleteMany({ where: { userId } }).catch(() => undefined);
    await db.syncRun.deleteMany({ where: { userId } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }
  await db.$disconnect();
});

suite("stale running recovery", () => {
  it("recovers a stale running resource even when bookkeeping refreshed updatedAt", async () => {
    const { userId } = await makeState({});
    // updatedAt is "now" (scheduler touch); lastHeartbeatAt is 20 min old.
    const claim = await claimResource(db, userId, "money_logs");
    expect(claim.claimed).toBe(true);
    expect(claim.state?.status).toBe("running");
    expect(claim.state?.lastHeartbeatAt?.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("still rejects a fresh running resource (overlap protection)", async () => {
    const { userId } = await makeState({
      lastStartedAt: new Date(),
      lastHeartbeatAt: new Date(Date.now() - 60_000),
    });
    const claim = await claimResource(db, userId, "money_logs");
    expect(claim.claimed).toBe(false);
    expect(claim.state?.status).toBe("running");
    expect(claim.state?.errorMessage).toBeNull();
  });

  it("rejects within the stale window even when updatedAt is old but heartbeat is fresh", async () => {
    const { userId } = await makeState({
      lastStartedAt: new Date(),
      lastHeartbeatAt: new Date(),
      updatedAt: new Date(Date.now() - RUNNING_STALE_AFTER_MS - 60_000),
    });
    const claim = await claimResource(db, userId, "money_logs");
    expect(claim.claimed).toBe(false);
  });

  it("successful recovery run returns the state to idle with a fresh success timestamp", async () => {
    const { userId } = await makeState({});
    const claim = await claimResource(db, userId, "money_logs");
    expect(claim.claimed).toBe(true);

    await progressResource(db, userId, "money_logs", 5);
    const afterProgress = await db.syncState.findUnique({ where: { userId_resource: { userId, resource: "money_logs" } } });
    expect(afterProgress?.recordsCollected).toBe(5);
    expect(afterProgress?.lastHeartbeatAt).not.toBeNull();

    const before = new Date();
    await completeResource(db, userId, "money_logs", {
      success: true,
      nextRunAt: new Date(Date.now() + 600_000),
    });
    const state = await db.syncState.findUnique({ where: { userId_resource: { userId, resource: "money_logs" } } });
    expect(state?.status).toBe("idle");
    expect(state?.errorMessage).toBeNull();
    expect(state?.lastSuccessAt?.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000);
  });
});
