import webpush from "web-push";
import { getPrismaClient } from "@tornscope/database";
import { DEFAULT_CATEGORY_STATE, checkPushEndpoint } from "@tornscope/shared";
import { env } from "../env.js";
import { assertPublicEndpoint } from "./push-ssrf.js";
import { errors } from "../errors.js";
import type { SessionUser } from "../auth.js";

/**
 * Web Push delivery + subscription management.
 *
 * Privacy: payloads carry NO amounts/senders unless the profile's
 * sensitiveDetails preference is ON, and never any credential material.
 * Tenant isolation: a subscription is bound to the session's profile;
 * every query is userId-scoped. Endpoints are validated structurally at
 * subscribe time (push-endpoint.ts) so a user can never turn push sends
 * into server-side requests at internal addresses.
 */

/** Maximum concurrently-active push devices per profile (device-farm guard). */
export const MAX_ACTIVE_SUBSCRIPTIONS = 10;

export function pushConfigured(): boolean {
  return env.vapidPublicKey !== "" && env.vapidPrivateKey !== "";
}

function configuredWebPush(): typeof webpush {
  if (!pushConfigured()) throw errors.notFound("Push notifications are not configured on this server.");
  webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
  return webpush;
}

export interface IncomingSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface NotificationDeviceDto {
  id: string;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

export interface NotificationPreferencesDto {
  categories: Record<string, boolean>;
  sensitiveDetails: boolean;
  quietStartMin: number | null;
  quietEndMin: number | null;
  enabledAt: number | null;
}

export interface NotificationsStatusResponse {
  pushConfigured: boolean;
  devices: NotificationDeviceDto[];
  preferences: NotificationPreferencesDto;
}

function defaultPreferences(): NotificationPreferencesDto {
  return { categories: { ...DEFAULT_CATEGORY_STATE }, sensitiveDetails: false, quietStartMin: null, quietEndMin: null, enabledAt: null };
}

/** GET /api/notifications — status for the Settings section. */
export async function getNotificationsStatus(user: SessionUser, currentEndpoint: string | null): Promise<NotificationsStatusResponse> {
  const db = getPrismaClient();
  const [devices, prefs] = await Promise.all([
    db.pushSubscription.findMany({
      where: { userId: user.id, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, endpoint: true, userAgent: true, createdAt: true, lastSeenAt: true },
    }),
    db.notificationPreference.findUnique({ where: { userId: user.id } }),
  ]);
  return {
    pushConfigured: pushConfigured(),
    devices: devices.map((d) => ({
      id: d.id,
      userAgent: d.userAgent,
      createdAt: Math.floor(d.createdAt.getTime() / 1000),
      lastSeenAt: Math.floor(d.lastSeenAt.getTime() / 1000),
      current: currentEndpoint !== null && d.endpoint === currentEndpoint,
    })),
    preferences: prefs
      ? {
          categories: { ...DEFAULT_CATEGORY_STATE, ...(prefs.categories as Record<string, boolean>) },
          sensitiveDetails: prefs.sensitiveDetails,
          quietStartMin: prefs.quietStartMin,
          quietEndMin: prefs.quietEndMin,
          enabledAt: Math.floor(prefs.enabledAt.getTime() / 1000),
        }
      : defaultPreferences(),
  };
}

/** POST /api/notifications/subscribe — register THIS browser. */
export async function subscribePush(
  user: SessionUser,
  subscription: IncomingSubscription,
  userAgent: string | null
): Promise<{ ok: true }> {
  if (!pushConfigured()) throw errors.notFound("Push notifications are not configured on this server.");
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    throw errors.validation({ formErrors: ["Invalid subscription."], fieldErrors: {} });
  }
  // SSRF guard: the endpoint is later POSTed to by the worker — never allow
  // registrations pointing at loopback/private/internal addresses.
  const guard = checkPushEndpoint(subscription.endpoint);
  if (!guard.allowed) throw errors.validation({ formErrors: [guard.reason ?? "Invalid push endpoint."], fieldErrors: {} });
  const db = getPrismaClient();
  // Device cap: an active registration for THIS endpoint re-binds (no count
  // change); a genuinely new device is refused once the profile is full, so
  // one profile cannot accumulate unbounded push targets.
  const existing = await db.pushSubscription.findUnique({ where: { endpoint: subscription.endpoint }, select: { id: true, revokedAt: true } });
  if (!existing || existing.revokedAt !== null) {
    const activeCount = await db.pushSubscription.count({ where: { userId: user.id, revokedAt: null } });
    if (activeCount >= MAX_ACTIVE_SUBSCRIPTIONS) {
      throw errors.conflict(`Push notification limit reached (${MAX_ACTIVE_SUBSCRIPTIONS} devices). Remove an old device in Settings before enabling a new one.`);
    }
  }
  await db.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    // Re-subscribing re-binds the endpoint to the CURRENT profile: the
    // browser that proved session ownership owns the registration.
    create: {
      userId: user.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent,
    },
    update: {
      userId: user.id,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent,
      revokedAt: null,
      lastSeenAt: new Date(),
    },
  });
  // First activation establishes the anti-flood boundary.
  await db.notificationPreference.upsert({
    where: { userId: user.id },
    create: { userId: user.id, categories: { ...DEFAULT_CATEGORY_STATE } },
    update: {},
  });
  return { ok: true };
}

/** POST /api/notifications/unsubscribe — revoke by endpoint (this browser). */
export async function unsubscribePush(user: SessionUser, endpoint: string): Promise<{ ok: true }> {
  const db = getPrismaClient();
  await db.pushSubscription.updateMany({
    where: { userId: user.id, endpoint },
    data: { revokedAt: new Date() },
  });
  return { ok: true };
}

/** POST /api/notifications/disable-device — revoke another of MY devices. */
export async function disableDevice(user: SessionUser, subscriptionId: string): Promise<{ ok: true }> {
  const db = getPrismaClient();
  await db.pushSubscription.updateMany({
    where: { userId: user.id, id: subscriptionId },
    data: { revokedAt: new Date() },
  });
  return { ok: true };
}

/** POST /api/notifications/preferences — update toggles/quiet hours. */
export async function updatePreferences(
  user: SessionUser,
  prefs: Partial<NotificationPreferencesDto>
): Promise<NotificationPreferencesDto> {
  const db = getPrismaClient();
  const existing = await db.notificationPreference.findUnique({ where: { userId: user.id } });
  const row = await db.notificationPreference.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      categories: { ...DEFAULT_CATEGORY_STATE, ...(prefs.categories ?? {}) },
      sensitiveDetails: prefs.sensitiveDetails ?? false,
      quietStartMin: prefs.quietStartMin ?? null,
      quietEndMin: prefs.quietEndMin ?? null,
    },
    update: {
      ...(prefs.categories !== undefined ? { categories: { ...DEFAULT_CATEGORY_STATE, ...(existing?.categories as Record<string, boolean> ?? {}), ...prefs.categories } } : {}),
      ...(prefs.sensitiveDetails !== undefined ? { sensitiveDetails: prefs.sensitiveDetails } : {}),
      ...(prefs.quietStartMin !== undefined ? { quietStartMin: prefs.quietStartMin } : {}),
      ...(prefs.quietEndMin !== undefined ? { quietEndMin: prefs.quietEndMin } : {}),
    },
  });
  return {
    categories: { ...DEFAULT_CATEGORY_STATE, ...(row.categories as Record<string, boolean>) },
    sensitiveDetails: row.sensitiveDetails,
    quietStartMin: row.quietStartMin,
    quietEndMin: row.quietEndMin,
    enabledAt: Math.floor(row.enabledAt.getTime() / 1000),
  };
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  icon: string;
  badge: string;
}

/**
 * Send a payload to one subscription. Returns "gone" for 404/410 so callers
 * can revoke dead registrations instead of retrying forever. Endpoints that
 * fail the structural guard (e.g. legacy rows stored before endpoint
 * validation) are also reported "gone": they are never legitimate browser
 * registrations and must not be sent to.
 */
export async function sendToSubscription(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload
): Promise<"sent" | "gone" | "error"> {
  if (!checkPushEndpoint(sub.endpoint).allowed) return "gone";
  try {
    const wp = configuredWebPush();
    await wp.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return "sent";
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) return "gone";
    return "error";
  }
}

/** POST /api/notifications/test — real pipeline, this device only. */
export async function sendTestNotification(user: SessionUser, endpoint: string): Promise<{ sent: boolean }> {
  const db = getPrismaClient();
  const sub = await db.pushSubscription.findFirst({
    where: { userId: user.id, endpoint, revokedAt: null },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (!sub) throw errors.notFound("No active subscription for this browser — enable notifications first.");
  const payload: PushPayload = {
    title: "TornScope notifications are working",
    body: "You'll receive Torn alerts on this device.",
    url: "/today",
    tag: `test:${Date.now()}`,
    icon: "/icons/tornscope-notifications-192.png",
    badge: "/icons/tornscope-badge-monochrome.png",
  };
  const result = await sendToSubscription(sub, payload);
  if (result === "gone") {
    await db.pushSubscription.update({ where: { id: sub.id }, data: { revokedAt: new Date() } });
    throw errors.notFound("This browser's subscription has expired — re-enable notifications.");
  }
  return { sent: result === "sent" };
}

/** Shared icon paths (kept in one place for SW + API payloads). */
export const PUSH_ICONS = {
  icon: "/icons/tornscope-notifications-192.png",
  badge: "/icons/tornscope-badge-monochrome.png",
};

export function assertPushOwnership(user: SessionUser, subscriptionId: string): void {
  // Placeholder kept explicit: all queries above already scope by user.id.
  void user;
  void subscriptionId;
}
