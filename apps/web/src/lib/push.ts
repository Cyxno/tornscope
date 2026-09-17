/**
 * Web Push client flow — key decoding, the enable() pipeline and failure
 * categorization.
 *
 * REGRESSION THIS MODULE EXISTS FOR (1.0.1, iOS/PWA "The string contains
 * invalid characters."): the VAPID public key served by the API is
 * base64URL (unpadded, may contain `-`/`_`). An older in-component helper
 * passed it straight to atob(), which only accepts the standard base64
 * alphabet — WebKit answers that with InvalidCharacterError "The string
 * contains invalid characters." before pushManager.subscribe() is ever
 * reached. Decoding therefore lives here, tested, and tolerant of both
 * base64url and standard-padded base64 server formats.
 *
 * The flow is dependency-injected (PushBrowser) so the whole pipeline —
 * permission → service worker → subscribe → server registration — is unit-
 * testable against stubs, and the component stays a thin UI shell.
 */

/** Uncompressed EC P-256 VAPID public key = 0x04 || X || Y (65 bytes). */
export const VAPID_PUBLIC_KEY_BYTES = 65;

/** Structurally what we need from a browser PushSubscription. */
export interface PushSubscriptionLike {
  endpoint: string;
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
}

/** Structurally what we need from a browser PushManager. */
export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<PushSubscriptionLike>;
}

/** The browser surface the enable flow touches (injectable for tests). */
export interface PushBrowser {
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  /** Registers (or returns the existing) /sw.js and hands back its
   *  PushManager; rejects when the service worker is unavailable. */
  serviceWorker(): Promise<PushManagerLike>;
}

/** Server-facing steps the enable flow delegates to the API client. */
export interface PushApi {
  vapidPublicKey(): Promise<string | null>;
  registerSubscription(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void>;
}

export type EnablePushFailure =
  | { kind: "server-unconfigured" }
  | { kind: "permission-denied" }
  | { kind: "invalid-key" }
  | { kind: "sw-unavailable" }
  | { kind: "unsupported" }
  | { kind: "subscribe-failed" }
  | { kind: "incomplete-subscription" }
  | { kind: "registration-failed" }
  | { kind: "unknown" };

export type EnablePushOutcome = { ok: true; endpoint: string } | ({ ok: false } & EnablePushFailure);

/** Thrown for a VAPID public key that is not decodable base64url/base64 —
 *  the categorized replacement for atob's raw InvalidCharacterError. */
export class PushKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushKeyError";
  }
}

/** Secret-free structured telemetry: lengths, states and outcome
 *  categories only — never key material, never p256dh/auth. console.debug
 *  stays invisible in production consoles unless verbose logging is on. */
function debugPush(stage: string, fields: Record<string, unknown>): void {
  console.debug("[tornscope:push]", stage, JSON.stringify(fields));
}

/**
 * Decode a base64URL (or standard padded base64) string to bytes.
 * Accepts both alphabets, applies the padding atob requires, and refuses
 * anything else with PushKeyError — never a leaked DOMException.
 */
export function urlBase64ToUint8Array(input: string): Uint8Array<ArrayBuffer> {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new PushKeyError("empty key");
  // Strip an even pair of surrounding quotes — defensive against
  // mis-parsed env values that were never part of the key itself.
  const unquoted = trimmed.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  if (!/^[A-Za-z0-9+/\-_]*={0,2}$/.test(unquoted)) {
    throw new PushKeyError(`key contains characters outside the base64/base64url alphabet (length ${unquoted.length})`);
  }
  const normalized = unquoted.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (unquoted.length % 4)) % 4);
  let raw: string;
  try {
    raw = atob(normalized);
  } catch {
    throw new PushKeyError(`key is not valid base64/base64url (length ${unquoted.length})`);
  }
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

/** VAPID public key → applicationServerKey, validated as a P-256 point. */
export function toApplicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const bytes = urlBase64ToUint8Array(publicKey);
  if (bytes.length !== VAPID_PUBLIC_KEY_BYTES) {
    throw new PushKeyError(`decoded public key is ${bytes.length} bytes, expected ${VAPID_PUBLIC_KEY_BYTES} (P-256 uncompressed)`);
  }
  return bytes;
}

/** Map a thrown browser error to a failure category. */
export function categorizePushError(err: unknown): EnablePushFailure {
  if (err instanceof PushKeyError) return { kind: "invalid-key" };
  const name = (err as { name?: string; code?: number } | null)?.name ?? "";
  switch (name) {
    case "InvalidCharacterError":
      return { kind: "invalid-key" };
    case "NotAllowedError":
      return { kind: "permission-denied" };
    case "NotSupportedError":
    case "AbortError":
      return { kind: "unsupported" };
    default:
      return { kind: "unknown" };
  }
}

/** The complete enable pipeline. Every user-visible outcome is categorized;
 *  technical detail goes to console.debug only. */
export async function enablePush(browser: PushBrowser, api: PushApi): Promise<EnablePushOutcome> {
  let publicKey: string | null = null;
  try {
    publicKey = await api.vapidPublicKey();
  } catch {
    debugPush("vapid-key-fetch", { outcome: "error" });
    return { ok: false, kind: "registration-failed" };
  }
  if (!publicKey) {
    debugPush("vapid-key-fetch", { outcome: "unconfigured" });
    return { ok: false, kind: "server-unconfigured" };
  }
  // Permission FIRST: iOS requires the request to originate from the user
  // gesture that started this flow, and there is no point subscribing a
  // browser that will refuse to show anything.
  if (browser.permission() !== "granted") {
    let requested: NotificationPermission;
    try {
      requested = await browser.requestPermission();
    } catch {
      return { ok: false, kind: "permission-denied" };
    }
    if (requested !== "granted") {
      debugPush("permission", { outcome: requested });
      return { ok: false, kind: "permission-denied" };
    }
  }

  let key: Uint8Array<ArrayBuffer>;
  try {
    key = toApplicationServerKey(publicKey);
  } catch (err) {
    // The exact production failure: server key not decodable by the browser.
    debugPush("vapid-key-decode", {
      keyLength: publicKey.length,
      decodedBytes: err instanceof PushKeyError ? (err.message.match(/is (\d+) bytes/)?.[1] ?? null) : null,
      outcome: "invalid",
    });
    return { ok: false, kind: "invalid-key" };
  }

  let pushManager: PushManagerLike;
  try {
    pushManager = await browser.serviceWorker();
  } catch (err) {
    debugPush("service-worker", { outcome: "error", reason: (err as Error)?.name ?? "unknown" });
    return { ok: false, kind: "sw-unavailable" };
  }

  let subscription: PushSubscriptionLike | null = null;
  try {
    subscription = (await pushManager.getSubscription()) ?? (await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  } catch (err) {
    const category = categorizePushError(err);
    debugPush("subscribe", { outcome: category.kind, errorName: (err as Error)?.name ?? "unknown" });
    return category.kind === "invalid-key" ? { ok: false, kind: "subscribe-failed" } : { ok: false, ...category };
  }

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    debugPush("subscription-shape", { hasEndpoint: Boolean(json.endpoint), hasKeys: Boolean(json.keys?.p256dh && json.keys?.auth) });
    return { ok: false, kind: "incomplete-subscription" };
  }

  try {
    await api.registerSubscription({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
  } catch {
    debugPush("server-register", { outcome: "error" });
    return { ok: false, kind: "registration-failed" };
  }
  const endpointHost = (() => {
    try {
      return new URL(json.endpoint).host;
    } catch {
      return null;
    }
  })();
  debugPush("enabled", { keyLength: publicKey.length, decodedBytes: key.length, endpointHost });
  return { ok: true, endpoint: json.endpoint };
}

/** Real-browser PushBrowser over navigator globals (the default wiring). */
export function browserPush(): PushBrowser {
  return {
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    // Same semantics the settings component always used: register /sw.js
    // and work through THAT registration's pushManager — never
    // navigator.serviceWorker.ready, which can wait indefinitely on a
    // stuck activation.
    serviceWorker: async () => {
      const registration = await navigator.serviceWorker.register("/sw.js");
      return registration.pushManager as unknown as PushManagerLike;
    },
  };
}

/** One shared humanizer so every push surface shows categorized text,
 *  never a raw browser exception like "The string contains invalid
 *  characters." */
export function enablePushFailureText(kind: EnablePushFailure["kind"]): string {
  switch (kind) {
    case "server-unconfigured":
      return "Push is not configured on this server yet.";
    case "permission-denied":
      return "Browser permission was not granted. If you previously blocked notifications, allow them in your browser's site settings and try again.";
    case "invalid-key":
      return "This server's push key is misconfigured — notifications cannot be enabled until the operator fixes it.";
    case "sw-unavailable":
      return "The notification service worker could not be registered. Reload the page and try again.";
    case "unsupported":
      return "This browser refused the push subscription. Reload the installed app and try again.";
    case "subscribe-failed":
      return "The push subscription failed. Reload the page and try again.";
    case "incomplete-subscription":
      return "The browser returned an incomplete subscription. Disable notifications on this device and re-enable them.";
    case "registration-failed":
      return "The server could not register this device. Check your connection and try again.";
    default:
      return "Enabling notifications failed unexpectedly. Reload the page and try again.";
  }
}
