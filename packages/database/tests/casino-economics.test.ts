import { describe, expect, it } from "vitest";
import { aggregateCasinoEconomics, aggregateCasinoPerGame, type CasinoEconomicsRow } from "../src/normalizers/casino-economics.js";

/**
 * Casino logical-play economics tests (2.5.1) — prove that per-log
 * ActivityEvent rows aggregate WITHOUT double counting: stakes are owned
 * by placement/start rows, settlements that repeat the stake don't add a
 * second wager, withdrawals are balance movements (never winnings), and
 * pending placements are never losses. Null stays null; exact zero stays
 * zero.
 */

function row(partial: Partial<CasinoEconomicsRow> & { activityType: string }): CasinoEconomicsRow {
  return { subtype: null, outcome: null, cashInput: null, cashReward: null, netValue: null, ...partial };
}

describe("casino logical-play economics", () => {
  it("slots: one log one play — plain sums exact", () => {
    const eco = aggregateCasinoEconomics([
      row({ activityType: "slots", subtype: "win", outcome: "win", cashInput: 1_000_000n, cashReward: 6_000_000n, netValue: 5_000_000n }),
      row({ activityType: "slots", subtype: "lose", outcome: "loss", cashInput: 1_000_000n, netValue: -1_000_000n }),
    ]);
    expect(eco.wagered).toBe(2_000_000n);
    expect(eco.returned).toBe(6_000_000n);
    expect(eco.net).toBe(4_000_000n);
    expect(eco.plays).toBe(2);
    expect(eco.pending).toBe(0);
  });

  it("bookie: settlement never re-adds the stake — wagered counts placements once", () => {
    const eco = aggregateCasinoEconomics([
      row({ activityType: "bookie", subtype: "placed", outcome: "placed", cashInput: 200_000_000n }),
      row({ activityType: "bookie", subtype: "won", outcome: "win", cashInput: 200_000_000n, cashReward: 400_000_000n, netValue: 200_000_000n }),
    ]);
    // Naive sums would report 400M wagered; the placement owns the stake.
    expect(eco.wagered).toBe(200_000_000n);
    expect(eco.returned).toBe(400_000_000n);
    expect(eco.net).toBe(200_000_000n);
    expect(eco.pending).toBe(0);
  });

  it("bookie: lose settlement repeats the stake — still counted once", () => {
    const eco = aggregateCasinoEconomics([
      row({ activityType: "bookie", subtype: "placed", outcome: "placed", cashInput: 13_240_000n }),
      row({ activityType: "bookie", subtype: "lost", outcome: "loss", cashInput: 13_240_000n, netValue: -13_240_000n }),
    ]);
    expect(eco.wagered).toBe(13_240_000n);
    expect(eco.net).toBe(-13_240_000n);
  });

  it("bookie: refund returns the stake with exact zero net", () => {
    const eco = aggregateCasinoEconomics([
      row({ activityType: "bookie", subtype: "placed", outcome: "placed", cashInput: 3_769_000n }),
      row({ activityType: "bookie", subtype: "refunded", outcome: "refund", cashInput: 3_769_000n, cashReward: 3_769_000n, netValue: 0n }),
    ]);
    expect(eco.wagered).toBe(3_769_000n);
    expect(eco.returned).toBe(3_769_000n);
    expect(eco.net).toBe(0n); // exact zero, from the payload
  });

  it("bookie withdrawal: balance movement excluded from winnings and net, disclosed", () => {
    const eco = aggregateCasinoEconomics([
      row({ activityType: "bookie", subtype: "placed", outcome: "placed", cashInput: 100n }),
      row({ activityType: "bookie", subtype: "won", outcome: "win", cashInput: 100n, cashReward: 300n, netValue: 200n }),
      row({ activityType: "bookie", subtype: "withdrawal", outcome: "withdrawal", cashReward: 3_818_341_835n, netValue: 3_818_341_835n }),
    ]);
    expect(eco.wagered).toBe(100n);
    expect(eco.returned).toBe(300n); // withdrawal NOT counted as winnings
    expect(eco.net).toBe(200n); // withdrawal NOT counted as net
    expect(eco.withdrawn).toBe(3_818_341_835n); // disclosed separately
  });

  it("blackjack: start owns the stake — terminal does not double the wager", () => {
    const eco = aggregateCasinoEconomics([
      row({ activityType: "blackjack", subtype: "start", outcome: "placed", cashInput: 100_000n }),
      row({ activityType: "blackjack", subtype: "win", outcome: "win", cashInput: 100_000n, cashReward: 250_000n, netValue: 150_000n }),
    ]);
    expect(eco.wagered).toBe(100_000n);
    expect(eco.net).toBe(150_000n);
  });

  it("blackjack: unresolved start is pending, never a loss", () => {
    const eco = aggregateCasinoEconomics([
      row({ activityType: "blackjack", subtype: "start", outcome: "placed", cashInput: 100_000n }),
    ]);
    expect(eco.wagered).toBe(100_000n);
    expect(eco.net).toBeNull(); // no settlement yet — P/L unknown
    expect(eco.pending).toBe(1);
  });

  it("high-low: stake appears only on the start — net subtracts it explicitly", () => {
    const eco = aggregateCasinoEconomics([
      row({ activityType: "high-low", subtype: "start", outcome: "placed", cashInput: 100_000n }),
      row({ activityType: "high-low", subtype: "start", outcome: "placed", cashInput: 100_000n }),
      row({ activityType: "high-low", subtype: "win", outcome: "win", cashReward: 250_000n, netValue: 250_000n }),
    ]);
    // 2 lost stakes (100k each) + 1 pot (250k) = +50k logical net; naive
    // sums would report +250k.
    expect(eco.wagered).toBe(200_000n);
    expect(eco.net).toBe(50_000n);
  });

  it("lottery: placements only — net stays null (pending), never -stakes", () => {
    const eco = aggregateCasinoEconomics([
      row({ activityType: "lottery", subtype: "bet", outcome: "placed", cashInput: 100n }),
      row({ activityType: "lottery", subtype: "bet", outcome: "placed", cashInput: 200n }),
    ]);
    expect(eco.wagered).toBe(300n);
    expect(eco.net).toBeNull();
    expect(eco.pending).toBe(2);
  });

  it("spin-the-wheel: start carries net -cost itself — plain sum exact", () => {
    const eco = aggregateCasinoEconomics([
      row({ activityType: "spin-the-wheel", subtype: "start", outcome: "started", cashInput: 1_000_000n, netValue: -1_000_000n }),
      row({ activityType: "spin-the-wheel", subtype: "win-money", outcome: "win", cashReward: 2_500_000n, netValue: 2_500_000n }),
    ]);
    expect(eco.wagered).toBe(1_000_000n);
    expect(eco.net).toBe(1_500_000n);
  });

  it("null vs zero: cashReward null is no-data, 0 is exact zero — both preserve net", () => {
    const lose = aggregateCasinoEconomics([
      row({ activityType: "slots", subtype: "lose", outcome: "loss", cashInput: 500n, netValue: -500n }),
    ]);
    expect(lose.returned).toBe(0n); // exact: no cash returned (payload shows none)
    expect(lose.net).toBe(-500n);

    const zeroReward = aggregateCasinoEconomics([
      row({ activityType: "keno", subtype: "lose", outcome: "loss", cashInput: 10n, cashReward: 0n, netValue: -10n }),
    ]);
    expect(zeroReward.returned).toBe(0n); // exact zero from the payload
    expect(zeroReward.net).toBe(-10n);
  });

  it("no cash at all: hasCash false and net null — not zero", () => {
    const eco = aggregateCasinoEconomics([
      row({ activityType: "blackjack", subtype: "hit", outcome: null }),
    ]);
    expect(eco.hasCash).toBe(false);
    expect(eco.net).toBeNull();
    expect(eco.wagered).toBe(0n);
  });

  it("per-game aggregation keeps ownership isolated", () => {
    const perGame = aggregateCasinoPerGame([
      row({ activityType: "bookie", subtype: "placed", outcome: "placed", cashInput: 1_000n }),
      row({ activityType: "bookie", subtype: "won", outcome: "win", cashInput: 1_000n, cashReward: 2_000n, netValue: 1_000n }),
      row({ activityType: "slots", subtype: "lose", outcome: "loss", cashInput: 500n, netValue: -500n }),
    ]);
    expect(perGame.get("bookie")!.wagered).toBe(1_000n);
    expect(perGame.get("slots")!.wagered).toBe(500n);
  });
});
