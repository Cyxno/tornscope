import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { createGoal, deleteGoal, listGoals, updateGoal } from "../src/services/goals.js";

/**
 * Goals service integration suite (2.0).
 *
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set (CI provides
 * one; hermetic local runs skip). Uses a throwaway user + snapshots and
 * cleans up after itself — never touches real profiles.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
let userId: string;
/** Test-case counter: keeps capturedAt values unique across cases (the
 *  (userId, capturedAt) unique constraint would otherwise collide). */
let caseOffset = 0;

function networthRow(total: number, capturedAt: number, wallet = 0) {
  return {
    userId,
    capturedAt: new Date(capturedAt * 1000),
    total: BigInt(total),
    wallet: BigInt(wallet),
    vault: 0n, pending: 0n, bookie: 0n, cityBank: 0n, caymanBank: 0n, piggyBank: 0n,
    loans: 0n, unpaidFees: 0n, inventory: 0n, displayCase: 0n, bazaar: 0n, trades: 0n,
    itemMarket: 0n, auctionHouse: 0n, enlistedCars: 0n, property: 0n, stockMarket: 0n,
    company: 0n, points: 0n, raw: undefined,
  };
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { displayName: `goals-test-${randomBytes(6).toString("hex")}`, role: "user", isDemo: false },
    select: { id: true },
  });
  userId = user.id;
});

afterAll(async () => {
  if (userId) await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  if (dbUrl) await db.$disconnect();
});

suite("goals service", () => {
  it("creates, lists and deletes a goal", async () => {
    const created = await createGoal(userId, { metric: "networth", target: 5_000_000_000, note: "five B" });
    expect(created.metric).toBe("networth");
    expect(created.target).toBe(5_000_000_000);
    expect(created.status).toBe("active");

    const listed = await listGoals(userId);
    expect(listed.goals).toHaveLength(1);
    expect(listed.metrics.length).toBeGreaterThanOrEqual(8);
    expect(listed.defaultLookbackDays).toBe(30);
    const view = listed.goals[0]!;
    expect(view.goal.id).toBe(created.id);
    // No snapshots yet → honest unavailable, projection withheld.
    expect(view.currentValue).toBeNull();
    expect(view.dataAvailable).toBe(false);
    expect(view.projection.insufficientReason).toBe("insufficient_history");

    const deleted = await deleteGoal(userId, created.id);
    expect(deleted.deleted).toBe(true);
    expect((await listGoals(userId)).goals).toHaveLength(0);
  });

  it("computes progress and a projection from stored net worth snapshots", async () => {
    // 30 clean days of +10M/day growth from 1B.
    caseOffset += 10;
    await db.networthSnapshot.createMany({
      data: Array.from({ length: 30 }, (_, i) => networthRow(1_000_000_000 + (i + 1) * 10_000_000, now - (30 - i) * DAY - caseOffset * 3600)),
    });
    const created = await createGoal(userId, { metric: "networth", target: 2_000_000_000 });
    const listed = await listGoals(userId);
    const view = listed.goals.find((g) => g.goal.id === created.id)!;
    expect(view.currentValue).toBe(1_000_000_000 + 30 * 10_000_000);
    expect(view.progress).toBeCloseTo(view.currentValue! / 2_000_000_000, 10);
    expect(view.projection.insufficientReason).toBeNull();
    expect(view.projection.velocityPerDay).toBeCloseTo(10_000_000, 3);
    expect(view.projection.etaAt).not.toBeNull();

    caseOffset += 10;
    // Liquid wealth reads the wallet column of the same snapshots.
    const liquid = await createGoal(userId, { metric: "liquid_wealth", target: 500_000_000 });
    const liquidView = (await listGoals(userId)).goals.find((g) => g.goal.id === liquid.id)!;
    expect(liquidView.currentValue).toBe(0); // wallet columns are 0 in this fixture
    void liquidView;
  });

  it("lazily marks achieved goals on read and keeps them frozen", async () => {
    // Own profile: the suite user carries earlier (larger) snapshots whose
    // latest value would dominate this case's "latest value" semantics.
    const owner = await db.user.create({
      data: { displayName: `goals-achieve-${randomBytes(6).toString("hex")}`, role: "user" },
      select: { id: true },
    });
    const ownerId = owner.id;
    const base = now - DAY;
    await db.networthSnapshot.createMany({
      data: [
        { ...networthRow(1_000_000, base - DAY), userId: ownerId },
        { ...networthRow(1_200_000, base, 50_000), userId: ownerId },
      ],
    });
    const goal = await createGoal(ownerId, { metric: "networth", target: 1_500_000 });
    let listed = await listGoals(ownerId);
    let view = listed.goals.find((g) => g.goal.id === goal.id)!;
    expect(view.goal.status).toBe("active"); // latest 1.2M < 1.5M

    // A later snapshot crosses the target; the next READ persists achievement.
    await db.networthSnapshot.create({ data: { ...networthRow(1_800_000, base + 3600, 60_000), userId: ownerId } });
    listed = await listGoals(ownerId);
    view = listed.goals.find((g) => g.goal.id === goal.id)!;
    expect(view.goal.status).toBe("achieved");
    expect(view.goal.achievedAt).not.toBeNull();
    expect(view.projection.insufficientReason).toBe("target_reached");

    const row = await db.goal.findUnique({ where: { id: goal.id } });
    expect(row?.status).toBe("achieved");
    expect(row?.achievedAt).not.toBeNull();

    await db.user.delete({ where: { id: ownerId } });
  });

  it("updates target/status and clears achievement on reopen", async () => {
    const goal = await createGoal(userId, { metric: "level", target: 50 });
    const updated = await updateGoal(userId, goal.id, { target: 60, status: "archived" });
    expect(updated.target).toBe(60);
    expect(updated.status).toBe("archived");
    const reopened = await updateGoal(userId, goal.id, { status: "active" });
    expect(reopened.status).toBe("active");
    const row = await db.goal.findUnique({ where: { id: goal.id } });
    expect(row?.achievedAt).toBeNull();
  });

  it("refuses to touch other profiles' goals", async () => {
    const other = await db.user.create({
      data: { displayName: `goals-other-${randomBytes(6).toString("hex")}`, role: "user" },
      select: { id: true },
    });
    const goal = await createGoal(other.id, { metric: "networth", target: 1_000 });
    await expect(updateGoal(userId, goal.id, { target: 2_000 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteGoal(userId, goal.id)).rejects.toMatchObject({ statusCode: 404 });
    await db.user.delete({ where: { id: other.id } });
  });
});
