import { describe, expect, it } from "vitest";
import {
  PAYOUT_TAIL_DAYS,
  deriveMemberStats,
  matchPayoutsToWars,
  personalShare,
  summarizeWars,
  warCombatEvents,
  warProfitability,
  warResult,
  type PayoutLike,
  type WarCombatEventLike,
  type WarLike,
} from "@tornscope/analytics";

/** Faction + ranked war analytics tests. */

const DAY = 86_400;
const T0 = Date.UTC(2026, 7, 1) / 1000; // 2026-08-01
const MY_FACTION = 51200;

const war = (over: Partial<WarLike> = {}): WarLike => ({
  tornWarId: 1,
  factionId: MY_FACTION,
  opponentFactionId: 900,
  opponentName: "Rivals",
  startedAt: T0,
  endedAt: T0 + 5 * DAY,
  winnerFactionId: MY_FACTION,
  ourScore: 12_000,
  opponentScore: 8_000,
  ...over,
});

const attack = (daysAfter: number, over: Partial<WarCombatEventLike> = {}): WarCombatEventLike => ({
  occurredAt: T0 + daysAfter * DAY,
  direction: "outgoing",
  opponentId: 900,
  result: "Attacked",
  respectDelta: 2.5,
  isRankedWar: true,
  ...over,
});

describe("war result", () => {
  it("uses the canonical winner field", () => {
    expect(warResult(war({ winnerFactionId: MY_FACTION }))).toBe("win");
    expect(warResult(war({ winnerFactionId: 900 }))).toBe("loss");
    expect(warResult(war({ endedAt: null }))).toBe("ongoing");
    expect(warResult(war({ winnerFactionId: null, endedAt: T0 + DAY }))).toBe("draw");
  });

  it("duration only for completed wars", () => {
    const rows = summarizeWars([war()], new Map(), new Map(), 0, Number.MAX_SAFE_INTEGER);
    expect(rows[0]!.durationSeconds).toBe(5 * DAY);
    const ongoing = summarizeWars([war({ endedAt: null })], new Map(), new Map(), 0, Number.MAX_SAFE_INTEGER);
    expect(ongoing[0]!.durationSeconds).toBeNull();
    expect(ongoing[0]!.result).toBe("ongoing");
  });
});

describe("member stats derived from ranked-war combat events", () => {
  it("counts only ranked-war outgoing events inside the war interval", () => {
    const events = [
      attack(0.5),
      attack(1, { result: "Mugged" }),
      attack(2, { result: "Hospitalized" }),
      attack(3, { result: "Lost" }),
      attack(6, { result: "Attacked" }), // after war end -> excluded
      attack(1, { direction: "incoming", isRankedWar: true }), // incoming -> excluded
      attack(1, { isRankedWar: false }), // normal attack -> excluded
    ];
    const linked = warCombatEvents(events, war());
    const stats = deriveMemberStats(linked);
    expect(stats.attacks).toBe(4);
    expect(stats.wins).toBe(3);
    expect(stats.losses).toBe(1);
    expect(stats.mugs).toBe(1);
    expect(stats.hospitalizes).toBe(1);
  });

  it("respect sums derived respect deltas", () => {
    const stats = deriveMemberStats([attack(0, { respectDelta: 2.5 }), attack(1, { respectDelta: 3.5 })]);
    expect(stats.respect).toBeCloseTo(6);
  });
});

describe("payout matching", () => {
  const completed = war();

  it("links payouts in the settlement tail as time_window_match", () => {
    const payouts: PayoutLike[] = [
      { occurredAt: completed.endedAt! + DAY, amount: 500_000, sourceRef: "m1" },
      { occurredAt: completed.endedAt! + 2 * DAY, amount: 300_000, sourceRef: "m2" },
    ];
    const matched = matchPayoutsToWars(payouts, [completed]);
    const summary = matched.get(1)!;
    expect(summary.knownPayoutTotal).toBe(800_000);
    expect(summary.matched.every((m) => m.linkage === "time_window_match")).toBe(true);
  });

  it("leaves payouts outside every war window unmatched", () => {
    const payouts: PayoutLike[] = [{ occurredAt: completed.endedAt! + (PAYOUT_TAIL_DAYS + 5) * DAY, amount: 999, sourceRef: "far" }];
    const matched = matchPayoutsToWars(payouts, [completed]);
    expect(matched.get(1)!.knownPayoutTotal).toBe(0);
    expect(matched.get(1)!.matched).toHaveLength(0);
  });

  it("attributes overlapping-tail payouts to the most recently ended war", () => {
    const earlier = war({ tornWarId: 2, startedAt: T0 - 20 * DAY, endedAt: T0 - 15 * DAY });
    const payouts: PayoutLike[] = [{ occurredAt: completed.endedAt! + DAY, amount: 100, sourceRef: "x" }];
    const matched = matchPayoutsToWars(payouts, [earlier, completed]);
    expect(matched.get(1)!.knownPayoutTotal).toBe(100);
    expect(matched.get(2)!.knownPayoutTotal).toBe(0);
  });

  it("multiple payouts to the same member all count", () => {
    const payouts: PayoutLike[] = [
      { occurredAt: completed.endedAt! + DAY, amount: 100_000, sourceRef: "p1" },
      { occurredAt: completed.endedAt! + 2 * DAY, amount: 200_000, sourceRef: "p2" },
      { occurredAt: completed.endedAt! + 3 * DAY, amount: 300_000, sourceRef: "p3" },
    ];
    expect(matchPayoutsToWars(payouts, [completed]).get(1)!.knownPayoutTotal).toBe(600_000);
  });
});

describe("war profitability and shares", () => {
  const completed = war();
  it("marks reconciliation partial when payouts exist; gross reward stays unavailable (not exposed by Torn)", () => {
    const payouts: PayoutLike[] = [{ occurredAt: completed.endedAt! + DAY, amount: 400_000, sourceRef: "p" }];
    const summary = matchPayoutsToWars(payouts, [completed]).get(1)!;
    const profit = warProfitability(completed, summary);
    expect(profit.grossCashReward).toBeNull();
    expect(profit.knownPayoutTotal).toBe(400_000);
    expect(profit.reconciliation).toBe("partial");
  });

  it("unavailable when nothing reconciled", () => {
    const summary = matchPayoutsToWars([], [completed]).get(1)!;
    expect(warProfitability(completed, summary).reconciliation).toBe("unavailable");
  });

  it("personal share of faction totals", () => {
    expect(personalShare(250, 1000)).toBe(0.25);
    expect(personalShare(250, 0)).toBeNull();
  });
});

describe("war range filtering", () => {
  it("summarizeWars filters by war start inside the range", () => {
    const w1 = war({ tornWarId: 1, startedAt: T0 });
    const w2 = war({ tornWarId: 2, startedAt: T0 + 40 * DAY });
    const rows = summarizeWars([w1, w2], new Map(), new Map(), T0 + 30 * DAY, T0 + 60 * DAY);
    expect(rows.map((r) => r.tornWarId)).toEqual([2]);
  });
});
