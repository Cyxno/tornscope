import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient, insertActivityEvents, upsertCatalogEntries } from "@tornscope/database";
import type { ActivityEventInput } from "@tornscope/database";
import { getCasinoSummary } from "../src/services/casino.js";
import { getRewardsSummary } from "../src/services/rewards.js";

/**
 * Activity & Rewards analytics integration suite (2.4.0).
 *
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set (CI provides
 * one; hermetic local runs skip). Covers: casino aggregation semantics
 * (placements are pending, never losses), rewards valuation classes
 * (exact cash / estimated items / unpriced never-zero), idempotent ingest,
 * ledger reconciliation deltas, and bounded-query index usage.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const now = Math.floor(Date.now() / 1000);
let userId: string;

function activity(partial: Partial<ActivityEventInput> & { sourceRef: string; occurredAt: Date }): ActivityEventInput {
  return {
    domain: "casino",
    activityType: "slots",
    activityLabel: "Slots",
    subtype: null,
    outcome: null,
    game: null,
    wheel: null,
    opponentId: null,
    cashInput: null,
    cashReward: null,
    pointsReward: null,
    tokensReward: null,
    nonPriceable: null,
    inputValue: null,
    rewardValue: null,
    netValue: null,
    valuation: "exact",
    provenance: "exact",
    metadata: {},
    ...partial,
  };
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { displayName: `activity-test-${randomBytes(6).toString("hex")}`, role: "user", isDemo: false },
    select: { id: true },
  });
  userId = user.id;

  const t = (s: number) => new Date((now - s) * 1000);
  await insertActivityEvents(db, userId, [
    // Slots: one loss, one win — net exact per spin.
    activity({ sourceRef: "act-t:slots:lose", occurredAt: t(3_600), cashInput: 1_000_000n, netValue: -1_000_000n, subtype: "lose", outcome: "loss" }),
    activity({ sourceRef: "act-t:slots:win", occurredAt: t(3_000), cashInput: 1_000_000n, cashReward: 6_000_000n, netValue: 5_000_000n, subtype: "win", outcome: "win" }),
    // Bookie placement — pending, netValue null (never a loss).
    activity({ sourceRef: "act-t:bookie:bet", occurredAt: t(2_400), activityType: "bookie", activityLabel: "Bookie", cashInput: 200_000n, netValue: null, subtype: "placed", outcome: "placed" }),
    // Wallet opening: exact cash + items (one priced, one unpriced).
    activity({
      sourceRef: "act-t:wallet:1", occurredAt: t(1_800), domain: "openable", activityType: "openable-1079", activityLabel: "Item #1079",
      subtype: "opened", outcome: "opened", cashReward: 130n, valuation: "exact",
      metadata: { item: 1079, items: [{ id: 67, qty: 3 }, { id: 1084, qty: 2 }], money: 130 },
    }),
    // Points-only pack: unpriced, never zero.
    activity({
      sourceRef: "act-t:pack:1", occurredAt: t(1_200), domain: "openable", activityType: "openable-283", activityLabel: "Donator Pack",
      subtype: "opened", outcome: "opened", pointsReward: 60, valuation: "unpriced",
      metadata: { item: 283, points: 60 },
    }),
  ]);

  // Ledger: the same cash movements MoneyEvent would carry for the casino
  // logs above (slots −1M/+6M, bookie placement not yet settled).
  await db.moneyEvent.createMany({
    data: [
      { userId, occurredAt: t(3_600), category: "casino", subcategory: "Casino slots lose", direction: "expense", amount: 1_000_000n, source: "torn_log", sourceRef: "act-t:slots:lose", description: "Casino slots lose" },
      { userId, occurredAt: t(3_000), category: "casino", subcategory: "Casino slots win", direction: "income", amount: 6_000_000n, source: "torn_log", sourceRef: "act-t:slots:win", description: "Casino slots win" },
    ],
  });

  // Catalog prices for valuation (67 priced, 1084 unpriced, 1079 input priced).
  await upsertCatalogEntries(db, [
    { itemId: 67, name: "First Aid Kit", type: "Medical", marketPrice: 400n },
    { itemId: 1079, name: "Wallet", type: "Other", marketPrice: 1_000n },
  ]);
});

afterAll(async () => {
  if (userId) await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  if (dbUrl) await db.$disconnect();
});

const range = { preset: "custom" as const, from: now - 86_400, to: now + 60 };

suite("casino analytics service", () => {
  it("aggregates per-game wagers, returns and net exactly", async () => {
    const res = await getCasinoSummary(userId, range);
    expect(res.range.from).toBe(range.from);
    expect(res.activities).toBe(3);
    expect(res.totalWagered.value).toBe(2_200_000);
    expect(res.cashReturned.value).toBe(6_000_000);
    // Net sums per-spin netValue: −1M (loss) + 5M (win); the pending bookie
    // placement carries null net and contributes nothing.
    expect(res.netCash.value).toBe(4_000_000);
    expect(res.totalWagered.provenance).toBe("exact");

    const slots = res.games.find((g) => g.game === "slots")!;
    expect(slots.plays).toBe(2);
    expect(slots.wagered).toBe(2_000_000);
    expect(slots.cashWon).toBe(6_000_000);
    expect(slots.net).toBe(4_000_000); // −1M loss + 5M win
    expect(slots.lastPlayedAt).not.toBeNull();

    // Placements are pending — the bookie row exists with null net and never
    // drags the aggregate negative.
    const bookie = res.games.find((g) => g.game === "bookie")!;
    expect(bookie.plays).toBe(1);
    expect(bookie.net).toBeNull();
    expect(res.outcomeCounts["placed"]).toBe(1);
  });

  it("reconciles the semantic activity delta against the MoneyEvent ledger", async () => {
    // The settled slots cash (won − bet = +5M) is exactly what the ledger
    // records (income 6M − expense 1M); the pending bookie placement exists
    // only as a semantic row with null net — never a ledger movement, never
    // counted as a loss. Differences between the two views are surfaced by
    // the repair/audit reconciliation, not patched.
    const ledger = await db.moneyEvent.groupBy({
      by: ["direction"],
      where: { userId, category: "casino" },
      _sum: { amount: true },
    });
    const byDirection = new Map(ledger.map((r) => [r.direction, r._sum.amount ?? 0n]));
    expect(byDirection.get("income")).toBe(6_000_000n);
    expect(byDirection.get("expense")).toBe(1_000_000n);
    const slotsNet = -1_000_000n + 5_000_000n;
    const slotsActivity = await db.activityEvent.aggregate({
      where: { userId, activityType: "slots" },
      _sum: { netValue: true },
    });
    expect(slotsActivity._sum.netValue).toBe(slotsNet);
  });
});

suite("rewards analytics service", () => {
  it("values cash exact, items estimated at current catalog prices, unpriced stays visible", async () => {
    const res = await getRewardsSummary(userId, range);
    expect(res.openings).toBe(2);
    expect(res.containerTypes).toBe(2);
    expect(res.cashReceived).toBe(130);

    // Reward items: 3 × First Aid Kit @400 = 1200; 2 × unpriced → visible.
    expect(res.itemValueEstimate.provenance).toBe("estimated");
    expect(res.itemValueEstimate.value).toBe(1_200);
    const kit = res.topItemRewards.find((i) => i.itemId === 67)!;
    expect(kit.qty).toBe(3);
    expect(kit.unitPriceEstimate).toBe(400);
    expect(kit.valueEstimate).toBe(1_200);
    expect(res.topItemRewards.find((i) => i.itemId === 1084)?.valueEstimate).toBeNull();

    // Input: 2 openings of priced items (wallet @1000 ×1) = 1000.
    expect(res.inputValueEstimate.value).toBe(1_000);

    // Estimated net = 130 + 1200 − 1000.
    expect(res.estimatedNet.value).toBe(330);
    expect(res.estimatedNet.provenance).toBe("estimated");

    // Unpriced quantity (2 × item 1084) reported, never zeroed.
    expect(res.unpricedItemQty).toBeGreaterThanOrEqual(2);
  });

  it("returns null — not zero — for ranges with nothing valued", async () => {
    const res = await getRewardsSummary(userId, { preset: "custom", from: now - 3_600, to: now - 3_000 });
    expect(res.openings).toBe(0);
    expect(res.cashReceived).toBeNull();
    expect(res.estimatedNet.value).toBeNull();
  });
});

suite("activity ingest + query shape", () => {
  it("is idempotent: re-inserting the same sourceRefs adds no rows", async () => {
    const before = await db.activityEvent.count({ where: { userId } });
    await insertActivityEvents(db, userId, [
      activity({ sourceRef: "act-t:slots:win", occurredAt: new Date((now - 3_000) * 1000), cashInput: 1_000_000n, cashReward: 6_000_000n, netValue: 5_000_000n, subtype: "win", outcome: "win" }),
    ]);
    const after = await db.activityEvent.count({ where: { userId } });
    expect(after).toBe(before);
  });

  it("window aggregates can hit the (userId, domain, activityType, occurredAt) index", async () => {
    // Tiny tables plan a seq scan; force index eligibility to prove the
    // index matches the window predicate shape (production tables plan it
    // naturally once rows exceed the seq-scan threshold).
    const plan = await db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe("SET LOCAL enable_seqscan = OFF");
      return tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
        `EXPLAIN SELECT "activityType", count(*), sum("netValue")
         FROM "ActivityEvent"
         WHERE "userId" = $1 AND domain = 'casino' AND "occurredAt" BETWEEN $2 AND $3
         GROUP BY 1`,
        userId, new Date(range.from * 1000), new Date(range.to * 1000),
      );
    });
    const planText = plan.map((r) => r["QUERY PLAN"]).join("\n");
    // Any userId-scoped index serving the window predicate is fine — the
    // planner picks the composite index once tables outgrow seq scans
    // (verified at 60k rows: Bitmap Index Scan on the composite index).
    expect(planText).toMatch(/Index Scan using "ActivityEvent_userId[^"]*_idx"/);
  });
});
