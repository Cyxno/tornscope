import {
  alertTrigger,
  normalizeAlertConfig,
  parseAlertQuietHours,
  AlertQuietHoursSchema,
  maskedWebhookPreview,
  validateDiscordWebhookUrl,
  sendDiscordWebhook,
  buildDiscordContent,
  ALERT_TRIGGERS,
  ALERT_TRIGGER_IDS,
  type AlertChannelDto,
  type AlertDeliveryDto,
  type AlertDeliveryStatus,
  type AlertRuleDto,
  type AlertRulesResponse,
  type AlertTriggerMeta,
  type AlertUnreadCountResponse,
} from "@tornscope/shared";
import { getPrismaClient, encryptionFromEnv } from "@tornscope/database";
import { cursorWhere, encodeCursor } from "../cursor.js";
import { env } from "../env.js";
import { errors } from "../errors.js";
import type { SessionUser } from "../auth.js";

/**
 * Proactive Alerts service (2.9.0): rule CRUD, Discord channel management
 * and the in-app inbox. Every read and write is scoped by the session
 * profile — ownership NEVER comes from the request body, and webhook URLs
 * are write-only secrets (encrypted at rest, only ever surfaced as a masked
 * preview).
 */

const MAX_PAGE_SIZE = 100;

type Db = ReturnType<typeof getPrismaClient>;
const db = (): Db => getPrismaClient();

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

function toRuleDto(row: {
  id: string;
  triggerType: string;
  enabled: boolean;
  config: unknown;
  quietHours: unknown;
  cooldownMinutes: number;
  lastFiredAt: Date | null;
  createdAt: Date;
}): AlertRuleDto {
  // Unknown persisted trigger types (older builds) are filtered by callers;
  // the DTO path assumes a registry id.
  return {
    id: row.id,
    triggerType: row.triggerType as AlertRuleDto["triggerType"],
    enabled: row.enabled,
    config: (row.config ?? {}) as Record<string, unknown>,
    quietHours: parseAlertQuietHours(row.quietHours),
    cooldownMinutes: row.cooldownMinutes,
    lastFiredAtSec: row.lastFiredAt === null ? null : Math.floor(row.lastFiredAt.getTime() / 1000),
    createdAtSec: Math.floor(row.createdAt.getTime() / 1000),
  };
}

export async function listAlertRules(userId: string): Promise<AlertRulesResponse> {
  const rows = await db().alertRule.findMany({
    where: { userId, triggerType: { in: alertTriggerIds() } },
    orderBy: { createdAt: "asc" },
  });
  return {
    rules: rows.map(toRuleDto),
    triggers: allTriggerMeta(),
  };
}

/** Registry ids as a plain list (the registry is a const tuple). */
const ALERT_TRIGGER_ID_LIST: string[] = [...ALERT_TRIGGER_IDS];
function alertTriggerIds(): string[] {
  return ALERT_TRIGGER_ID_LIST;
}

const allTriggerMeta = (): AlertTriggerMeta[] => ALERT_TRIGGERS;

export interface AlertRuleInput {
  triggerType: string;
  enabled?: boolean;
  config?: unknown;
  quietHours?: unknown;
  cooldownMinutes?: number;
}

export async function createAlertRule(userId: string, input: AlertRuleInput): Promise<AlertRuleDto> {
  const meta = alertTrigger(input.triggerType);
  if (!meta) throw errors.validation(`Unsupported trigger type: ${String(input.triggerType)}`);
  let config: Record<string, unknown>;
  try {
    config = normalizeAlertConfig(meta.id, input.config);
  } catch (err) {
    throw errors.validation((err as { details?: unknown }).details ?? "Invalid configuration");
  }
  let quietHours: unknown = null;
  if (input.quietHours !== undefined && input.quietHours !== null) {
    const parsed = AlertQuietHoursSchema.safeParse(input.quietHours);
    if (!parsed.success) throw errors.validation("quiet_hours must be {start:\"HH:MM\", end:\"HH:MM\", tz:\"IANA/Zone\"}");
    if (!isValidQuietZone(parsed.data.tz)) throw errors.validation("quiet_hours.tz must be a valid IANA timezone");
    quietHours = parsed.data;
  }
  try {
    const row = await db().alertRule.create({
      data: {
        userId,
        triggerType: meta.id,
        enabled: input.enabled ?? true,
        config: config as never,
        quietHours: quietHours as never,
        cooldownMinutes: clampCooldown(input.cooldownMinutes),
      },
    });
    return toRuleDto(row);
  } catch (err) {
    // (userId, triggerType) unique: one rule per built-in trigger.
    if ((err as { code?: string }).code === "P2002") {
      throw errors.conflict(`An alert rule for "${meta.id}" already exists.`);
    }
    throw err;
  }
}

export interface AlertRuleUpdateInput {
  enabled?: boolean;
  config?: unknown;
  quietHours?: unknown | null;
  cooldownMinutes?: number;
}

export async function updateAlertRule(userId: string, ruleId: string, input: AlertRuleUpdateInput): Promise<AlertRuleDto> {
  const existing = await db().alertRule.findFirst({ where: { id: ruleId, userId } });
  if (!existing || !alertTrigger(existing.triggerType)) throw errors.notFound("Alert rule");
  const data: Record<string, unknown> = {};
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.cooldownMinutes !== undefined) data.cooldownMinutes = clampCooldown(input.cooldownMinutes);
  if (input.config !== undefined) {
    try {
      // Validate against the rule's OWN trigger type (both create AND update).
      data.config = normalizeAlertConfig(existing.triggerType, input.config) as never;
    } catch (err) {
      throw errors.validation((err as { details?: unknown }).details ?? "Invalid configuration");
    }
  }
  if (input.quietHours !== undefined) {
    if (input.quietHours === null) {
      data.quietHours = null;
    } else {
      const parsed = AlertQuietHoursSchema.safeParse(input.quietHours);
      if (!parsed.success) throw errors.validation("quiet_hours must be {start:\"HH:MM\", end:\"HH:MM\", tz:\"IANA/Zone\"}");
      if (!isValidQuietZone(parsed.data.tz)) throw errors.validation("quiet_hours.tz must be a valid IANA timezone");
      data.quietHours = parsed.data as never;
    }
  }
  const row = await db().alertRule.update({ where: { id: existing.id }, data: data as never });
  return toRuleDto(row);
}

export async function deleteAlertRule(userId: string, ruleId: string): Promise<{ deleted: true }> {
  // Deliveries cascade (FK onDelete: Cascade) — no orphans in any path.
  const result = await db().alertRule.deleteMany({ where: { id: ruleId, userId } });
  if (result.count === 0) throw errors.notFound("Alert rule");
  return { deleted: true };
}

function clampCooldown(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(7 * 24 * 60, Math.max(0, Math.round(value)));
}

/** IANA validation lives in shared (day.ts); re-imported lazily to keep this file's import list flat. */
function isValidQuietZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Channels (Discord webhooks — secrets)                                      */
/* -------------------------------------------------------------------------- */

export async function listAlertChannels(userId: string): Promise<{ channels: AlertChannelDto[] }> {
  const rows = await db().alertChannel.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  return {
    channels: rows.map((row) => ({
      id: row.id,
      type: row.type,
      targetPreview: row.targetPreview,
      verifiedAtSec: row.verifiedAt === null ? null : Math.floor(row.verifiedAt.getTime() / 1000),
      enabled: row.enabled,
      createdAtSec: Math.floor(row.createdAt.getTime() / 1000),
    })),
  };
}

export async function createAlertChannel(userId: string, input: { type: string; url: string }): Promise<AlertChannelDto> {
  if (input.type !== "discord") throw errors.validation("Unsupported channel type — the MVP supports Discord webhooks only.");
  const validation = validateDiscordWebhookUrl(input.url);
  if (!validation.ok) {
    throw errors.validation(`Not a valid Discord webhook URL (${validation.reason}).`);
  }
  const encryption = encryptionFromEnv();
  const encrypted = encryption.encrypt(input.url);
  const row = await db().alertChannel.create({
    data: {
      userId,
      type: "discord",
      encryptedKey: encrypted.encryptedKey,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      targetPreview: maskedWebhookPreview(input.url),
    },
  });
  return {
    id: row.id,
    type: row.type,
    targetPreview: row.targetPreview,
    verifiedAtSec: null,
    enabled: row.enabled,
    createdAtSec: Math.floor(row.createdAt.getTime() / 1000),
  };
}

export async function updateAlertChannel(userId: string, channelId: string, input: { enabled?: boolean }): Promise<AlertChannelDto> {
  const existing = await db().alertChannel.findFirst({ where: { id: channelId, userId } });
  if (!existing) throw errors.notFound("Alert channel");
  const data: Record<string, unknown> = {};
  if (input.enabled !== undefined) data.enabled = input.enabled;
  const row = await db().alertChannel.update({ where: { id: existing.id }, data });
  return {
    id: row.id,
    type: row.type,
    targetPreview: row.targetPreview,
    verifiedAtSec: row.verifiedAt === null ? null : Math.floor(row.verifiedAt.getTime() / 1000),
    enabled: row.enabled,
    createdAtSec: Math.floor(row.createdAt.getTime() / 1000),
  };
}

export async function deleteAlertChannel(userId: string, channelId: string): Promise<{ deleted: true }> {
  const result = await db().alertChannel.deleteMany({ where: { id: channelId, userId } });
  if (result.count === 0) throw errors.notFound("Alert channel");
  return { deleted: true };
}

/**
 * Test delivery: the SAME sender implementation the worker uses, clearly
 * labeled as a test, no rule state or cooldown touched. verifiedAt updates
 * only after Discord ACCEPTED the request.
 */
export async function testAlertChannel(user: SessionUser, channelId: string): Promise<{ ok: boolean; errorKind?: string; message?: string }> {
  if (!env.alerts.enabled) throw errors.conflict("Alerts are disabled on this deployment (ALERTS_ENABLED=false).");
  const channel = await db().alertChannel.findFirst({
    where: { id: channelId, userId: user.id },
    select: { id: true, encryptedKey: true, iv: true, authTag: true, enabled: true },
  });
  if (!channel) throw errors.notFound("Alert channel");
  if (!channel.enabled) throw errors.conflict("Enable the channel before testing it.");
  let webhookUrl: string;
  try {
    webhookUrl = encryptionFromEnv().decrypt(channel);
  } catch {
    // The stored payload is unreadable — the user must re-add the channel.
    return { ok: false, errorKind: "invalid_webhook", message: "Stored webhook could not be decrypted — remove and re-add the channel." };
  }
  const result = await sendDiscordWebhook(webhookUrl, buildDiscordContent({
    title: "TornScope test alert",
    message: "This is a test notification from your TornScope alerts channel. If you can read this, Discord delivery works.",
    suffix: "Test message — no alert rule was affected",
  }), { timeoutMs: env.alerts.discordTimeoutMs });
  if (result.outcome === "sent") {
    await db().alertChannel.update({ where: { id: channel.id }, data: { verifiedAt: new Date() } }).catch(() => undefined);
    return { ok: true };
  }
  if (result.outcome === "rate_limited") {
    return { ok: false, errorKind: "rate_limited", message: "Discord rate-limited the test delivery — try again shortly." };
  }
  return { ok: false, errorKind: result.errorKind, message: result.message };
}

/* -------------------------------------------------------------------------- */
/* Inbox (deliveries)                                                         */
/* -------------------------------------------------------------------------- */

export interface AlertDeliveriesQuery {
  limit?: number;
  cursor?: string | null;
  triggerType?: string | null;
  unread?: boolean;
}

export async function listAlertDeliveries(
  userId: string,
  query: AlertDeliveriesQuery
): Promise<{ entries: AlertDeliveryDto[]; nextCursor: string | null }> {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.round(query.limit ?? 50)));
  const where: Record<string, unknown> = { userId };
  if (query.triggerType && alertTrigger(query.triggerType)) where.triggerType = query.triggerType;
  if (query.unread === true) where.readAt = null;
  const cursorCondition = query.cursor ? cursorWhere(query.cursor) : undefined;
  const rows = await db().alertDelivery.findMany({
    where: cursorCondition ? { ...where, AND: [cursorCondition] } : where,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit,
    include: { channelDeliveries: { select: { channelId: true, status: true, errorKind: true, errorMessage: true, attempts: true } } },
  });

  const entries: AlertDeliveryDto[] = rows.map((row) => ({
    id: row.id,
    triggerType: row.triggerType as AlertDeliveryDto["triggerType"],
    title: row.title,
    message: row.message,
    payload: (row.payload ?? null) as Record<string, unknown> | null,
    status: row.status as AlertDeliveryStatus,
    occurredAtSec: Math.floor(row.occurredAt.getTime() / 1000),
    readAtSec: row.readAt === null ? null : Math.floor(row.readAt.getTime() / 1000),
    channels: row.channelDeliveries.map((cd) => ({
      channelId: cd.channelId,
      status: cd.status as AlertDeliveryStatus,
      errorKind: cd.errorKind,
      errorMessage: cd.errorMessage,
      attempts: cd.attempts,
    })),
  }));
  const last = rows[rows.length - 1];
  return {
    entries,
    nextCursor: rows.length < limit || !last ? null : encodeCursor({ occurredAt: Math.floor(last.occurredAt.getTime() / 1000), id: last.id }),
  };
}

export async function markDeliveryRead(userId: string, deliveryId: string): Promise<{ ok: true }> {
  const result = await db().alertDelivery.updateMany({
    where: { id: deliveryId, userId, readAt: null },
    data: { readAt: new Date() },
  });
  if (result.count === 0) {
    // Either not found, not owned, or already read — both are "ok" for the
    // caller, but a foreign id must not be silently accepted.
    const owned = await db().alertDelivery.findFirst({ where: { id: deliveryId, userId }, select: { id: true } });
    if (!owned) throw errors.notFound("Alert delivery");
  }
  return { ok: true };
}

export async function markAllDeliveriesRead(userId: string): Promise<{ updated: number }> {
  const result = await db().alertDelivery.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return { updated: result.count };
}

export async function getAlertUnreadCount(userId: string): Promise<AlertUnreadCountResponse> {
  const count = await db().alertDelivery.count({ where: { userId, readAt: null } });
  return { count };
}
