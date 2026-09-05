import { describe, expect, it } from "vitest";
import { aggregateCombatStats, aggregateCrimeStats } from "@tornscope/analytics";
import { normalizeAttack } from "../../worker/src/sync/handlers.js";

/**
 * Combat + crimes analytics tests, and the double-count contract:
 * combat mug cash lives ONLY in MoneyEvent (category mugging); CombatEvent
 * carries no money so the two can never double count.
 */

const HOUR = 3600;
const T0 = Date.UTC(2026, 8, 1) / 1000;

describe("combat event normalization (from /v2/user/attacks payloads)", () => {
  const MY_ID = 1816206;

  it("outgoing attack: attacker is the account", () => {
    const n = normalizeAttack(
      { id: 506592037, started: T0, ended: T0 + 5, attacker: { id: MY_ID, name: "Cyxno" }, defender: { id: 42, name: "Rival" }, result: "Attacked", respect_gain: 4.13, respect_loss: 1.03, modifiers: { fair_fight: 1.21 } },
      MY_ID
    );
    expect(n.direction).toBe("outgoing");
    expect(n.opponentId).toBe(42);
    expect(n.opponentName).toBe("Rival");
    expect(n.result).toBe("Attacked");
    expect(n.occurredAt.getTime()).toBe((T0 + 5) * 1000);
  });

  it("incoming attack: defender is the account; unknown attacker stays null", () => {
    const n = normalizeAttack(
      { id: 503194047, started: T0, ended: T0 + 5, attacker: null, defender: { id: MY_ID, name: "Cyxno" }, result: "Mugged", respect_gain: 2.2, respect_loss: 0.55 },
      MY_ID
    );
    expect(n.direction).toBe("incoming");
    expect(n.opponentId).toBeNull();
    expect(n.opponentName).toBeNull();
    expect(n.result).toBe("Mugged");
  });

  it("respect delta is the net gain-loss swing", () => {
    const n = normalizeAttack({ id: 1, started: T0, ended: T0, attacker: { id: 1, name: "a" }, defender: { id: 2, name: "b" }, result: "Attacked", respect_gain: 4.13, respect_loss: 1.03 }, 1);
    expect(n.respectDelta).toBeCloseTo(3.1);
  });

  it("mug cash is NOT stored on the combat event (no double counting)", () => {
    const n = normalizeAttack({ id: 503194047, started: T0, ended: T0, attacker: null, defender: { id: MY_ID, name: "Cyxno" }, result: "Mugged" }, MY_ID);
    expect("moneyDelta" in n ? (n as { moneyDelta?: unknown }).moneyDelta : undefined).toBeUndefined();
  });
});

describe("combat aggregation", () => {
  const events = [
    { occurredAt: T0, direction: "outgoing" as const, opponentId: 10, opponentName: "Rival", result: "Attacked", respectDelta: 3 },
    { occurredAt: T0 + HOUR, direction: "outgoing" as const, opponentId: 10, opponentName: "Rival", result: "Mugged", respectDelta: 2 },
    { occurredAt: T0 + 2 * HOUR, direction: "incoming" as const, opponentId: 99, opponentName: null, result: "Mugged", respectDelta: -1 },
    { occurredAt: T0 + 3 * HOUR, direction: "incoming" as const, opponentId: 99, opponentName: null, result: "Lost", respectDelta: null },
  ];

  it("counts made/received, wins/losses, mugs and hospitalizations", () => {
    const s = aggregateCombatStats(events, T0 - 1, T0 + 4 * HOUR);
    expect(s.attacksMade).toBe(2);
    expect(s.attacksReceived).toBe(2);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    expect(s.mugsMade).toBe(1);
    expect(s.mugsReceived).toBe(1);
    expect(s.winRate).toBe(0.5);
    expect(s.provenance).toBe("exact");
  });

  it("aggregates opponents with unknown opponents labeled, not fabricated", () => {
    const s = aggregateCombatStats(events, T0 - 1, T0 + 4 * HOUR);
    const unknown = s.byOpponent.find((o) => o.opponentId === 99)!;
    expect(unknown.opponent).toBe("Unknown opponent");
    const rival = s.byOpponent.find((o) => o.opponentId === 10)!;
    expect(rival.opponent).toBe("Rival");
    expect(rival.attacks).toBe(2);
  });

  it("respects the selected range", () => {
    const s = aggregateCombatStats(events, T0 + 150 * 60, T0 + 4 * HOUR);
    expect(s.attacksMade + s.attacksReceived).toBe(1);
    expect(s.attacksReceived).toBe(1);
  });
});

describe("crime aggregation", () => {
  const events = [
    { occurredAt: T0, crimeName: "copying DVDs", success: true, nerveUsed: 2, moneyDelta: 500_000, itemsValue: null, jailSeconds: null },
    { occurredAt: T0 + HOUR, crimeName: "copying DVDs", success: false, nerveUsed: 2, moneyDelta: null, itemsValue: null, jailSeconds: 3600 },
    { occurredAt: T0 + 2 * HOUR, crimeName: "shoplifting", success: true, nerveUsed: 4, moneyDelta: null, itemsValue: 50_000, jailSeconds: null },
  ];

  it("aggregates attempts, success rate, cash, items and nerve", () => {
    const s = aggregateCrimeStats(events, T0 - 1, T0 + 3 * HOUR);
    expect(s.attempts).toBe(3);
    expect(s.successful).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.successRate).toBeCloseTo(2 / 3);
    expect(s.moneyGained).toBe(500_000);
    expect(s.moneyLost).toBe(0);
    expect(s.netCrimeCash).toBe(500_000);
    expect(s.estimatedItemsValue).toBe(50_000);
    expect(s.nerveUsed).toBe(8);
    expect(s.totalEstimatedValue).toBe(550_000);
    expect(s.valuePerNerve).toBeCloseTo(550_000 / 8);
    expect(s.jailedCount).toBe(1);
    expect(s.totalJailSeconds).toBe(3600);
  });

  it("nerve metrics stay null when no nerve data exists", () => {
    const s = aggregateCrimeStats(events.map((e) => ({ ...e, nerveUsed: null })), T0 - 1, T0 + 3 * HOUR);
    expect(s.nerveUsed).toBeNull();
    expect(s.valuePerNerve).toBeNull();
  });

  it("breakdown ranks by attempts and computes per-crime nets", () => {
    const s = aggregateCrimeStats(events, T0 - 1, T0 + 3 * HOUR);
    expect(s.byCrime[0]!.crime).toBe("copying DVDs");
    expect(s.byCrime[0]!.attempts).toBe(2);
    expect(s.byCrime[0]!.netValue).toBe(500_000);
  });

  it("respects the selected range (no fake zeros outside it)", () => {
    const s = aggregateCrimeStats(events, T0 + 90 * 60, T0 + 3 * HOUR);
    expect(s.attempts).toBe(1);
    expect(s.successRate).toBe(1);
  });
});
