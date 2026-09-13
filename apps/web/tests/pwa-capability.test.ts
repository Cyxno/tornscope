import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detectPushCapability, isIOS, isStandalone } from "../src/lib/pwa.js";

/**
 * Real-user remediation (iOS findings #11/#12): the push capability state
 * machine must distinguish "install to Home Screen first" from "genuinely
 * unsupported", feature-first, and never route a capable platform into a
 * dead-end copy. Decision table:
 *   insecure context                 → insecure (regardless of platform)
 *   PushManager present              → ok (normal flow, incl. iOS standalone)
 *   iOS + browser tab + no push      → ios-needs-install
 *   anything else without push       → unsupported
 */

type WindowStub = Record<string, unknown> | undefined;

function withWindow(opts: {
  secure: boolean;
  pushManager: boolean;
  serviceWorker: boolean;
  notification: boolean;
  permission?: NotificationPermission;
  ua: string;
  touchPoints?: number;
  standaloneQuery?: boolean;
  iosStandalone?: boolean;
}, run: () => void): void {
  const navigatorStub = {
    userAgent: opts.ua,
    maxTouchPoints: opts.touchPoints ?? 0,
    serviceWorker: opts.serviceWorker ? {} : undefined,
    standalone: opts.iosStandalone,
  };
  // Feature keys must be ABSENT (not undefined) — capability checks use "in".
  const windowStub: Record<string, unknown> = {
    isSecureContext: opts.secure,
    matchMedia: (q: string) => ({ matches: Boolean(opts.standaloneQuery) && q.includes("standalone") }),
    navigator: navigatorStub,
  };
  if (opts.pushManager) windowStub.PushManager = function PushManager() {};
  if (opts.notification) windowStub.Notification = { permission: opts.permission ?? "default" };
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("navigator", navigatorStub);
  if (opts.notification) {
    vi.stubGlobal("Notification", { permission: opts.permission ?? "default" });
    vi.stubGlobal("PushManager", function PushManager() {});
  }
  try {
    run();
  } finally {
    vi.unstubAllGlobals();
  }
}

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const FIREFOX_IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/126.0 Mobile/15E148 Safari/605.1.15";
const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const IPADOS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

describe("push capability detection (real-user iOS remediation)", () => {
  beforeEach(() => {
    delete (globalThis as unknown as { PushManager?: unknown }).PushManager;
  });
  afterEach(() => {
    delete (globalThis as unknown as { PushManager?: unknown }).PushManager;
  });

  it("insecure context → insecure, before any platform logic", () => {
    withWindow({ secure: false, pushManager: false, serviceWorker: false, notification: false, ua: IPHONE_UA }, () => {
      expect(detectPushCapability().capability.kind).toBe("insecure");
    });
  });

  it("iPhone browser tab without PushManager → ios-needs-install (the Firefox-on-iOS case)", () => {
    withWindow({ secure: true, pushManager: false, serviceWorker: false, notification: false, ua: FIREFOX_IOS_UA }, () => {
      const detected = detectPushCapability();
      expect(detected.capability.kind).toBe("ios-needs-install");
      expect(detected.ios).toBe(true);
      expect(detected.standalone).toBe(false);
    });
  });

  it("iPhone installed standalone with push → ok (iOS 16.4+ home-screen web app)", () => {
    withWindow(
      {
        secure: true,
        pushManager: true,
        serviceWorker: true,
        notification: true,
        permission: "default",
        ua: IPHONE_UA,
        standaloneQuery: true,
      },
      () => {
        const detected = detectPushCapability();
        expect(detected.capability).toEqual({ kind: "ok", permission: "default" });
        expect(isStandalone()).toBe(true);
      }
    );
  });

  it("iOS < 16.4 standalone (no push even installed) → unsupported with iOS note available", () => {
    withWindow({ secure: true, pushManager: false, serviceWorker: false, notification: false, ua: IPHONE_UA, iosStandalone: true }, () => {
      const detected = detectPushCapability();
      expect(detected.capability.kind).toBe("unsupported");
      expect(detected.ios).toBe(true);
      expect(detected.standalone).toBe(true);
    });
  });

  it("desktop without push → plain unsupported, never the iOS guidance", () => {
    withWindow({ secure: true, pushManager: false, serviceWorker: false, notification: false, ua: DESKTOP_UA }, () => {
      const detected = detectPushCapability();
      expect(detected.capability.kind).toBe("unsupported");
      expect(detected.ios).toBe(false);
    });
  });

  it("desktop with push → ok", () => {
    withWindow({ secure: true, pushManager: true, serviceWorker: true, notification: true, permission: "granted", ua: DESKTOP_UA }, () => {
      expect(detectPushCapability().capability).toEqual({ kind: "ok", permission: "granted" });
    });
  });

  it("iPadOS 13+ masquerades as Macintosh: desktop UA + multi-touch is iOS", () => {
    withWindow({ secure: true, pushManager: false, serviceWorker: false, notification: false, ua: IPADOS_UA, touchPoints: 5 }, () => {
      expect(isIOS()).toBe(true);
      expect(detectPushCapability().capability.kind).toBe("ios-needs-install");
    });
  });
});

describe("iOS install/push copy contract (rendered surfaces)", () => {
  const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

  it("settings guide iPhone users to the Home Screen instead of a dead-end unsupported message", () => {
    const src = read("../src/lib/components/NotificationsSettings.svelte");
    expect(src).toContain('support.kind === "ios-needs-install"');
    expect(src).toContain("install TornScope on your Home Screen first to enable notifications");
    expect(src).toContain("Firefox and Chrome on iOS");
    expect(src).toContain('support.kind === "sw-failed"'); // honest registration failure stays reachable
  });

  it("the install hint is dismissable, hidden when installed, and honest about insecure origins", () => {
    const src = read("../src/lib/components/InstallHint.svelte");
    expect(src).toContain("dismissInstallHint");
    expect(src).toContain("visible = false");
    expect(src).toContain("installed = isStandalone()");
    expect(src).toContain("this address is not HTTPS");
  });

  it("the app shell carries the standalone meta tags and the SW registers at startup", () => {
    expect(read("../src/app.html")).toContain("apple-mobile-web-app-capable");
    expect(read("../src/app.html")).toContain("apple-mobile-web-app-status-bar-style");
    expect(read("../src/app.html")).toContain("apple-mobile-web-app-title");
    expect(read("../src/routes/+layout.svelte")).toContain("registerServiceWorker()");
    const manifest = JSON.parse(read("../static/manifest.webmanifest"));
    expect(manifest.display).toBe("standalone");
    expect(manifest.id).toBe("/");
    expect(manifest.start_url).toBe("/today");
    expect((manifest.icons ?? []).some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
  });
});
