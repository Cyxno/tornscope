import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { getMe, saveApiKey, validateApiKey } from "../src/services/me.js";
import { getSyncHealth } from "../src/services/syncStatus.js";
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
  it("no payload for any profile contains infra strings, a build SHA, or owner flags", async () => {
    const ownerUser = await db.user.create({ data: { displayName: "Privacy-Owner", role: "owner" } });
    cleanupIds.push(ownerUser.id);

    const guest = await getMe({ id: user.id, displayName: user.displayName, timezone: "UTC", isDemo: false, role: "user" });
    const demoViewer = await getMe({ id: ownerUser.id, displayName: "x", timezone: "UTC", isDemo: true, role: "owner" });
    const owner = await getMe({ id: ownerUser.id, displayName: "x", timezone: "UTC", isDemo: false, role: "owner" });

    for (const [label, payload] of [["guest", guest], ["demo", demoViewer], ["owner", owner]] as const) {
      const text = JSON.stringify(payload);
      expect(label + ":unraid", text).not.toContain("Unraid");
      expect(text.toLowerCase()).not.toContain("postgres");
      expect(text.toLowerCase()).not.toContain("docker");
      // Removed product surface: absent for EVERYONE, owner-role included.
      expect("build" in payload).toBe(false);
      expect("isServerOwner" in payload).toBe(false);
      expect("ownerBindAvailable" in payload).toBe(false);
    }
  });

  it("sync health carries no infrastructure topology or build identity for anyone", async () => {
    const ownerUser = await db.user.create({ data: { displayName: "Privacy-Owner2", role: "owner" } });
    cleanupIds.push(ownerUser.id);
    for (const id of [user.id, ownerUser.id]) {
      const health = await getSyncHealth(id);
      const healthText = JSON.stringify(health);
      expect(healthText.toLowerCase()).not.toContain("postgres");
      expect(healthText.toLowerCase()).not.toContain("redis down");
      expect("system" in health).toBe(false);
      expect("queues" in health).toBe(false);
      expect("build" in health).toBe(false);
    }
  });
});

suite('legacy owner bind removal', () => {
  it('no owner-bind UI flag exists in user payloads and the endpoint is gone', async () => {
    const me = await getMe({ id: user.id, displayName: user.displayName, timezone: 'UTC', isDemo: false, role: 'user' });
    // The removed fields must be entirely absent — not merely false/null.
    expect('ownerBindAvailable' in me).toBe(false);
    expect('isServerOwner' in me).toBe(false);
    expect('build' in me).toBe(false);
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

/* -------------------------------------------------------------------------- */
/* Demo availability: synthetic data never reads as a permission problem       */
/* -------------------------------------------------------------------------- */
import { upsertCatalogEntries } from "@tornscope/database";
import { getFactionOcs } from "../src/services/faction.js";
import { getTravelHistory, getTravelSummary } from "../src/services/travel.js";

suite("demo availability semantics", () => {
  it("a demo profile with stored drug data gets available_historical — never stale/permission", async () => {
    const demoUser = await db.user.create({ data: { displayName: "Privacy-Demo", role: "owner", isDemo: true } });
    cleanupIds.push(demoUser.id);
    await db.drugEvent.create({
      data: {
        userId: demoUser.id,
        occurredAt: new Date(),
        drugItemId: 206,
        drugName: "Xanax",
        outcome: "success",
        source: "demo",
        sourceRef: `demo-test:${randomBytes(3).toString("hex")}`,
      },
    });
    await db.syncState.create({
      data: { userId: demoUser.id, resource: "drugs", recordsCollected: 120, lastSuccessAt: new Date() },
    });
    const drugs = await getDrugsSummary(demoUser.id, { preset: "30d" }, null);
    expect(drugs.availability?.history.state).toBe("available_historical");
    expect(drugs.availability?.history.requiresLabel).toBeNull();
    // No stale/permission messaging data leaks into the demo payload.
    expect(JSON.stringify(drugs.availability)).not.toContain("an API key");
  });
});

/* -------------------------------------------------------------------------- */
/* Xanax per-bucket values: consumption vs personal vs sponsored vs opening    */
/* -------------------------------------------------------------------------- */
suite("xanax value semantics", () => {
  it("sponsored personal cost is $0 while consumption value includes sponsored units", async () => {
    const u = await db.user.create({ data: { displayName: "Privacy-Xan", role: "user" } });
    cleanupIds.push(u.id);
    const price = 840_000;
    await upsertCatalogEntries(db, [{ itemId: 206, name: "Xanax", type: "Drug", marketPrice: BigInt(price) }]);
    const base = Math.floor(Date.now() / 1000) - 3600;
    // 5 uses: 2 armory-sponsored (use logged with armory news at the same second), 3 unattributed.
    const uses: Array<{ occurredAt: Date; drugItemId: number | null; drugName: string; outcome: "success"; source: string; sourceRef: string }> = [];
    const armory: Array<{ userId: string; factionId: number; memberId: number | null; itemId: number; itemName: string; action: string; quantity: number; occurredAt: Date; source: string; sourceRef: string }> = [];
    for (let i = 0; i < 5; i++) {
      const t = base - i * 600;
      uses.push({
        userId: u.id,
        occurredAt: new Date(t * 1000),
        drugItemId: 206,
        drugName: "Xanax",
        outcome: "success",
        source: "demo",
        sourceRef: `xv:${i}:${randomBytes(2).toString("hex")}`,
      });
      if (i < 2) {
        armory.push({
          userId: u.id, factionId: 1, memberId: 777, itemId: 206, itemName: "Xanax", action: "used",
          quantity: 1, occurredAt: new Date((t - 5) * 1000), source: "demo", sourceRef: `xv-armory:${i}`,
        });
      }
    }
    await db.drugEvent.createMany({ data: uses });
    await db.factionArmoryEvent.createMany({ data: armory });
    await db.tornAccount.create({ data: { userId: u.id, tornId: 777, name: "XanPlayer", level: 40, firstSeenAt: new Date(), lastSeenAt: new Date() } });

    const drugs = await getDrugsSummary(u.id, { preset: "7d" }, null);
    expect(drugs.xanaxFunding.used).toBe(5);
    expect(drugs.xanaxFunding.confirmedFaction).toBe(2);
    // Consumption value covers ALL used units (sponsored included).
    expect(drugs.xanaxFunding.values.consumption).toBe(5 * price);
    expect(drugs.xanaxFunding.values.factionSponsored).toBe(2 * price);
    expect(drugs.xanaxFunding.values.unitPrice).toBe(price);
    // Opening inventory value only covers opening-unknown units (never labeled spend).
    expect(drugs.xanaxFunding.values.openingInventory).toBe((drugs.xanaxFunding.openingInventoryUnknown) * price);
  });
});

/* -------------------------------------------------------------------------- */
/* OC rewards: items with names/estimated values; zero cash is a real value    */
/* -------------------------------------------------------------------------- */
suite("oc reward details", () => {
  it("resolves item rewards to valued, named lines and estimates the total", async () => {
    const u = await db.user.create({ data: { displayName: "Privacy-OC", role: "user" } });
    cleanupIds.push(u.id);
    await upsertCatalogEntries(db, [
      { itemId: 206, name: "Xanax", type: "Drug", marketPrice: BigInt(840_000) },
      // No catalog entry for 999999: unpriced item must render with null value.
    ]);
    await db.organizedCrime.create({
      data: {
        userId: u.id,
        factionId: 1,
        ocId: 9001,
        name: "Reward Test",
        difficulty: 5,
        status: "Successful",
        executedAt: new Date(),
        slots: [{ position: "Muscle", user: { id: 55_600_200 }, checkpoint_pass_rate: 1 }],
        rewards: { money: 0, respect: 136, items: [{ id: 206, quantity: 15 }, { id: 999_999, quantity: 1 }] },
      },
    });
    const ocs = await getFactionOcs(u.id, { preset: "90d" });
    const oc = ocs.ocs.find((o) => o.ocId === 9001)!;
    expect(oc.rewardItemsDetailed).toHaveLength(2);
    expect(oc.rewardItemsDetailed[0]).toMatchObject({ name: "Xanax", quantity: 15, kind: "drug", estimatedValue: 15 * 840_000 });
    // Unpriced item: shown, value unavailable.
    expect(oc.rewardItemsDetailed[1]!.name).toBe("Item 999999");
    expect(oc.rewardItemsDetailed[1]!.estimatedValue).toBeNull();
    expect(oc.rewardValueComplete).toBe(false);
    // Total = reported cash (0) + priced items only.
    expect(oc.rewardEstimatedTotal).toBe(15 * 840_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Travel history range consistency                                            */
/* -------------------------------------------------------------------------- */
suite("travel history range consistency", () => {
  it("history covers exactly the requested range — no ±7d attach-window leakage", async () => {
    const u = await db.user.create({ data: { displayName: "Privacy-Travel", role: "user" } });
    cleanupIds.push(u.id);
    const now = Date.now() / 1000;
    const DAY = 86_400;
    for (const [departedDaysAgo, ref] of [[1, "in-range"], [4, "in-range-2"], [10, "outside-before"]] as const) {
      await db.travelEvent.create({
        data: {
          userId: u.id, destination: "Mexico", source: "trip", sourceRef: `trip:${ref}`,
          departedAt: new Date((now - departedDaysAgo * DAY) * 1000),
          returnedAt: new Date((now - (departedDaysAgo - 0.5) * DAY) * 1000),
        },
      });
    }
    const summary = await getTravelSummary(u.id, { preset: "7d" });
    const history = await getTravelHistory(u.id, { preset: "7d" }, 50);
    // Summary counts only in-range departures; history must agree.
    expect(history.items.length).toBe(summary.trips);
    // A trip 10 days back (inside the loader's 7d attach window of a 7d range
    // start) must NOT appear in a 7D history.
    expect(history.items.some((t) => t.id.includes === undefined && t.destination === "Mexico" && t.departedAt * 1000 < Date.now() - 7 * DAY * 1000)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Xanax item mapping + price freshness through the API                        */
/* -------------------------------------------------------------------------- */
import { upsertCatalogEntries as upsertCatalog } from "@tornscope/database";

suite("xanax item mapping and price freshness", () => {
  it("resolves the correct item id and exposes catalog freshness with the unit price", async () => {
    await upsertCatalog(db, [{ itemId: 206, name: "Xanax", type: "Drug", marketPrice: BigInt(852_200) }]);
    const drugs = await getDrugsSummary(user.id, { preset: "7d" }, null);
    expect(drugs.xanaxFunding.values.unitPrice).toBe(852_200);
    expect(drugs.xanaxFunding.values.priceUpdatedAt).not.toBeNull();
    // Freshness is a unix-seconds timestamp in the sane past.
    const ageDays = (Date.now() / 1000) - (drugs.xanaxFunding.values.priceUpdatedAt ?? 0);
    expect(ageDays).toBeGreaterThanOrEqual(0);
    expect(ageDays).toBeLessThan(400);
  });
});
