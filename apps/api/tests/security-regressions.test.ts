import { describe, expect, it, afterAll } from "vitest";
import { getPrismaClient } from "@tornscope/database";
import { assertSameOrigin } from "../src/auth.js";
import { buildServer } from "../src/server.js";
import { saveApiKey, deleteProfile } from "../src/services/me.js";

/**
 * Security regression tests: origin checks behind the web proxy, legacy
 * owner-bind removal, and the demo-profile mutation guards.
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const cleanupUserIds: string[] = [];


function originReq(opts: { origin?: string; host?: string; forwardedHost?: string; method?: string; cookie?: string } = {}): any {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.host !== undefined) headers.host = opts.host;
  if (opts.forwardedHost !== undefined) headers["x-forwarded-host"] = opts.forwardedHost;
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  return { method: opts.method ?? "POST", headers, ip: "10.1.1.1" };
}

afterAll(async () => {
  for (const id of cleanupUserIds) {
    await db.userSession.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.appSetting.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id, isDemo: false } }).catch(() => undefined);
  }
});

suite("assertSameOrigin (CSRF defense behind the web proxy)", () => {
  it("accepts a browser origin that matches the forwarded host (proxy keeps Origin, rewrites Host)", () => {
    expect(() =>
      assertSameOrigin(originReq({ origin: "http://192.168.1.2:5173", host: "api:3000", forwardedHost: "192.168.1.2:5173" }))
    ).not.toThrow();
  });

  it("accepts the internal host itself (server-to-server, curl)", () => {
    expect(() => assertSameOrigin(originReq({ origin: "http://api:3000", host: "api:3000" }))).not.toThrow();
  });

  it("accepts ALLOWED_ORIGINS entries", () => {
    process.env.ALLOWED_ORIGINS = "https://tornscope.example.com";
    try {
      expect(() => assertSameOrigin(originReq({ origin: "https://tornscope.example.com", host: "api:3000" }))).not.toThrow();
    } finally {
      delete process.env.ALLOWED_ORIGINS;
    }
  });

  it("rejects a cross-SITE origin even though the proxy forwarded the real host", () => {
    expect(() =>
      assertSameOrigin(originReq({ origin: "https://evil.example", host: "api:3000", forwardedHost: "192.168.1.2:5173" }))
    ).toThrow(/Cross-origin/);
  });

  it("rejects a malformed origin", () => {
    expect(() => assertSameOrigin(originReq({ origin: "not-a-url", host: "api:3000", forwardedHost: "x" }))).toThrow(/Cross-origin/);
  });
});

suite('legacy owner bind removal', () => {
  it('the bind-owner endpoint no longer exists (404) — profile linking is the only multi-device mechanism', async () => {
    const app = await buildServer();
    const response = await app.inject({ method: 'POST', url: '/api/session/bind-owner', payload: { token: 'tok_anytoken' } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

suite("demo profile mutation guards", () => {
  it("saveApiKey refuses the demo profile (shared synthetic dataset)", async () => {
    const demo = await db.user.findUnique({ where: { email: "demo@tornscope.local" }, select: { id: true } });
    if (!demo) return; // demo not seeded on this database
    await expect(saveApiKey({ id: demo.id, isDemo: true }, "0123456789abcdef")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("deleteProfile refuses to delete the demo dataset", async () => {
    const demo = await db.user.findUnique({ where: { email: "demo@tornscope.local" }, select: { id: true } });
    if (!demo) return;
    await expect(deleteProfile(demo.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(await db.user.findUnique({ where: { id: demo.id }, select: { id: true } })).not.toBeNull();
  });
});
