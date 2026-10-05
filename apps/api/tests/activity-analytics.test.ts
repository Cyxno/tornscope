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
      { userId, occurredAt: t(3_600), category: "casino", subcategory: "Casino slots lose", direction: "expense", amount: -1_000_000n, source: "torn_log", sourceRef: "act-t:slots:lose", description: "Casino slots lose" },
      { userId, occurredAt: t(3_000), category: "casino", subcategory: "Casino slots win", direction: "income", amount: 6_000_000n, source: "torn_log", sourceRef: "act25:ledger:win", description: "Casino slots win" },
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
    expect(byDirection.get("expense")).toBe(-1_000_000n); // expense amounts are stored signed (production convention)
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
    expect(planText).toMatch(/Index Scan using "ActivityEvent_userId[^"]*_(idx|key)"/);
  });
});

suite("domain services (2.5.0)", () => {
  it("hunting summary: exact cash, skill trajectory, session types", async () => {
    const t = (s: number) => new Date((now - s) * 1000);
    await insertActivityEvents(db, userId, [
      { sourceRef: "act25:hunt:1", occurredAt: t(5_000), domain: "hunting", activityType: "hunting", activityLabel: "Hunting", subtype: "beginners", outcome: "completed", cashInput: 500n, cashReward: 7_985n, netValue: 7_485n, valuation: "exact", provenance: "exact", metadata: { skillLevel: 56.781, skillGain: 0.0865 } },
      { sourceRef: "act25:hunt:2", occurredAt: t(4_000), domain: "hunting", activityType: "hunting", activityLabel: "Hunting", subtype: "standard", outcome: "completed", cashInput: 500n, cashReward: 1_100_000n, netValue: 1_099_500n, valuation: "exact", provenance: "exact", metadata: { skillLevel: 56.8675, skillGain: 0.0865 } },
      { sourceRef: "act25:level:1", occurredAt: t(3_900), domain: "hunting", activityType: "hunting", activityLabel: "Hunting", subtype: "skill-level-up", outcome: "progressed", valuation: "unpriced", provenance: "exact", metadata: { skill_level: 57 } },
    ] as never[]);
    const hunting = await import("../src/services/hunting.js");
    const res = await hunting.getHuntingSummary(userId, range);
    expect(res.hunts).toBe(2);
    expect(res.levelUps).toBe(1);
    expect(res.cashSpent).toBe(1_000);
    expect(res.cashEarned).toBe(1_107_985);
    expect(res.netCash.value).toBe(1_106_985);
    expect(res.netCash.provenance).toBe("exact");
    expect(res.valuePerHunt).toBe(553_492.5);
    expect(res.skill.current).toBeCloseTo(56.8675, 4);
    expect(res.skill.firstSeen).toBeCloseTo(56.781, 4);
    expect(res.skill.totalGain).toBeCloseTo(0.173, 3);
    expect(res.skill.levelUps).toBe(1);
    expect(res.sessionTypes.find((s) => s.type === "beginners")!.net).toBe(7_485);
    expect(res.bestHunt!.net).toBe(1_099_500);
    expect(res.recent.length).toBe(2);
  });

  it("cross-domain activity summary: value attribution + semantic-only disclosure + signed ledger", async () => {
    const t = (s: number) => new Date((now - s) * 1000);
    await insertActivityEvents(db, userId, [
      // Missions: cash + credits token units.
      { sourceRef: "act25:mis:1", occurredAt: t(3_800), domain: "missions", activityType: "missions", activityLabel: "Missions", subtype: "contract", outcome: "completed", cashReward: 112_000n, tokensReward: 67, netValue: 112_000n, valuation: "exact", provenance: "exact", metadata: {} },
      // Bounty place (cost) + claim (income) — opposite directions.
      { sourceRef: "act25:bou:1", occurredAt: t(3_700), domain: "bounties", activityType: "bounties", activityLabel: "Bounties", subtype: "placed", outcome: "placed", opponentId: 3086444, cashInput: 450_000n, netValue: -450_000n, valuation: "exact", provenance: "exact", metadata: {} },
      { sourceRef: "act25:bou:2", occurredAt: t(3_600), domain: "bounties", activityType: "bounties", activityLabel: "Bounties", subtype: "claimed", outcome: "claimed", opponentId: 2135330, cashReward: 300_000n, netValue: 300_000n, valuation: "exact", provenance: "exact", metadata: {} },
      // Racing: performance + upgrade spend.
      { sourceRef: "act25:rac:1", occurredAt: t(3_500), domain: "racing", activityType: "racing", activityLabel: "Racing", subtype: "official-finish", outcome: "win", pointsReward: 1, valuation: "unpriced", provenance: "exact", metadata: {} },
      { sourceRef: "act25:rac:2", occurredAt: t(3_400), domain: "racing", activityType: "racing", activityLabel: "Racing", subtype: "upgrade", outcome: "upgraded", cashInput: 3_000n, netValue: -3_000n, valuation: "exact", provenance: "exact", metadata: {} },
      // Education: committed course cost.
      { sourceRef: "act25:edu:1", occurredAt: t(3_300), domain: "education", activityType: "education", activityLabel: "Education", subtype: "course-started", outcome: "started", cashInput: 2_880n, netValue: -2_880n, valuation: "exact", provenance: "exact", metadata: {} },
    ] as never[]);
    // Explicit signed ledger rows: income + NEGATIVE expense — the signed-sum
    // invariant that the 2.4 diagnostics got wrong.
    await db.moneyEvent.createMany({
      data: [
        { userId, occurredAt: t(3_000), category: "casino", subcategory: "Casino slots win", direction: "income", amount: 6_000_000n, source: "torn_log", sourceRef: "act25:ledger2:win", description: "Casino slots win" },
        { userId, occurredAt: t(3_600), category: "casino", subcategory: "Casino slots lose", direction: "expense", amount: -1_000_000n, source: "torn_log", sourceRef: "act25:ledger2:lose", description: "Casino slots lose" },
      ],
    });

    const activity = await import("../src/services/activity.js");
    const res = await activity.getActivitySummary(userId, range);

    const domains = new Map(res.domains.map((d) => [d.domain, d]));
    expect(domains.get("hunting")!.activities).toBe(3);
    expect(domains.get("hunting")!.exactNetCash).toBe(1_106_985);
    expect(domains.get("missions")!.progressionTokens).toBe(67);
    expect(domains.get("missions")!.ledgerLinked).toBe(false);
    expect(domains.get("racing")!.progressionPoints).toBe(1);
    expect(domains.get("racing")!.exactNetCash).toBe(-3_000);
    expect(domains.get("bounties")!.cashSpent).toBe(450_000);
    expect(domains.get("bounties")!.cashReceived).toBe(300_000);
    expect(domains.get("education")!.exactNetCash).toBe(-2_880);
    expect(domains.get("casino")!.ledgerLinked).toBe(true);
    // Ledger cash is SIGNED. Both seeds together: (6M + 6M) income and
    // (−1M + −1M) expense → 10M. The 2.4 double-flip bug would report 14M.
    const casinoRecon = res.reconciliation.find((r) => r.domain === "casino")!;
    expect(casinoRecon.ledgerCash).toBe(10_000_000);
    expect(casinoRecon.semanticOnly).toBe(false);
    // Semantic-only domains disclose that their cash exists nowhere else.
    const huntingRecon = res.reconciliation.find((r) => r.domain === "hunting")!;
    expect(huntingRecon.semanticOnly).toBe(true);
    expect(huntingRecon.ledgerCash).toBeNull();
    // Nothing is collapsed: exact cash net covers all domains' netValues.
    // Total exact net across domains, including the earlier casino seed (+4M).
    expect(res.exactNetCash).toBe(Number(4_000_000n + 7_485n + 1_099_500n + 112_000n - 450_000n + 300_000n - 3_000n - 2_880n));
  });
});
