import webpush from "web-push";
import { getPrismaClient, EncryptionService, encryptionFromEnv } from "@tornscope/database";
import {
  checkPushEndpoint,
  classifyAttentionEvent,
  classifyPushSendOutcome,
  DEFAULT_TYPE_TOGGLES,
  decideQuietHours,
  diffTimerTransitions,
  notificationType,
  normalizeTypeToggles,
  normalizeTypeConfig,
  providerRejectionReason,
  type LiveTimerState,
  type QuietHoursSettings,
  type ResolvedTypeConfig,
} from "@tornscope/shared";
import { localMinutesInZone, nextWallClockOccurrence } from "@tornscope/shared";
import { env, logger } from "../env.js";
import {
  evaluateSystemProducer,
  evaluateEnergyProducer,
  evaluateProgressionProducer,
  evaluateEconomyProducer,
  evaluateDailySummaryProducer,
} from "./producers.js";

/**
 * Central notification engine (runs inside the existing worker process).
 *
 * ARCHITECTURE (docs/NOTIFICATIONS.md):
 *   producers (thin, state-transition driven)
 *     → ingest(): ONE canonical path — registry lookup, preference toggle,
 *       capability gate, freshness gate, profile-level dedupe
 *       (NotificationEvent.userId+dedupeKey unique), quiet-hours decision
 *       (deliver / DEFER with expiry / suppress with machine reason)
 *     → per-device deliveries (pending → sent | failed→bounded retry |
 *       invalid_subscription + revoke on 404/410)
 *
 * Sources, evaluated at most every MIN_EVALUATE_SECONDS:
 * 1. DEFERRED FLUSH — deferred events whose quiet hours ended; stale ones
 *    expire instead of delivering useless morning alerts.
 * 2. RETRY — bounded backoff for transient push failures.
 * 3. TIMER TRANSITIONS — one live Torn call per user ONLY when a tracked
 *    timer can have changed (nextEligibleAt), never a per-minute poll.
 *    (Energy/nerve are NOT timers — they are owned by the bars producer.)
 * 4. TIMELINE ATTENTION — only TimelineEvents inserted AFTER the last
 *    evaluated id AND after the activation boundary (enabledAt), so
 *    backfills and history imports can never flood.
 * 5. BARS / SYSTEM / PROGRESSION / ECONOMY / DAILY SUMMARY producers —
 *    each with its own first-observation suppression and age guards
 *    (see producers.ts).
 *
 * Demo profiles are never evaluated and never push.
 */

const MIN_EVALUATE_SECONDS = 120;
const IDLE_RECHECK_SECONDS = 600;
const TIMER_GRACE_SECONDS = 45;
const MAX_EVENTS_PER_TICK = 20;
/** Bounded retry backoff (minutes) for transient push failures. */
export const RETRY_BACKOFF_MINUTES = [5, 25, 125];
/** Bars snapshots older than this never drive energy notifications. */
export const BARS_MAX_AGE_SECONDS = 15 * 60;
/** Source events older than this are never notified, even if newly seen. */
export const SOURCE_MAX_AGE_SECONDS = 6 * 3600;

let webpushReady = false;
let lastRunAt = 0;
let encryption: EncryptionService | null = null;

function pushReady(): boolean {
  return process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? true : false;
}

/** VAPID subject fallback mirroring the API's env.ts rule: the public https
 *  origin when known. Apple's push service rejects reserved-TLD mailto:
 *  subjects with 403 BadJwtToken (1.0.3 production finding), so the inert
 *  mailto default is only for dev setups with no public origin. */
function vapidSubject(): string {
  const explicit = (process.env.VAPID_SUBJECT ?? "").trim();
  if (explicit) return explicit;
  const publicOrigin = (process.env.PUBLIC_BASE_URL ?? "").trim();
  return /^https:\/\/\S+$/i.test(publicOrigin) ? publicOrigin : "mailto:alerts@tornscope.local";
}

function webpushClient(): typeof webpush {
  if (!webpushReady) {
    webpush.setVapidDetails(vapidSubject(), process.env.VAPID_PUBLIC_KEY ?? "", process.env.VAPID_PRIVATE_KEY ?? "");
    webpushReady = true;
  }
  return webpush;
}

function decryptor(): EncryptionService {
  if (!encryption) encryption = encryptionFromEnv();
  return encryption;
}

/** A notification draft produced by ANY producer. Privacy-safe bodies only. */
export interface NotificationDraft {
  type: string;
  /** Deterministic profile-level identity of the logical event. */
  dedupeKey: string;
  /** When the underlying fact happened (epoch sec) — never "now" for facts. */
  occurredAt: number;
  title: string;
  body: string;
  sensitiveBody?: string | null;
  clickPath?: string;
  provenance?: "exact" | "derived" | "estimated" | "inferred";
  /** Explicit user action (test push): bypasses quiet hours deferral. */
  explicit?: boolean;
}

export interface IngestContext {
  userId: string;
  timezone: string;
  toggles: Record<string, boolean>;
  sensitiveDetails: boolean;
  quiet: QuietHoursSettings;
  enabledAtSec: number;
  capabilities: Record<string, boolean> | null;
  config: ResolvedTypeConfig;
}

export type IngestOutcome = "created" | "duplicate" | "dropped_disabled" | "dropped_capability" | "dropped_stale";

/**
 * THE canonical ingest path. Everything a user ever receives (or silently
 * doesn't) flows through here, so reasons and dedupe behave identically for
 * every producer.
 */
export async function ingest(userId: string, draft: NotificationDraft, ctx: IngestContext): Promise<IngestOutcome> {
  const db = getPrismaClient();
  const meta = notificationType(draft.type);
  if (!meta) return "dropped_disabled";

  // 1. User toggle (explicit choice — nothing recorded: the user decided).
  if (!draft.explicit && ctx.toggles[meta.id] !== true) return "dropped_disabled";

  // 2. Activation boundary: no notification for facts observed before push
  //    was enabled (or long-stale source events).
  const nowSec = Math.floor(Date.now() / 1000);
  if (draft.occurredAt < ctx.enabledAtSec - 60) return "dropped_stale";
  if (!draft.explicit && nowSec - draft.occurredAt > SOURCE_MAX_AGE_SECONDS) return "dropped_stale";

  // 3. Capability gate — recorded (rare, explainable), never silent.
  if (!draft.explicit && meta.requires && ctx.capabilities?.[meta.requires as keyof typeof ctx.capabilities] === false) {
    await db.notificationEvent.create({
      data: {
        userId, type: meta.id, dedupeKey: draft.dedupeKey, occurredAt: new Date(draft.occurredAt * 1000),
        title: draft.title, body: draft.body, clickPath: draft.clickPath ?? meta.clickPath,
        provenance: draft.provenance ?? meta.provenance, status: "suppressed", reason: "missing_capability",
      },
    }).catch(() => undefined);
    return "dropped_capability";
  }

  // 4. Profile-level dedupe: one logical event, ever, regardless of devices,
  //    ticks or restarts. The unique constraint is the source of truth.
  let event;
  try {
    event = await db.notificationEvent.create({
      data: {
        userId, type: meta.id, dedupeKey: draft.dedupeKey, occurredAt: new Date(draft.occurredAt * 1000),
        title: draft.title, body: draft.explicit ? draft.body : (ctx.sensitiveDetails && draft.sensitiveBody ? draft.sensitiveBody : draft.body),
        clickPath: draft.clickPath ?? meta.clickPath, provenance: draft.provenance ?? meta.provenance,
      },
    });
  } catch {
    return "duplicate";
  }

  // 5. Quiet hours: deliver / DEFER (with expiry) / suppress — never silently
  //    drop. Explicit user actions (test) are never deferred.
  const nowLocal = localMinutesInZone(nowSec, ctx.timezone);
  const quietEndSec = ctx.quiet.endMin !== null ? nextWallClockOccurrence(ctx.quiet.endMin, ctx.timezone, nowSec) : null;
  const decision = decideQuietHours(meta, ctx.quiet, nowLocal, { quietEndSec, explicit: draft.explicit });
  if (decision.action === "defer") {
    await db.notificationEvent.update({
      where: { id: event.id },
      data: {
        status: "deferred",
        deliverAt: new Date(decision.deliverAtSec * 1000),
        expiresAt: new Date((draft.occurredAt + meta.maxDeferralAgeSeconds) * 1000),
      },
    });
    return "created";
  }
  if (decision.action === "suppress") {
    await db.notificationEvent.update({ where: { id: event.id }, data: { status: "suppressed", reason: decision.reason } });
    return "created";
  }

  await deliverEvent(userId, event.id, { ...draft, title: event.title, body: event.body, clickPath: event.clickPath });
  return "created";
}

/**
 * Deliver one logical event to every active subscription. Per-device ledger
 * rows record the real outcome; transient failures get bounded retries.
 */
export async function deliverEvent(
  userId: string,
  eventId: string,
  draft: NotificationDraft
): Promise<{ sent: number; revoked: number; failed: number }> {
  const db = getPrismaClient();
  const subs = await db.pushSubscription.findMany({
    where: { userId, revokedAt: null },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  return deliverToSubscriptions(userId, eventId, draft, subs);
}

/** Delivery fan-out shared by first delivery, deferral flush and retries. */
async function deliverToSubscriptions(
  userId: string,
  eventId: string,
  draft: NotificationDraft,
  subs: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>
): Promise<{ sent: number; revoked: number; failed: number }> {
  const db = getPrismaClient();
  const meta = notificationType(draft.type);
  const payload = JSON.stringify({
    title: draft.title,
    body: draft.body,
    url: draft.clickPath ?? meta?.clickPath ?? "/today",
    tag: `${draft.type}:${draft.dedupeKey}`,
    icon: "/icons/tornscope-notifications-192.png",
    badge: "/icons/tornscope-badge-monochrome.png",
  });

  let sent = 0;
  let revoked = 0;
  let failed = 0;
  for (const sub of subs) {
    // Per-device dedupe: the unique constraint makes retries idempotent.
    let deliveryId: string;
    try {
      const row = await db.notificationDelivery.create({
        data: {
          userId,
          subscriptionId: sub.id,
          eventKey: draft.dedupeKey,
          notificationType: draft.type,
          eventId,
          status: "pending",
          attempts: 0,
        },
        select: { id: true },
      });
      deliveryId = row.id;
    } catch {
      continue; // already delivered/attempted for this device
    }
    const outcome = await sendToSubscriptionRow(sub, payload);
    if (outcome === "sent") {
      await db.notificationDelivery.update({
        where: { id: deliveryId },
        data: { status: "sent", sentAt: new Date() },
      });
      sent += 1;
    } else if (outcome === "gone") {
      await db.notificationDelivery.update({
        where: { id: deliveryId },
        data: { status: "invalid_subscription", reason: "invalid_subscription" },
      });
      await db.pushSubscription.update({ where: { id: sub.id }, data: { revokedAt: new Date() } }).catch(() => undefined);
      revoked += 1;
    } else {
      await db.notificationDelivery.update({
        where: { id: deliveryId },
        data: { status: "failed", attempts: 1, nextAttemptAt: new Date(Date.now() + RETRY_BACKOFF_MINUTES[0]! * 60_000) },
      });
      failed += 1;
    }
  }

  await db.notificationEvent.update({
    where: { id: eventId },
    data: {
      status: sent > 0 ? "delivered" : subs.length === 0 ? "suppressed" : "failed",
      reason: subs.length === 0 ? "device_disabled" : null,
    },
  }).catch(() => undefined);
  return { sent, revoked, failed };
}

async function sendToSubscriptionRow(
  sub: { id: string; endpoint: string; p256dh: string; auth: string },
  payload: string
): Promise<"sent" | "gone" | "error"> {
  // SSRF guard (defense in depth — endpoints are validated at subscribe
  // time): a stored endpoint pointing at loopback/private space is never
  // legitimate, so revoke it instead of POSTing into the network.
  if (!checkPushEndpoint(sub.endpoint).allowed) return "gone";
  try {
    const wp = webpushClient();
    await wp.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
    return "sent";
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    // 401/403 are SERVER-CONFIG rejections (bad VAPID subject/keys — 1.0.3:
    // Apple answered 403 BadJwtToken while the subscription was fine), so
    // they must NOT revoke; they retry like transient failures. Only the
    // provider saying the subscription no longer exists (404/410) revokes.
    const outcome = classifyPushSendOutcome(status);
    logger.warn(
      {
        subscriptionId: sub.id,
        endpointHost: safeEndpointHost(sub.endpoint),
        outcome,
        statusCode: status ?? null,
        providerReason: providerRejectionReason((err as { body?: unknown }).body),
      },
      "push delivery failed"
    );
    return outcome === "gone" ? "gone" : "error";
  }
}

/** Host of a push endpoint for logging — never the full endpoint (it
 *  embeds the subscription token). Unparsable endpoints log as null. */
function safeEndpointHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Ticks: deferral flush + bounded retry                                       */
/* -------------------------------------------------------------------------- */

/** Deliver due deferred events; expire stale ones instead of sending them. */
export async function flushDeferredForUser(userId: string, ctx: IngestContext): Promise<void> {
  const db = getPrismaClient();
  const now = new Date();
  const due = await db.notificationEvent.findMany({
    where: { userId, status: "deferred", deliverAt: { lte: now } },
    orderBy: { occurredAt: "asc" },
    take: MAX_EVENTS_PER_TICK,
  });
  for (const event of due) {
    if (event.expiresAt !== null && event.expiresAt < now) {
      await db.notificationEvent.update({ where: { id: event.id }, data: { status: "expired", reason: "expired" } }).catch(() => undefined);
      continue;
    }
    await deliverEvent(userId, event.id, {
      type: event.type,
      dedupeKey: event.dedupeKey,
      occurredAt: Math.floor(event.occurredAt.getTime() / 1000),
      title: event.title,
      body: event.body,
      clickPath: event.clickPath,
    });
  }
  void ctx;
}

/** Bounded retries for events whose every device attempt failed. */
export async function retryFailedForUser(userId: string): Promise<void> {
  const db = getPrismaClient();
  const now = new Date();
  const events = await db.notificationEvent.findMany({
    where: { userId, status: "failed" },
    orderBy: { occurredAt: "asc" },
    take: MAX_EVENTS_PER_TICK,
  });
  for (const event of events) {
    const pending = await db.notificationDelivery.findMany({
      where: { eventId: event.id, status: "failed", nextAttemptAt: { lte: now }, attempts: { lt: RETRY_BACKOFF_MINUTES.length } },
      include: { subscription: true },
    });
    let anySent = false;
    for (const delivery of pending) {
      if (delivery.subscription.revokedAt !== null) {
        await db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: "invalid_subscription", reason: "device_disabled" } });
        continue;
      }
      const payload = JSON.stringify({
        title: event.title, body: event.body, url: event.clickPath,
        tag: `${event.type}:${event.dedupeKey}`,
        icon: "/icons/tornscope-notifications-192.png",
        badge: "/icons/tornscope-badge-monochrome.png",
      });
      const outcome = await sendToSubscriptionRow(delivery.subscription, payload);
      if (outcome === "sent") {
        await db.notificationDelivery.update({
          where: { id: delivery.id },
          data: { status: "sent", sentAt: new Date(), attempts: { increment: 1 }, nextAttemptAt: null },
        });
        anySent = true;
      } else if (outcome === "gone") {
        await db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: "invalid_subscription", reason: "invalid_subscription" } });
        await db.pushSubscription.update({ where: { id: delivery.subscriptionId }, data: { revokedAt: new Date() } }).catch(() => undefined);
      } else {
        const attempts = delivery.attempts + 1;
        const next = RETRY_BACKOFF_MINUTES[attempts];
        await db.notificationDelivery.update({
          where: { id: delivery.id },
          data: { attempts, nextAttemptAt: next ? new Date(Date.now() + next * 60_000) : null, lastError: "transient" },
        });
      }
    }
    if (anySent) {
      await db.notificationEvent.update({ where: { id: event.id }, data: { status: "delivered", reason: null } }).catch(() => undefined);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Per-user evaluation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Activation boundary for timeline attention: the instant push was enabled,
 * minus 60s of clock slack. `enabledAt` comes from Prisma, whose DateTime is
 * already epoch MILLISECONDS — multiplying again yields Dates in far-future
 * millennia that the query engine rejects outright (regression 1.0.1: the
 * crashed findMany left the timeline cursor frozen and the evaluation
 * retry-looping every tick for affected users).
 */
export function timelineActivationBoundary(enabledAt: Date): Date {
  return new Date(enabledAt.getTime() - 60_000);
}

/** One live Torn call for all timer sources (single /user selection set). */
async function fetchLiveTimers(userId: string, tornBaseUrl: string, minIntervalMs: number): Promise<LiveTimerState | null> {
  const db = getPrismaClient();
  const cred = await db.apiCredential.findFirst({ where: { userId, revokedAt: null }, orderBy: { createdAt: "desc" } });
  if (!cred) return null;
  let apiKey: string;
  try {
    apiKey = decryptor().decrypt(cred);
  } catch {
    return null;
  }
  const selections = "bars,cooldowns,education,travel,money,basic";
  const res = await fetch(`${tornBaseUrl}/user?selections=${selections}`, {
    headers: { Authorization: `ApiKey ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as any;
  if (!body || body.error) return null;

  const now = Math.floor(Date.now() / 1000);
  const cd = body.cooldowns ?? {};
  const toTs = (sec: unknown): number | null => (typeof sec === "number" && sec > 0 ? now + sec : null);
  return {
    cooldownDrugEndsAt: toTs(cd.drug),
    cooldownMedicalEndsAt: toTs(cd.medical),
    cooldownBoosterEndsAt: toTs(cd.booster),
    travelLandsAt: body.travel?.time_left !== undefined && body.travel?.traveling === true ? toTs(body.travel.time_left) : null,
    hospitalizedUntil: typeof body.basic?.status?.until === "number" && body.basic?.status?.state === "Hospital" ? body.basic.status.until : null,
    jailedUntil: typeof body.basic?.status?.until === "number" && body.basic?.status?.state === "Jail" ? body.basic.status.until : null,
    educationEndsAt: typeof body.education?.timeleft === "number" && body.education.timeleft > 0 ? now + body.education.timeleft : null,
    bankMaturesAt: typeof body.money?.city_bank?.until === "number" && body.money.city_bank.until > now ? body.money.city_bank.until : null,
    energyFullAt: toTs(body.bars?.energy?.fulltime),
    nerveFullAt: toTs(body.bars?.nerve?.fulltime),
  };
}

async function evaluateUser(userId: string, timezone: string): Promise<void> {  const db = getPrismaClient();
  const prefs = await db.notificationPreference.findUnique({ where: { userId } });
  if (!prefs) return;
  const [credential] = await Promise.all([
    db.apiCredential.findFirst({ where: { userId, revokedAt: null }, select: { capabilities: true, accessLevel: true } }),
  ]);
  const { hasCompleteCapabilityShape, normalizeCapabilitiesWithFallback } = await import("@tornscope/shared");
  const capabilities = credential && hasCompleteCapabilityShape(credential.capabilities)
    ? (normalizeCapabilitiesWithFallback(credential.capabilities, credential.accessLevel) as Record<string, boolean> | null)
    : null;

  const ctx: IngestContext = {
    userId,
    timezone,
    toggles: normalizeTypeToggles({ ...DEFAULT_TYPE_TOGGLES, ...(prefs.categories as Record<string, boolean> | null) }),
    sensitiveDetails: prefs.sensitiveDetails,
    quiet: { startMin: prefs.quietStartMin, endMin: prefs.quietEndMin, bypassCritical: prefs.bypassCritical },
    enabledAtSec: Math.floor(prefs.enabledAt.getTime() / 1000),
    capabilities,
    config: normalizeTypeConfig(prefs.typeConfig),
  };

  await flushDeferredForUser(userId, ctx);
  await retryFailedForUser(userId);

  // ---- Timeline attention: only rows beyond the cursor AND after activation
  const state = await db.notificationState.findUnique({ where: { userId } });
  const lastSeq = state?.lastTimelineSeq ?? 0n;
  const newest = await db.timelineEvent.findFirst({ where: { userId }, orderBy: { seq: "desc" }, select: { seq: true } });
  const maxSeq: bigint = newest?.seq ?? 0n;
  if (state === null) {
    // First observation: start at the current high-water mark — never push history.
    await db.notificationState.create({ data: { userId, lastTimelineSeq: maxSeq } });
    return;
  }
  if (maxSeq > lastSeq) {
    const rows = await db.timelineEvent.findMany({
      where: { userId, seq: { gt: lastSeq }, occurredAt: { gte: timelineActivationBoundary(prefs.enabledAt) } },
      orderBy: { id: "asc" },
      take: MAX_EVENTS_PER_TICK,
      select: { id: true, title: true, seq: true, occurredAt: true },
    });
    for (const row of rows) {
      const cls = classifyAttentionEvent(row.title);
      if (cls === null) continue;
      await ingest(userId, {
        type: cls.type,
        dedupeKey: cls.eventKey,
        occurredAt: Math.floor(row.occurredAt.getTime() / 1000),
        title: cls.title,
        body: cls.body,
        sensitiveBody: cls.sensitiveBody,
        clickPath: cls.clickPath,
      }, ctx);
    }
    if (rows.length === MAX_EVENTS_PER_TICK) {
      // More rows pending: advance to the last processed row only.
      const lastProcessed = rows[rows.length - 1]!.seq;
      await db.notificationState.update({ where: { userId }, data: { lastTimelineSeq: lastProcessed } });
      return;
    }
    await db.notificationState.update({ where: { userId }, data: { lastTimelineSeq: maxSeq } });
  }

  // ---- Timer transitions: gated by nextEligibleAt ------------------------
  if (pushReady() && (state.nextEligibleAt === null || state.nextEligibleAt.getTime() <= Date.now())) {
    let current: LiveTimerState | null = null;
    try {
      current = await fetchLiveTimers(userId, env.tornBaseUrl, env.tornMinRequestIntervalMs);
    } catch (err) {
      logger.warn({ userId, err: (err as Error).message }, "notification timer fetch failed");
    }
    if (current !== null) {
      const previous = (state.previousState ?? null) as LiveTimerState | null;
      const nowSec = Math.floor(Date.now() / 1000);
      const { events, nextEligibleAt } = diffTimerTransitions(previous, current, nowSec, TIMER_GRACE_SECONDS);
      for (const event of events) {
        await ingest(userId, {
          type: event.type,
          dedupeKey: event.eventKey,
          occurredAt: nowSec,
          title: event.title,
          body: event.body,
          clickPath: event.clickPath,
        }, ctx);
      }
      await db.notificationState.update({
        where: { userId },
        data: {
          previousState: current as never,
          nextEligibleAt: nextEligibleAt !== null ? new Date(nextEligibleAt * 1000) : new Date(Date.now() + IDLE_RECHECK_SECONDS * 1000),
        },
      });
    } else {
      await db.notificationState.update({
        where: { userId },
        data: { nextEligibleAt: new Date(Date.now() + IDLE_RECHECK_SECONDS * 1000) },
      });
    }
  }

  // ---- Stored-data producers (bars energy, system, progression, economy) --
  // Each owns its NotificationState.systemState slice and persists it via
  // updateSystemState; first observation initializes state without notifying.
  const updateSystemState = async (patch: Record<string, unknown>): Promise<void> => {
    const current = (await db.notificationState.findUnique({ where: { userId }, select: { systemState: true } }))?.systemState ?? {};
    await db.notificationState.update({
      where: { userId },
      data: { systemState: { ...(current as Record<string, unknown>), ...patch } as never },
    }).catch(() => undefined);
  };
  await evaluateEnergyProducer(ctx, (state?.systemState ?? null) as Record<string, unknown> | null, updateSystemState, BARS_MAX_AGE_SECONDS);
  await evaluateSystemProducer(ctx, (state?.systemState ?? null) as Record<string, unknown> | null, updateSystemState);
  await evaluateProgressionProducer(ctx, (state?.systemState ?? null) as Record<string, unknown> | null, updateSystemState);
  await evaluateEconomyProducer(ctx, (state?.systemState ?? null) as Record<string, unknown> | null, updateSystemState);
  await evaluateDailySummaryProducer(ctx, updateSystemState);
}

/**
 * Evaluate notification events for every profile with an active device.
 * Called from the worker's 60s scheduler tick; self-throttled to at most
 * one run per MIN_EVALUATE_SECONDS. Demo profiles are never evaluated.
 */
export async function evaluateNotifications(): Promise<void> {
  if (!pushReady()) return;
  const now = Date.now();
  if (now - lastRunAt < MIN_EVALUATE_SECONDS * 1000) return;
  lastRunAt = now;
  const counters = { users: 0, failed: 0 };
  try {
    const db = getPrismaClient();
    const users = await db.pushSubscription.findMany({
      where: { revokedAt: null },
      select: { userId: true },
      distinct: ["userId"],
    });
    for (const { userId } of users) {
      const user = await db.user.findUnique({ where: { id: userId }, select: { isDemo: true, timezone: true } });
      if (!user || user.isDemo) continue;
      counters.users += 1;
      await evaluateUser(userId, user.timezone).catch((err: Error) => {
        counters.failed += 1;
        logger.warn({ userId, err: err.message }, "notification evaluation failed");
      });
    }
    logger.info({ users: counters.users, failed: counters.failed }, "notification tick complete");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "notification evaluation tick failed");
  }
}
