import { describe, expect, it, vi } from "vitest";
import { enablePush, type EnablePushOutcome, type PushApi, type PushBrowser, type PushManagerLike, type PushSubscriptionLike } from "../src/lib/push";

/**
 * The enable() pipeline (1.0.2 iOS/PWA fix): permission → service worker →
 * subscribe → server registration, against a fully stubbed browser. Every
 * failure mode observed in production must come back CATEGORIZED — the raw
 * WebKit "The string contains invalid characters." must never surface as
 * user-facing text.
 */

/** 65-byte P-256 public key, base64url-encoded — the production shape. */
const VALID_PUBLIC_KEY = Buffer.from(
  Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 0x04 : (i * 11 + 1) % 256))
).toString("base64url");

function fakeSubscription(endpoint = "https://fcm.googleapis.com/fcm/send/sub-1"): PushSubscriptionLike {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "p256dh-key-material", auth: "auth-key-material" } }),
  };
}

class DOMExceptionStub extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

interface BrowserOverrides {
  permission?: NotificationPermission;
  requestResult?: NotificationPermission;
  swError?: Error;
  subscribeError?: Error;
  existing?: PushSubscriptionLike | null;
}

/** Fake PushBrowser with live counters (getters, so mutations are visible). */
function fakeBrowser(overrides: BrowserOverrides = {}): PushBrowser & { subscribeCalls: number; requestedPermission: boolean; lastApplicationServerKey: Uint8Array | null } {
  const state = { subscribeCalls: 0, requestedPermission: false, lastApplicationServerKey: null as Uint8Array | null };
  const pushManager: PushManagerLike = {
    getSubscription: async () => overrides.existing ?? null,
    subscribe: async (options) => {
      state.subscribeCalls += 1;
      state.lastApplicationServerKey = options.applicationServerKey;
      if (!options.userVisibleOnly) throw new Error("userVisibleOnly must be true");
      if (overrides.subscribeError) throw overrides.subscribeError;
      return fakeSubscription();
    },
  };
  return {
    permission: () => overrides.permission ?? "granted",
    requestPermission: async () => {
      state.requestedPermission = true;
      return overrides.requestResult ?? "granted";
    },
    serviceWorker: async () => {
      if (overrides.swError) throw overrides.swError;
      return pushManager;
    },
    get subscribeCalls() {
      return state.subscribeCalls;
    },
    get requestedPermission() {
      return state.requestedPermission;
    },
    get lastApplicationServerKey() {
      return state.lastApplicationServerKey;
    },
  };
}

function fakeApi(overrides: { publicKey?: string | null; registerError?: Error } = {}): PushApi & { registered: { endpoint: string; keys: { p256dh: string; auth: string } }[] } {
  const calls = { registered: [] as { endpoint: string; keys: { p256dh: string; auth: string } }[] };
  return {
    vapidPublicKey: async () => ("publicKey" in overrides ? overrides.publicKey! : VALID_PUBLIC_KEY),
    registerSubscription: async (subscription) => {
      if (overrides.registerError) throw overrides.registerError;
      calls.registered.push(subscription);
    },
    ...calls,
  };
}

describe("enablePush — happy paths", () => {
  it("supported browser, permission already granted: subscribes and registers the device", async () => {
    const browser = fakeBrowser();
    const api = fakeApi();
    const outcome = await enablePush(browser, api);
    expect(outcome).toEqual({ ok: true, endpoint: "https://fcm.googleapis.com/fcm/send/sub-1" });
    expect(browser.subscribeCalls).toBe(1);
    expect(browser.lastApplicationServerKey?.length).toBe(65);
    expect(api.registered).toHaveLength(1);
    expect(api.registered[0]!.keys).toEqual({ p256dh: "p256dh-key-material", auth: "auth-key-material" });
  });

  it("asks for permission when default and proceeds once granted", async () => {
    const browser = fakeBrowser({ permission: "default", requestResult: "granted" });
    const outcome = await enablePush(browser, fakeApi());
    expect(browser.requestedPermission).toBe(true);
    expect(outcome.ok).toBe(true);
  });

  it("reuses an existing browser subscription instead of double-subscribing", async () => {
    const existing = fakeSubscription("https://updates.push.services.mozilla.com/wpush/v2/old");
    const browser = fakeBrowser({ existing });
    const api = fakeApi();
    const outcome = await enablePush(browser, api);
    expect(outcome).toEqual({ ok: true, endpoint: "https://updates.push.services.mozilla.com/wpush/v2/old" });
    expect(browser.subscribeCalls).toBe(0);
    expect(api.registered[0]!.endpoint).toContain("mozilla.com");
  });
});

describe("enablePush — the production failure modes", () => {
  it("malformed public key (the 1.0.1 regression) → invalid-key, subscribe never called", async () => {
    const browser = fakeBrowser();
    const api = fakeApi({ publicKey: "not-a-valid-key!!" });
    const outcome = await enablePush(browser, api);
    expect(outcome).toEqual({ ok: false, kind: "invalid-key" });
    expect(browser.subscribeCalls).toBe(0);
    expect(api.registered).toHaveLength(0);
  });

  it("permission denied → permission-denied, no subscribe attempt", async () => {
    const browser = fakeBrowser({ permission: "default", requestResult: "denied" });
    const api = fakeApi();
    expect(await enablePush(browser, api)).toEqual({ ok: false, kind: "permission-denied" });
    expect(browser.subscribeCalls).toBe(0);
    expect(api.registered).toHaveLength(0);
  });

  it("permission prompt throwing → permission-denied, no subscribe attempt", async () => {
    const browser = {
      ...fakeBrowser({ permission: "default" }),
      requestPermission: () => Promise.reject(new DOMExceptionStub("NotAllowedError", "prompt blocked")),
    };
    expect(await enablePush(browser, fakeApi())).toEqual({ ok: false, kind: "permission-denied" });
  });

  it("service worker unavailable → sw-unavailable", async () => {
    const browser = fakeBrowser({ swError: new DOMExceptionStub("SecurityError", "registration failed") });
    expect(await enablePush(browser, fakeApi())).toEqual({ ok: false, kind: "sw-unavailable" });
  });

  it("PushManager refusing the subscription (NotSupportedError) → unsupported", async () => {
    const browser = fakeBrowser({ subscribeError: new DOMExceptionStub("NotSupportedError", "no push service") });
    expect(await enablePush(browser, fakeApi())).toEqual({ ok: false, kind: "unsupported" });
  });

  it("subscribe aborted by the browser (AbortError) → unsupported, not a raw crash", async () => {
    const browser = fakeBrowser({ subscribeError: new DOMExceptionStub("AbortError", "user quit the app") });
    expect(await enablePush(browser, fakeApi())).toEqual({ ok: false, kind: "unsupported" });
  });

  it("subscription missing key material → incomplete-subscription, never registered", async () => {
    const bad = {
      endpoint: "https://push.example.com/e/1",
      toJSON: () => ({ endpoint: "https://push.example.com/e/1", keys: { p256dh: "present", auth: "" } }),
    };
    const browser = fakeBrowser({ existing: bad as unknown as PushSubscriptionLike });
    const api = fakeApi();
    expect(await enablePush(browser, api)).toEqual({ ok: false, kind: "incomplete-subscription" });
    expect(api.registered).toHaveLength(0);
  });

  it("server rejects the registration → registration-failed", async () => {
    const api = fakeApi({ registerError: new Error("429") });
    expect(await enablePush(fakeBrowser(), api)).toEqual({ ok: false, kind: "registration-failed" });
  });

  it("vapid key fetch failing → registration-failed (distinct from unconfigured)", async () => {
    const api = fakeApi();
    const failing = { ...api, vapidPublicKey: () => Promise.reject(new Error("network down")) };
    expect(await enablePush(fakeBrowser(), failing)).toEqual({ ok: false, kind: "registration-failed" });
  });

  it("server without VAPID keys → server-unconfigured", async () => {
    expect(await enablePush(fakeBrowser(), fakeApi({ publicKey: null }))).toEqual({ ok: false, kind: "server-unconfigured" });
    expect(await enablePush(fakeBrowser(), fakeApi({ publicKey: "" }))).toEqual({ ok: false, kind: "server-unconfigured" });
  });
});

describe("enablePush — ordering and privacy contracts", () => {
  it("requests permission BEFORE creating the subscription (iOS user-gesture requirement)", async () => {
    const order: string[] = [];
    const browser: PushBrowser = {
      permission: () => "default",
      requestPermission: async () => {
        order.push("permission");
        return "granted";
      },
      serviceWorker: async () => {
        order.push("sw");
        return {
          getSubscription: async () => {
            order.push("getSubscription");
            return null;
          },
          subscribe: async () => {
            order.push("subscribe");
            return fakeSubscription();
          },
        };
      },
    };
    const outcome = await enablePush(browser, fakeApi());
    expect(outcome.ok).toBe(true);
    expect(order).toEqual(["permission", "sw", "getSubscription", "subscribe"]);
  });

  it("diagnostics never log key material or subscription secrets", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      await enablePush(fakeBrowser(), fakeApi());
      expect(debug).toHaveBeenCalled();
      for (const call of debug.mock.calls) {
        const rendered = call.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
        expect(rendered).not.toContain(VALID_PUBLIC_KEY);
        expect(rendered).not.toContain("p256dh-key-material");
        expect(rendered).not.toContain("auth-key-material");
      }
    } finally {
      debug.mockRestore();
    }
  });
});

describe("EnablePushOutcome contract", () => {
  it("every failure kind is one of the categorized union", async () => {
    const outcomes: EnablePushOutcome[] = [
      await enablePush(fakeBrowser(), fakeApi({ publicKey: null })),
      await enablePush(fakeBrowser({ permission: "denied", requestResult: "denied" }), fakeApi()),
      await enablePush(fakeBrowser(), fakeApi({ publicKey: "!!!" })),
    ];
    for (const outcome of outcomes) {
      if (outcome.ok) throw new Error("expected failure");
      expect(typeof outcome.kind).toBe("string");
    }
  });
});
