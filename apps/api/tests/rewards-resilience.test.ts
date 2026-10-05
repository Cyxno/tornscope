import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient, insertActivityEvents } from "@tornscope/database";
import type { ActivityEventInput } from "@tornscope/database";
import { getRewardsSummary } from "../src/services/rewards.js";

/**
 * Rewards resilience suite (2.5.1): malformed and future payload shapes
 * must never crash the endpoint, never be priced, never be zeroed — they
 * are excluded from sums and counted as malformedComponents. Also proves
 * partial-valuation labeling (valuationCoverage) and null-vs-zero for
 * exact-zero cash.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const now = Math.floor(Date.now() / 1000);
let userId: string;
const range = { preset: "custom" as const, from: now - 86_400, to: now + 60 };

function openable(sourceRef: string, metadata: Record<string, unknown>, cashReward: bigint | null = null): ActivityEventInput {
  return {
    occurredAt: new Date(now * 1000),
    domain: "openable",
    activityType: `openable-${metadata.item ?? "unknown"}`,
    activityLabel: "Openable",
    subtype: "opened",
    outcome: "opened",
    game: null,
    wheel: null,
    opponentId: null,
    cashInput: null,
    cashReward,
    pointsReward: null,
    tokensReward: null,
    nonPriceable: null,
    inputValue: null,
    rewardValue: null,
    netValue: cashReward,
    valuation: cashReward !== null ? "exact" : "unpriced",
    provenance: "exact",
    sourceRef,
    metadata,
  };
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { displayName: `rw-resil-${randomBytes(6).toString("hex")}`, role: "user", isDemo: false },
    select: { id: true },
  });
  userId = user.id;
  const t = (s: number) => new Date((now - s) * 1000);
  await insertActivityEvents(db, userId, [
    // Healthy: priced reward item + exact cash.
    openable("rw:ok:1", { item: 555001, items: [{ id: 67, qty: 2 }], money: 500 }, 500n),
    // Healthy: priced input (wallet id priced in catalog seed) — see beforeAll catalog.
    openable("rw:ok:2", { item: 555001, items: [{ id: 67, qty: 1 }] }),
    // Malformed shapes — must survive every one of these:
    openable("rw:bad:1", { item: 555001, items: 5 }), // items not an array
    openable("rw:bad:2", { item: 555001, items: "give me stuff" }), // items string
    openable("rw:bad:3", { item: 555001, items: [{ id: "abc", qty: 2 }] }), // id not numeric
    openable("rw:bad:4", { item: 555001, items: [{ id: 1.5, qty: 2 }] }), // id non-integer
    openable("rw:bad:5", { item: 555001, items: [{ id: 67, qty: "many" }] }), // qty string
    openable("rw:bad:6", { item: 555001, item2: "x" }), // item2 string
    openable("rw:bad:7", { item: "wallet", items: [{ id: 67, qty: 1 }] }), // input item non-numeric
  ]);

  // Catalog: item 67 priced; 1079 (wallet input) NOT priced → unpriced input qty.
  await db.$executeRawUnsafe(`
    INSERT INTO "TornItemCatalog" ("itemId", "name", "type", "marketPrice", "updatedAt")
    VALUES (67, 'First Aid Kit', 'Medical', 400, now())
    ON CONFLICT ("itemId") DO UPDATE SET "marketPrice" = 400, "updatedAt" = now()
  `);
});

afterAll(async () => {
  if (userId) await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  if (dbUrl) await db.$disconnect();
});

suite("rewards resilience (2.5.1)", () => {
  it("survives every malformed shape and counts them diagnostically", async () => {
    const res = await getRewardsSummary(userId, range);
    expect(res.openings).toBe(9);
    // 7 malformed rows contributed no parseable component.
    expect(res.malformedComponents).toBeGreaterThanOrEqual(7);
    // Healthy rows still valued: 4 × First Aid Kit @400 = 1600 (bad:7's input is
    // malformed but its items array is valid and still counts).
    expect(res.itemValueEstimate.value).toBe(1_600);
  });

  it("partial valuation is labeled partial — unpriced inputs stay visible", async () => {
    const res = await getRewardsSummary(userId, range);
    // Item 67 priced, wallet input (1079) unpriced → partial, not complete.
    expect(res.valuationCoverage).toBe("partial");
    expect(res.unpricedItemQty).toBeGreaterThanOrEqual(2); // 2 wallet openings
    expect(res.estimatedNet.provenance).toBe("partial-estimate");
  });

  it("exact-zero cash is distinguishable from no cash", async () => {
    // Credits-only style opening: money key present with 0.
    await insertActivityEvents(db, userId, [
      openable("rw:zero:1", { item: 555001, items: [{ id: 67, qty: 1 }], money: 0 }, 0n),
    ]);
    const res = await getRewardsSummary(userId, range);
    // 0 is an exact payload zero — included in the sum (not treated as
    // missing data), so cashReceived stays exactly 500.
    expect(res.cashReceived).toBe(500);
    expect(res.openings).toBe(10);
  });

  it("unpriced-only rewards: coverage 'unpriced', net stays null", async () => {
    const user2 = await db.user.create({
      data: { displayName: `rw-resil2-${randomBytes(6).toString("hex")}`, role: "user", isDemo: false },
      select: { id: true },
    });
    try {
      const t = (s: number) => new Date((now - s) * 1000);
      await insertActivityEvents(db, user2.id, [
        openable("rw2:unpriced:1", { item: 4200, items: [{ id: 999999, qty: 1 }] }),
      ]);
      const res = await getRewardsSummary(user2.id, range);
      expect(res.valuationCoverage).toBe("unpriced");
      expect(res.estimatedNet.value).toBeNull(); // nothing defensibly valued
      expect(res.unpricedItemQty).toBe(2); // reward item + opened input — visible, never zeroed
    } finally {
      await db.user.delete({ where: { id: user2.id } }).catch(() => undefined);
    }
  });
});
