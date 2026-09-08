import { describe, expect, it, afterAll } from "vitest";
import { getPrismaClient } from "@tornscope/database";
import { buildServer } from "../src/server.js";

/**
 * TRUST_PROXY=true (default): Fastify resolves req.ip and req.protocol from
 * the X-Forwarded-* chain of the trusted web-app proxy, so
 * - the session cookie becomes Secure exactly when the BROWSER-facing
 *   request is HTTPS (x-forwarded-proto), and
 * - profile creation is keyed on the resolved client address (visitors with
 *   different addresses never share one rate-limit bucket).
 *
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const { buildServer } = await import("../src/server.js");

const db = getPrismaClient();
const cleanupUserIds: string[] = [];

let counter = 0;
function spoofableIp(): string {
  return `203.0.113.${counter++}`; // TEST-NET-3: never a real client
}

function setCookieOf(res: { headers: Record<string, unknown> }): string {
  const value = res.headers["set-cookie"];
  return Array.isArray(value) ? value.join("; ") : typeof value === "string" ? value : "";
}

afterAll(async () => {
  for (const id of cleanupUserIds) {
    await db.userSession.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.appSetting.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id, isDemo: false } }).catch(() => undefined);
  }
});

suite("TRUST_PROXY=true resolves the forwarded request (web app proxy in front)", () => {
  it("marks the session cookie Secure when x-forwarded-proto says https", async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { "x-forwarded-for": spoofableIp(), "x-forwarded-proto": "https" },
      });
      expect(res.statusCode).toBe(200);
      const cookie = setCookieOf(res);
      expect(cookie).toMatch(/^ts_session=/);
      expect(cookie).toContain("Secure");
      cleanupUserIds.push(res.json().userId);
    } finally {
      await app.close();
    }
  });

  it("keeps the cookie non-Secure on a plain-HTTP request", async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/me", headers: { "x-forwarded-for": spoofableIp() } });
      expect(res.statusCode).toBe(200);
      const cookie = setCookieOf(res);
      expect(cookie).toMatch(/^ts_session=/);
      expect(cookie).not.toContain("Secure");
      cleanupUserIds.push(res.json().userId);
    } finally {
      await app.close();
    }
  });

  it("keys identity resolution on the forwarded client address (no shared bucket)", async () => {
    const app = await buildServer();
    try {
      const a = await app.inject({ method: "GET", url: "/api/me", headers: { "x-forwarded-for": spoofableIp() } });
      const b = await app.inject({ method: "GET", url: "/api/me", headers: { "x-forwarded-for": spoofableIp() } });
      expect(a.json().userId).toBeTruthy();
      expect(b.json().userId).toBeTruthy();
      expect(a.json().userId).not.toBe(b.json().userId);
      cleanupUserIds.push(a.json().userId, b.json().userId);
    } finally {
      await app.close();
    }
  });
});
