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
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let userId: string;

beforeAll(async () => {
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
    ],
  });
});

afterAll(async () => {
  await db.activityEvent.deleteMany({ where: { userId } });
  await db.timelineEvent.deleteMany({ where: { userId } });
  await db.appSetting.deleteMany({ where: { userId } });
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
});

suite("activity repair (DB-backed)", () => {
  it("dry-run reports without writing", () => {
    const out = runRepair(["--dry-run"]);
    expect(out).toContain("Recognized (would insert): 3");
    expect(out).toContain("DRY RUN");
    expect(db.activityEvent.count({ where: { userId } })).resolves.toBe(0);
  });

  it("inserts recognized activities; consumable skipped", async () => {
    const out = runRepair();
    expect(out).toContain("Repair applied: 3");
    expect(db.activityEvent.count({ where: { userId } })).resolves.toBe(3);
    expect(db.activityEvent.count({ where: { userId, activityType: "slots" } })).resolves.toBe(1);
    expect(db.activityEvent.count({ where: { userId, activityType: "bookie" } })).resolves.toBe(1);
    expect(db.activityEvent.count({ where: { userId, domain: "openable" } })).resolves.toBe(1);
  });

  it("slots net value is exact (won − bet)", async () => {
    const slots = await db.activityEvent.findFirst({ where: { userId, activityType: "slots" } });
    expect(slots!.netValue).toBe(5_000_000n);
    expect(slots!.valuation).toBe("exact");
  });

  it("raw archive untouched", () => {
    expect(db.timelineEvent.count({ where: { userId } })).resolves.toBe(4);
  });

  it("second run inserts nothing (idempotent)", () => {
    // The archive may hold other users' candidates (shared/dev databases),
    // so idempotency is asserted on THIS user's rows: nothing new is
    // applied, count unchanged.
    const out = runRepair();
    expect(out.includes("Repair applied:")).toBe(false);
    expect(db.activityEvent.count({ where: { userId } })).resolves.toBe(3);
  });
});
