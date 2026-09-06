import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAYOUT_SETTLEMENT_DAYS,
  deriveMemberStats,
  matchOcPayout,
  matchPayout,
  matchPayouts,
  personalShare,
  reconcileWar,
  summarizeWars,
  warCombatEvents,
  warProfitability,
  warResult,
  type PayoutCandidateInput,
  type WarCombatEventLike,
  type WarLike,
} from "@tornscope/analytics";

/** Faction + ranked war analytics tests: matcher, provenance, reconciliation. */

const DAY = 86_400;
const HOUR = 3600;
const T0 = Date.UTC(2026, 8, 1) / 1000; // 2026-09-01
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

const payout = (over: Partial<PayoutCandidateInput> = {}): PayoutCandidateInput => ({
  occurredAt: T0 + 6 * DAY,
  amount: 500_000,
  sourceRef: "p1",
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

describe("payout matcher", () => {
  it("exact: explicit war id wins with confidence 1.0", () => {
    const m = matchPayout(payout({ warId: 7 }), [war({ tornWarId: 7 })]);
    expect(m.matchType).toBe("exact");
    expect(m.matchConfidence).toBe(1.0);
    expect(m.matchedWarId).toBe(7);
  });

  it("oc payout: scenario metadata links to organized crime, never a war", () => {
    const m = matchPayout(payout({ scenario: "Gaslight the Way" }), [war()]);
    expect(m.matchType).toBe("oc_payout");
    expect(m.matchConfidence).toBe(1.0);
    expect(m.matchedWarId).toBeNull();
    expect(m.matchedOcName).toBe("Gaslight the Way");
  });

  it("strong: single completed war, payout after war end (0.8)", () => {
    const m = matchPayout(payout({ occurredAt: T0 + 6 * DAY }), [war()]);
    expect(m.matchType).toBe("strong");
    expect(m.matchConfidence).toBe(0.8);
    expect(m.matchedWarId).toBe(1);
  });

  it("time_window: single candidate but payout inside the war window (0.5)", () => {
    const m = matchPayout(payout({ occurredAt: T0 + 2 * DAY }), [war()]);
    expect(m.matchType).toBe("time_window");
    expect(m.matchConfidence).toBe(0.5);
  });

  it("ambiguous: multiple completed wars qualify — not auto-selected", () => {
    const w1 = war({ tornWarId: 1 });
    const w2 = war({ tornWarId: 2, startedAt: T0 + 2 * DAY, endedAt: T0 + 7 * DAY });
    const m = matchPayout(payout({ occurredAt: T0 + 8 * DAY }), [w1, w2]);
    expect(m.matchType).toBe("ambiguous");
    expect(m.matchConfidence).toBe(0);
    expect(m.matchedWarId).toBeNull();
    expect(m.candidateCount).toBe(2);
    expect(m.candidateWarIds.sort()).toEqual([1, 2]);
  });

  it("unmatched: no completed war within the settlement window", () => {
    const m = matchPayout(payout({ occurredAt: T0 + 60 * DAY }), [war()]);
    expect(m.matchType).toBe("unmatched");
    expect(m.matchConfidence).toBe(0);
    expect(m.matchedWarId).toBeNull();
  });

  it("settlement window is configurable (30-day config extends reach)", () => {
    const far = T0 + 20 * DAY;
    const short = matchPayout(payout({ occurredAt: far }), [war()], { settlementDays: 7 });
    const long = matchPayout(payout({ occurredAt: far }), [war()], { settlementDays: 30 });
    expect(short.matchType).toBe("unmatched");
    expect(long.matchType).toBe("strong");
    expect(DEFAULT_PAYOUT_SETTLEMENT_DAYS).toBe(7);
  });

  it("deterministic: same input, same output", () => {
    const wars = [war({ tornWarId: 2 }), war({ tornWarId: 1 })];
    const p = payout();
    expect(matchPayouts([p], wars)).toEqual(matchPayouts([p], wars));
  });
});

describe("oc payout matching", () => {
  const ocs = [
    { ocId: 10, name: "Gaslight the Way", status: "Successful", executedAt: T0 + 2 * HOUR },
    { ocId: 11, name: "Gaslight the Way", status: "Successful", executedAt: T0 + 20 * DAY },
  ];

  it("exact oc match by scenario + time proximity", () => {
    const m = matchOcPayout(payout({ occurredAt: T0 + 2 * HOUR + 600, scenario: "Gaslight the Way" }), ocs);
    expect(m.ocId).toBe(10);
    expect(m.confidence).toBe(1.0);
  });

  it("name-only match (no time evidence) has lower confidence", () => {
    const m = matchOcPayout(payout({ occurredAt: T0 + 30 * DAY, scenario: "Gaslight the Way" }), ocs);
    expect(m.matchedOcName).toBe("Gaslight the Way");
    expect(m.confidence).toBeLessThan(1);
  });

  it("no scenario means no OC linkage", () => {
    expect(matchOcPayout(payout(), ocs).ocId).toBeNull();
  });
});

describe("member stats derived from ranked-war combat events", () => {
  it("counts only ranked-war outgoing events inside the war interval", () => {
    const linked = warCombatEvents(
      [
        attack(0.5),
        attack(1, { result: "Mugged" }),
        attack(2, { result: "Hospitalized" }),
        attack(3, { result: "Lost" }),
        attack(6, { result: "Attacked" }), // after war end
        attack(1, { direction: "incoming", isRankedWar: true }),
        attack(1, { isRankedWar: false }),
      ],
      war()
    );
    const stats = deriveMemberStats(linked);
    expect(stats.attacks).toBe(4);
    expect(stats.wins).toBe(3);
    expect(stats.losses).toBe(1);
    expect(stats.mugs).toBe(1);
    expect(stats.hospitalizes).toBe(1);
  });
});

describe("war profitability and reconciliation", () => {
  it("matched payouts mark reconciliation partial; gross reward stays null", () => {
    const m = matchPayout(payout(), [war()]);
    const rec = reconcileWar(war(), [{ match: m, amount: 500_000, occurredAt: T0 + 6 * DAY, sourceRef: "p1" }]);
    expect(rec.factionCashReward).toBeNull();
    expect(rec.retainedFactionCash).toBeNull();
    expect(rec.reconciliationCoverage).toBeNull();
    expect(rec.knownMatchedPayouts).toBe(500_000);
    expect(rec.reconciliationStatus).toBe("partial");
  });

  it("no matched payouts -> unavailable", () => {
    const m = matchPayout(payout({ occurredAt: T0 + 60 * DAY }), [war()]);
    const rec = reconcileWar(war(), [{ match: m, amount: 0, occurredAt: 0, sourceRef: "x" }]);
    expect(rec.reconciliationStatus).toBe("unavailable");
  });

  it("warProfitability reports partial but never an invented gross reward", () => {
    const p = matchPayout(payout(), [war()]);
    const summary = { matched: [{ ...p, amount: 100, occurredAt: 0, sourceRef: "p" }], knownPayoutTotal: 100, personalPayoutTotal: null };
    const profit = warProfitability(war(), summary);
    expect(profit.grossCashReward).toBeNull();
    expect(profit.reconciliation).toBe("partial");
  });
});

describe("war utilities", () => {
  it("warResult uses the canonical winner; ongoing wars have no result", () => {
    expect(warResult(war())).toBe("win");
    expect(warResult(war({ winnerFactionId: 900 }))).toBe("loss");
    expect(warResult(war({ endedAt: null }))).toBe("ongoing");
  });

  it("summarizeWars filters by range and attaches known totals", () => {
    const w2 = war({ tornWarId: 2, startedAt: T0 + 40 * DAY });
    const totals = new Map([[2, 250_000]]);
    const rows = summarizeWars([war(), w2], totals, new Map(), T0 + 30 * DAY, T0 + 60 * DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.knownPayoutTotal).toBe(250_000);
  });

  it("personalShare returns null on zero faction total", () => {
    expect(personalShare(100, 0)).toBeNull();
  });
});
