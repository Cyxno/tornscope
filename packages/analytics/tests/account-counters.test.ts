import { describe, expect, it } from "vitest";
import { computeCounterDelta, isMonotonic, type CounterPoint } from "../src/counter-series.js";
import { buildAccountCounters, extractAccountCounters } from "../src/account-counters.js";

/* counter engine ---------------------------------------------------------- */

const DAY = 86_400;
const series = (values: Array<number | null>, startDays = 0): CounterPoint[] =>
  values.map((value, i) => ({ t: (startDays + i) * DAY, value }));

describe("counter delta engine", () => {
  it("computes opening/closing/delta/rate over a monotonic series", () => {
    const d = computeCounterDelta(series([100, 150, 200, 260]));
    expect(d.opening).toBe(100);
    expect(d.closing).toBe(260);
    expect(d.delta).toBe(160);
    expect(d.resetDetected).toBe(false);
    expect(d.ratePerDay).not.toBeNull();
    // 160 over 3 days
    expect(d.ratePerDay).toBeCloseTo(160 / 3, 6);
  });

  it("returns a single-point delta without fabricated rate", () => {
    const d = computeCounterDelta(series([42]));
    expect(d.delta).toBeNull();
    expect(d.ratePerDay).toBeNull();
    expect(d.opening).toBe(42);
  });

  it("ignores null observations and never fabricates deltas from gaps", () => {
    const d = computeCounterDelta(series([null, 10, null, 20]));
    expect(d.delta).toBe(10);
    expect(d.points).toBe(2);
  });

  it("detects a counter reset and computes delta over the post-reset regime", () => {
    // Steady 1000-level counter that Torn resets to 5, then continues.
    const d = computeCounterDelta(series([1000, 1010, 5, 9, 15]));
    expect(d.resetDetected).toBe(true);
    expect(d.preResetClosing).toBe(1010);
    expect(d.opening).toBe(5);
    expect(d.closing).toBe(15);
    expect(d.delta).toBe(10);
  });

  it("treats a small dip as a real decrease, never a reset", () => {
    const d = computeCounterDelta(series([100, 98, 104]));
    expect(d.resetDetected).toBe(false);
    expect(d.delta).toBe(4);
    expect(d.decreases).toBe(1);
  });

  it("respects the selected range", () => {
    const d = computeCounterDelta(series([0, 10, 20, 30]), { from: 2 * DAY, to: 3 * DAY });
    expect(d.opening).toBe(20);
    expect(d.closing).toBe(30);
  });

  it("isMonotonic reports decreases", () => {
    expect(isMonotonic(series([1, 2, 3]))).toBe(true);
    expect(isMonotonic(series([1, 0, 3]))).toBe(false);
  });
});

/* account counters -------------------------------------------------------- */

const statsBlob = {
  crimes: { total: 500 },
  other: { awards: 42, refills: { energy: 130 }, donator_days: 300 },
  jobs: { trains_received: 55, job_points_used: 9 },
  hospital: { times_hospitalized: 12, medical_items_used: 80, blood_withdrawn: 3, reviving: { revives_received: 7 } },
  travel: { total: 33 },
  communication: { mails_sent: 15 },
  networth: { total: 1 }, // intentionally ignored: redundant with NetworthSnapshot
  level: 42,
};

describe("account counters", () => {
  it("extracts every catalog counter from a blob (unknown paths stay null)", () => {
    const extracted = extractAccountCounters(statsBlob);
    expect(extracted.awards).toBe(42);
    expect(extracted.crimes).toBe(500);
    expect(extracted.trains_received).toBe(55);
    expect(extracted.revives_received).toBe(7);
    // networth.total is deliberately NOT a catalog counter
    expect(extracted).not.toHaveProperty("networth_total");
  });

  it("builds range deltas from a snapshot series", () => {
    const rows = [
      { t: 0, stats: statsBlob },
      { t: 5 * DAY, stats: { ...statsBlob, other: { ...statsBlob.other, awards: 50, refills: { energy: 140 } }, crimes: { total: 540 } } },
    ];
    const result = buildAccountCounters(rows, { from: 0, to: 5 * DAY });
    expect(result.trackingSince).toBe(0);
    const awards = result.primary.find((c) => c.key === "awards")!;
    expect(awards.delta).toBe(8);
    expect(awards.current).toBe(50);
    const crimes = result.primary.find((c) => c.key === "crimes")!;
    expect(crimes.delta).toBe(40);
    // counters absent from the blobs never appear
    expect(result.primary.find((c) => c.key === "missions_credits")).toBeUndefined();
  });

  it("counters absent from the blobs never appear", () => {
    const result = buildAccountCounters([{ t: 0, stats: statsBlob }]);
    expect(result.primary.find((c) => c.key === "missions_credits")).toBeUndefined();
  });

  // 2.8.0: the Combat / Racing / bounty families — every path proven in the
  // stored production archive (JSON-path fingerprint, 2026-10-08).
  it("extracts the combat/racing/bounty counters from a real-shape blob", () => {
    const blob = {
      attacking: {
        elo: 2442,
        hits: { miss: 602, success: 1816, critical: 222, one_hit_kills: 229 },
        attacks: { won: 672, lost: 14, assist: 5, stealth: 501, stalemate: 1 },
        defends: { won: 5, lost: 183, total: 188 },
        faction: { respect: 3176, ranked_war_hits: 346 },
        networth: { largest_mug: 189_052, money_mugged: 478_831 },
        killstreak: { best: 51, current: 0 },
      },
      racing: { races: { won: 45, entered: 205 }, skill: 5, points: 250 },
      bounties: { placed: { value: 1502, amount: 2 }, received: { value: 825_000, amount: 5 }, collected: { value: 0, amount: 0 } },
    };
    const extracted = extractAccountCounters(blob);
    expect(extracted.attacks_won).toBe(672);
    expect(extracted.attacks_lost).toBe(14);
    expect(extracted.attacks_stealth).toBe(501);
    expect(extracted.hits_critical).toBe(222);
    expect(extracted.defends_total).toBe(188);
    expect(extracted.combat_elo).toBe(2442);
    expect(extracted.killstreak_best).toBe(51);
    expect(extracted.money_mugged).toBe(478_831);
    expect(extracted.largest_mug).toBe(189_052);
    expect(extracted.faction_respect).toBe(3176);
    expect(extracted.ranked_war_hits).toBe(346);
    expect(extracted.races_entered).toBe(205);
    expect(extracted.races_won).toBe(45);
    expect(extracted.racing_points).toBe(250);
    expect(extracted.racing_skill).toBe(5);
    expect(extracted.bounty_placed_value).toBe(1502);
    expect(extracted.bounty_received_value).toBe(825_000);
    expect(extracted.bounty_collected_value).toBe(0);
  });

  it("builds combat deltas with groups, and gauges never false-positive resets", () => {
    // Real archive shape: elo climbs with ordinary swings — never a 50% drop,
    // so the reset detector must not mislabel the gauge.
    const rows = [
      { t: 0, stats: { attacking: { attacks: { won: 672 }, elo: 1398, networth: { money_mugged: 478_831 } } } },
      { t: 10 * DAY, stats: { attacking: { attacks: { won: 6804 }, elo: 1500, networth: { money_mugged: 109_395_449 } } } },
      { t: 20 * DAY, stats: { attacking: { attacks: { won: 6900 }, elo: 1440, networth: { money_mugged: 110_000_000 } } } },
    ];
    const result = buildAccountCounters(rows);
    const won = result.primary.find((c) => c.key === "attacks_won")!;
    expect(won.group).toBe("Combat");
    expect(won.delta).toBe(6228);
    const elo = result.secondary.find((c) => c.key === "combat_elo")!;
    expect(elo.delta).toBe(42); // 1398 → 1440 with swings — a range change, not a reset
    expect(elo.resetDetected).toBe(false);
    const mugged = result.primary.find((c) => c.key === "money_mugged")!;
    expect(mugged.delta).toBe(109_521_169);
  });
});
