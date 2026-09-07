import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { getMe, saveApiKey, validateApiKey } from "../src/services/me.js";
import { getSyncHealth } from "../src/services/syncStatus.js";
import { bindLegacyOwner, ownerBindAvailableFor } from "../src/auth.js";
import { getDrugsSummary } from "../src/services/drugs.js";
import type { SessionUser } from "../src/auth.js";

/**
 * Privacy + rehab-semantics regression suite:
 *
 * 1. Owner-only infrastructure visibility: guest / normal-user / demo
 *    payloads (JSON API AND anything hydrated from them) contain NO
 *    infrastructure strings and no build SHA; only the server-owner's
 *    payload does.
 * 2. Owner-bind security: the bind/recovery token NEVER reaches the browser
 *    (only a boolean), the recovery UI hides once the owner is bound, and
 *    recovery re-binding requires the explicit OWNER_BIND_ENABLED=true
 *    opt-in — a leaked recovery token alone is dead on a production server.
 * 3. Key validation must NOT store anything: only the explicit continue
 *    (saveApiKey) does.
 * 4. Rehab visits/sessions: the API serves Torn's explicit rehab_times as
 *    sessions with visits = log rows — never 1 row = 1 session.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

process.env.API_KEY_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.TORN_API_MIN_REQUEST_INTERVAL_MS = "0";

const db = getPrismaClient();

const TORN_ID = 55_600_200;
const FULL_KEY = "privacy-test-full-key1";

function installTornStub(): void {
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (url: string | URL, init?: { headers?: Record<string, string> | Headers }) => {
    const headers = init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : (init?.headers ?? {});
    const auth = headers["Authorization"] ?? headers["authorization"] ?? "";
    const key = String(auth).replace(/^ApiKey\s+/i, "");
    if (key !== FULL_KEY) return json({ error: { code: 2, error: "incorrect key" } });
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/key/info")) {
      return json({
        info: {
          user: { id: TORN_ID, faction_id: null },
          selections: { user: ["basic", "profile", "bars", "log", "money"], faction: [] },
          access: { level: 4, type: "Full Access", faction: false },
        },
      });
    }
    if (path.endsWith("/basic")) {
      return json({ profile: { id: TORN_ID, name: "PrivacyPlayer", level: 40, rank: "Alpha", donator_status: 0, property: null, status: null, faction_id: null } });
    }
    return json({});
  }) as unknown as typeof fetch;
}

let user: SessionUser;
const cleanupIds: string[] = [];

beforeAll(async () => {
  installTornStub();
  user = await db.user.create({ data: { displayName: "Privacy-A", role: "user" } });
  cleanupIds.push(user.id);
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: cleanupIds } } });
  delete process.env.OWNER_BIND_TOKEN_TEST;
});

suite("infrastructure privacy in API payloads", () => {
  it("guest / normal-user / demo payloads carry no infra strings and no build SHA", async () => {
    const ownerUser = await db.user.create({ data: { displayName: "Privacy-Owner", role: "owner" } });
    cleanupIds.push(ownerUser.id);

    const guest = await getMe({ id: user.id, displayName: user.displayName, timezone: "UTC", isDemo: false, role: "user" });
    const demoViewer = await getMe({ id: ownerUser.id, displayName: "x", timezone: "UTC", isDemo: true, role: "owner" });
    const owner = await getMe({ id: ownerUser.id, displayName: "x", timezone: "UTC", isDemo: false, role: "owner" });

    for (const [label, payload] of [["guest", guest], ["demo", demoViewer]] as const) {
      const text = JSON.stringify(payload);
      expect(label + ":unraid", text).not.toContain("Unraid");
      expect(text.toLowerCase()).not.toContain("postgres");
      expect(text.toLowerCase()).not.toContain("docker");
      expect(payload.build.commit).toBeNull();
      expect(payload.isServerOwner).toBe(false);
    }
    expect(owner.isServerOwner).toBe(true);
    expect(owner.build.commit).not.toBeNull();

    // Sync health: system/queues topology is null for non-owners.
    const guestHealth = await getSyncHealth(user.id, { isOwner: false });
    const healthText = JSON.stringify(guestHealth);
    expect(healthText.toLowerCase()).not.toContain("postgres");
    expect(healthText.toLowerCase()).not.toContain("redis down");
    expect(guestHealth.system).toBeNull();
    expect(guestHealth.queues).toBeNull();
    expect(guestHealth.build.commit).toBeNull();
  });
});

suite("owner-bind token security", () => {
  it("the recovery UI hides once the owner is bound (no explicit opt-in), and recovery re-binding refuses without the flag", async () => {
    // The bind logic targets THE OLDEST owner row — use it, whatever created it.
    let owner = await db.user.findFirst({ where: { role: "owner", isDemo: false }, orderBy: { createdAt: "asc" } });
    if (!owner) {
      owner = await db.user.create({ data: { id: "test-privacy-owner", displayName: "PrivacyBindOwner", role: "owner" } });
      cleanupIds.push(owner.id);
    }
    const hadBound = await db.appSetting.findUnique({ where: { userId_key: { userId: owner.id, key: "owner_bound" } } });
    if (!hadBound) {
      await db.appSetting.create({ data: { userId: owner.id, key: "owner_bound", value: true } });
    }

    const previousEnabled = process.env.OWNER_BIND_ENABLED;
    process.env.OWNER_BIND_TOKEN = "bind-secret-test";
    process.env.OWNER_RECOVERY_TOKEN = "recovery-secret-test";
    delete process.env.OWNER_BIND_ENABLED; // production default: recovery OFF

    try {
      // Hidden for ordinary users while disabled (and for the owner always).
      expect(await ownerBindAvailableFor(user.id)).toBe(false);
      expect(await ownerBindAvailableFor(owner.id)).toBe(false);

      // And the endpoint refuses re-binding even with the CORRECT token.
      const req = { headers: { cookie: "" } };
      const reply = { header() {}, headers: {} as Record<string, string> };
      let threw: unknown = null;
      try {
        await bindLegacyOwner(req as never, reply as never, "recovery-secret-test");
      } catch (err) {
        threw = err;
      }
      expect((threw as { code?: string })?.code).toBe("bind_disabled");

      // With the explicit opt-in, recovery becomes available again.
      process.env.OWNER_BIND_ENABLED = "true";
      expect(await ownerBindAvailableFor(user.id)).toBe(true);
    } finally {
      if (previousEnabled === undefined) delete process.env.OWNER_BIND_ENABLED;
      else process.env.OWNER_BIND_ENABLED = previousEnabled;
      delete process.env.OWNER_BIND_TOKEN;
      delete process.env.OWNER_RECOVERY_TOKEN;
      // Restore the owner row's prior state.
      if (!hadBound) {
        await db.appSetting.deleteMany({ where: { userId: owner.id, key: "owner_bound" } }).catch(() => undefined);
      }
    }
  });
});

suite("validation must not store the key", () => {
  it("validateApiKey stores nothing; only saveApiKey (explicit continue) does", async () => {
    await validateApiKey({ id: user.id, isDemo: false }, FULL_KEY);
    expect(await db.apiCredential.count({ where: { userId: user.id } })).toBe(0);

    await saveApiKey({ id: user.id, isDemo: false }, FULL_KEY);
    expect(await db.apiCredential.count({ where: { userId: user.id } })).toBe(1);
  });
});

suite("rehab visits vs sessions through the API", () => {
  it("visits = log rows; sessions sum the explicit rehab_times (never 1 row = 1 session)", async () => {
    const base = Date.now() / 1000 - 3600;
    for (const [i, sessions] of [3, 4, 2].entries()) {
      await db.rehabEvent.create({
        data: {
          userId: user.id,
          occurredAt: new Date((base - i * 600) * 1000),
          cost: BigInt(500_000 * sessions),
          sessions,
          source: "torn_log",
          sourceRef: `rehab-test:${i}:${randomBytes(3).toString("hex")}`,
          raw: { data: { cost: 500_000 * sessions, rehab_times: sessions } },
        },
      });
    }
    const drugs = await getDrugsSummary(user.id, { preset: "30d" }, null);
    expect(drugs.rehab.visits).toBe(3);
    expect(drugs.rehab.sessions).toBe(9);
    expect(drugs.rehab.averageSessionsPerVisit).toBe(3);
    expect(drugs.rehab.averageCostPerSession.value).toBe(500_000);
    expect(drugs.rehab.visitTrend).toHaveLength(3);
  });
});
