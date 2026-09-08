import webpush from "web-push";
import { getPrismaClient, EncryptionService, encryptionFromEnv } from "@tornscope/database";
import {
  checkPushEndpoint,
  classifyAttentionEvent,
  CATEGORY_IMPORTANCE,
  DEFAULT_CATEGORY_STATE,
  type NotificationImportance,
} from "@tornscope/shared";
import { env, logger } from "../env.js";

/**
 * Central notification engine (runs inside the existing worker process).
 *
 * Sources, evaluated at most every MIN_EVALUATE_SECONDS:
 * 1. TIMER TRANSITIONS — one live Torn call per user ONLY when a tracked
 *    timer can have changed (nextEligibleAt), never a per-minute poll.
 * 2. TIMELINE ATTENTION — only TimelineEvents inserted AFTER the last
 *    evaluated id AND after the activation boundary (enabledAt), so
 *    backfills and history imports can never flood.
 *
 * Delivery is deduplicated by the NotificationDelivery unique constraint
 * (subscriptionId + eventKey + notificationType); a worker restart cannot
 * resend. 404/410 push responses revoke the dead subscription.
 */

const MIN_EVALUATE_SECONDS = 120;
const IDLE_RECHECK_SECONDS = 600;
const TIMER_GRACE_SECONDS = 45;
const MAX_EVENTS_PER_TICK = 20;

let webpushReady = false;
let lastRunAt = 0;
let encryption: EncryptionService | null = null;

function pushReady(): boolean {
  return process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? true : false;
}

function webpushClient(): typeof webpush {
  if (!webpushReady) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT ?? "mailto:alerts@tornscope.local",
      process.env.VAPID_PUBLIC_KEY ?? "",
      process.env.VAPID_PRIVATE_KEY ?? ""
    );
    webpushReady = true;
  }
  return webpush;
}

function decryptor(): EncryptionService {
  if (!encryption) encryption = encryptionFromEnv();
  return encryption;
}

export interface NotificationEvent {
  category: string;
  importance: NotificationImportance;
  title: string;
  body: string;
  eventKey: string;
  clickPath: string;
}

/** In-worker delivery (mirrors the API's test path incl. revoke handling). */
async function deliver(
  userId: string,
  event: NotificationEvent,
  sensitiveDetails: boolean,
  quietMinutes: { start: number | null; end: number | null; timezone: string }
): Promise<{ sent: number; revoked: number; skipped: number }> {
  const db = getPrismaClient();
  const subs = await db.pushSubscription.findMany({
    where: { userId, revokedAt: null },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subs.length === 0) return { sent: 0, revoked: 0, skipped: 0 };

  // Quiet hours (user timezone): non-critical events are dropped (v1 keeps
  // this conservative — the transition diff will not regenerate them).
  if (event.importance !== "critical" && quietMinutes.start !== null && quietMinutes.end !== null) {
    const nowLocal = localMinutes(quietMinutes.timezone);
    const inQuiet =
      quietMinutes.start < quietMinutes.end
        ? nowLocal >= quietMinutes.start && nowLocal < quietMinutes.end
        : nowLocal >= quietMinutes.start || nowLocal < quietMinutes.end;
    if (inQuiet) {
      logger.debug({ userId, category: event.category }, "notification suppressed by quiet hours");
      return { sent: 0, revoked: 0, skipped: subs.length };
    }
  }

  const body = sensitiveDetails ? event.body : event.body; // body selection happens at classification time
  void body;
  const payload = JSON.stringify({
    title: event.title,
    body: event.body,
    url: event.clickPath,
    tag: `${event.category}:${event.eventKey}`,
    icon: "/icons/tornscope-notifications-192.png",
    badge: "/icons/tornscope-badge-monochrome.png",
  });

  let sent = 0;
  let revoked = 0;
  for (const sub of subs) {
    // Dedup ledger: the unique constraint makes restarts/resends idempotent.
    try {
      await db.notificationDelivery.create({
        data: { userId, subscriptionId: sub.id, eventKey: event.eventKey, notificationType: event.category },
      });
    } catch {
      continue; // already delivered to this device
    }
    try {
      // SSRF guard (defense in depth — endpoints are validated at subscribe
      // time): a stored endpoint pointing at loopback/private space is never
      // legitimate, so revoke it instead of POSTing into the network.
      if (!checkPushEndpoint(sub.endpoint).allowed) {
        await db.pushSubscription.update({ where: { id: sub.id }, data: { revokedAt: new Date() } }).catch(() => undefined);
        revoked += 1;
        continue;
      }
      const wp = webpushClient();
      await wp.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      sent += 1;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await db.pushSubscription.update({ where: { id: sub.id }, data: { revokedAt: new Date() } }).catch(() => undefined);
        revoked += 1;
      } else {
        logger.warn({ userId, status, err: (err as Error).message }, "push delivery failed");
      }
    }
  }
  return { sent, revoked, skipped: 0 };
}

function localMinutes(timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone }).format(new Date());
    const [h, m] = parts.split(":").map((v) => Number(v));
    return h! * 60 + m!;
  } catch {
    const d = new Date();
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

interface LiveTimerState {
  cooldownDrugEndsAt?: number | null;
  cooldownMedicalEndsAt?: number | null;
  cooldownBoosterEndsAt?: number | null;
  travelLandsAt?: number | null;
  hospitalizedUntil?: number | null;
  jailedUntil?: number | null;
  educationEndsAt?: number | null;
  bankMaturesAt?: number | null;
  energyFullAt?: number | null;
  nerveFullAt?: number | null;
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
    ...(minIntervalMs > 0 ? {} : {}),
  };
}

interface TimerRule {
  key: keyof LiveTimerState;
  category: string;
  label: string;
  landedLabel: string;
}

const TIMER_RULES: TimerRule[] = [
  { key: "travelLandsAt", category: "travel", label: "Traveling", landedLabel: "Travel landed", },
  { key: "hospitalizedUntil", category: "hospital_jail", label: "Hospitalized", landedLabel: "You have been released from hospital." },
  { key: "jailedUntil", category: "hospital_jail", label: "Jailed", landedLabel: "You have been released from jail." },
  { key: "cooldownDrugEndsAt", category: "cooldowns", label: "Drug cooldown", landedLabel: "Your drug cooldown is ready." },
  { key: "cooldownMedicalEndsAt", category: "cooldowns", label: "Medical cooldown", landedLabel: "Your medical cooldown is ready." },
  { key: "cooldownBoosterEndsAt", category: "cooldowns", label: "Booster cooldown", landedLabel: "Your booster cooldown is ready." },
  { key: "educationEndsAt", category: "education", label: "Education", landedLabel: "Your education course has completed." },
  { key: "bankMaturesAt", category: "bank", label: "Bank investment", landedLabel: "Your bank investment has matured." },
  { key: "energyFullAt", category: "energy_nerve", label: "Energy", landedLabel: "Your energy is full." },
  { key: "nerveFullAt", category: "energy_nerve", label: "Nerve", landedLabel: "Your nerve is full." },
];

/** Detect active → ready transitions between the previous and new snapshots. */
function diffTimers(previous: LiveTimerState | null, current: LiveTimerState, nowSec: number): { events: NotificationEvent[]; nextEligibleAt: number | null } {
  const events: NotificationEvent[] = [];
  let nextEligibleAt: number | null = null;
  for (const rule of TIMER_RULES) {
    const prevEnd = previous?.[rule.key] ?? null;
    const curEnd = current[rule.key] ?? null;
    // transition: previously active (end in the future at that time) and now
    // no longer active (ended).
    if (prevEnd !== null && curEnd === null && prevEnd <= nowSec + TIMER_GRACE_SECONDS) {
      events.push({
        category: rule.category,
        importance: CATEGORY_IMPORTANCE[rule.category] ?? "important",
        title: rule.label,
        body: rule.landedLabel,
        eventKey: `${rule.key}:ended:${prevEnd}`,
        clickPath: rule.category === "travel" ? "/travel" : rule.category === "bank" ? "/economy" : "/today",
      });
    }
    if (curEnd !== null && curEnd > nowSec) {
      const eligible = curEnd + TIMER_GRACE_SECONDS;
      if (nextEligibleAt === null || eligible < nextEligibleAt) nextEligibleAt = eligible;
    }
  }
  return { events, nextEligibleAt };
}

async function evaluateUser(userId: string, timezone: string): Promise<void> {
  const db = getPrismaClient();
  const prefs = await db.notificationPreference.findUnique({ where: { userId } });
  if (!prefs) return;
  const categories = { ...DEFAULT_CATEGORY_STATE, ...(prefs.categories as Record<string, boolean> | null) };
  const importanceOf = (category: string): NotificationImportance => CATEGORY_IMPORTANCE[category] ?? "important";
  const enabled = (category: string): boolean => categories[category] === true;

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
      where: { userId, seq: { gt: lastSeq }, occurredAt: { gte: new Date(prefs.enabledAt.getTime() * 1000 - 60_000) } },
      orderBy: { id: "asc" },
      take: MAX_EVENTS_PER_TICK,
      select: { id: true, title: true, seq: true },
    });
    for (const row of rows) {
      const cls = classifyAttentionEvent(row.title);
      if (cls !== null && enabled(cls.category)) {
        await deliver(userId, {
          category: cls.category,
          importance: cls.importance,
          title: cls.title,
          body: prefs.sensitiveDetails && cls.sensitiveBody ? cls.sensitiveBody : cls.body,
          eventKey: cls.eventKey,
          clickPath: cls.clickPath,
        }, prefs.sensitiveDetails, { start: prefs.quietStartMin, end: prefs.quietEndMin, timezone });
      }
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
      const { events, nextEligibleAt } = diffTimers(previous, current, nowSec);
      for (const event of events) {
        if (!enabled(event.category)) continue;
        event.importance = importanceOf(event.category);
        // Privacy default: bodies are transition-safe (no amounts). Timer
        // bodies never contain sensitive material, so sensitiveDetails only
        // affects timeline events today.
        await deliver(userId, event, prefs.sensitiveDetails, { start: prefs.quietStartMin, end: prefs.quietEndMin, timezone });
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
      await evaluateUser(userId, user.timezone).catch((err: Error) =>
        logger.warn({ userId, err: err.message }, "notification evaluation failed")
      );
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "notification evaluation tick failed");
  }
}
