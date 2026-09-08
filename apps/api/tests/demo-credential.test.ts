import { describe, expect, it, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { buildServer } from "../src/server.js";

/**
 * Demo-view / credential regression: the demo flag may resolve the session
 * to the shared demo profile ONLY while the profile has NO ACTIVE API
 * credential — a revoked credential must not block the demo view, and an
 * active one must always win over the flag.
 *
 * Exercises the real route (GET /api/me) with a minted session cookie.
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const cleanupUserIds: string[] = [];

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function profileWithDemoFlag(): Promise<{ id: string; cookie: string }> {
  const user = await db.user.create({ data: { displayName: `DemoCond ${randomBytes(3).toString("hex")}`, role: "user" } });
  cleanupUserIds.push(user.id);
  const token = randomBytes(32).toString("base64url");
  await db.userSession.create({ data: { userId: user.id, tokenHash: hashToken(token) } });
  await db.appSetting.create({ data: { userId: user.id, key: "demo_view", value: true } });
  return { id: user.id, cookie: `ts_session=${token}` };
}

async function addCredential(userId: string, revoked: boolean): Promise<void> {
  await db.apiCredential.create({
    data: {
      userId,
      encryptedKey: "test-encrypted",
      iv: "test-iv",
      authTag: "test-tag",
      keyPreview: "••••test",
      logAccessAvailable: false,
      revokedAt: revoked ? new Date() : null,
    },
  });
}

async function meIsDemo(cookie: string): Promise<{ isDemo: boolean; userId: string; status: number }> {
  const app = await buildServer();
  try {
    const res = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    const body = res.json();
    return { isDemo: body.isDemo, userId: body.userId, status: res.statusCode };
  } finally {
    await app.close();
  }
}

afterAll(async () => {
  for (const id of cleanupUserIds) {
    await db.apiCredential.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.appSetting.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.userSession.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id, isDemo: false } }).catch(() => undefined);
  }
});

suite("demo view vs API credential state", () => {
  it("no credential: the demo flag activates the demo view", async () => {
    const demo = await db.user.findUnique({ where: { email: "demo@tornscope.local" }, select: { id: true } });
    if (!demo) return; // demo dataset not seeded on this database
    const profile = await profileWithDemoFlag();
    const result = await meIsDemo(profile.cookie);
    expect(result.status).toBe(200);
    expect(result.isDemo).toBe(true);
    expect(result.userId).toBe(demo.id);
  });

  it("revoked credential: the demo flag still activates the demo view", async () => {
    const demo = await db.user.findUnique({ where: { email: "demo@tornscope.local" }, select: { id: true } });
    if (!demo) return;
    const profile = await profileWithDemoFlag();
    await addCredential(profile.id, true);
    const result = await meIsDemo(profile.cookie);
    expect(result.status).toBe(200);
    expect(result.isDemo).toBe(true);
    expect(result.userId).toBe(demo.id);
  });

  it("active credential: the session stays on the REAL profile even with the flag set", async () => {
    const profile = await profileWithDemoFlag();
    await addCredential(profile.id, false);
    const result = await meIsDemo(profile.cookie);
    expect(result.status).toBe(200);
    expect(result.isDemo).toBe(false);
    expect(result.userId).toBe(profile.id);
  });
});
