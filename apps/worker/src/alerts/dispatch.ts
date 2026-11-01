import { buildDiscordContent, isTransientDiscordError, sendDiscordWebhook, type DiscordErrorKind } from "@tornscope/shared";
import { getPrismaClient, EncryptionService } from "@tornscope/database";
import { env, logger } from "../env.js";

/**
 * Discord dispatch with a reliable queued-delivery pattern.
 *
 * The database transaction commits the alert with channel rows in "pending";
 * the actual Discord HTTP request happens HERE, outside any transaction —
 * the row (not the HTTP call) is the source of truth. A crash between commit
 * and dispatch leaves a pending row that a later tick retries; a Discord
 * success marks the row "sent"; transient failures get bounded retries with
 * exponential backoff + jitter (rate-limits honor Discord's retry_after).
 *
 * After ALERT_DELIVERY_MAX_RETRIES transient failures the row is marked
 * "failed" WITH its error category — never deleted — so the inbox keeps the
 * logical alert and the UI can show what went wrong per channel.
 *
 * Secrets: webhook URLs are decrypted only for the request; logs carry the
 * delivery id and a machine error kind, never the URL or token.
 */

/** One-time decryptor (mirrors the push engine's lazy construction). */
let encryption: EncryptionService | null = null;
function decryptor(): EncryptionService {
  if (!encryption) encryption = new EncryptionService(env.encryptionKey);
  return encryption;
}

/** Exponential backoff: 60s × 2^attempt, bounded at 6h, ±20% jitter. */
export function retryDelaySeconds(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(6 * 3600, 60 * Math.pow(2, Math.max(0, attempt)));
  const jitter = base * 0.2 * (rand() * 2 - 1);
  return Math.max(1, Math.round(base + jitter));
}

/** Rows processed per dispatch pass (bounded; the next tick continues). */
const MAX_DISPATCH_PER_PASS = 50;

/**
 * Dispatch every due channel delivery: pending rows whose next attempt is
 * due (or unset). Called from the same scheduler tick as evaluation, so
 * retries require no dedicated queue.
 */
export async function dispatchDueAlertDeliveries(opts: { sender?: typeof sendDiscordWebhook } = {}): Promise<void> {
  if (!env.alerts.enabled) return;
  const db = getPrismaClient();
  const now = new Date();
  const due = await db.alertChannelDelivery.findMany({
    where: {
      status: "pending",
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: MAX_DISPATCH_PER_PASS,
    select: { id: true, deliveryId: true, channelId: true, attempts: true },
  });

  const sender = opts.sender ?? sendDiscordWebhook;
  // Decrypt lazily per distinct channel so one pass never decrypts twice.
  const urlCache = new Map<string, string | null>();

  for (const row of due) {
    try {
      let webhookUrl = urlCache.get(row.channelId);
      if (webhookUrl === undefined) {
        webhookUrl = await decryptChannelUrl(db, row.channelId);
        urlCache.set(row.channelId, webhookUrl);
      }
      if (webhookUrl === null) {
        await db.alertChannelDelivery.update({
          where: { id: row.id },
          data: { status: "failed", errorKind: "invalid_webhook", errorMessage: "Channel target is missing or unreadable.", nextAttemptAt: null },
        });
        continue;
      }
      const delivery = await db.alertDelivery.findUnique({
        where: { id: row.deliveryId },
        select: { title: true, message: true, dedupeKey: true },
      });
      if (!delivery) {
        // Cascade delete would normally remove this row; a dangling row is
        // a data anomaly — retire it instead of retrying forever.
        await db.alertChannelDelivery.update({
          where: { id: row.id },
          data: { status: "failed", errorKind: "invalid_webhook", errorMessage: "Alert no longer exists.", nextAttemptAt: null },
        });
        continue;
      }

      const content = buildDiscordContent({
        title: delivery.title,
        message: delivery.message,
        suffix: "Sent by TornScope alerts",
      });
      const result = await sender(webhookUrl, content, { timeoutMs: env.alerts.discordTimeoutMs });
      await applySendResult(db, row.id, row.attempts, result);
    } catch (err) {
      // Never let one broken channel stall the pass.
      logger.warn({ deliveryId: row.deliveryId, channelId: row.channelId, err: (err as Error).message }, "alert dispatch row failed");
    }
  }
}

/** Apply a send outcome to the ledger row (bounded retries, permanent kinds fail fast). */
async function applySendResult(
  db: ReturnType<typeof getPrismaClient>,
  rowId: string,
  attemptsSoFar: number,
  result: Awaited<ReturnType<typeof sendDiscordWebhook>>
): Promise<void> {
  if (result.outcome === "sent") {
    await db.alertChannelDelivery.update({
      where: { id: rowId },
      data: { status: "sent", sentAt: new Date(), nextAttemptAt: null, errorKind: null, errorMessage: null },
    });
    return;
  }

  const attempts = attemptsSoFar + 1;
  const errorKind: DiscordErrorKind = result.outcome === "rate_limited" ? "rate_limited" : result.errorKind;
  const message = result.outcome === "rate_limited" ? "Discord rate-limited the delivery." : result.message;

  const transient = isTransientDiscordError(errorKind);
  // ALERT_DELIVERY_MAX_RETRIES counts RETRIES beyond the first attempt: a
  // value of 5 allows at most 6 sends before the row is marked failed.
  if (transient && attempts < env.alerts.deliveryMaxRetries + 1) {
    const delaySec =
      result.outcome === "rate_limited" ? Math.min(3600, result.retryAfterSec) : retryDelaySeconds(attempts - 1);
    await db.alertChannelDelivery.update({
      where: { id: rowId },
      data: { attempts, nextAttemptAt: new Date(Date.now() + delaySec * 1000), errorKind, errorMessage: message },
    });
    logger.info({ deliveryRowId: rowId, attempts, errorKind, retryInSec: delaySec }, "alert dispatch retry scheduled");
    return;
  }
  await db.alertChannelDelivery.update({
    where: { id: rowId },
    data: { status: "failed", attempts, nextAttemptAt: null, errorKind, errorMessage: message },
  });
  logger.warn({ deliveryRowId: rowId, attempts, errorKind }, "alert dispatch failed permanently");
}

/** Decrypt a channel's webhook URL; null when the row or payload is broken. */
export async function decryptChannelUrl(db: ReturnType<typeof getPrismaClient>, channelId: string): Promise<string | null> {
  const channel = await db.alertChannel.findUnique({
    where: { id: channelId },
    select: { encryptedKey: true, iv: true, authTag: true, enabled: true },
  });
  if (!channel || !channel.enabled) return null;
  try {
    return decryptor().decrypt(channel);
  } catch {
    return null;
  }
}
