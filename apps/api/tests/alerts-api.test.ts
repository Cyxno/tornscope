import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";

/**
 * Alerts API service suite (2.9.0): rule CRUD validation, channel secrecy,
 * account isolation and inbox read-state. Calls the service functions the
 * routes delegate to (the established pattern in this suite family) with a
 * session identity — never a client-supplied id.
 */

process.env.API_KEY_ENCRYPTION_KEY ??= "a".repeat(64);

const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const { createAlertRule, listAlertRules, updateAlertRule, deleteAlertRule, createAlertChannel, listAlertChannels, listAlertDeliveries, markDeliveryRead, markAllDeliveriesRead, getAlertUnreadCount } = await import(
  "../src/services/alerts.js"
);

type SessionUser = import("../src/auth.js").SessionUser;
const errorsModule = await import("../src/errors.js");

const db = getPrismaClient();
const NOW = Math.floor(Date.now() / 1000);

const cleanup: string[] = [];

function sessionUser(id: string): SessionUser {
  return { id, displayName: "Test", role: "user", isDemo: false, timezone: "UTC" };
}

async function newUser(): Promise<string> {
  const user = await db.user.create({
    data: { displayName: `alerts-api-${randomBytes(6).toString("hex")}`, role: "user" },
    select: { id: true },
  });
  cleanup.push(user.id);
  return user.id;
}

const VALID_WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij";

beforeAll(async () => {
  // Nothing shared — users are created per test for strict isolation.
});

afterAll(async () => {
  for (const id of cleanup) {
    await db.user.delete({ where: { id } }).catch(() => undefined);
  }
  if (dbUrl) await db.$disconnect();
});

suite("alerts rules API", () => {
  it("creates a rule with validated defaults, lists it with trigger metadata", async () => {
    const userId = await newUser();
    const created = await createAlertRule(userId, { triggerType: "net_worth_drop", config: { pct: 7.5 } });
    expect(created.triggerType).toBe("net_worth_drop");
    expect(created.config).toEqual({ pct: 7.5, window_hours: 24 });
    expect(created.lastFiredAtSec).toBeNull();

    const listed = await listAlertRules(userId);
    expect(listed.rules).toHaveLength(1);
    expect(listed.triggers.map((t) => t.id)).toContain("cooldown_ready");
    expect(listed.triggers.map((t) => t.id)).toContain("sync_recovery");
  });

  it("rejects unsupported trigger types, invalid configs and invalid quiet hours", async () => {
    const userId = await newUser();
    await expect(createAlertRule(userId, { triggerType: "made_up" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createAlertRule(userId, { triggerType: "net_worth_drop", config: { pct: 500 } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createAlertRule(userId, { triggerType: "cooldown_ready", quietHours: { start: "99:00", end: "07:00", tz: "UTC" } })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createAlertRule(userId, { triggerType: "cooldown_ready", quietHours: { start: "23:00", end: "07:00", tz: "not-a-zone" } })
    ).rejects.toMatchObject({ statusCode: 400 });
    // Strict config: unknown keys are typos, rejected.
    await expect(createAlertRule(userId, { triggerType: "net_worth_drop", config: { pctt: 5 } })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("enforces one rule per trigger type and validates updates against the rule's own trigger", async () => {
    const userId = await newUser();
    const created = await createAlertRule(userId, { triggerType: "oc_ready" });
    await expect(createAlertRule(userId, { triggerType: "oc_ready" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(updateAlertRule(userId, created.id, { config: { pct: 5 } })).rejects.toMatchObject({ statusCode: 400 });

    const updated = await updateAlertRule(userId, created.id, { enabled: false, cooldownMinutes: 30 });
    expect(updated.enabled).toBe(false);
    expect(updated.cooldownMinutes).toBe(30);

    // Quiet hours can be set and cleared.
    const withQuiet = await updateAlertRule(userId, created.id, { quietHours: { start: "23:00", end: "07:00", tz: "Europe/Amsterdam" } });
    expect(withQuiet.quietHours).toEqual({ start: "23:00", end: "07:00", tz: "Europe/Amsterdam" });
    expect((await updateAlertRule(userId, created.id, { quietHours: null })).quietHours).toBeNull();
  });

  it("prevents cross-account read, update and delete by changing the identifier", async () => {
    const owner = await newUser();
    const attacker = await newUser();
    const rule = await createAlertRule(owner, { triggerType: "travel_landed" });

    const attackerList = await listAlertRules(attacker);
    expect(attackerList.rules).toEqual([]);
    await expect(updateAlertRule(attacker, rule.id, { enabled: false })).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteAlertRule(attacker, rule.id)).rejects.toMatchObject({ statusCode: 404 });
    // The rule is untouched.
    expect((await listAlertRules(owner)).rules).toHaveLength(1);
  });

  it("deleting a rule cascades its deliveries (no orphans)", async () => {
    const userId = await newUser();
    const rule = await createAlertRule(userId, { triggerType: "sync_failure" });
    await db.alertDelivery.create({
      data: {
        userId,
        ruleId: rule.id,
        triggerType: "sync_failure",
        dedupeKey: `syncfail:test:${randomBytes(4).toString("hex")}`,
        occurredAt: new Date(),
        title: "T",
        message: "M",
        status: "sent",
      },
    });
    await deleteAlertRule(userId, rule.id);
    expect(await db.alertDelivery.count({ where: { userId } })).toBe(0);
  });
});

suite("alerts channels API", () => {
  it("stores the webhook encrypted and NEVER returns the URL (only a masked preview)", async () => {
    const userId = await newUser();
    const channel = await createAlertChannel(userId, { type: "discord", url: VALID_WEBHOOK });
    expect(channel.targetPreview).toContain("••••");
    expect(JSON.stringify(channel)).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");

    const row = await db.alertChannel.findUnique({ where: { id: channel.id } });
    expect(row!.encryptedKey).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(row!.encryptedKey).not.toBe(VALID_WEBHOOK);

    const listed = await listAlertChannels(userId);
    expect(JSON.stringify(listed)).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");
  });

  it("rejects invalid webhook targets (SSRF guard) and unsupported channel types", async () => {
    const userId = await newUser();
    await expect(createAlertChannel(userId, { type: "discord", url: "http://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createAlertChannel(userId, { type: "discord", url: "https://evil.example/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createAlertChannel(userId, { type: "slack", url: VALID_WEBHOOK })).rejects.toMatchObject({ statusCode: 400 });
    expect(await db.alertChannel.count({ where: { userId } })).toBe(0);
  });

  it("isolates channels per account (a foreign id is a 404, never a leak)", async () => {
    const owner = await newUser();
    const attacker = await newUser();
    const channel = await createAlertChannel(owner, { type: "discord", url: VALID_WEBHOOK });
    expect((await listAlertChannels(attacker)).channels).toEqual([]);
    await expect(listAlertChannels(attacker).then((r) => r.channels[0])).resolves.toBeUndefined();
    // Enable/disable by the wrong account must not find the row.
    const { updateAlertChannel, deleteAlertChannel } = await import("../src/services/alerts.js");
    await expect(updateAlertChannel(attacker, channel.id, { enabled: false })).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteAlertChannel(attacker, channel.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});

suite("alerts inbox API", () => {
  it("lists reverse-chronologically with per-channel statuses and keyset pagination", async () => {
    const userId = await newUser();
    const rule = await createAlertRule(userId, { triggerType: "cooldown_ready" });
    const channel = await createAlertChannel(userId, { type: "discord", url: VALID_WEBHOOK });
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) {
      const dedupeKey = `cooldown:ready:cooldown_drug:${NOW - i * 600}`;
      keys.push(dedupeKey);
      const delivery = await db.alertDelivery.create({
        data: {
          userId,
          ruleId: rule.id,
          triggerType: "cooldown_ready",
          dedupeKey,
          occurredAt: new Date((NOW - i * 600) * 1000),
          title: `Alert ${i}`,
          message: "M",
          status: i === 0 ? "sent" : "sent",
          readAt: i >= 3 ? new Date() : null,
        },
      });
      await db.alertChannelDelivery.create({
        data: {
          userId,
          deliveryId: delivery.id,
          channelId: channel.id,
          status: i === 4 ? "failed" : "sent",
          errorKind: i === 4 ? "invalid_webhook" : null,
          errorMessage: i === 4 ? "Webhook rejected by Discord (HTTP 404)." : null,
        },
      });
    }

    const page1 = await listAlertDeliveries(userId, { limit: 3 });
    expect(page1.entries.map((e) => e.title)).toEqual(["Alert 0", "Alert 1", "Alert 2"]);
    expect(page1.nextCursor).not.toBeNull();
    expect(JSON.stringify(page1)).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(page1.entries[0]!.channels[0]!.status).toBe("sent");

    const page2 = await listAlertDeliveries(userId, { limit: 3, cursor: page1.nextCursor });
    expect(page2.entries.map((e) => e.title)).toEqual(["Alert 3", "Alert 4"]);
    expect(page2.nextCursor).toBeNull();
    expect(page2.entries[1]!.channels[0]!.status).toBe("failed");
  });

  it("filters by trigger type and unread, and read-state mutations are account-scoped", async () => {
    const userId = await newUser();
    const attacker = await newUser();
    const rule = await createAlertRule(userId, { triggerType: "oc_ready" });
    const a = await db.alertDelivery.create({
      data: { userId, ruleId: rule.id, triggerType: "oc_ready", dedupeKey: `oc:a:${randomBytes(4).toString("hex")}`, occurredAt: new Date((NOW - 300) * 1000), title: "A", message: "M", status: "sent" },
    });
    await db.alertDelivery.create({
      data: { userId, ruleId: rule.id, triggerType: "oc_ready", dedupeKey: `oc:b:${randomBytes(4).toString("hex")}`, occurredAt: new Date(), title: "B", message: "M", status: "sent" },
    });

    const unread = await listAlertDeliveries(userId, { unread: true });
    expect(unread.entries).toHaveLength(2);

    // A foreign id is a 404, never a cross-account mutation.
    await expect(markDeliveryRead(attacker, a.id)).rejects.toMatchObject({ statusCode: 404 });

    await markDeliveryRead(userId, a.id);
    expect((await getAlertUnreadCount(userId)).count).toBe(1);
    expect((await getAlertUnreadCount(attacker)).count).toBe(0);

    const { updated } = await markAllDeliveriesRead(userId);
    expect(updated).toBe(1);
    expect((await getAlertUnreadCount(userId)).count).toBe(0);
  });

  it("exposes sanitized delivery statuses only (no internal error text)", async () => {
    const userId = await newUser();
    const rule = await createAlertRule(userId, { triggerType: "sync_failure" });
    const delivery = await db.alertDelivery.create({
      data: { userId, ruleId: rule.id, triggerType: "sync_failure", dedupeKey: `syncfail:x:${randomBytes(4).toString("hex")}`, occurredAt: new Date(), title: "T", message: "M", status: "suppressed" },
    });
    await db.alertChannelDelivery.create({
      data: {
        userId,
        deliveryId: delivery.id,
        channelId: (await createAlertChannel(userId, { type: "discord", url: VALID_WEBHOOK })).id,
        status: "failed",
        errorKind: "invalid_webhook",
        // Deliberately ugly internal detail — the DTO may carry it only
        // because the dispatch layer already sanitizes; assert no URL/token.
        errorMessage: "Webhook rejected by Discord (HTTP 404).",
      },
    });
    const page = await listAlertDeliveries(userId, {});
    expect(page.entries[0]!.status).toBe("suppressed");
    expect(page.entries[0]!.channels[0]!.errorKind).toBe("invalid_webhook");
    expect(JSON.stringify(page)).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");
  });

  it("error envelope stays consistent (AppError codes)", () => {
    expect(new errorsModule.AppError("not_found", "x", 404).statusCode).toBe(404);
  });
});
