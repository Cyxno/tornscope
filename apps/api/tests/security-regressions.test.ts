import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { assertSameOrigin, bindLegacyOwner, resolveSessionUser } from "../src/auth.js";
import { saveApiKey, deleteProfile } from "../src/services/me.js";

/**
 * Security regression tests: origin checks behind the web proxy, session
 * rotation on owner bind, and the demo-profile mutation guards.
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const cleanupUserIds: string[] = [];
let recoveryToken = "";

function originReq(opts: { origin?: string; host?: string; forwardedHost?: string; method?: string; cookie?: string } = {}): any {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.host !== undefined) headers.host = opts.host;
  if (opts.forwardedHost !== undefined) headers["x-forwarded-host"] = opts.forwardedHost;
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  return { method: opts.method ?? "POST", headers, ip: "10.1.1.1" };
}

beforeAll(async () => {
  recoveryToken = `tok_${randomBytes(12).toString("hex")}`;
  process.env.OWNER_RECOVERY_TOKEN = recoveryToken;
  process.env.OWNER_BIND_TOKEN = "";
});

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

suite("owner bind hardening", () => {
  it("bind rotates the session token: the old guest cookie stops working, the new one is the owner", async () => {
    // Fresh guest profile + session.
    const reply: any = { __h: {} as Record<string, string>, header(n: string, v: string) { this.__h[n] = v; } };
    const guest = await resolveSessionUser({ headers: {}, ip: "10.9.9.9" } as any, reply);
    cleanupUserIds.push(guest.id);
    const setCookie = reply.__h["Set-Cookie"] as string;
    const guestToken = decodeURIComponent(setCookie.split(";")[0].split("=")[1]);

    const bindReply: any = { __h: {} as Record<string, string>, header(n: string, v: string) { this.__h[n] = v; } };
    const bindReq = {
      method: "POST",
      headers: { origin: "http://192.168.1.2:5173", host: "api:3000", "x-forwarded-host": "192.168.1.2:5173", cookie: `ts_session=${guestToken}` },
      ip: "10.9.9.9",
      protocol: "http",
    } as any;
    const owner = await bindLegacyOwner(bindReq, bindReply, recoveryToken);

    // The old token must be dead (rotated), the new one must resolve to the owner.
    // (Distinct fake IPs: a 425-coalesced creation from the same address would
    // otherwise mask the assertion with a retryable bootstrap error.)
    const oldCookieGone = await resolveSessionUser({ headers: { cookie: `ts_session=${guestToken}` }, ip: "10.9.9.10" } as any, { __h: {}, header() {} } as any);
    const newCookie = (bindReply.__h["Set-Cookie"] as string).split(";")[0].split("=")[1];
    const newCookieWorks = await resolveSessionUser({ headers: { cookie: `ts_session=${newCookie}` }, ip: "10.9.9.11" } as any, { __h: {}, header() {} } as any);

    expect(owner.role).toBe("owner");
    expect(newCookie).not.toBe(guestToken);
    expect(newCookieWorks.id).toBe(owner.id);
    // Old token no longer maps to the owner (revoked session row).
    expect(oldCookieGone.id).not.toBe(owner.id);
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
