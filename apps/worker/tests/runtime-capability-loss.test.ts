import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { TornApiError } from "@tornscope/torn-api";
import { getPrismaClient } from "@tornscope/database";

/**
 * Runtime capability-loss behavior (v0.2 Phase 10):
 *
 * A Torn API error code 16 (access level too low) raised DURING a sync means
 * the stored capability blob is stale — the key lost the permission. The
 * runner must record capability_denied (NOT failed), keep every previously
 * collected row and park the resource at the shared re-check interval, so
 * data confidence reads stale_permission instead of a generic sync error.
 */

const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

// The runner is exercised with a fake worker context and a handler that
// throws the runtime denial — no Torn API traffic, no Redis.
const fakeCtx = {
  db: getPrismaClient(),
  rateLimiter: {},
  initialHistoryDays: 180,
  decryptCredential: () => "test-api-key",
  createTorn: () => ({
    endpoints: {} as never,
    metrics: { requests: 1, denied: 1, timeouts: 0, retries: 0 },
  }),
};

vi.mock("../src/context.js", () => ({ getWorkerContext: () => fakeCtx }));
vi.mock("../src/sync/handlers.js", () => ({
  SYNC_HANDLERS: {
    // Snapshot resource: a single failing call, no category walkers involved.
    networth: vi.fn().mockRejectedValue(new TornApiError("Access level too low", { kind: "access_denied", tornCode: 16 })),
  },
}));

const { runResourceSync } = await import("../src/sync/runner.js");

const db = getPrismaClient();
const cleanupIds: string[] = [];

const FULL_CAPS = {
  canReadUserBasic: true, canReadUserBars: true, canReadUserCooldowns: true, canReadUserEducation: true,
  canReadUserTravel: true, canReadUserMoney: true, canReadUserLogs: true, canReadUserAttacks: true,
  canReadUserNetworth: true, canReadUserEvents: true, canReadUserPersonalStats: true,
  canReadFactionBasic: false, canReadFactionMembers: false, canReadFactionRankedWars: false,
  canReadFactionChains: false, canReadFactionCrimes: false, canReadFactionArmoryNews: false,
  canReadFactionBalance: false, canReadFactionLogs: false,
};

beforeAll(async () => {
  process.env.API_KEY_ENCRYPTION_KEY = process.env.API_KEY_ENCRYPTION_KEY ?? "a".repeat(64);
});

afterAll(async () => {
  for (const id of cleanupIds.splice(0)) {
    await db.syncRun.deleteMany({ where: { userId: id } });
    await db.syncState.deleteMany({ where: { userId: id } });
    await db.apiCredential.deleteMany({ where: { userId: id } });
    await db.user.delete({ where: { id } }).catch(() => undefined);
  }
});

suite("runtime capability denial during sync", () => {
  it("marks capability_denied (not failed), retains data and history rows", async () => {
    const user = await db.user.create({ data: { displayName: `RUNTIME-DENY-${Date.now()}`, role: "user" } });
    cleanupIds.push(user.id);
    await db.apiCredential.create({
      data: {
        userId: user.id,
        encryptedKey: randomBytes(16).toString("hex"),
        iv: randomBytes(8).toString("hex"),
        authTag: randomBytes(8).toString("hex"),
        keyPreview: "TEST",
        logAccessAvailable: true,
        accessLevel: 4,
        capabilities: FULL_CAPS,
        validatedAt: new Date(),
      },
    });
    const seededCursor = BigInt(Math.floor(Date.now() / 1000) - 3600);
    // Pre-existing history + a previously clean walk: the key HAD access before.
    await db.syncState.upsert({
      where: { userId_resource: { userId: user.id, resource: "networth" } },
      create: {
        userId: user.id,
        resource: "networth",
        status: "idle",
        lastSuccessAt: new Date(Date.now() - 3600_000),
        recordsCollected: 4200,
        stopReason: "source_exhausted",
        lastTimestamp: seededCursor,
        __seeded: undefined as never,
      },
      update: {},
    });

    const outcome = await runResourceSync(user.id, "networth");

    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toBe(true);

    const state = await db.syncState.findUnique({ where: { userId_resource: { userId: user.id, resource: "networth" } } });
    // Permission state, not a generic failure.
    expect(state?.status).toBe("capability_denied");
    // Previously collected data is fully retained.
    expect(state?.recordsCollected).toBe(4200);
    expect(state?.lastTimestamp).toBe(seededCursor);
    // Parked at the capability re-check interval, not hot-retrying.
    const recheckHours = (state!.nextRunAt!.getTime() - Date.now()) / 3600_000;
    expect(recheckHours).toBeGreaterThan(5);
    expect(recheckHours).toBeLessThanOrEqual(6);

    const runs = await db.syncRun.findMany({ where: { userId: user.id, resource: "networth" } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("skipped");
  });
});
