import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getPrismaClient } from "../src/client.js";

/**
 * Activity & Rewards repair tests (2.4.0): backfill ActivityEvents from raw
 * TimelineEvent logs — idempotent, raw archive untouched, sourceRef-based.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;
const db = getPrismaClient();
const REPAIR_SCRIPT = fileURLToPath(new URL("../src/repair/activity-repair.ts", import.meta.url));

function runRepair(extra: string[] = []): string {
  return execFileSync("pnpm", ["--filter", "@tornscope/database", "exec", "tsx", REPAIR_SCRIPT, ...extra], {
    env: { ...process.env, DATABASE_URL: dbUrl + (dbUrl.includes("?") ? "&" : "?") + "connection_limit=2" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let userId: string;

beforeAll(async () => {
  // Sweep leftovers from crashed earlier runs (only this suite creates
  // ACT-* users) so the repair's global candidate counts stay deterministic.
  await db.user.deleteMany({ where: { displayName: { startsWith: 'ACT-' } } });
  userId = (await db.user.create({ data: { displayName: `ACT-${randomUUID().slice(0, 8)}`, role: "user" } })).id;
  const now = Date.now();
  await db.timelineEvent.createMany({
    data: [
      // Slots win → recognized casino activity.
      { userId, occurredAt: new Date(now - 5_000), type: "log", category: "Casino", title: "Casino slots win", source: "torn_log", sourceRef: "act:slots:1", metadata: { data: { bet_amount: 1000000, won_amount: 6000000, combination: 29 } } },
      // Bookie placement → placed (not a loss).
      { userId, occurredAt: new Date(now - 4_000), type: "log", category: "Casino", title: "Bookie bet (new)", source: "torn_log", sourceRef: "act:bookie:1", metadata: { data: { bet: 200000000, odds: "2.54", selection: [1, 2, 3] } } },
      // Wallet opening → openable with items + cash.
      { userId, occurredAt: new Date(now - 3_000), type: "log", category: "Item use", title: "Item use wallet", source: "torn_log", sourceRef: "act:wallet:1", metadata: { data: { item: 1079, items: [{ id: 1084, qty: 2 }], money: 130, faction: 0 } } },
      // Plain consumable → NOT an activity candidate.
      { userId, occurredAt: new Date(now - 2_000), type: "log", category: "Item use", title: "Item use candy", source: "torn_log", sourceRef: "act:candy:1", metadata: { data: { item: 209, faction: 0, happy_increased: 38 } } },
      // Hunting session (2.5.0) → exact cost/income/net + skill metadata.
      { userId, occurredAt: new Date(now - 6_000), type: "log", category: "Hunting", title: "Hunting", source: "torn_log", sourceRef: "act:hunt:1", metadata: { data: { cost: 500, income: 7985, session_type: "a beginners hunting session", hunting_skill: "56.781", hunting_skill_gain: "and gained 0.0865 hunting skill" } } },
      // Mission completion (2.5.0) → exact cash + credits.
      { userId, occurredAt: new Date(now - 7_000), type: "log", category: "Missions", title: "Missions complete", source: "torn_log", sourceRef: "act:mission:1", metadata: { data: { type: "contract", agent: 3, money: 112000, credits: 67, mission: 51, difficulty: "vhard" } } },
      // Bounty place + claim (2.5.0) → committed cost / income.
      { userId, occurredAt: new Date(now - 8_000), type: "log", category: "Bounties", title: "Bounty place", source: "torn_log", sourceRef: "act:bounty:1", metadata: { data: { cost: 450000, target: 3086444, quantity: 1, bounty_reward: 300000 } } },
      { userId, occurredAt: new Date(now - 9_000), type: "log", category: "Bounties", title: "Bounty claim", source: "torn_log", sourceRef: "act:bounty:2", metadata: { data: { lister: 3437615, target: 2135330, anonymous: 0, bounty_reward: 300000 } } },
      // Racing finish + upgrade (2.5.0) → performance + spend.
      { userId, occurredAt: new Date(now - 10_000), type: "log", category: "Racing", title: "Racing finish official race", source: "torn_log", sourceRef: "act:race:1", metadata: { data: { car: 82, track: 23, race_id: 20621581, position: "1st", racing_skill: "and gained 0.0228 racing skill", racing_points: "1 racing point" } } },
      { userId, occurredAt: new Date(now - 11_000), type: "log", category: "Racing", title: "Racing upgrade car", source: "torn_log", sourceRef: "act:race:2", metadata: { data: { car: 82, cost: 3000, upgrade: 12, racing_points: "2 racing points" } } },
      // Education start (2.5.0) → committed course cost.
      { userId, occurredAt: new Date(now - 12_000), type: "log", category: "Education", title: "Education start", source: "torn_log", sourceRef: "act:edu:1", metadata: { data: { cost: 2880, course: 50, duration: 1270080 } } },
      // Legacy casino money log (2.5.0): no payload at all, only the amount column.
      { userId, occurredAt: new Date(now - 13_000), type: "log", category: "Money casino", title: "Casino win", source: "torn_log", sourceRef: "act:legacy:1", amount: BigInt(133519), metadata: {} },
    ],
  });
});

afterAll(async () => {
  await db.activityEvent.deleteMany({ where: { userId } });
  await db.timelineEvent.deleteMany({ where: { userId } });
  await db.appSetting.deleteMany({ where: { userId } });
  await db.user.deleteMany({ where: { displayName: { startsWith: 'ACT-' } } });
});

suite("activity repair (DB-backed)", () => {
  it("dry-run reports without writing", async () => {
    // Global candidate counts can move while other suites top up the demo
    // profile concurrently — the invariant is user-scoped: nothing written.
    const out = runRepair(["--dry-run"]);
    const recognized = Number(/Recognized \(would insert\): (\d+)/.exec(out)![1]);
    expect(recognized).toBeGreaterThanOrEqual(11);
    expect(out).toContain("DRY RUN");
    await expect(db.activityEvent.count({ where: { userId } })).resolves.toBe(0);
  });

  it("inserts recognized activities across all domains; consumable skipped", async () => {
    // Concurrent demo top-ups may add their own candidates+inserts; the
    // repair's per-user outcome is what this suite asserts.
    const out = runRepair();
    const applied = Number(/Repair applied: (\d+)/.exec(out)![1]);
    expect(applied).toBeGreaterThanOrEqual(11);
    await expect(db.activityEvent.count({ where: { userId } })).resolves.toBe(11);
    await expect(db.activityEvent.count({ where: { userId, activityType: "slots" } })).resolves.toBe(1);
    await expect(db.activityEvent.count({ where: { userId, activityType: "bookie" } })).resolves.toBe(1);
    await expect(db.activityEvent.count({ where: { userId, domain: "openable" } })).resolves.toBe(1);
    await expect(db.activityEvent.count({ where: { userId, domain: "hunting" } })).resolves.toBe(1);
    await expect(db.activityEvent.count({ where: { userId, domain: "missions" } })).resolves.toBe(1);
    await expect(db.activityEvent.count({ where: { userId, domain: "racing" } })).resolves.toBe(2);
    await expect(db.activityEvent.count({ where: { userId, domain: "bounties" } })).resolves.toBe(2);
    await expect(db.activityEvent.count({ where: { userId, domain: "education" } })).resolves.toBe(1);
    await expect(db.activityEvent.count({ where: { userId, activityType: "casino-legacy" } })).resolves.toBe(1);
  });

  it("domain semantics survive the repair (hunt net, bounty directions, legacy game unknown)", async () => {
    const hunt = await db.activityEvent.findFirst({ where: { userId, domain: "hunting", outcome: "completed" } });
    expect(hunt!.netValue).toBe(7485n);
    expect(hunt!.valuation).toBe("exact");
    const meta = hunt!.metadata as { skillLevel?: number };
    expect(meta.skillLevel).toBeCloseTo(56.781, 4);

    const place = await db.activityEvent.findFirst({ where: { userId, domain: "bounties", subtype: "placed" } });
    expect(place!.netValue).toBe(-450000n);
    expect(place!.cashReward).toBeNull(); // bounty_reward belongs to the claimer

    const claim = await db.activityEvent.findFirst({ where: { userId, domain: "bounties", subtype: "claimed" } });
    expect(claim!.netValue).toBe(300000n);

    const legacy = await db.activityEvent.findFirst({ where: { userId, activityType: "casino-legacy" } });
    expect(legacy!.cashReward).toBe(133519n);
    expect(legacy!.game).toBeNull(); // old-format logs have no game attribution — stays unknown

    const mission = await db.activityEvent.findFirst({ where: { userId, domain: "missions" } });
    expect(mission!.cashReward).toBe(112000n);
    expect(mission!.tokensReward).toBe(67);
  });

  it("slots net value is exact (won − bet)", async () => {
    const slots = await db.activityEvent.findFirst({ where: { userId, activityType: "slots" } });
    expect(slots!.netValue).toBe(5_000_000n);
    expect(slots!.valuation).toBe("exact");
  });

  it("raw archive untouched", async () => {
    await expect(db.timelineEvent.count({ where: { userId } })).resolves.toBe(12);
  });

  it("second run inserts nothing (idempotent)", async () => {
    // The archive may hold other users' candidates (shared/dev databases),
    // so idempotency is asserted on THIS user's rows: nothing new is
    // applied, count unchanged.
    runRepair();
    await expect(db.activityEvent.count({ where: { userId } })).resolves.toBe(11);
  });
});
