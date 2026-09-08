import { describe, expect, it, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { checkPushEndpoint } from "@tornscope/shared";

/**
 * Push subscription security regressions: endpoint validation, the
 * active-device cap, and user-scoped unsubscribe/disable ownership.
 *
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set. VAPID env is
 * faked BEFORE the service module loads (its env snapshot is taken at import
 * time) so subscribePush passes its pushConfigured() gate; nothing is ever
 * sent in these tests.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

process.env.VAPID_PUBLIC_KEY ??= "test-vapid-public-key";
process.env.VAPID_PRIVATE_KEY ??= "test-vapid-private-key";

const { subscribePush, unsubscribePush, disableDevice, sendToSubscription, MAX_ACTIVE_SUBSCRIPTIONS } = await import(
  "../src/services/notifications.js"
);

type SessionUser = import("../src/auth.js").SessionUser;

const db = getPrismaClient();
const cleanupUserIds: string[] = [];
const cleanupEndpoints: string[] = [];

function sessionUser(id: string): SessionUser & { id: string } {
  return { id, displayName: "Test", role: "user", isDemo: false, timezone: "UTC" };
}

async function newUser(): Promise<{ id: string }> {
  const user = await db.user.create({ data: { displayName: `PushTest ${randomBytes(3).toString("hex")}`, role: "user" } });
  cleanupUserIds.push(user.id);
  return user;
}

function endpoint(tag: string): string {
  const url = `https://fcm.googleapis.com/fcm/send/test-${tag}-${randomBytes(6).toString("hex")}`;
  cleanupEndpoints.push(url);
  return url;
}

const keys = { p256dh: "B".repeat(40), auth: "a".repeat(24) };

afterAll(async () => {
  for (const id of cleanupUserIds) {
    await db.pushSubscription.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.notificationPreference.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.userSession.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id, isDemo: false } }).catch(() => undefined);
  }
  for (const url of cleanupEndpoints) {
    await db.pushSubscription.deleteMany({ where: { endpoint: url } }).catch(() => undefined);
  }
});

suite("push endpoint validation at subscribe time (SSRF guard)", () => {
  it("accepts a valid HTTPS push endpoint", async () => {
    const user = await newUser();
    const ep = endpoint("valid");
    await expect(subscribePush(sessionUser(user.id), { endpoint: ep, keys }, "vitest/ua")).resolves.toEqual({ ok: true });
    const row = await db.pushSubscription.findUnique({ where: { endpoint: ep } });
    expect(row).not.toBeNull();
    expect(row!.revokedAt).toBeNull();
    expect(row!.userId).toBe(user.id);
  });

  it("rejects an http endpoint", async () => {
    const user = await newUser();
    const ep = endpoint("http").replace("https://", "http://");
    await expect(subscribePush(sessionUser(user.id), { endpoint: ep, keys }, null)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await db.pushSubscription.findUnique({ where: { endpoint: ep } })).toBeNull();
  });

  it("rejects localhost and loopback endpoints", async () => {
    const user = await newUser();
    for (const ep of ["https://localhost/fcm/send/x", "https://127.0.0.1/fcm/send/x", "https://[::1]/fcm"]) {
      await expect(subscribePush(sessionUser(user.id), { endpoint: ep, keys }, null), ep).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(checkPushEndpoint(ep).allowed).toBe(false);
    }
  });

  it("rejects private IPv4 endpoints", async () => {
    const user = await newUser();
    for (const ep of ["https://10.0.0.5/fcm", "https://192.168.1.4/fcm", "https://169.254.169.254/fcm"]) {
      await expect(subscribePush(sessionUser(user.id), { endpoint: ep, keys }, null), ep).rejects.toMatchObject({
        statusCode: 400,
      });
    }
  });
});

suite("active-device cap (max 10 subscriptions per profile)", () => {
  it("refuses an 11th device but allows re-binding an existing one", async () => {
    const user = await newUser();
    const ownEndpoints: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_SUBSCRIPTIONS; i++) {
      const ep = endpoint(`cap${i}`);
      ownEndpoints.push(ep);
      await subscribePush(sessionUser(user.id), { endpoint: ep, keys }, null);
    }
    expect(await db.pushSubscription.count({ where: { userId: user.id, revokedAt: null } })).toBe(MAX_ACTIVE_SUBSCRIPTIONS);

    // Re-subscribing the CURRENT browser (existing active endpoint) re-binds
    // instead of counting as a new device.
    await expect(subscribePush(sessionUser(user.id), { endpoint: ownEndpoints[0]!, keys }, null)).resolves.toEqual({ ok: true });

    // A genuinely new device at the cap is refused.
    const blocked = endpoint("blocked");
    await expect(subscribePush(sessionUser(user.id), { endpoint: blocked, keys }, null)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await db.pushSubscription.findUnique({ where: { endpoint: blocked } })).toBeNull();

    // Freeing a slot (disable a device) lets a new one in.
    await disableDevice(sessionUser(user.id), (await db.pushSubscription.findFirst({ where: { userId: user.id, revokedAt: null } }))!.id);
    const freed = endpoint("freed");
    await expect(subscribePush(sessionUser(user.id), { endpoint: freed, keys }, null)).resolves.toEqual({ ok: true });
  });
});

suite("unsubscribe / disable stay user-scoped", () => {
  it("another profile cannot revoke someone else's registration", async () => {
    const owner = await newUser();
    const attacker = await newUser();
    const ep = endpoint("scoped");
    await subscribePush(sessionUser(owner.id), { endpoint: ep, keys }, null);

    await unsubscribePush(sessionUser(attacker.id), ep);
    await disableDevice(sessionUser(attacker.id), (await db.pushSubscription.findUnique({ where: { endpoint: ep } }))!.id);

    expect(await db.pushSubscription.findUnique({ where: { endpoint: ep } })).toMatchObject({
      userId: owner.id,
      revokedAt: null,
    });
  });
});

suite("send-side endpoint guard", () => {
  it("reports an internal endpoint as gone instead of POSTing to it", async () => {
    const result = await sendToSubscription({ endpoint: "https://127.0.0.1:9/push", p256dh: "x".repeat(30), auth: "y".repeat(30) }, {
      title: "t",
      body: "b",
      url: "/today",
      tag: "t",
      icon: "/i.png",
      badge: "/b.png",
    });
    expect(result).toBe("gone");
  });
});
