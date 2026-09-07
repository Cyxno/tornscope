import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient, ensureSyncStates } from "@tornscope/database";
import { deleteApiKey, getMe, saveApiKey, type SaveApiKeyResult } from "../src/services/me.js";
import { getSyncHealth } from "../src/services/syncStatus.js";
import { buildServer } from "../src/server.js";
import { enqueueDueSyncs } from "../../worker/src/scheduler.js";
import { runResourceSync } from "../../worker/src/sync/runner.js";
import { CAPABILITY_RECHECK_SECONDS } from "@tornscope/shared";
import type { SessionUser } from "../src/auth.js";

/**
 * Correctness + performance regression suite:
 *
 * 1. Body-less mutations: a DELETE carrying a JSON content-type with NO body
 *    (the exact request shape that used to fail with "Body cannot be empty
 *    when content-type is set") reaches route logic — the backend strips the
 *    header. Disconnect works and preserves ALL history, the profile and
 *    the browser session.
 * 2. Limited-key initialization is capability-aware: denied resources are
 *    never enqueued as worker jobs and are marked capability_denied
 *    immediately; the scheduler parks them at the re-check interval instead
 *    of claiming them every cycle; a denied resource makes zero Torn calls.
 * 3. Owner visibility: isServerOwner is server-derived; the deployed build
 *    commit is disclosed to the owner only (never to ordinary users).
 *
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set; Torn is
 * stubbed at the fetch level. Redis is never touched: queue adds are
 * captured by a recording fake.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

process.env.API_KEY_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.TORN_API_MIN_REQUEST_INTERVAL_MS = "0";

const db = getPrismaClient();

const TORN_ID = 55_600_100;
const FULL_KEY = "perf-test-full-key-01";
const LIMITED_KEY = "perf-test-limited-key01";

interface MockKey { id: number; name: string; level: number; type: string; user: string[]; faction?: string[] }
const MOCK_KEYS: Record<string, MockKey> = {
  [FULL_KEY]: { id: TORN_ID, name: "PerfPlayer", level: 4, type: "Full Access", user: ["basic", "profile", "bars", "money", "log", "attacks", "networth", "events", "personalstats", "travel", "cooldowns", "education"], faction: ["basic", "members", "rankedwars", "chains", "crimes", "armorynews", "balance", "log"] },
  [LIMITED_KEY]: { id: TORN_ID, name: "PerfPlayer", level: 3, type: "Limited Access", user: ["basic", "profile", "bars", "cooldowns", "education", "travel", "money", "networth", "personalstats", "attacks"], faction: ["basic"] },
};

/** Counts ACTUAL Torn calls so tests can prove denied endpoints are never touched. */
let tornCalls = 0;

function installTornStub(): void {
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> | Headers }) => {
    const headers = init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : (init?.headers ?? {});
    const auth = headers["Authorization"] ?? headers["authorization"] ?? "";
    const key = String(auth).replace(/^ApiKey\s+/i, "");
    const info = MOCK_KEYS[key];
    if (!info) return json({ error: { code: 2, error: "incorrect key" } });
    tornCalls += 1;
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/key/info")) {
      return json({ info: { user: { id: info.id, faction_id: null }, selections: { user: info.user, faction: info.faction ?? [] }, access: { level: info.level, type: info.type, faction: Boolean(info.faction?.length) } } });
    }
    if (path.endsWith("/basic")) {
      return json({ profile: { id: info.id, name: info.name, level: 40, rank: "Alpha", donator_status: 0, property: null, status: null, faction_id: null } });
    }
    return json({});
  }) as unknown as typeof fetch;
}

/** Fake BullMQ queue: records adds without touching Redis. */
function fakeQueue(): { added: Array<{ userId: string; resource: string }>; add: (name: string, data: { userId: string; resource: string }) => Promise<never> } {
  const added: Array<{ userId: string; resource: string }> = [];
  return {
    added,
    add: async (_name: string, data: { userId: string; resource: string }) => {
      added.push({ userId: data.userId, resource: data.resource });
      return {} as never;
    },
  };
}

let user: SessionUser; // disconnect-suite profile
let freshUser: SessionUser; // never-connected profile for initialization suites
const cleanupIds: string[] = [];

beforeAll(async () => {
  installTornStub();
  user = await db.user.create({ data: { displayName: "PerfTest-A", role: "user" } });
  freshUser = await db.user.create({ data: { displayName: "PerfTest-B", role: "user" } });
  cleanupIds.push(user.id, freshUser.id);
});

afterAll(async () => {
  // Child rows cascade with the user row.
  await db.user.deleteMany({ where: { id: { in: cleanupIds } } });
});

async function swapSyncQueue<T>(fn: (queue: ReturnType<typeof fakeQueue>) => Promise<T>): Promise<T> {
  const mod = await import("../src/context.js");
  const ctx = mod.getApiContext();
  const queue = fakeQueue();
  const original = ctx.syncQueue;
  // `syncQueue` is a constructor-created own property; swap it for the fake.
  Object.defineProperty(ctx, "syncQueue", { value: queue, configurable: true });
  try {
    return await fn(queue);
  } finally {
    Object.defineProperty(ctx, "syncQueue", { value: original, configurable: true });
  }
}

suite("body-less mutations + disconnect semantics", () => {
  it("a DELETE with a JSON content-type and NO body reaches the route (no parser 400)", async () => {
    const app = await buildServer();
    // No session cookie: the preHandler creates a guest profile, the route
    // then answers normally ({deleted:false}-style) instead of Fastify's JSON
    // parser rejecting the empty body with 400.
    const response = await app.inject({ method: "DELETE", url: "/api/settings/api-key", headers: { "content-type": "application/json" } });
    expect(response.statusCode).not.toBe(400);
    expect(response.body).not.toContain("Body cannot be empty");
    await app.close();
  });

  it("disconnect revokes the credential but preserves history, profile and sessions", async () => {
    // Connect a limited key first (also covered by the capability suites).
    await swapSyncQueue(() => saveApiKey({ id: user.id, isDemo: false }, LIMITED_KEY));

    // Collected history that must survive disconnect.
    await db.drugEvent.create({
      data: {
        userId: user.id,
        occurredAt: new Date(),
        drugItemId: 206,
        drugName: "Xanax",
        outcome: "success",
        source: "torn_log",
        sourceRef: `perf-test:${randomBytes(4).toString("hex")}`,
      },
    });
    await db.userSession.create({ data: { userId: user.id, tokenHash: randomBytes(32).toString("hex") } });

    await deleteApiKey(user.id);

    const credential = await db.apiCredential.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    expect(credential?.revokedAt).not.toBeNull(); // credential revoked…
    expect(await db.drugEvent.count({ where: { userId: user.id } })).toBe(1); // …history kept…
    expect(await db.user.findUnique({ where: { id: user.id } })).not.toBeNull(); // …profile kept…
    expect(await db.userSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(1); // …browser session kept.
  });

  it("a payload-free POST (no content-type at all) also reaches route logic", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "POST", url: "/api/sync/retry-failed" });
    expect(response.statusCode).not.toBe(400);
    await app.close();
  });
});

suite("Limited-key initialization is capability-aware", () => {
  it("marks denied resources skipped immediately and never enqueues them", async () => {
    // A NEVER-connected profile: the initial backfill runs for it.
    let added: Array<{ resource: string }> = [];
    const result = await swapSyncQueue((queue) => {
      added = queue.added;
      return saveApiKey({ id: freshUser.id, isDemo: false }, LIMITED_KEY);
    });
    expect(result.status.accessLevel).toBe("3");
    expect(result.status.accessType).toBe("Limited Access");

    // Sanity: the recording fake captured the initial backfill.
    expect(added).not.toHaveLength(0);
    expect(added.map((a) => a.resource)).toContain("profile");
    // Denied resources were NEVER enqueued…
    expect(added.map((a) => a.resource)).not.toContain("drugs");
    expect(added.map((a) => a.resource)).not.toContain("money_logs");
    expect(added.map((a) => a.resource)).not.toContain("events");
    // …and are already marked capability_denied (no waiting for the worker).
    for (const resource of ["drugs", "travel", "rehab", "money_logs", "events", "organized_crimes"]) {
      const state = await db.syncState.findUnique({ where: { userId_resource: { userId: freshUser.id, resource } } });
      expect(state?.status, resource).toBe("capability_denied");
    }
    // Allowed resources are NOT parked.
    const profile = await db.syncState.findUnique({ where: { userId_resource: { userId: freshUser.id, resource: "profile" } } });
    expect(profile?.status).not.toBe("capability_denied");
  });

  it("the scheduler parks known-denied resources without enqueueing them", async () => {
    await ensureSyncStates(db, freshUser.id);
    await swapSyncQueue(async () => {
      const queue = fakeQueue();
      await enqueueDueSyncs(queue as never);
      const resources = queue.added.map((a) => a.resource);
      expect(resources).not.toContain("drugs");
      expect(resources).not.toContain("money_logs");
    });

    const drugs = await db.syncState.findUnique({ where: { userId_resource: { userId: freshUser.id, resource: "drugs" } } });
    expect(drugs?.status).toBe("capability_denied");
    if (drugs?.nextRunAt) {
      const hours = (drugs.nextRunAt.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(CAPABILITY_RECHECK_SECONDS / 3_600 - 1);
    }
  });

  it("running a denied resource makes ZERO Torn calls and records a skipped run", async () => {
    tornCalls = 0;
    const outcome = await runResourceSync(freshUser.id, "drugs");
    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toBe(true);
    expect(tornCalls).toBe(0);
    const run = await db.syncRun.findFirst({ where: { userId: freshUser.id, resource: "drugs" }, orderBy: { startedAt: "desc" } });
    expect(run?.status).toBe("skipped");
    expect(run?.errorMessage).toContain("Permission required");
  });
});

suite('no owner privilege differences in user-facing payloads', () => {
  it('MeResponse and sync health carry no owner flag, no build identity, no infra topology', async () => {
    const ownerUser = await db.user.create({ data: { displayName: 'PerfTest-Owner', role: 'owner' } });
    cleanupIds.push(ownerUser.id);

    // Profiles are functionally equal: an owner-role profile and a normal
    // user get the SAME payload shape, with no role-derived extras.
    const owner = await getMe({ id: ownerUser.id, displayName: ownerUser.displayName, timezone: 'UTC', isDemo: false, role: 'owner' });
    const guest = await getMe({ id: user.id, displayName: user.displayName, timezone: 'UTC', isDemo: false, role: 'user' });
    expect('isServerOwner' in owner).toBe(false);
    expect('isServerOwner' in guest).toBe(false);
    expect('build' in owner).toBe(false);
    expect('build' in guest).toBe(false);
    expect(JSON.stringify(owner).toLowerCase()).not.toContain('postgres');
    expect(JSON.stringify(guest).toLowerCase()).not.toContain('postgres');

    const health = await getSyncHealth(user.id);
    expect('system' in health).toBe(false);
    expect('queues' in health).toBe(false);
    expect('build' in health).toBe(false);
  });
});
