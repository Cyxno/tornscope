import { describe, expect, it, afterAll } from "vitest";
import { getPrismaClient } from "@tornscope/database";
import { buildServer } from "../src/server.js";

/**
 * Dedicated subscribe rate limit: POST /api/notifications/subscribe is
 * limited per client IP (20 per 10 minutes) so endpoint registration can
 * never be spammed. Separate test FILE on purpose — the limiter is
 * in-process and this file gets a fresh one.
 *
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const cleanupUserIds: string[] = [];

function setCookieOf(res: { headers: Record<string, unknown> }): string | undefined {
  const value = res.headers["set-cookie"];
  const first = Array.isArray(value) ? value[0] : (value as string | undefined);
  return first?.split(";")[0];
}

afterAll(async () => {
  for (const id of cleanupUserIds) {
    await db.pushSubscription.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.notificationPreference.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.userSession.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.appSetting.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id, isDemo: false } }).catch(() => undefined);
  }
});

suite("subscribe rate limit", () => {
  it("blocks after 20 subscribe attempts from one address", async () => {
    const app = await buildServer();
    try {
      // Bootstrap a session like a browser would (identity keyed on the
      // forwarded client address), so every attempt below belongs to ONE
      // visitor from ONE address.
      const bootstrap = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { "x-forwarded-for": "198.51.100.10" },
      });
      expect(bootstrap.statusCode).toBe(200);
      cleanupUserIds.push(bootstrap.json().userId);
      const cookie = setCookieOf(bootstrap);
      expect(cookie, "session bootstrap worked").toBeTruthy();

      let sawLimited = false;
      for (let i = 0; i < 25 && !sawLimited; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/notifications/subscribe",
          headers: { cookie, "x-forwarded-for": "198.51.100.10" },
          payload: {
            endpoint: `https://fcm.googleapis.com/fcm/send/rl-${Date.now()}-${i}`,
            keys: { p256dh: "p".repeat(20), auth: "a".repeat(20) },
          },
        });
        if (res.json().error?.details?.formErrors?.[0]?.startsWith("Too many notification attempts")) {
          sawLimited = true;
        } else {
          // Without VAPID configured the route 404s before touching the
          // subscription table — those attempts still count against the IP.
          expect([400, 404], `unexpected status at attempt ${i + 1}`).toContain(res.statusCode);
        }
      }
      expect(sawLimited, "the dedicated subscribe limiter must engage").toBe(true);
    } finally {
      await app.close();
    }
  });
});
