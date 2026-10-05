import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient, insertActivityEvents } from "@tornscope/database";
import type { ActivityEventInput } from "@tornscope/database";
import { getCasinoSummary } from "../src/services/casino.js";

/**
 * Casino hardening suite (2.5.1): logical-play aggregation against a real
 * PostgreSQL — best/worst results, placement/settlement double-count
 * prevention, withdrawal exclusion, pending semantics, null-vs-zero.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const now = Math.floor(Date.now() / 1000);
let userId: string;
const range = { preset: "custom" as const, from: now - 86_400, to: now + 60 };

function casino(partial: Partial<ActivityEventInput> & { sourceRef: string }): ActivityEventInput {
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
    data: { displayName: `casino-hard-${randomBytes(6).toString("hex")}`, role: "user", isDemo: false },
    select: { id: true },
  });
  userId = user.id;
  const t = (s: number) => new Date((now - s) * 1000);
  await insertActivityEvents(db, userId, [
    // Slots: one loss, one win with an exact-zero reward variant.
    casino({ sourceRef: "ch:slots:lose", occurredAt: t(5_000), subtype: "lose", outcome: "loss", cashInput: 1_000_000n, netValue: -1_000_000n }),
    casino({ sourceRef: "ch:slots:win", occurredAt: t(4_900), subtype: "win", outcome: "win", cashInput: 1_000_000n, cashReward: 2_500_000n, netValue: 1_500_000n }),
    // Bookie: placement + win settlement (stake repeats in both payloads).
    casino({ sourceRef: "ch:bookie:bet", occurredAt: t(4_000), activityType: "bookie", activityLabel: "Bookie", subtype: "placed", outcome: "placed", cashInput: 500_000n }),
    casino({ sourceRef: "ch:bookie:win", occurredAt: t(3_900), activityType: "bookie", activityLabel: "Bookie", subtype: "won", outcome: "win", cashInput: 500_000n, cashReward: 1_250_000n, netValue: 750_000n }),
    // Bookie withdrawal: balance movement — excluded from winnings/net.
    casino({ sourceRef: "ch:bookie:wd", occurredAt: t(3_800), activityType: "bookie", activityLabel: "Bookie", subtype: "withdrawal", outcome: "withdrawal", cashReward: 700_000n, netValue: 700_000n }),
    // Blackjack: start + win terminal (stake repeats).
    casino({ sourceRef: "ch:bj:start", occurredAt: t(3_000), activityType: "blackjack", activityLabel: "Blackjack", subtype: "start", outcome: "placed", cashInput: 100_000n }),
    casino({ sourceRef: "ch:bj:win", occurredAt: t(2_900), activityType: "blackjack", activityLabel: "Blackjack", subtype: "win", outcome: "win", cashInput: 100_000n, cashReward: 250_000n, netValue: 150_000n }),
    // High-low: start + win (win carries the pot only — stake missing from net).
    casino({ sourceRef: "ch:hl:start", occurredAt: t(2_000), activityType: "high-low", activityLabel: "High-Low", subtype: "start", outcome: "placed", cashInput: 200_000n }),
    casino({ sourceRef: "ch:hl:start2", occurredAt: t(1_900), activityType: "high-low", activityLabel: "High-Low", subtype: "start", outcome: "placed", cashInput: 200_000n }),
    casino({ sourceRef: "ch:hl:win", occurredAt: t(1_800), activityType: "high-low", activityLabel: "High-Low", subtype: "win", outcome: "win", cashReward: 450_000n, netValue: 450_000n }),
    // Unresolved placement: pending, never a loss.
    casino({ sourceRef: "ch:lot:bet", occurredAt: t(1_000), activityType: "lottery", activityLabel: "Lottery — Daily Dime", subtype: "bet", outcome: "placed", cashInput: 300n }),
  ]);
});

afterAll(async () => {
  if (userId) await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  if (dbUrl) await db.$disconnect();
});

suite("casino hardening (2.5.1)", () => {
  it("aggregates logical-play economics without double counting", async () => {
    const res = await getCasinoSummary(userId, range);
    // Wagered: slots 2M + bookie placement 500k (settlement's 500k NOT
    // re-added) + blackjack start 100k (terminal's 100k NOT re-added) +
    // high-low starts 400k + lottery 300n.
    expect(res.totalWagered.value).toBe(3_000_300);
    // Returned: slots 2.5M + bookie winnings 1.25M + bj 250k + hl pot 450k.
    // The 700k withdrawal is excluded.
    expect(res.cashReturned.value).toBe(4_450_000);
    // Net: slots +500k, bookie +750k, bj +150k, hl 450k − 400k stakes,
    // lottery pending (null contribution). Withdrawal excluded.
    expect(res.netCash.value).toBe(1_450_000);
    // Withdrawals disclosed separately.
    expect(res.withdrawn).toBe(700_000);
    // Unresolved placement (lottery) counted, never counted as a loss.
    expect(res.pendingActivities).toBe(1);
  });

  it("returns deterministic best AND worst results", async () => {
    const res = await getCasinoSummary(userId, range);
    expect(res.bestResult).not.toBeNull();
    expect(res.bestResult!.net).toBe(1_500_000); // slots win
    expect(res.worstResult).not.toBeNull();
    expect(res.worstResult!.net).toBe(-1_000_000); // slots loss
    expect(res.worstResult!.label).toBe("Slots");
  });

  it("outcome counts and row counts keep their event-row semantics", async () => {
    const res = await getCasinoSummary(userId, range);
    // 11 seeded rows; row counts are events, not logical plays.
    expect(res.activities).toBe(11);
    const bookie = res.games.find((g) => g.game === "bookie")!;
    expect(bookie.plays).toBe(3); // rows: placed + won + withdrawal
    expect(bookie.wagered).toBe(500_000); // placement only
    const hl = res.games.find((g) => g.game === "high-low")!;
    expect(hl.net).toBe(50_000); // 450k pot − 2×200k stakes
  });

  it("no casino data: nulls everywhere, never zeros", async () => {
    const empty = await getCasinoSummary(`no-such-user-${randomBytes(4).toString("hex")}`, range);
    expect(empty.activities).toBe(0);
    expect(empty.totalWagered.value).toBeNull();
    expect(empty.cashReturned.value).toBeNull();
    expect(empty.netCash.value).toBeNull();
    expect(empty.bestResult).toBeNull();
    expect(empty.worstResult).toBeNull();
  });
});
