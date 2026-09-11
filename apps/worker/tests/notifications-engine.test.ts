import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";

/**
 * Notification platform regression matrix (roadmap #7).
 *
 * DB-backed: the real ingest pipeline, quiet-hours deferral + expiry,
 * dedupe, bounded retry, invalid-subscription handling, and the stored-data
 * producers (energy bars, sync system, progression, daily summary, economy).
 *
 * web-push is MOCKED: no real push is ever sent from tests, and each suite
 * script controls success / transient failure / 404 / 410.
 */

vi.mock("web-push", () => {
  type Behavior = "ok" | "transient" | "gone404" | "gone410";
  const state: { behavior: Behavior; calls: Array<{ endpoint: string; payload: string }> } = {
    behavior: "ok",
    calls: [],
  };
  const webpush = {
    setVapidDetails: () => undefined,
    sendNotification: async (sub: { endpoint: string }, payload: string) => {
      state.calls.push({ endpoint: sub.endpoint, payload });
      if (state.behavior === "transient") {
        const err = new Error("queue overflow") as Error & { statusCode?: number };
        err.statusCode = 500;
        throw err;
      }
      if (state.behavior === "gone404") {
        const err = new Error("not found") as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      }
      if (state.behavior === "gone410") {
        const err = new Error("gone") as Error & { statusCode?: number };
        err.statusCode = 410;
        throw err;
      }
      return {};
    },
    state,
  };
  return { default: webpush };
});

// The engine reads VAPID env through process.env at call time; tests call
// ingest/deliver/flush directly so pushReady() is not required — but the
// mocked module needs to exist for import.
const webpushMock = (await import("web-push")).default as unknown as {
  state: { behavior: "ok" | "transient" | "gone404" | "gone410"; calls: Array<{ endpoint: string; payload: string }> };
};

import {
  flushDeferredForUser,
  ingest,
  retryFailedForUser,
  deliverEvent,
  BARS_MAX_AGE_SECONDS,
  RETRY_BACKOFF_MINUTES,
  type IngestContext,
  type NotificationDraft,
} from "../src/notifications/engine.js";
import {
  evaluateEnergyProducer,
  evaluateSystemProducer,
  evaluateProgressionProducer,
  evaluateEconomyProducer,
  evaluateDailySummaryProducer,
} from "../src/notifications/producers.js";
import { nextWallClockOccurrence, localMinutesInZone, normalizeTypeToggles } from "@tornscope/shared";

const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const createdUsers: string[] = [];

const FULL_CAPS = {
  canReadUserBasic: true, canReadUserBars: true, canReadUserCooldowns: true, canReadUserEducation: true,
  canReadUserTravel: true, canReadUserMoney: true, canReadUserLogs: true, canReadUserAttacks: true,
  canReadUserNetworth: true, canReadUserEvents: true, canReadUserPersonalStats: true,
  canReadFactionBasic: true, canReadFactionMembers: false, canReadFactionRankedWars: false,
  canReadFactionChains: false, canReadFactionCrimes: false, canReadFactionArmoryNews: false,
  canReadFactionBalance: false, canReadFactionLogs: false,
};

const nowSec = Math.floor(Date.now() / 1000);

async function makeProfile(opts: { devices?: number; toggles?: Record<string, boolean>; caps?: Record<string, boolean> | null; quiet?: { start: number | null; end: number | null; bypass?: boolean } } = {}): Promise<string> {
  const userId = `notif-${randomUUID()}`;
  createdUsers.push(userId);
  await db.user.create({ data: { id: userId, displayName: "notification-test", timezone: "UTC" } });
  await db.notificationPreference.create({
    data: {
      userId,
      categories: { ...(opts.toggles ?? {}) },
      quietStartMin: opts.quiet?.start ?? null,
      quietEndMin: opts.quiet?.end ?? null,
      bypassCritical: opts.quiet?.bypass ?? true,
      enabledAt: new Date((nowSec - 3600) * 1000),
    },
  });
  if (opts.caps !== null) {
    await db.apiCredential.create({
      data: { userId, encryptedKey: "x", iv: "x", authTag: "x", keyPreview: "…", logAccessAvailable: true, capabilities: opts.caps ?? FULL_CAPS },
    });
  }
  for (let i = 0; i < (opts.devices ?? 0); i++) {
    await db.pushSubscription.create({
      data: { userId, endpoint: `https://fcm.googleapis.com/fcm/send/test-${userId}-${i}`, p256dh: "k".repeat(90), auth: "a".repeat(20) },
    });
  }
  return userId;
}

async function ctxFor(userId: string, overrides: Partial<IngestContext> = {}): Promise<IngestContext> {
  const [prefs, credential] = await Promise.all([
    db.notificationPreference.findUnique({ where: { userId } }),
    db.apiCredential.findFirst({ where: { userId, revokedAt: null }, select: { capabilities: true } }),
  ]);
  return {
    userId,
    timezone: "UTC",
    toggles: normalizeTypeToggles((prefs?.categories as Record<string, boolean> | null) ?? {}),
    sensitiveDetails: false,
    quiet: { startMin: null, endMin: null, bypassCritical: true },
    enabledAtSec: nowSec - 3600,
    capabilities: (credential?.capabilities as Record<string, boolean> | null) ?? FULL_CAPS,
    config: { nearFullThreshold: 135, cashThreshold: 50_000_000, networthThreshold: 100_000_000, summaryTimeMin: 480 },
    ...overrides,
  };
}

function draft(overrides: Partial<NotificationDraft> = {}): NotificationDraft {
  return {
    type: "mail",
    dedupeKey: `mail:test-${randomUUID()}`,
    occurredAt: nowSec,
    title: "New Torn mail",
    body: "You received a new message.",
    ...overrides,
  };
}

let cleanup: (() => Promise<void>) | null = null;
beforeEach(async () => {
  webpushMock.state.calls.length = 0;
  webpushMock.state.behavior = "ok";
});

beforeAll(async () => {
  // basic connectivity gate like other DB suites
  await db.user.count();
  cleanup = async () => {
    for (const id of createdUsers) {
      await db.notificationDelivery.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await db.notificationEvent.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await db.notificationPreference.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await db.notificationState.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await db.pushSubscription.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await db.barsSnapshot.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await db.personalStatSnapshot.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await db.userSnapshot.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await db.syncState.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await db.moneyEvent.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await db.networthSnapshot.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await db.apiCredential.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await db.user.deleteMany({ where: { id } }).catch(() => undefined);
    }
  };
});
afterAll(async () => {
  if (cleanup) await cleanup();
});

suite("notification ingest + dedupe", () => {
  it("11/13. one logical event → one event row, deliveries to every device, restart-stable", async () => {
    const userId = await makeProfile({ devices: 2, toggles: { mail: true } });
    const d = draft();
    const outcome = await ingest(userId, d, await ctxFor(userId));
    expect(outcome).toBe("created");
    const event = await db.notificationEvent.findUnique({ where: { userId_dedupeKey: { userId, dedupeKey: d.dedupeKey } } });
    expect(event?.status).toBe("delivered");
    const deliveries = await db.notificationDelivery.findMany({ where: { eventId: event!.id } });
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((x) => x.status === "sent")).toBe(true);

    // 14/15/16. same logical event again (worker restart / retry / re-eval):
    expect(await ingest(userId, d, await ctxFor(userId))).toBe("duplicate");
    expect(await db.notificationEvent.findMany({ where: { userId, dedupeKey: d.dedupeKey } })).toHaveLength(1);
    expect(webpushMock.state.calls.length).toBe(2); // no extra pushes
  });

  it("1/2/3. disabled type → nothing recorded (explicit user choice)", async () => {
    const userId = await makeProfile({ toggles: { mail: false } });
    const outcome = await ingest(userId, draft(), await ctxFor(userId));
    expect(outcome).toBe("dropped_disabled");
    expect(await db.notificationEvent.findMany({ where: { userId } })).toHaveLength(0);
  });

  it("4/69. missing capability → suppressed with machine reason, recorded once", async () => {
    const userId = await makeProfile({ toggles: { mail: true }, caps: { ...FULL_CAPS, canReadUserEvents: false } });
    const d = draft();
    const outcome = await ingest(userId, d, await ctxFor(userId));
    expect(outcome).toBe("dropped_capability");
    const event = await db.notificationEvent.findUnique({ where: { userId_dedupeKey: { userId, dedupeKey: d.dedupeKey } } });
    expect(event?.status).toBe("suppressed");
    expect(event?.reason).toBe("missing_capability");
    // No pushes, no deliveries.
    expect(await db.notificationDelivery.findMany({ where: { userId } })).toHaveLength(0);
  });

  it("46. stale source event (before activation boundary) never notifies", async () => {
    const userId = await makeProfile({ toggles: { mail: true } });
    const outcome = await ingest(userId, draft({ occurredAt: nowSec - 7200 }), await ctxFor(userId));
    expect(outcome).toBe("dropped_stale");
    expect(await db.notificationEvent.findMany({ where: { userId } })).toHaveLength(0);
  });
});

suite("quiet hours: deferral, expiry, bypass", () => {
  function quietWindowAroundNow(): { start: number; end: number; endSec: number } {
    const nowLocal = localMinutesInZone(nowSec, "UTC");
    const start = (nowLocal - 30 + 1440) % 1440;
    const end = (nowLocal + 30) % 1440;
    return { start, end, endSec: nextWallClockOccurrence(end, "UTC", nowSec) };
  }

  it("21/26. normal notification defers during quiet hours with deliverAt + expiresAt", async () => {
    const q = quietWindowAroundNow();
    const userId = await makeProfile({ toggles: { daily_summary_ready: true }, quiet: { start: q.start, end: q.end } });
    const d = draft({ type: "daily_summary_ready", dedupeKey: `daily-summary:test-${randomUUID()}` });
    expect(await ingest(userId, d, await ctxFor(userId, { quiet: { startMin: q.start, endMin: q.end, bypassCritical: true } }))).toBe("created");
    const event = await db.notificationEvent.findUnique({ where: { userId_dedupeKey: { userId, dedupeKey: d.dedupeKey } } });
    expect(event?.status).toBe("deferred");
    expect(event?.deliverAt).not.toBeNull();
    // expiresAt = occurredAt + maxDeferralAge (4h for the summary type).
    expect(Math.floor((event!.expiresAt!.getTime() - event!.occurredAt.getTime()) / 1000)).toBe(4 * 3600);
    expect(webpushMock.state.calls).toHaveLength(0);
  });

  it("22. deferred notification is delivered when quiet hours end", async () => {
    const q = quietWindowAroundNow();
    const userId = await makeProfile({ devices: 1, toggles: { daily_summary_ready: true }, quiet: { start: q.start, end: q.end } });
    const d = draft({ type: "daily_summary_ready", dedupeKey: `daily-summary:test-${randomUUID()}` });
    await ingest(userId, d, await ctxFor(userId, { quiet: { startMin: q.start, endMin: q.end, bypassCritical: true } }));
    // Quiet hours "end": pull deliverAt into the past.
    const event = await db.notificationEvent.findUnique({ where: { userId_dedupeKey: { userId, dedupeKey: d.dedupeKey } } });
    await db.notificationEvent.update({ where: { id: event!.id }, data: { deliverAt: new Date(Date.now() - 60_000) } });
    await flushDeferredForUser(userId, await ctxFor(userId));
    const after = await db.notificationEvent.findUnique({ where: { id: event!.id } });
    expect(after?.status).toBe("delivered");
    expect(webpushMock.state.calls).toHaveLength(1);
  });

  it("23. stale deferred notification expires instead of delivering useless morning alerts", async () => {
    const q = quietWindowAroundNow();
    const userId = await makeProfile({ devices: 1, toggles: { daily_summary_ready: true }, quiet: { start: q.start, end: q.end } });
    const d = draft({ type: "daily_summary_ready", dedupeKey: `daily-summary:test-${randomUUID()}` });
    await ingest(userId, d, await ctxFor(userId, { quiet: { startMin: q.start, endMin: q.end, bypassCritical: true } }));
    const event = await db.notificationEvent.findUnique({ where: { userId_dedupeKey: { userId, dedupeKey: d.dedupeKey } } });
    await db.notificationEvent.update({
      where: { id: event!.id },
      data: { deliverAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 30_000) },
    });
    await flushDeferredForUser(userId, await ctxFor(userId));
    const after = await db.notificationEvent.findUnique({ where: { id: event!.id } });
    expect(after?.status).toBe("expired");
    expect(after?.reason).toBe("expired");
    expect(webpushMock.state.calls).toHaveLength(0);
  });

  it("29/30. disabled notification never queues; no devices → suppressed, not silently lost", async () => {
    const q = quietWindowAroundNow();
    // Disabled: dropped before any quiet-hours handling.
    const disabled = await makeProfile({ toggles: { daily_summary_ready: false }, quiet: { start: q.start, end: q.end } });
    expect(
      await ingest(disabled, draft({ type: "daily_summary_ready", dedupeKey: `d-${randomUUID()}` }), await ctxFor(disabled, { quiet: { startMin: q.start, endMin: q.end, bypassCritical: true } }))
    ).toBe("dropped_disabled");
    expect(await db.notificationEvent.findMany({ where: { userId: disabled } })).toHaveLength(0);

    // Enabled but zero devices: event recorded as suppressed device_disabled.
    const noDevices = await makeProfile({ toggles: { mail: true } });
    const d = draft();
    await ingest(noDevices, d, await ctxFor(noDevices));
    const event = await db.notificationEvent.findUnique({ where: { userId_dedupeKey: { userId: noDevices, dedupeKey: d.dedupeKey } } });
    expect(event?.status).toBe("suppressed");
    expect(event?.reason).toBe("device_disabled");
  });
});

suite("delivery lifecycle: retry, invalid subscriptions", () => {
  it("32/33. transient failure retries with bounded backoff, then recovers", async () => {
    const userId = await makeProfile({ devices: 1, toggles: { mail: true } });
    webpushMock.state.behavior = "transient";
    const d = draft();
    await ingest(userId, d, await ctxFor(userId));
    let event = await db.notificationEvent.findUnique({ where: { userId_dedupeKey: { userId, dedupeKey: d.dedupeKey } } });
    expect(event?.status).toBe("failed");
    let deliveries = await db.notificationDelivery.findMany({ where: { eventId: event!.id } });
    expect(deliveries[0]?.status).toBe("failed");
    expect(deliveries[0]?.attempts).toBe(1);
    expect(deliveries[0]?.nextAttemptAt).not.toBeNull();

    // Service recovers → the retry tick delivers.
    webpushMock.state.behavior = "ok";
    await db.notificationDelivery.updateMany({ where: { eventId: event!.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await retryFailedForUser(userId);
    event = await db.notificationEvent.findUnique({ where: { id: event!.id } });
    expect(event?.status).toBe("delivered");
    deliveries = await db.notificationDelivery.findMany({ where: { eventId: event!.id } });
    expect(deliveries[0]?.status).toBe("sent");
    expect(deliveries[0]?.attempts).toBe(2);
  });

  it("31. max retries reached: delivery stays failed, no endless retry", async () => {
    const userId = await makeProfile({ devices: 1, toggles: { mail: true } });
    webpushMock.state.behavior = "transient";
    const d = draft();
    await ingest(userId, d, await ctxFor(userId));
    const event = await db.notificationEvent.findUnique({ where: { userId_dedupeKey: { userId, dedupeKey: d.dedupeKey } } });
    // Exhaust all attempts with due timers.
    for (let i = 1; i < RETRY_BACKOFF_MINUTES.length; i++) {
      await db.notificationDelivery.updateMany({ where: { eventId: event!.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await retryFailedForUser(userId);
    }
    const deliveries = await db.notificationDelivery.findMany({ where: { eventId: event!.id } });
    expect(deliveries[0]?.attempts).toBe(RETRY_BACKOFF_MINUTES.length);
    expect(deliveries[0]?.nextAttemptAt).toBeNull();
    expect(webpushMock.state.calls.filter((c) => c.endpoint.includes(userId)).length).toBe(RETRY_BACKOFF_MINUTES.length);
    webpushMock.state.behavior = "ok";
  });

  it("34/35/28. 404/410 → invalid_subscription, subscription revoked, no more sends", async () => {
    for (const behavior of ["gone404", "gone410"] as const) {
      const userId = await makeProfile({ devices: 1, toggles: { mail: true } });
      webpushMock.state.behavior = behavior;
      const d = draft();
      await ingest(userId, d, await ctxFor(userId));
      const sub = await db.pushSubscription.findFirst({ where: { userId } });
      expect(sub?.revokedAt).not.toBeNull();
      const deliveries = await db.notificationDelivery.findMany({ where: { userId } });
      expect(deliveries[0]?.status).toBe("invalid_subscription");
      expect(deliveries[0]?.reason).toBe("invalid_subscription");
      webpushMock.state.behavior = "ok";
    }
  });

  it("37. structurally-internal endpoint is revoked, never POSTed", async () => {
    const userId = await makeProfile({ devices: 0, toggles: { mail: true } });
    await db.pushSubscription.create({
      data: { userId, endpoint: "https://169.254.169.254/latest/meta-data", p256dh: "k".repeat(90), auth: "a".repeat(20) },
    });
    const before = webpushMock.state.calls.length;
    const event = await db.notificationEvent.create({
      data: { userId, type: "mail", dedupeKey: `mail:ssrf-${randomUUID()}`, occurredAt: new Date(), title: "t", body: "b" },
      select: { id: true, dedupeKey: true },
    });
    await deliverEvent(userId, event.id, { type: "mail", dedupeKey: event.dedupeKey, occurredAt: nowSec, title: "t", body: "b" });
    const sub = await db.pushSubscription.findFirst({ where: { userId } });
    expect(sub?.revokedAt).not.toBeNull();
    expect(webpushMock.state.calls.length).toBe(before);
  });
});

suite("energy producer (bars snapshots: fresh, transition, re-arm)", () => {
  let barsSeq = 0;
  async function setBars(userId: string, current: number, max: number, ageSec = 60): Promise<void> {
    await db.barsSnapshot.deleteMany({ where: { userId } });
    // Distinct observation timestamps: the dedupe key is the observation time,
    // so a genuinely NEW snapshot is a NEW logical event.
    const age = ageSec + barsSeq * 5;
    barsSeq += 1;
    await db.barsSnapshot.create({
      data: { userId, capturedAt: new Date((nowSec - age) * 1000), energyCurrent: current, energyMaximum: max, happyCurrent: 0, happyMaximum: 0 },
    });
  }
  async function stateOf(userId: string): Promise<Record<string, unknown> | null> {
    const row = await db.notificationState.findUnique({ where: { userId } });
    return (row?.systemState ?? null) as Record<string, unknown> | null;
  }
  async function run(userId: string, ctx: IngestContext, systemState: Record<string, unknown> | null): Promise<Record<string, unknown> | null> {
    let updated: Record<string, unknown> | null = systemState;
    await evaluateEnergyProducer(ctx, systemState, async (patch) => {
      updated = { ...(updated ?? {}), ...patch };
    }, BARS_MAX_AGE_SECONDS);
    return updated;
  }

  it("48/49. first observation arms silently; old state after restart does not push", async () => {
    const userId = await makeProfile({ toggles: { energy_full: true } });
    await setBars(userId, 150, 150);
    const state = await run(userId, await ctxFor(userId, { toggles: { energy_full: true } }), null);
    expect((state as { energy?: { armedFull?: boolean } })?.energy?.armedFull).toBe(false); // already full → disarmed, no push
    expect(webpushMock.state.calls.filter((c) => c.payload.includes("Energy full"))).toHaveLength(0);
  });

  it("41/42/43. crossing fires once, staying full stays quiet, dropping re-arms", async () => {
    const userId = await makeProfile({ devices: 1, toggles: { energy_full: true } });
    const ctx = await ctxFor(userId, { toggles: { energy_full: true } });
    // Arm: below max.
    await setBars(userId, 100, 150);
    let state = await run(userId, ctx, null);
    expect((state as { energy?: { armedFull?: boolean } })?.energy?.armedFull).toBe(true);
    // Cross to full → exactly one push.
    await setBars(userId, 150, 150);
    state = await run(userId, ctx, state);
    const energyEvents = await db.notificationEvent.findMany({ where: { userId, type: "energy_full" } });
    expect(energyEvents).toHaveLength(1);
    expect(energyEvents[0]?.status).toBe("delivered");
    expect(energyEvents[0]?.dedupeKey).toContain("energy:full:");
    // Still full → disarmed, no duplicate.
    state = await run(userId, ctx, state);
    expect(await db.notificationEvent.findMany({ where: { userId, type: "energy_full" } })).toHaveLength(1);
    // Drop well below → re-arm.
    await setBars(userId, 100, 150);
    state = await run(userId, ctx, state);
    expect((state as { energy?: { armedFull?: boolean } })?.energy?.armedFull).toBe(true);
    // Full again → second, distinct event.
    await setBars(userId, 150, 150);
    state = await run(userId, ctx, state);
    expect(await db.notificationEvent.findMany({ where: { userId, type: "energy_full" } })).toHaveLength(2);
  });

  it("44. stale bars never drive energy notifications (confidence gating)", async () => {
    const userId = await makeProfile({ toggles: { energy_full: true } });
    const ctx = await ctxFor(userId, { toggles: { energy_full: true } });
    await setBars(userId, 100, 150);
    const state = await run(userId, ctx, null);
    await setBars(userId, 150, 150, BARS_MAX_AGE_SECONDS + 600);
    await run(userId, ctx, state);
    expect(await db.notificationEvent.findMany({ where: { userId, type: "energy_full" } })).toHaveLength(0);
  });

  it("5/6. near-full threshold config: fires on crossing, not above", async () => {
    const userId = await makeProfile({ toggles: { energy_near_full: true } });
    const ctx = await ctxFor(userId, { toggles: { energy_near_full: true } });
    await setBars(userId, 100, 150);
    let state = await run(userId, ctx, null);
    await setBars(userId, 140, 150); // ≥135, not full
    state = await run(userId, ctx, state);
    const events = await db.notificationEvent.findMany({ where: { userId, type: "energy_near_full" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.body).toContain("close to full");
    // Sensitive variant carries exact numbers only in sensitiveBody drafts —
    // the stored default body stays generic (privacy).
    expect(events[0]?.body).not.toContain("140");
    void state;
  });
});

suite("system producer (grouped, once per episode, capability wording)", () => {
  async function ctxT(userId: string, toggles: Record<string, boolean>): Promise<IngestContext> {
    return await ctxFor(userId, { toggles });
  }

  it("48/51. first observation records footprint silently; degraded needs 2 consecutive failures", async () => {
    const userId = await makeProfile({ toggles: { sync_degraded: true } });
    await db.syncState.create({ data: { userId, resource: "money_logs", status: "failed", errorCount: 1, lastErrorKind: "transient" } });
    let state: Record<string, unknown> | null = null;
    const update = async (patch: Record<string, unknown>): Promise<void> => {
      state = { ...(state ?? {}), ...patch };
    };
    await evaluateSystemProducer((await ctxT(userId, { sync_degraded: true })), state, update);
    expect(await db.notificationEvent.findMany({ where: { userId } })).toHaveLength(0);
    // Second consecutive failure (errorCount ≥ 2) → one grouped alert.
    await db.syncState.update({ where: { userId_resource: { userId, resource: "money_logs" } }, data: { errorCount: 2 } });
    await evaluateSystemProducer((await ctxT(userId, { sync_degraded: true })), state, update);
    const events = await db.notificationEvent.findMany({ where: { userId, type: "sync_degraded" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.body).toContain("no longer updating");
    expect(events[0]?.body).not.toContain("money_logs"); // no raw machine enum in push text
  });

  it("54/57. multiple failures group into ONE notification; healthy state stays quiet", async () => {
    const userId = await makeProfile({ toggles: { sync_degraded: true } });
    for (const resource of ["money_logs", "drugs", "travel"]) {
      await db.syncState.create({ data: { userId, resource, status: "failed", errorCount: 2, lastErrorKind: "network" } });
    }
    const update = async (patch: Record<string, unknown>): Promise<void> => {
      void patch;
    };
    await evaluateSystemProducer((await ctxT(userId, { sync_degraded: true })), { system: { capability: [], degraded: [] } }, update);
    const events = await db.notificationEvent.findMany({ where: { userId, type: "sync_degraded" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.body).toContain("3 data sources");
  });

  it("52. recovery only fires when the user enabled it (default off)", async () => {
    const userId = await makeProfile({ toggles: { sync_degraded: true } });
    await db.syncState.create({ data: { userId, resource: "money_logs", status: "failed", errorCount: 2, lastErrorKind: "network" } });
    const update = async (patch: Record<string, unknown>): Promise<void> => {
      void patch;
    };
    const seeded = { system: { capability: [], degraded: ["money_logs"] } };
    await evaluateSystemProducer((await ctxT(userId, { sync_degraded: true })), seeded, update);
    expect(await db.notificationEvent.findMany({ where: { userId, type: "sync_recovered" } })).toHaveLength(0);
    // The resource recovers in the DB; still no event while recovery is off.
    await db.syncState.update({ where: { userId_resource: { userId, resource: "money_logs" } }, data: { status: "success", errorCount: 0, lastErrorKind: null } });
    await evaluateSystemProducer((await ctxT(userId, { sync_degraded: true })), { system: { capability: [], degraded: ["money_logs"] } }, update);
    expect(await db.notificationEvent.findMany({ where: { userId, type: "sync_recovered" } })).toHaveLength(0);
    // Recovery enabled explicitly → fires once.
    await evaluateSystemProducer((await ctxT(userId, { sync_degraded: true, sync_recovered: true })), { system: { capability: [], degraded: ["money_logs"] } }, update);
    expect(await db.notificationEvent.findMany({ where: { userId, type: "sync_recovered" } })).toHaveLength(1);
  });

  it("53/20. capability loss uses the critical retained-history wording", async () => {
    const userId = await makeProfile({ toggles: { capability_lost: true } });
    await db.syncState.create({ data: { userId, resource: "money_logs", status: "capability_denied", errorCount: 1, lastErrorKind: "access_denied" } });
    const update = async (patch: Record<string, unknown>): Promise<void> => {
      void patch;
    };
    await evaluateSystemProducer((await ctxT(userId, { capability_lost: true })), { system: { capability: [], degraded: [] } }, update);
    const events = await db.notificationEvent.findMany({ where: { userId, type: "capability_lost" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.body).toContain("retained");
    expect(events[0]?.body.toLowerCase()).not.toContain("failed");
  });
});

suite("progression producer (milestones + level ups)", () => {
  const STATS_FULL = (v: number): Record<string, unknown> => ({
    battle_stats: { strength: v, defense: v, speed: v, dexterity: v, total: v * 4 },
  });

  it("63/64/17. milestone fires with crossing-window wording and permanent dedupe", async () => {
    const userId = await makeProfile({ toggles: { progression_milestone: true } });
    const t0 = nowSec - 3600;
    await db.personalStatSnapshot.create({
      data: { userId, capturedAt: new Date((t0 - 3600) * 1000), stats: STATS_FULL(9_500_000) },
    });
    let state: Record<string, unknown> | null = null;
    const update = async (patch: Record<string, unknown>): Promise<void> => {
      state = { ...(state ?? {}), ...patch };
    };
    // First observation: park cursor at the frontier.
    await evaluateProgressionProducer(await ctxFor(userId, { toggles: { progression_milestone: true } }), null, update);
    // New observation crossing 10M strength.
    await db.personalStatSnapshot.create({
      data: { userId, capturedAt: new Date(t0 * 1000), stats: STATS_FULL(10_100_000) },
    });
    await evaluateProgressionProducer(await ctxFor(userId, { toggles: { progression_milestone: true } }), state, update);
    const events = await db.notificationEvent.findMany({ where: { userId, type: "progression_milestone" } });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const strength = events.find((e) => e.dedupeKey === "progression:strength:10000000");
    expect(strength).toBeDefined();
    expect(strength!.body).toMatch(/passed 10M between .+ and .+\./);
    expect(strength!.provenance).toBe("derived");
    // 17. permanent dedupe: re-evaluation never re-fires.
    await evaluateProgressionProducer(await ctxFor(userId, { toggles: { progression_milestone: true } }), state, update);
    expect(await db.notificationEvent.findMany({ where: { userId, dedupeKey: "progression:strength:10000000" } })).toHaveLength(1);
  });

  it("27. historical crossings far in the past are never notified as new", async () => {
    const userId = await makeProfile({ toggles: { progression_milestone: true } });
    const update = async (patch: Record<string, unknown>): Promise<void> => {
      void patch;
    };
    // Cursor already at the old snapshot's time; the crossing window ended >6h ago.
    const old = nowSec - 48 * 3600;
    await db.personalStatSnapshot.create({ data: { userId, capturedAt: new Date((old - 3600) * 1000), stats: STATS_FULL(9_000_000) } });
    await db.personalStatSnapshot.create({ data: { userId, capturedAt: new Date(old * 1000), stats: STATS_FULL(11_000_000) } });
    const state = { progression: { statCursor: old - 7200, lastLevel: null } };
    await evaluateProgressionProducer(await ctxFor(userId, { toggles: { progression_milestone: true } }), state, update);
    expect(await db.notificationEvent.findMany({ where: { userId, type: "progression_milestone" } })).toHaveLength(0);
  });

  it("level up fires once per level identity", async () => {
    const userId = await makeProfile({ toggles: { level_up: true } });
    const update = async (patch: Record<string, unknown>): Promise<void> => {
      void patch;
    };
    const state = { progression: { statCursor: nowSec - 600, lastLevel: 41 } };
    await db.userSnapshot.create({ data: { userId, capturedAt: new Date((nowSec - 300) * 1000), level: 42 } });
    await evaluateProgressionProducer(await ctxFor(userId, { toggles: { level_up: true } }), state, update);
    expect(await db.notificationEvent.findMany({ where: { userId, dedupeKey: "level:42" } })).toHaveLength(1);
  });
});

suite("daily summary producer", () => {
  it("20/24. fires once per local day at/after the chosen local minute", async () => {
    const userId = await makeProfile({ toggles: { daily_summary_ready: true } });
    const ctx = await ctxFor(userId, { toggles: { daily_summary_ready: true } });
    const update = async (): Promise<void> => {};
    // Force the local minute past the default 08:00 by using summaryTimeMin 0.
    const ctxEarly = { ...ctx, config: { ...ctx.config, summaryTimeMin: 0 } };
    await evaluateDailySummaryProducer(ctxEarly, update);
    const events = await db.notificationEvent.findMany({ where: { userId, type: "daily_summary_ready" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.dedupeKey).toMatch(/^daily-summary:\d{4}-\d{2}-\d{2}$/);
    // Same day again → the event unique constraint (pre-check) blocks a second.
    await evaluateDailySummaryProducer(ctxEarly, update);
    expect(await db.notificationEvent.findMany({ where: { userId, type: "daily_summary_ready" } })).toHaveLength(1);
  });
});

suite("economy producer (thresholds, conversions, net-worth wording)", () => {
  it("59/61. major cash movement respects threshold; conversions worded as asset sales", async () => {
    const userId = await makeProfile({ toggles: { major_cash_movement: true } });
    const ctx = await ctxFor(userId, { toggles: { major_cash_movement: true } });
    const update = async (): Promise<void> => {};
    // First observation: cursor parks silently.
    await db.moneyEvent.create({
      data: { userId, occurredAt: new Date((nowSec - 1800) * 1000), category: "faction", direction: "expense", amount: 82_400_000n, source: "money_logs", sourceRef: "ref-1" },
    });
    await evaluateEconomyProducer(ctx, null, update);
    expect(await db.notificationEvent.findMany({ where: { userId } })).toHaveLength(0);
    // New above-threshold outflow.
    await db.moneyEvent.create({
      data: { userId, occurredAt: new Date((nowSec - 600) * 1000), category: "faction", direction: "expense", amount: 82_400_000n, source: "money_logs", sourceRef: "ref-2" },
    });
    const ref1 = await db.moneyEvent.findFirst({ where: { userId, sourceRef: "ref-1" }, select: { id: true } });
    const seeded = { economy: { moneyCursor: { occurredAt: nowSec - 1800, id: ref1!.id }, networthCursor: null, lastNetworthTotal: null } };
    await evaluateEconomyProducer(ctx, seeded, update);
    const events = await db.notificationEvent.findMany({ where: { userId, type: "major_cash_movement" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.dedupeKey).toBe("cash:money_logs:ref-2");
    expect(events[0]?.body).toContain("$82.4m");
    // Below threshold → nothing, even when fresh.
    await db.moneyEvent.create({
      data: { userId, occurredAt: new Date((nowSec - 300) * 1000), category: "jobs", direction: "income", amount: 1_000n, source: "money_logs", sourceRef: "ref-3" },
    });
    const cursorNow = { economy: { moneyCursor: { occurredAt: nowSec - 600, id: "zzz" }, networthCursor: null, lastNetworthTotal: null } };
    await evaluateEconomyProducer(ctx, cursorNow, update);
    expect(await db.notificationEvent.findMany({ where: { userId, type: "major_cash_movement" } })).toHaveLength(1);
  });

  it("60/62. net-worth movement uses snapshot-delta wording, never 'profit'", async () => {
    const userId = await makeProfile({ toggles: { networth_movement: true } });
    const ctx = await ctxFor(userId, { toggles: { networth_movement: true } });
    const update = async (): Promise<void> => {};
    const seeded = { economy: { moneyCursor: null, networthCursor: nowSec - 3600, lastNetworthTotal: 1_000_000_000 } };
    await db.networthSnapshot.create({
      data: { userId, capturedAt: new Date((nowSec - 600) * 1000), total: 1_125_000_000n },
    });
    await evaluateEconomyProducer(ctx, seeded, update);
    const events = await db.notificationEvent.findMany({ where: { userId, type: "networth_movement" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.body).toContain("+$125m");
    expect(events[0]?.body.toLowerCase()).toContain("not a profit");
    expect(events[0]?.provenance).toBe("derived");
  });
});

suite("privacy + isolation", () => {
  it("69/76. delivery history and events are strictly user-scoped", async () => {
    const a = await makeProfile({ devices: 1, toggles: { mail: true } });
    const b = await makeProfile({ devices: 0, toggles: { mail: false } });
    await ingest(a, draft(), await ctxFor(a));
    const bEvents = await db.notificationEvent.findMany({ where: { userId: b } });
    expect(bEvents).toHaveLength(0);
    const aDeliveries = await db.notificationDelivery.findMany({ where: { userId: a } });
    expect(aDeliveries).toHaveLength(1);
    expect(await db.notificationDelivery.findMany({ where: { userId: b } })).toHaveLength(0);
  });

  it("72/73. payload and ledger never contain endpoint URLs or keys", async () => {
    const userId = await makeProfile({ devices: 1, toggles: { mail: true } });
    const d = draft();
    await ingest(userId, d, await ctxFor(userId));
    const events = await db.notificationEvent.findMany({ where: { userId } });
    const eventsText = JSON.stringify(events);
    expect(eventsText).not.toContain("fcm.googleapis.com");
    expect(eventsText).not.toContain("p256dh");
    const deliveries = await db.notificationDelivery.findMany({ where: { userId } });
    const deliveriesText = JSON.stringify(deliveries, Object.keys(deliveries[0] ?? {}).filter((k) => k !== "subscriptionId"));
    expect(deliveriesText).not.toContain("fcm.googleapis.com");
    void deliveriesText;
  });
});
