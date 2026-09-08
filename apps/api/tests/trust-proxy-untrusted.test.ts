import { describe, expect, it, afterAll } from "vitest";
import { getPrismaClient } from "@tornscope/database";

/**
 * TRUST_PROXY pinned to a subnet list that does NOT include the direct peer:
 * X-Forwarded-* headers from an untrusted connection must be ignored —
 * req.protocol falls back to the socket (no Secure cookie from a spoofed
 * x-forwarded-proto), which is exactly the "never blindly trust arbitrary
 * X-Forwarded-For" requirement for deployments where the API is not behind
 * the trusted proxy chain.
 *
 * Loads the server with TRUST_PROXY=10.0.0.0/8 BEFORE import (the env
 * snapshot is taken at module load). Runs against a real PostgreSQL when
 * TEST_DATABASE_URL is set.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

process.env.TRUST_PROXY = "10.0.0.0/8";

const { buildServer } = await import("../src/server.js");

const db = getPrismaClient();
const cleanupUserIds: string[] = [];

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

suite("TRUST_PROXY=10.0.0.0/8 ignores forwarded headers from an untrusted peer", () => {
  it("does NOT mark the session cookie Secure on a spoofed x-forwarded-proto", async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { "x-forwarded-for": "198.51.100.7", "x-forwarded-proto": "https" },
      });
      expect(res.statusCode).toBe(200);
      const cookie = setCookieOf(res);
      expect(cookie).toMatch(/^ts_session=/);
      expect(cookie).not.toContain("Secure");
      cleanupUserIds.push(res.json().userId);
    } finally {
      await app.close();
    }
  });
});
