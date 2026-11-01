import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient, EncryptionService } from "@tornscope/database";
import { networthEpisodeKey, type DiscordSendResult } from "@tornscope/shared";

/**
 * Proactive Alerts engine integration suite (2.9.0).
 *
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set (hermetic
 * local runs skip). Exercises the full lifecycle — evaluation → dedupe →
 * in-app delivery → channel fan-out → Discord dispatch/retries — with an
 * INJECTED live-fetch and INJECTED senders: no test ever contacts Torn or
 * Discord. Demo profiles prove their isolation in the same suite.
 */

process.env.API_KEY_ENCRYPTION_KEY ??= "a".repeat(64);

const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const NOW = Math.floor(Date.now() / 1000);

let userId: string;
let demoUserId: string;

/** The live-fetch mock the engine receives; each test points it at a state. */
let liveState: Record<string, number | null> | null;
const liveFetch = async (): Promise<Record<string, number | null> | null> => liveState;

/** A controllable sender mock (injected into every dispatch pass). */
let sendResults: DiscordSendResult[] = [];
const TRANSIENT: DiscordSendResult = { outcome: "failed", errorKind: "transient", message: "Discord server error (HTTP 503)." };
const senderMock = vi.fn(async (): Promise<DiscordSendResult> => sendResults.shift() ?? TRANSIENT);

async function evaluate(): Promise<void> {
  const { evaluateAlerts, resetAlertEngineStateForTests } = await import("../src/alerts/engine.js");
  const { dispatchDueAlertDeliveries } = await import("../src/alerts/dispatch.js");
  await evaluateAlerts({ liveFetch, sender: senderMock });
  // An explicit extra pass so tests can drive retry timing directly.
  await dispatchDueAlertDeliveries({ sender: senderMock });
  // The engine self-throttles (60s) and caches live-fetch eligibility in
  // memory: reset between evaluations so each test call is a fresh tick.
  resetAlertEngineStateForTests();
}

async function createRule(data: {
  triggerType: string;
  config?: unknown;
  quietHours?: unknown;
  cooldownMinutes?: number;
  enabled?: boolean;
  lastState?: unknown;
  lastFiredAt?: Date | null;
}): Promise<string> {
  // One rule per trigger type per account (the engine's own invariant) —
  // the suite reuses the SAME user, so re-arming a trigger UPSERTS its rule.
  const row = await db.alertRule.upsert({
    where: { userId_triggerType: { userId, triggerType: data.triggerType } },
    create: {
      userId,
      triggerType: data.triggerType,
      enabled: data.enabled ?? true,
      config: (data.config ?? {}) as never,
      quietHours: (data.quietHours ?? undefined) as never,
      cooldownMinutes: data.cooldownMinutes ?? 0,
      lastState: (data.lastState ?? undefined) as never,
      lastFiredAt: data.lastFiredAt ?? null,
    },
    update: {
      enabled: data.enabled ?? true,
      config: (data.config ?? {}) as never,
      quietHours: (data.quietHours ?? undefined) as never,
      cooldownMinutes: data.cooldownMinutes ?? 0,
      lastState: (data.lastState ?? undefined) as never,
      lastFiredAt: data.lastFiredAt ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { displayName: `alerts-test-${randomBytes(6).toString("hex")}`, role: "user", isDemo: false },
    select: { id: true },
  });
  userId = user.id;
  const demo = await db.user.create({
    data: { displayName: `alerts-demo-${randomBytes(6).toString("hex")}`, role: "user", isDemo: true },
    select: { id: true },
  });
  demoUserId = demo.id;
});

afterAll(async () => {
  for (const id of [userId, demoUserId]) {
    if (id) await db.user.delete({ where: { id } }).catch(() => undefined);
  }
  if (dbUrl) await db.$disconnect();
});

suite("proactive alerts engine", () => {
  it("cooldown_ready: first observation only baselines, the real transition fires once, re-evaluation dedupes", async () => {
    const ruleId = await createRule({ triggerType: "cooldown_ready" });
    const endSec = NOW + 3600;

    liveState = { cooldownDrugEndsAt: endSec };
    await evaluate();
    let deliveries = await db.alertDelivery.findMany({ where: { userId } });
    expect(deliveries).toEqual([]); // baseline, never an alert
    let rule = await db.alertRule.findUnique({ where: { id: ruleId } });
    expect((rule!.lastState as { observedAt: number }).observedAt).toBeGreaterThan(0);

    // The cooldown ends and the next tick observes ready.
    liveState = { cooldownDrugEndsAt: null };
    await evaluate();
    deliveries = await db.alertDelivery.findMany({ where: { userId, triggerType: "cooldown_ready" } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.dedupeKey).toBe(`cooldown_ready:cooldown_drug:${endSec}`);
    expect(deliveries[0]!.status).toBe("sent");
    rule = await db.alertRule.findUnique({ where: { id: ruleId } });
    expect(rule!.lastFiredAt).not.toBeNull();

    // Re-processing the SAME state (worker crash / repeated tick) creates no duplicate.
    liveState = { cooldownDrugEndsAt: null };
    await evaluate();
    deliveries = await db.alertDelivery.findMany({ where: { userId, triggerType: "cooldown_ready" } });
    expect(deliveries).toHaveLength(1);
  });

  it("cooldown_ready: a stale observation (>12h) is re-baselined, never fabricated into a transition", async () => {
    await db.alertDelivery.deleteMany({ where: { userId } }); // scope assertions to THIS test
    const ruleId = await createRule({
      triggerType: "cooldown_ready",
      lastState: { observedAt: NOW - 13 * 3600, timers: { cooldownDrugEndsAt: NOW - 12 * 3600 } },
    });
    liveState = { cooldownDrugEndsAt: null };
    await evaluate();
    const deliveries = await db.alertDelivery.findMany({ where: { userId, triggerType: "cooldown_ready" } });
    expect(deliveries).toEqual([]);
    const rule = await db.alertRule.findUnique({ where: { id: ruleId } });
    // Baseline re-established at the fresh observation.
    expect((rule!.lastState as { observedAt: number }).observedAt).toBeGreaterThan(NOW - 60);
  });

  it("cooldown_ready: a failed live fetch keeps the previous baseline and fires nothing", async () => {
    await db.alertDelivery.deleteMany({ where: { userId } });
    const before = NOW - 120;
    const ruleId = await createRule({
      triggerType: "cooldown_ready",
      lastState: { observedAt: before, timers: { cooldownBoosterEndsAt: NOW + 600 } },
    });
    liveState = null; // fetch failure
    await evaluate();
    expect(await db.alertDelivery.count({ where: { userId } })).toBe(0);
    const rule = await db.alertRule.findUnique({ where: { id: ruleId } });
    expect((rule!.lastState as { observedAt: number }).observedAt).toBe(before); // untouched
  });

  it("quiet hours suppress with a visible record and never set lastFiredAt", async () => {
    await db.alertDelivery.deleteMany({ where: { userId } });
    const ruleId = await createRule({
      triggerType: "bank_matured",
      quietHours: { start: "00:00", end: "00:00", tz: "UTC" }, // start == end: full-day quiet
      lastState: { observedAt: NOW - 120, timers: { bankMaturesAt: NOW - 30 } },
    });
    liveState = { bankMaturesAt: null };
    await evaluate();
    const deliveries = await db.alertDelivery.findMany({ where: { userId, triggerType: "bank_matured" } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe("suppressed");
    const rule = await db.alertRule.findUnique({ where: { id: ruleId } });
    expect(rule!.lastFiredAt).toBeNull();
  });

  it("per-rule cooldown blocks repeats but a NEW episode after expiry fires again", async () => {
    const endSec = NOW + 1800;
    const ruleId = await createRule({
      triggerType: "cooldown_ready",
      cooldownMinutes: 60,
      lastFiredAt: new Date((NOW - 60) * 1000), // fired a minute ago
      lastState: { observedAt: NOW - 120, timers: { cooldownMedicalEndsAt: endSec } },
    });
    liveState = { cooldownMedicalEndsAt: null };
    await evaluate();
    expect(await db.alertDelivery.count({ where: { userId, triggerType: "cooldown_ready", dedupeKey: `cooldown_ready:cooldown_medical:${endSec}` } })).toBe(0);

    // Cooldown expired → the same rule fires for a NEW episode.
    const endSec2 = NOW + 7200;
    await db.alertRule.update({
      where: { id: ruleId },
      data: { lastFiredAt: new Date((NOW - 2 * 3600) * 1000), lastState: { observedAt: NOW - 120, timers: { cooldownMedicalEndsAt: endSec2 } } as never },
    });
    liveState = { cooldownMedicalEndsAt: null };
    await evaluate();
    expect(await db.alertDelivery.count({ where: { userId, triggerType: "cooldown_ready", dedupeKey: `cooldown_ready:cooldown_medical:${endSec2}` } })).toBe(1);
  });

  it("net_worth_drop: baseline → drop fires once → open episode blocks repeats → recovery re-arms", async () => {
    const ruleId = await createRule({ triggerType: "net_worth_drop", config: { pct: 5, window_hours: 24 } });
    // The baseline must sit in [windowStart − 3h tolerance, windowStart]:
    // window 24h → boundary at −24h, so −25h qualifies.
    const baseAt = NOW - 25 * 3600;
    let seq = 0;
    const addSnapshot = (total: bigint, capturedAt: number): Promise<void> =>
      db.networthSnapshot.create({
        data: {
          userId,
          capturedAt: new Date(capturedAt * 1000 + seq++),
          total,
          pending: 0n, wallet: 0n, vault: 0n, bookie: 0n, cityBank: 0n, caymanBank: 0n, piggyBank: 0n,
          loans: 0n, unpaidFees: 0n, inventory: 0n, displayCase: 0n, bazaar: 0n, trades: 0n,
          itemMarket: 0n, auctionHouse: 0n, enlistedCars: 0n, property: 0n, stockMarket: 0n,
          company: 0n, points: 0n,
        },
        select: { id: true },
      }).then(() => undefined);

    await addSnapshot(100_000_000n, baseAt);
    await addSnapshot(94_000_000n, NOW - 3600); // 6% drop already present at first observation

    liveState = null;
    await evaluate();
    expect(await db.alertDelivery.count({ where: { userId, triggerType: "net_worth_drop" } })).toBe(0); // baseline

    // A NEW (further dropped) snapshot while the window baseline stays:
    await addSnapshot(92_000_000n, NOW - 1800);
    await evaluate();
    const fired = await db.alertDelivery.findMany({ where: { userId, triggerType: "net_worth_drop" } });
    expect(fired).toHaveLength(1);
    const rule = await db.alertRule.findUnique({ where: { id: ruleId } });
    expect((rule!.lastState as { openEpisode: { baselineId: string } }).openEpisode?.baselineId).toMatch(/^nwdrop:/);

    // Re-processing the same crossing does not duplicate (unique dedupeKey).
    await evaluate();
    expect(await db.alertDelivery.count({ where: { userId, triggerType: "net_worth_drop" } })).toBe(1);

    // Recovery above the threshold clears the episode; a second drop re-arms.
    await addSnapshot(99_000_000n, NOW - 900);
    await evaluate();
    await addSnapshot(93_000_000n, NOW - 600);
    await evaluate();
    expect(await db.alertDelivery.count({ where: { userId, triggerType: "net_worth_drop" } })).toBe(2);
  });

  it("net_worth_drop: a data gap never closes an episode — no duplicate after sync outage (audit F2)", async () => {
    // The earlier net-worth test left snapshots and deliveries behind for
    // this shared user — this test pins its own baseline/current pair.
    await db.networthSnapshot.deleteMany({ where: { userId } });
    await db.alertDelivery.deleteMany({ where: { userId, triggerType: "net_worth_drop" } });
    const ruleId = await createRule({ triggerType: "net_worth_drop", config: { pct: 5, window_hours: 24 } });
    let seq = 0;
    const addSnapshot = async (total: bigint, capturedAt: number): Promise<string> =>
      (
        await db.networthSnapshot.create({
          data: {
            userId,
            capturedAt: new Date(capturedAt * 1000 + seq++),
            total,
            pending: 0n, wallet: 0n, vault: 0n, bookie: 0n, cityBank: 0n, caymanBank: 0n, piggyBank: 0n,
            loans: 0n, unpaidFees: 0n, inventory: 0n, displayCase: 0n, bazaar: 0n, trades: 0n,
            itemMarket: 0n, auctionHouse: 0n, enlistedCars: 0n, property: 0n, stockMarket: 0n,
            company: 0n, points: 0n,
          },
          select: { id: true },
        })
      ).id;

    // Reconstruct a fired episode deterministically (the engine reads the
    // wall clock, so the fired-past is seeded): baseline A 26h old (inside
    // the [24h, 27h] window band), current B stale (13h old), the delivery
    // for the A→B crossing exists and the episode is open.
    const aId = await addSnapshot(100_000_000n, NOW - 26 * 3600);
    const bId = await addSnapshot(94_000_000n, NOW - 13 * 3600);
    await db.alertDelivery.create({
      data: {
        userId, ruleId, triggerType: "net_worth_drop", dedupeKey: `nwdrop:${aId}:${bId}`,
        occurredAt: new Date((NOW - 2 * 3600) * 1000), title: "Net worth dropped", message: "fired before the gap", status: "sent",
      },
    });
    await db.alertRule.update({
      where: { id: ruleId },
      data: { lastState: { observedAt: NOW - 2 * 3600, openEpisode: { baselineId: networthEpisodeKey(aId) } } as never },
    });

    // The current snapshot is stale → data-quality failure → the episode
    // MUST survive, and nothing new fires.
    liveState = null;
    await evaluate();
    let rule = await db.alertRule.findUnique({ where: { id: ruleId } });
    expect((rule!.lastState as { openEpisode?: unknown }).openEpisode).toEqual({ baselineId: networthEpisodeKey(aId) });
    expect(await db.alertDelivery.count({ where: { userId, triggerType: "net_worth_drop" } })).toBe(1);

    // No current at all (only the baseline remains) → still preserved.
    await db.networthSnapshot.delete({ where: { id: bId } });
    await evaluate();
    rule = await db.alertRule.findUnique({ where: { id: ruleId } });
    expect((rule!.lastState as { openEpisode?: unknown }).openEpisode).toEqual({ baselineId: networthEpisodeKey(aId) });

    // GENUINE recovery (valid comparison above the threshold) closes it.
    await addSnapshot(99_000_000n, NOW - 60);
    await evaluate();
    rule = await db.alertRule.findUnique({ where: { id: ruleId } });
    expect((rule!.lastState as { openEpisode?: unknown }).openEpisode).toBeNull();

    // ...and a NEW drop after real recovery may alert again (re-armed).
    await addSnapshot(93_000_000n, NOW - 30);
    await evaluate();
    expect(await db.alertDelivery.count({ where: { userId, triggerType: "net_worth_drop" } })).toBe(2);
  });

  it("oc_ready: fires only for OCs that became ready since the previous observation, for a participant", async () => {
    const tornId = 9_876_500 + Math.floor(Math.random() * 1000);
    await db.tornAccount.create({
      data: { userId, tornId, isDemo: false, name: "AlertsTest", level: 10, firstSeenAt: new Date(), lastSeenAt: new Date() },
    });
    await createRule({ triggerType: "oc_ready", lastState: { observedAt: NOW - 600 } });
    await db.organizedCrime.create({
      data: {
        userId,
        factionId: 1,
        ocId: 9_100_000,
        name: "Test OC",
        status: "recruiting",
        readyAt: new Date((NOW - 300) * 1000), // became ready during the observation window
        slots: [{ position: "Muscle", user: { id: tornId } }] as never,
      },
    });
    // An OC that has NOT reached its readyAt must not fire.
    await db.organizedCrime.create({
      data: {
        userId,
        factionId: 1,
        ocId: 9_100_001,
        name: "Future OC",
        status: "recruiting",
        readyAt: new Date((NOW + 3600) * 1000),
        slots: [{ position: "Muscle", user: { id: tornId } }] as never,
      },
    });
    liveState = null;
    await evaluate();
    const fired = await db.alertDelivery.findMany({ where: { userId, triggerType: "oc_ready" } });
    expect(fired).toHaveLength(1);
    expect(fired[0]!.dedupeKey).toBe(`oc:ready:9100000:${NOW - 300}`);
    expect(fired[0]!.payload).toMatchObject({ ocId: 9_100_000 });
  });

  it("sync_failure / sync_recovery: grouped transitions from the same failing-set definition as push", async () => {
    await createRule({ triggerType: "sync_failure" });
    await createRule({ triggerType: "sync_recovery" });
    const mkState = async (resource: string, status: string, errorCount: number): Promise<void> => {
      await db.syncState.create({
        data: { userId, resource, status, errorCount, lastSuccessAt: new Date((NOW - 3600) * 1000) },
      });
    };
    await mkState("money_logs", "failed", 3);
    liveState = null;

    await evaluate(); // baseline: the pre-existing failure is silent
    expect(await db.alertDelivery.count({ where: { userId, triggerType: "sync_failure" } })).toBe(0);

    await db.syncState.update({
      where: { userId_resource: { userId, resource: "money_logs" } },
      data: { errorCount: 4 },
    });
    await mkState("attacks", "failed", 2); // NEW failure
    await evaluate();
    const failures = await db.alertDelivery.findMany({ where: { userId, triggerType: "sync_failure" } });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.dedupeKey).toMatch(/^syncfail:attacks:\d+$/);
    expect(failures[0]!.payload).toMatchObject({ resources: ["attacks"] });

    // Everything recovers → the recovery rule fires once for the incident.
    await db.syncState.updateMany({ where: { userId }, data: { status: "idle", errorCount: 0 } });
    await evaluate();
    const recoveries = await db.alertDelivery.findMany({ where: { userId, triggerType: "sync_recovery" } });
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.dedupeKey).toMatch(/^syncrecover:attacks,money_logs:\d+$/);
    expect(await db.alertDelivery.count({ where: { userId, triggerType: "sync_failure" } })).toBe(1);
  });

  it("sync_failure: an identical repeated incident fires again (per-incident stamp, audit F1)", async () => {
    // The earlier sync-health test left deliveries behind for this shared
    // user — scope this test's counts to its own run.
    await db.alertDelivery.deleteMany({ where: { userId, triggerType: { in: ["sync_failure", "sync_recovery"] } } });
    await createRule({ triggerType: "sync_failure" });
    const mkState = async (resource: string, status: string, errorCount: number): Promise<void> => {
      await db.syncState.upsert({
        where: { userId_resource: { userId, resource } },
        create: { userId, resource, status, errorCount, lastSuccessAt: new Date((NOW - 3600) * 1000) },
        update: { status, errorCount },
      });
    };
    await mkState("money_logs", "idle", 0);
    liveState = null;

    await evaluate(); // baseline: healthy
    await mkState("money_logs", "failed", 3); // incident 1
    await evaluate();
    const first = await db.alertDelivery.findMany({ where: { userId, triggerType: "sync_failure" } });
    expect(first).toHaveLength(1);

    // Re-evaluating the SAME incident adds nothing (stable stamp).
    await evaluate();
    expect(await db.alertDelivery.count({ where: { userId, triggerType: "sync_failure" } })).toBe(1);

    // Recovery closes the incident (recovery alerts are covered above); a
    // WEEKS-LATER identical failure is a NEW incident: updatedAt moved, so
    // the stamp — and therefore the dedupeKey — differs. The small wait
    // guarantees a distinct millisecond stamp deterministically.
    await mkState("money_logs", "idle", 0);
    await evaluate();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await mkState("money_logs", "failed", 3);
    await evaluate();
    const repeated = await db.alertDelivery.findMany({ where: { userId, triggerType: "sync_failure" } });
    expect(repeated).toHaveLength(2);
    expect(repeated[0]!.dedupeKey).not.toBe(repeated[1]!.dedupeKey);
    expect(repeated[1]!.dedupeKey).toMatch(/^syncfail:money_logs:\d+$/);
  });

  it("channel fan-out: one in-app alert, one pending row per channel; dispatch marks sent and never duplicates", async () => {
    const encryption = new EncryptionService(process.env.API_KEY_ENCRYPTION_KEY!);
    const webhook = "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij";
    const encrypted = encryption.encrypt(webhook);
    const channel = await db.alertChannel.create({
      data: {
        userId,
        type: "discord",
        encryptedKey: encrypted.encryptedKey,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        targetPreview: "discord.com/api/webhooks/1234…/••••",
        enabled: true,
      },
      select: { id: true },
    });
    const endSec = NOW + 5400;
    await createRule({
      triggerType: "cooldown_ready",
      lastState: { observedAt: NOW - 120, timers: { cooldownDrugEndsAt: endSec } },
    });
    liveState = { cooldownDrugEndsAt: null };
    sendResults = [{ outcome: "sent" }];
    senderMock.mockClear();
    await evaluate();

    // One logical alert (in-app) — NOT one per channel.
    const deliveries = await db.alertDelivery.findMany({ where: { userId, dedupeKey: `cooldown_ready:cooldown_drug:${endSec}` } });
    expect(deliveries).toHaveLength(1);
    const channelRows = await db.alertChannelDelivery.findMany({ where: { deliveryId: deliveries[0]!.id } });
    expect(channelRows).toHaveLength(1);
    expect(channelRows[0]!.channelId).toBe(channel.id);
    expect(channelRows[0]!.status).toBe("sent");
    expect(senderMock).toHaveBeenCalledTimes(1);
    // The URL reached the sender but is never persisted in plaintext.
    const raw = JSON.stringify(channelRows[0]);
    expect(raw).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");

    // Re-running the whole tick dispatches nothing new.
    senderMock.mockClear();
    await evaluate();
    expect(senderMock).toHaveBeenCalledTimes(0);
  });

  it("dispatch retries transient failures with backoff and exhausts into a retained failed row", async () => {
    // Only ONE enabled channel for this test's fan-out (the earlier one is
    // retired so row counting stays unambiguous).
    await db.alertChannel.updateMany({ where: { userId }, data: { enabled: false } });
    const encryption = new EncryptionService(process.env.API_KEY_ENCRYPTION_KEY!);
    const webhook = "https://discord.com/api/webhooks/123456789012345679/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij";
    const encrypted = encryption.encrypt(webhook);
    await db.alertChannel.create({
      data: {
        userId,
        type: "discord",
        encryptedKey: encrypted.encryptedKey,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        targetPreview: "discord.com/api/webhooks/5678…/••••",
        enabled: true,
      },
      select: { id: true },
    });
    const endSec = NOW + 9000;
    await createRule({
      triggerType: "cooldown_ready",
      lastState: { observedAt: NOW - 120, timers: { cooldownBoosterEndsAt: endSec } },
    });
    liveState = { cooldownBoosterEndsAt: null };
    sendResults = [{ outcome: "failed", errorKind: "transient", message: "Discord server error (HTTP 503)." }];
    await evaluate();

    const row = (await db.alertChannelDelivery.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }))[0]!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.errorKind).toBe("transient");
    expect(row.nextAttemptAt).not.toBeNull();

    // Simulate a worker crash between commit and dispatch: a SECOND logical
    // alert never exists, the pending row survives and exhausts its retries.
    const { dispatchDueAlertDeliveries } = await import("../src/alerts/dispatch.js");
    const { resetAlertEngineStateForTests } = await import("../src/alerts/engine.js");
    resetAlertEngineStateForTests();
    for (let i = 0; i < 8; i++) {
      // Pull nextAttemptAt into the past so each pass is due immediately.
      await db.alertChannelDelivery.updateMany({ where: { id: row.id, status: "pending" }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await dispatchDueAlertDeliveries({ sender: senderMock });
      const after = await db.alertChannelDelivery.findUnique({ where: { id: row.id } });
      if (after!.status === "failed") break;
    }
    const final = await db.alertChannelDelivery.findUnique({ where: { id: row.id } });
    expect(final!.status).toBe("failed");
    expect(final!.errorKind).toBe("transient"); // category preserved, row retained
    expect(final!.attempts).toBeGreaterThanOrEqual(6); // 1 initial + 5 retries (ALERT_DELIVERY_MAX_RETRIES=5)
    // The logical alert is still in the inbox.
    expect(await db.alertDelivery.count({ where: { userId, dedupeKey: `cooldown_ready:cooldown_booster:${endSec}` } })).toBe(1);

    // A permanently invalid webhook is NEVER retried.
    senderMock.mockClear();
    sendResults = [{ outcome: "failed", errorKind: "invalid_webhook", message: "Webhook rejected by Discord (HTTP 404)." }];
    const endSec3 = NOW + 12_600;
    await createRule({
      triggerType: "cooldown_ready",
      lastState: { observedAt: NOW - 120, timers: { cooldownMedicalEndsAt: endSec3 } },
    });
    liveState = { cooldownMedicalEndsAt: null };
    await evaluate();
    const invalid = (await db.alertChannelDelivery.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }))[0]!;
    expect(invalid.status).toBe("failed");
    expect(invalid.errorKind).toBe("invalid_webhook");
    expect(senderMock).toHaveBeenCalledTimes(1); // one attempt, no retries
  });

  it("disabled channel: pending deliveries are retained, not failed, and resume after re-enable (audit F3)", async () => {
    // One enabled channel + one pending row.
    await db.alertChannel.updateMany({ where: { userId }, data: { enabled: false } });
    const encryption = new EncryptionService(process.env.API_KEY_ENCRYPTION_KEY!);
    const webhook = "https://discord.com/api/webhooks/1234567890123499/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij";
    const encrypted = encryption.encrypt(webhook);
    const channel = await db.alertChannel.create({
      data: {
        userId, type: "discord",
        encryptedKey: encrypted.encryptedKey, iv: encrypted.iv, authTag: encrypted.authTag,
        targetPreview: "discord.com/api/webhooks/3499…/••••", enabled: true,
      },
      select: { id: true },
    });
    const delivery = await db.alertDelivery.create({
      data: {
        userId, ruleId: (await db.alertRule.findFirst({ where: { userId } }))!.id, triggerType: "cooldown_ready",
        dedupeKey: `audit-f3:${randomBytes(4).toString("hex")}`, occurredAt: new Date(), title: "T", message: "M", status: "sent",
      },
      select: { id: true },
    });
    const rowId = (
      await db.alertChannelDelivery.create({
        data: { userId, deliveryId: delivery.id, channelId: channel.id, status: "pending" },
        select: { id: true },
      })
    ).id;

    // Disabled → the pass must NOT select the row at all: still pending,
    // zero send attempts, no log-worthy work.
    await db.alertChannel.update({ where: { id: channel.id }, data: { enabled: false } });
    senderMock.mockClear();
    const { dispatchDueAlertDeliveries } = await import("../src/alerts/dispatch.js");
    await dispatchDueAlertDeliveries({ sender: senderMock });
    let row = await db.alertChannelDelivery.findUnique({ where: { id: rowId } });
    expect(row!.status).toBe("pending");
    expect(row!.errorKind).toBeNull();
    expect(senderMock).toHaveBeenCalledTimes(0);

    // Re-enabled → the SAME pending row is processed normally.
    await db.alertChannel.update({ where: { id: channel.id }, data: { enabled: true } });
    sendResults = [{ outcome: "sent" }];
    await dispatchDueAlertDeliveries({ sender: senderMock });
    row = await db.alertChannelDelivery.findUnique({ where: { id: rowId } });
    expect(row!.status).toBe("sent");
    expect(senderMock).toHaveBeenCalledTimes(1);
  });

  it("unreadable channel ciphertext under a valid key is failed permanently, never retried (audit F4)", async () => {
    await db.alertChannel.updateMany({ where: { userId }, data: { enabled: false } });
    // Corrupt ciphertext (not decryptable under ANY key shape).
    const channel = await db.alertChannel.create({
      data: {
        userId, type: "discord",
        encryptedKey: "!!!!not-valid-ciphertext!!!!", iv: "!!!!", authTag: "!!!!",
        targetPreview: "discord.com/api/webhooks/4777…/••••", enabled: true,
      },
      select: { id: true },
    });
    const delivery = await db.alertDelivery.create({
      data: {
        userId, ruleId: (await db.alertRule.findFirst({ where: { userId } }))!.id, triggerType: "cooldown_ready",
        dedupeKey: `audit-f4:${randomBytes(4).toString("hex")}`, occurredAt: new Date(), title: "T", message: "M", status: "sent",
      },
      select: { id: true },
    });
    const rowId = (
      await db.alertChannelDelivery.create({
        data: { userId, deliveryId: delivery.id, channelId: channel.id, status: "pending" },
        select: { id: true },
      })
    ).id;

    senderMock.mockClear();
    const { dispatchDueAlertDeliveries } = await import("../src/alerts/dispatch.js");
    await dispatchDueAlertDeliveries({ sender: senderMock });
    const row = await db.alertChannelDelivery.findUnique({ where: { id: rowId } });
    expect(row!.status).toBe("failed");
    expect(row!.errorKind).toBe("unreadable_target");
    expect(row!.errorMessage).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(senderMock).toHaveBeenCalledTimes(0); // never sent anywhere
    expect(JSON.stringify(row)).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz"); // no plaintext leak
  });

  it("an invalid alerts encryption configuration aborts the pass and RETAINS pending rows (audit F4)", async () => {
    await db.alertChannel.updateMany({ where: { userId }, data: { enabled: false } });
    const encryption = new EncryptionService(process.env.API_KEY_ENCRYPTION_KEY!);
    const webhook = "https://discord.com/api/webhooks/1234567890123501/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij";
    const encrypted = encryption.encrypt(webhook);
    const channel = await db.alertChannel.create({
      data: {
        userId, type: "discord",
        encryptedKey: encrypted.encryptedKey, iv: encrypted.iv, authTag: encrypted.authTag,
        targetPreview: "discord.com/api/webhooks/3501…/••••", enabled: true,
      },
      select: { id: true },
    });
    const delivery = await db.alertDelivery.create({
      data: {
        userId, ruleId: (await db.alertRule.findFirst({ where: { userId } }))!.id, triggerType: "cooldown_ready",
        dedupeKey: `audit-f4cfg:${randomBytes(4).toString("hex")}`, occurredAt: new Date(), title: "T", message: "M", status: "sent",
      },
      select: { id: true },
    });
    const rowId = (
      await db.alertChannelDelivery.create({
        data: { userId, deliveryId: delivery.id, channelId: channel.id, status: "pending" },
        select: { id: true },
      })
    ).id;

    // A broken encryption factory (the boot-invalid-key shape) aborts the
    // pass ONCE; the row stays pending and nothing is sent or destroyed.
    senderMock.mockClear();
    const { dispatchDueAlertDeliveries } = await import("../src/alerts/dispatch.js");
    await expect(
      dispatchDueAlertDeliveries({
        sender: senderMock,
        encryption: () => {
          throw new Error("API_KEY_ENCRYPTION_KEY must be 64 hex characters");
        },
      })
    ).resolves.toBeUndefined();
    const row = await db.alertChannelDelivery.findUnique({ where: { id: rowId } });
    expect(row!.status).toBe("pending"); // retained, resumes after the key is fixed
    expect(senderMock).toHaveBeenCalledTimes(0);
  });

  it("disabled rules are skipped; demo profiles are never evaluated", async () => {
    await createRule({
      triggerType: "travel_landed",
      enabled: false,
      lastState: { observedAt: NOW - 120, timers: { travelLandsAt: NOW - 30 } },
    });
    await db.alertRule.create({
      data: { userId: demoUserId, triggerType: "travel_landed", enabled: true, lastState: { observedAt: NOW - 120, timers: { travelLandsAt: NOW - 30 } } as never },
      select: { id: true },
    });
    liveState = { travelLandsAt: null };
    await evaluate();
    // Disabled rule: nothing.
    expect(await db.alertDelivery.count({ where: { userId, triggerType: "travel_landed" } })).toBe(0);
    // Demo profile: the engine skipped it entirely (no deliveries, and the
    // rule's seeded baseline is UNCHANGED — it was never re-evaluated).
    expect(await db.alertDelivery.count({ where: { userId: demoUserId } })).toBe(0);
    const demoRule = await db.alertRule.findFirst({ where: { userId: demoUserId } });
    expect(demoRule!.lastState).toEqual({ observedAt: NOW - 120, timers: { travelLandsAt: NOW - 30 } });
  });

  it("each user's deliveries are invisible to another account's queries", async () => {
    const other = await db.user.create({
      data: { displayName: `alerts-other-${randomBytes(4).toString("hex")}`, role: "user" },
      select: { id: true },
    });
    try {
      // The same shape the API service queries with — scoping is the
      // isolation boundary (the API suite exercises it through services).
      const own = await db.alertDelivery.findMany({ where: { userId } });
      const foreign = await db.alertDelivery.findMany({ where: { userId: other.id } });
      expect(own.length).toBeGreaterThan(0);
      expect(foreign).toEqual([]);
    } finally {
      await db.user.delete({ where: { id: other.id } }).catch(() => undefined);
    }
  });
});
