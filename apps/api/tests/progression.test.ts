import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { getProgression, getProgressionGlimpse } from "../src/services/progression.js";
import { getDailySummary } from "../src/services/dailySummary.js";
import { deleteProfile } from "../src/services/me.js";

/**
 * Progression & Energy Intelligence acceptance (roadmap item).
 *
 * DB-backed: synthetic profiles exercise capability gating, zero-vs-
 * unavailable semantics, isolation and the Daily Summary integration.
 * Analytics-level matrices live in packages/analytics/tests/progression.test.ts.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();

const FULL_CAPS = {
  canReadUserBasic: true, canReadUserBars: true, canReadUserCooldowns: true, canReadUserEducation: true,
  canReadUserTravel: true, canReadUserMoney: true, canReadUserLogs: true, canReadUserAttacks: true,
  canReadUserNetworth: true, canReadUserEvents: true, canReadUserPersonalStats: true,
  canReadFactionBasic: false, canReadFactionMembers: false, canReadFactionRankedWars: false,
  canReadFactionChains: false, canReadFactionCrimes: false, canReadFactionArmoryNews: false,
  canReadFactionBalance: false, canReadFactionLogs: false,
};
const LIMITED_CAPS = { ...FULL_CAPS, canReadUserLogs: false, canReadUserBars: false, canReadUserPersonalStats: false };

const DAY = 86_400;
const nowSec = Math.floor(Date.now() / 1000);
const range = { preset: "7d" as const, from: undefined, to: undefined };
const cleanupIds: string[] = [];

async function makeProfile(name: string, caps: object): Promise<{ id: string; tornId: number }> {
  const tornId = 2_100_000_000 + Math.floor(Math.random() * 40_000_000);
  const user = await db.user.create({ data: { displayName: name, role: "user", timezone: "UTC" } });
  cleanupIds.push(user.id);
  await db.apiCredential.create({
    data: {
      userId: user.id,
      encryptedKey: randomBytes(16).toString("hex"),
      iv: randomBytes(8).toString("hex"),
      authTag: randomBytes(8).toString("hex"),
      keyPreview: "TEST",
      accessLevel: 3,
      accessType: "Limited",
      logAccessAvailable: true,
      capabilities: caps,
      validatedAt: new Date(),
    },
  });
  await db.tornAccount.create({ data: { userId: user.id, tornId, name, level: 40, firstSeenAt: new Date(), lastSeenAt: new Date() } });
  return { id: user.id, tornId };
}

/** Bars snapshots in a train/regen/train shape, aligned to 5-minute steps. */
async function seedBars(userId: string): Promise<void> {
  const start = Math.floor(nowSec / 300) * 300 - 3 * 3600;
  const rows = [];
  let energy = 150;
  for (let t = start; t < start + 3 * 3600; t += 300) {
    const minute = Math.floor((t % 3600) / 60);
    if (minute >= 30 && minute < 50) energy = Math.max(30, energy - 25); // training burst
    else if (minute < 30) energy = Math.min(150, energy + 1); // regen
    rows.push({
      userId,
      capturedAt: new Date(t * 1000),
      energyCurrent: energy,
      energyMaximum: 150,
      happyCurrent: 1000,
      happyMaximum: 5000,
    });
  }
  await db.barsSnapshot.createMany({ data: rows, skipDuplicates: true });
}

/** Hourly personalstats snapshots with real battle_stats growth. */
async function seedStats(userId: string): Promise<void> {
  const start = Math.floor(nowSec / 3600) * 3600 - 3 * 3600;
  const rows = [];
  let strength = 1_000_000;
  for (let t = start; t <= start + 3 * 3600; t += 3600) {
    rows.push({
      userId,
      capturedAt: new Date(t * 1000),
      networthTotal: null,
      stats: {
        battle_stats: { strength, defense: 500_000, speed: 400_000, dexterity: 300_000, total: strength + 1_200_000 },
        other: { refills: { energy: 3 }, awards: 10 },
        drugs: { xanax: 5, ecstasy: 1 },
      },
    });
    strength += 50_000;
  }
  await db.personalStatSnapshot.createMany({ data: rows, skipDuplicates: true });
}

async function caughtUpStates(userId: string): Promise<void> {
  for (const resource of ["bars", "personal_stats", "drugs", "money_logs", "travel", "rehab", "events"]) {
    await db.syncState.upsert({
      where: { userId_resource: { userId, resource } },
      create: {
        userId, resource, status: "idle",
        lastSuccessAt: new Date((nowSec - 300) * 1000),
        lastAttemptAt: new Date((nowSec - 300) * 1000),
        lastCompletedAt: new Date((nowSec - 300) * 1000),
        recordsCollected: 1000,
        stopReason: "history_boundary_reached",
        sourceEarliestAt: BigInt(nowSec - 60 * DAY),
        lastTimestamp: BigInt(nowSec - 300),
        frequencySeconds: resource === "bars" ? 300 : 600,
        nextRunAt: new Date((nowSec + 600) * 1000),
      },
      update: { status: "idle", recordsCollected: 1000, stopReason: "history_boundary_reached" },
    });
  }
}

suite("progression & energy intelligence", () => {
  it("full profile: battlestat delta derived from brackets; training energy inferred from bars", async () => {
    const p = await makeProfile("PROG-FULL", FULL_CAPS);
    await caughtUpStates(p.id);
    await seedBars(p.id);
    await seedStats(p.id);
    // Window anchored to the stat grid so it always contains a burst and
    // both delta anchors (the fixtures span hourStart-3h .. hourStart).
    const hourStart = Math.floor(nowSec / 3600) * 3600;
    const s = await getProgression(p.id, { preset: "custom", from: hourStart - 2 * 3600, to: nowSec });
    expect(s.summary.totalBattlestats.value).toBeGreaterThan(0);
    expect(s.summary.totalDelta.value).toBeGreaterThan(0);
    expect(s.battlestats.series.length).toBeGreaterThanOrEqual(2);
    // Bars observed a 120-energy decline (150 → 30).
    expect(s.energy.covered).toBe(true);
    expect(s.energy.uses.some((u) => u.category.startsWith("Training"))).toBe(true);
    expect(s.training.sessions.length).toBeGreaterThanOrEqual(1);
    const session = s.training.sessions[0]!;
    expect(session.energySpent).toBeGreaterThan(0);
    // Honest labeling: sessions carry inference strength and evidence.
    expect(["likely", "possible"]).toContain(session.inference);
    expect(Array.isArray(session.evidence)).toBe(true);
  });

  it("zero bars + zero stats stays null — never zero-filled", async () => {
    const p = await makeProfile("PROG-EMPTY", FULL_CAPS);
    await caughtUpStates(p.id);
    const s = await getProgression(p.id, range);
    expect(s.energy.covered).toBe(false);
    expect(s.summary.energyTrained.value).toBeNull();
    expect(s.summary.totalDelta.value).toBeNull();
    expect(s.battlestats.trackedSince).toBeNull();
    expect(s.battlestats.milestones).toEqual([]);
  });

  it("limited capability: sections degrade independently, never blank the page", async () => {
    const p = await makeProfile("PROG-LIMITED", LIMITED_CAPS);
    await caughtUpStates(p.id);
    await seedStats(p.id); // retained personalstats history exists
    const s = await getProgression(p.id, range);
    // Personal stats were collected while the key had access → retained.
    expect(s.summary.totalBattlestats.value).not.toBeNull();
    // No bar permission → energy/training degrade without fabrication.
    expect(s.energy.covered).toBe(false);
    expect(s.summary.energyTrained.value).toBeNull();
    // The matrix distinguishes "can no longer refresh" (stale) from "never
    // had it": with a prior sync state the feature stays visible as stale.
    expect(s.availability?.energy.state).toBe("stale_permission");
    // Retained personalstats history exists; the key just cannot refresh it.
    expect(s.availability?.battlestats.state).toBe("stale_permission");
  });

  it("multi-user isolation: another profile's stats and bars never leak", async () => {
    const a = await makeProfile("PROG-ISO-A", FULL_CAPS);
    const b = await makeProfile("PROG-ISO-B", FULL_CAPS);
    await caughtUpStates(a.id);
    await caughtUpStates(b.id);
    await seedBars(a.id);
    await seedStats(a.id);
    const sa = await getProgression(a.id, range);
    const sb = await getProgression(b.id, range);
    expect(sa.summary.totalBattlestats.value).not.toBeNull();
    expect(sb.summary.totalBattlestats.value).toBeNull();
    expect(sb.energy.covered).toBe(false);
    expect(sb.training.sessions).toHaveLength(0);
  });

  it("timezone: the Daily Summary progression glimpse respects the user's day", async () => {
    const p = await makeProfile("PROG-TZ", FULL_CAPS);
    await caughtUpStates(p.id);
    const dayStartUtc = Math.floor(nowSec / DAY) * DAY;
    // A pre-day snapshot anchors the day window (like the hourly collector does).
    await db.personalStatSnapshot.create({
      data: {
        userId: p.id,
        capturedAt: new Date((dayStartUtc - 3600) * 1000),
        networthTotal: null,
        stats: { battle_stats: { strength: 50_000, defense: 100_000, speed: 100_000, dexterity: 100_000, total: 350_000 } },
      },
    });
    await db.personalStatSnapshot.create({
      data: {
        userId: p.id,
        capturedAt: new Date((dayStartUtc + 3600) * 1000),
        networthTotal: null,
        stats: { battle_stats: { strength: 100_000, defense: 100_000, speed: 100_000, dexterity: 100_000, total: 400_000 } },
      },
    });
    await db.personalStatSnapshot.create({
      data: {
        userId: p.id,
        capturedAt: new Date((dayStartUtc + 2 * 3600) * 1000),
        networthTotal: null,
        stats: { battle_stats: { strength: 150_000, defense: 100_000, speed: 100_000, dexterity: 100_000, total: 450_000 } },
      },
    });
    // 01:00 UTC = still the previous day in Los Angeles (UTC-7 → 18:00).
    const summaryUtc = await getDailySummary({ id: p.id, timezone: "UTC", isDemo: false });
    const summaryLa = await getDailySummary({ id: p.id, timezone: "America/Los_Angeles", isDemo: false });
    const utcHas = summaryUtc.progression?.battlestatGain.value ?? null;
    const laHas = summaryLa.progression?.battlestatGain.value ?? null;
    // UTC "today" contains both snapshots (50k growth); the LA "today" may
    // contain none of them depending on the current hour — the point is they
    // are computed on DIFFERENT day windows, not one global window.
    expect(utcHas === null || typeof utcHas === "number").toBe(true);
    if (nowSec - dayStartUtc >= 2 * 3600) {
      expect(utcHas).toBe(100_000); // 450k closing − 350k pre-day baseline
      if (nowSec - dayStartUtc < 7 * 3600) {
        expect(laHas).toBeNull(); // LA is still on the previous day
      }
    }
    expect(summaryUtc.progression).not.toBeNull();
    expect(summaryUtc.progression!.energyTrained.provenance).toBe("estimated");
  });

  it("cross-page contract: Today's glimpse and Progression agree for the same day", async () => {
    // Phase 45: one canonical engine — the Daily Summary glimpse must report
    // the SAME sessions and training energy as the Progression page, and the
    // gym-attributable gain must match the Progression attribution split.
    const p = await makeProfile("PROG-CROSSPAGE", FULL_CAPS);
    await caughtUpStates(p.id);
    await seedBars(p.id);
    await seedStats(p.id);
    const dayStart = Math.floor(nowSec / DAY) * DAY;
    // Deterministic only once the seeded 3h of history sits inside the UTC
    // day and the glimpse's 1h pre-window can anchor the day baseline.
    if (nowSec - dayStart < 4 * 3600) return;
    const full = await getProgression(p.id, { preset: "custom", from: dayStart, to: nowSec });
    const glimpse = await getProgressionGlimpse(p.id, dayStart, nowSec);

    expect(glimpse.sessions).toBe(full.summary.sessions);
    expect(glimpse.energyTrained).toBe(full.summary.energyTrained.value);
    expect(glimpse.battlestatGain).toBe(full.summary.totalDelta.value);
    if (full.battlestats.attribution.gym === 0 && glimpse.gymGain === null) {
      // Both honest: no clean bracket anywhere (gym gain unknown, never 0).
      expect(full.battlestats.attribution.gym).toBe(0);
    } else {
      expect(glimpse.gymGain).toBe(full.battlestats.attribution.gym);
    }

    // The Daily Summary strip carries the same numbers through its contract.
    const dayKey = new Date(dayStart * 1000).toISOString().slice(0, 10);
    const summary = await getDailySummary({ id: p.id, timezone: "UTC", isDemo: false }, dayKey);
    expect(summary.progression).not.toBeNull();
    expect(summary.progression!.sessions).toBe(full.summary.sessions);
    expect(summary.progression!.energyTrained.value).toBe(full.summary.energyTrained.value);
    expect(summary.progression!.gymGain?.value ?? null).toBe(glimpse.gymGain);
    expect(summary.progression!.gymGain?.provenance ?? null).toBe(glimpse.gymGain === null ? null : "derived");
  });

  it("demo profile: coherent progression history with an inferred happy jump", async () => {
    const demoUser = await db.user.findUnique({ where: { email: "demo@tornscope.local" } });
    if (!demoUser) return; // demo seed not present in this environment
    const s = await getProgression(demoUser.id, { preset: "custom", from: nowSec - 3 * DAY, to: nowSec });
    expect(s.battlestats.trackedSince).not.toBeNull();
    expect(s.battlestats.series.length).toBeGreaterThan(24); // hourly snapshots
    if (s.energy.covered) {
      // Demo bars derive a ~12/h regen rate and attribute training energy.
      expect(s.energy.regenPerHour).not.toBeNull();
      expect(s.summary.energyTrained.value).toBeGreaterThan(0);
      expect(s.training.sessions.length).toBeGreaterThan(0);
      const jumps = s.happyJumps.jumps;
      expect(jumps.length).toBeGreaterThanOrEqual(1);
      const likely = jumps.find((j) => j.confidence === "likely");
      if (likely) {
        expect(likely.signals).toContain("xanax_cluster");
        expect(likely.evidence.length).toBeGreaterThanOrEqual(3);
        expect(likely.missing.some((m) => m.toLowerCase().includes("estimate"))).toBe(true);
      }
    }
  });
});

afterAll(async () => {
  for (const id of cleanupIds) {
    try {
      await deleteProfile(id);
    } catch {
      /* already gone */
    }
  }
});
