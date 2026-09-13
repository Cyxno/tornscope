/**
 * PWA / platform capability detection (real-user remediation, iOS findings).
 *
 * PLATFORM REALITY this module encodes:
 * - Web Push on iPhone/iPad is only available to HOME SCREEN web apps
 *   (installed via Safari "Add to Home Screen", iOS/iPadOS 16.4+). A normal
 *   browser tab on iOS — Safari, or Firefox/Chrome which are WebKit views
 *   with no add-on push of their own — does not expose a usable
 *   PushManager, and no user-agent check can conjure one.
 * - Therefore: on iOS we distinguish "browser tab" (→ guide to install)
 *   from "installed standalone" (→ push flow proceeds normally), using
 *   feature detection first and platform hints only to pick the wording.
 * - On other platforms `beforeinstallprompt` may exist; when it does we can
 *   offer a native install control. Its absence (iOS) must never surface as
 *   a broken button — that path is the guided Add to Home Screen hint.
 */

export type PushCapability =
  | { kind: "ok"; permission: NotificationPermission }
  | { kind: "insecure" }
  /** iOS/iPadOS browser tab — Web Push unlocks after Home Screen install. */
  | { kind: "ios-needs-install" }
  /** Platform has no Web Push at all (e.g. Firefox on iOS uses WebKit
   *  without push even as a web app; iOS < 16.4 standalone). */
  | { kind: "unsupported" }
  | { kind: "sw-failed"; reason: string };

/** iPhone / iPod / iPad (incl. iPadOS 13+ masquerading as Macintosh). */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS requests the desktop site: Macintosh UA + multi-touch support.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** App is running installed (home-screen web app), not as a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const standaloneQuery = window.matchMedia?.("(display-mode: standalone)")?.matches ?? false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standaloneQuery || iosStandalone;
}

/**
 * Detect the push capability for THIS context. Feature detection first:
 * PushManager present → the platform can do push (proceed to the normal
 * flow). Its absence on iOS is not "unsupported" — it means "install to the
 * Home Screen first" whenever the platform could support push once
 * installed (iOS/iPadOS 16.4+). Only genuinely pushless contexts get
 * "unsupported", with the iOS nuance explained in the UI copy.
 */
export function detectPushCapability(): { capability: PushCapability; ios: boolean; standalone: boolean } {
  const ios = isIOS();
  const standalone = isStandalone();
  if (typeof window === "undefined") return { capability: { kind: "unsupported" }, ios, standalone };
  // Secure-context FIRST: on an insecure origin (LAN HTTP) browsers do not
  // expose PushManager/Notification at all, so capability checks would
  // misreport a working browser as "unsupported".
  if (!window.isSecureContext) return { capability: { kind: "insecure" }, ios, standalone };
  const hasPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (hasPush) {
    return { capability: { kind: "ok", permission: Notification.permission }, ios, standalone };
  }
  if (ios && !standalone) {
    return { capability: { kind: "ios-needs-install" }, ios, standalone };
  }
  return { capability: { kind: "unsupported" }, ios, standalone };
}

/* -------------------------------------------------------------------------- */
/* Install prompt state                                                        */
/* -------------------------------------------------------------------------- */

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** The deferred native install event, when the platform fires one. */
export function onBeforeInstallPrompt(handler: (event: BeforeInstallPromptEvent) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = (event: Event) => {
    event.preventDefault();
    handler(event as BeforeInstallPromptEvent);
  };
  window.addEventListener("beforeinstallprompt", listener);
  return () => window.removeEventListener("beforeinstallprompt", listener);
}

/** True once the app runs installed — the hint must then never reappear. */
export function onInstalled(handler: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = () => handler();
  window.addEventListener("appinstalled", listener);
  return () => window.removeEventListener("appinstalled", listener);
}

const DISMISS_KEY = "tornscope-install-hint-dismissed";

/** Dismissal persists across sessions; a fresh install clears it naturally. */
export function installHintDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissInstallHint(): void {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Private-mode localStorage failures just mean the hint may reappear.
  }
}

/** Register the push service worker at startup. The SW is push-only (no
 *  offline caching), so early registration carries no staleness risk — but
 *  it means an installed iOS web app can subscribe right after install. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}
