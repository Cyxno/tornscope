import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { resolveSessionUser, revokeSessionsFor, type SessionUser } from "../src/auth.js";
import { getDashboard } from "../src/services/dashboard.js";
import { getDrugsSummary } from "../src/services/drugs.js";
import { getTravelSummary } from "../src/services/travel.js";
import { getCombatSummary } from "../src/services/crimesCombat.js";
import { deleteProfile } from "../src/services/me.js";
import { setDemoView } from "../src/services/me.js";

/**
 * Browser-identity + tenant-isolation tests.
 *
 * These run against a real PostgreSQL when TEST_DATABASE_URL is set (they
 * create their own synthetic profiles and delete them afterwards); without
 * the variable they are skipped so the pure-test suite stays hermetic.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();

function fakeReq(cookie?: string): any {
  // Unique per-call IP: sequential test browsers must not trip the per-IP
  // bootstrap coalescing grace window (distinct browsers, one address).
  return { headers: cookie ? { cookie } : {}, protocol: "http", ip: `test-${Date.now()}-${counter++}` };
}
let counter = 0;
function fakeReply(): any {
  return { __headers: {} as Record<string, string>, header(name: string, value: string) { this.__headers[name] = value; } };
}
function sha(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

let userA: SessionUser;
let userB: SessionUser;
const cleanupIds: string[] = [];

beforeAll(async () => {
  // Synthetic profiles with clearly distinct data.
  userA = await db.user.create({ data: { displayName: "ISO-A", role: "user" } });
  userB = await db.user.create({ data: { displayName: "ISO-B", role: "user" } });
  cleanupIds.push(userA.id, userB.id);

  await db.moneyEvent.createMany({
    data: [
      { userId: userA.id, occurredAt: new Date(), category: "salary", direction: "income", amount: 111_000n, source: "test", sourceRef: "iso-a:1" },
      { userId: userB.id, occurredAt: new Date(), category: "salary", direction: "income", amount: 999_000n, source: "test", sourceRef: "iso-b:1" },
    ],
  });
  await db.combatEvent.createMany({
    data: [
      { userId: userA.id, occurredAt: new Date(), direction: "outgoing", result: "Attacked", sourceRef: "iso-a:1" },
      { userId: userB.id, occurredAt: new Date(), direction: "incoming", result: "Mugged", sourceRef: "iso-b:1" },
    ],
  });
  await db.travelEvent.createMany({
    data: [
      { userId: userA.id, destination: "DestinationA", departedAt: new Date(), status: "completed", source: "trip", sourceRef: "iso-a:1" },
      { userId: userB.id, destination: "DestinationB", departedAt: new Date(), status: "completed", source: "trip", sourceRef: "iso-b:1" },
    ],
  });
  await db.drugEvent.createMany({
    data: [
      { userId: userA.id, occurredAt: new Date(), outcome: "success", drugName: "Xanax", source: "test", sourceRef: "iso-a:1" },
      { userId: userB.id, occurredAt: new Date(), outcome: "success", drugName: "Xanax", source: "test", sourceRef: "iso-b:1" },
    ],
  });
});

afterAll(async () => {
  for (const id of cleanupIds) {
    await deleteProfile(id).catch(() => undefined);
  }
});

suite("browser identity (resolveSessionUser)", () => {
  it("a browser without a cookie gets a fresh anonymous profile + session cookie", async () => {
    const reply = fakeReply();
    const user = await resolveSessionUser(fakeReq(undefined), reply);
    cleanupIds.push(user.id);
    expect(user.role).toBe("user");
    expect(reply.__headers["Set-Cookie"]).toContain("ts_session=");
    expect(reply.__headers["Set-Cookie"]).toContain("HttpOnly");
    // never the legacy owner
    expect(user.id).not.toBe((await db.user.findFirst({ where: { role: "owner" } }))?.id);
  });

  it("an invalid session token is ignored (fresh anonymous profile, never a lookup error)", async () => {
    const reply = fakeReply();
    const user = await resolveSessionUser(fakeReq("ts_session=garbage"), reply);
    cleanupIds.push(user.id);
    expect(reply.__headers["Set-Cookie"]).toContain("ts_session=");
  });

  it("a revoked session is rejected and cannot resurrect its profile", async () => {
    const token = randomBytes(32).toString("base64url");
    const user = await db.user.create({ data: { displayName: "ISO-revoked", role: "user" } });
    cleanupIds.push(user.id);
    await db.userSession.create({ data: { userId: user.id, tokenHash: sha(token) } });
    await revokeSessionsFor(db, user.id);
    const reply = fakeReply();
    const resolved = await resolveSessionUser(fakeReq(`ts_session=${token}`), reply);
    cleanupIds.push(resolved.id);
    expect(resolved.id).not.toBe(user.id);
  });

  it("a valid session token restores the SAME profile across requests", async () => {
    const token = randomBytes(32).toString("base64url");
    const user = await db.user.create({ data: { displayName: "ISO-persist", role: "user" } });
    cleanupIds.push(user.id);
    await db.userSession.create({ data: { userId: user.id, tokenHash: sha(token) } });
    const reply = fakeReply();
    const resolved = await resolveSessionUser(fakeReq(`ts_session=${token}`), reply);
    expect(resolved.id).toBe(user.id);
    expect(reply.__headers["Set-Cookie"]).toBeUndefined();
  });

  it("demo mode is per profile: B's demo toggle does not affect A", async () => {
    const tokenB = randomBytes(32).toString("base64url");
    await db.userSession.create({ data: { userId: userB.id, tokenHash: sha(tokenB) } });
    await setDemoView(userB, true);
    const demoResolved = await resolveSessionUser(fakeReq(`ts_session=${tokenB}`), fakeReply());
    expect(demoResolved.isDemo).toBe(true);
    // A keeps its own (non-demo) identity even while B is in demo mode.
    const tokenA = randomBytes(32).toString("base64url");
    await db.userSession.create({ data: { userId: userA.id, tokenHash: sha(tokenA) } });
    const aResolved = await resolveSessionUser(fakeReq(`ts_session=${tokenA}`), fakeReply());
    expect(aResolved.id).toBe(userA.id);
    expect(aResolved.isDemo).toBe(false);
    await setDemoView(userB, false);
  });
});

suite("tenant isolation (services are scoped by profile)", () => {
  it("dashboard for A never contains B's money or vice versa", async () => {
    const now = Math.floor(Date.now() / 1000);
    const a = await getDashboard(userA.id, { preset: "7d", from: now - 86_400, to: now + 86_400 });
    const b = await getDashboard(userB.id, { preset: "7d", from: now - 86_400, to: now + 86_400 });
    expect(a.financial.trueIncome).toBe(111_000);
    expect(b.financial.trueIncome).toBe(999_000);
  });

  it("travel for A only lists A's destinations", async () => {
    const now = Math.floor(Date.now() / 1000);
    const a = await getTravelSummary(userA.id, { preset: "30d", from: now - 86_400, to: now + 86_400 });
    const destinations = a.profitByDestination.map((d) => d.destination);
    expect(destinations).toContain("DestinationA");
    expect(destinations).not.toContain("DestinationB");
  });

  it("combat for A counts only A's attacks", async () => {
    const now = Math.floor(Date.now() / 1000);
    const a = await getCombatSummary(userA.id, { preset: "7d", from: now - 86_400, to: now + 86_400 });
    const b = await getCombatSummary(userB.id, { preset: "7d", from: now - 86_400, to: now + 86_400 });
    expect(a.attacksMade).toBe(1);
    expect(b.attacksMade).toBe(0);
    expect(b.incomingLost).toBe(1);
  });

  it("drugs for A never sees B's use count", async () => {
    const now = Math.floor(Date.now() / 1000);
    const a = await getDrugsSummary(userA.id, { preset: "7d", from: now - 86_400, to: now + 86_400 }, null);
    const b = await getDrugsSummary(userB.id, { preset: "7d", from: now - 86_400, to: now + 86_400 }, null);
    expect(a.overall.totalUses).toBe(1);
    expect(b.overall.totalUses).toBe(1);
  });
});

suite("profile deletion", () => {
  it("deletes the profile and its data without touching other profiles", async () => {
    const victim = await db.user.create({ data: { displayName: "ISO-del", role: "user" } });
    await db.moneyEvent.create({ data: { userId: victim.id, occurredAt: new Date(), category: "other", direction: "income", amount: 1n, source: "test", sourceRef: "iso-del:1" } });
    const survivorsBefore = await db.moneyEvent.count({ where: { userId: userA.id } });

    await deleteProfile(victim.id);

    expect(await db.user.findUnique({ where: { id: victim.id } })).toBeNull();
    expect(await db.moneyEvent.count({ where: { userId: victim.id } })).toBe(0);
    expect(await db.moneyEvent.count({ where: { userId: userA.id } })).toBe(survivorsBefore);
  });
});

suite("owner deletion protection", () => {
  it("the legacy owner profile cannot be deleted through the normal flow", async () => {
    const owner = await db.user.findFirst({ where: { role: "owner", isDemo: false } });
    if (!owner) return; // environment without the legacy owner
    await expect(deleteProfile(owner.id)).rejects.toThrow();
    expect(await db.user.findUnique({ where: { id: owner.id } })).not.toBeNull();
  });
});
