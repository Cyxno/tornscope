import { describe, expect, it } from "vitest";
import { buildCrimeSkillProgression, buildFactionTrend, buildUserMilestones, mergeCrimeSkillSnapshot } from "../src/faction-trend.js";
import { calculateNetworthPosition, type NetworthSnapshotFields } from "../src/networth.js";
import { buildInternalTransfers } from "../src/money.js";

/* networth balance-sheet position ----------------------------------------- */

function snapshot(overrides: Partial<NetworthSnapshotFields>): NetworthSnapshotFields {
  return {
    capturedAt: 0,
    total: 1_000_000,
    loans: 0,
    unpaidFees: 0,
    pending: 0,
    wallet: 500_000,
    vault: 500_000,
    bookie: 0,
    cityBank: 0,
    caymanBank: 0,
    piggyBank: 0,
    inventory: 0,
    displayCase: 0,
    bazaar: 0,
    trades: 0,
    itemMarket: 0,
    auctionHouse: 0,
    enlistedCars: 0,
    property: 0,
    stockMarket: 0,
    company: 0,
    points: 0,
    ...overrides,
  };
}

describe("networth balance-sheet position", () => {
  it("reports gross assets / liabilities / net with positive liabilities", () => {
    // Torn stores loans/unpaidFees NEGATIVE; total is already net.
    const pos = calculateNetworthPosition(
      [snapshot({ capturedAt: 0, total: 1_000_000, loans: -225_000, unpaidFees: -25_000 })],
      0,
      10 * 86_400
    );
    expect(pos.liabilities.current).toBe(250_000);
    expect(pos.grossAssets.current).toBe(1_250_000);
    expect(pos.net.current).toBe(1_000_000);
    expect(pos.loans.current).toBe(225_000);
    expect(pos.unpaidFees.current).toBe(25_000);
    expect(pos.provenance).toBe("exact");
  });

  it("computes the range change against the at-or-before baseline", () => {
    const D = 86_400;
    const pos = calculateNetworthPosition(
      [snapshot({ capturedAt: 0, total: 900_000, loans: -100_000, unpaidFees: 0 }), snapshot({ capturedAt: 5 * D, total: 1_200_000, loans: -200_000, unpaidFees: -50_000 })],
      1 * D,
      6 * D
    );
    expect(pos.coverage).toBe("full");
    expect(pos.net.baseline).toBe(900_000);
    expect(pos.net.current).toBe(1_200_000);
    expect(pos.net.change).toBe(300_000);
    expect(pos.liabilities.baseline).toBe(100_000);
    expect(pos.liabilities.current).toBe(250_000);
    expect(pos.grossAssets.change).toBe(1_450_000 - 1_000_000);
  });

  it("never reports a loan payout as negative liabilities (null vs zero respected)", () => {
    const pos = calculateNetworthPosition([snapshot({ capturedAt: 0, loans: 0, unpaidFees: 0 })], 0, 1);
    expect(pos.liabilities.current).toBe(0);
    expect(pos.grossAssets.current).toBe(pos.net.current);
  });
});

/* internal transfers ------------------------------------------------------ */

describe("internal transfers aggregation", () => {
  it("aggregates vault and bank movements per account, never as P/L", () => {
    const rows = [
      { category: "vault", direction: "neutral", amount: -100_000n },
      { category: "vault", direction: "neutral", amount: 40_000n },
      { category: "city_bank", direction: "neutral", amount: -500_000n },
      { category: "cayman_bank", direction: "neutral", amount: 1_000n },
      // income/expense rows never enter transfers even with a transfer category
      { category: "vault", direction: "income", amount: 999n },
      // unknown internal account ignored
      { category: "mystery_pool", direction: "neutral", amount: -1n },
    ];
    const t = buildInternalTransfers(rows);
    expect(t.deposited).toBe(600_000);
    expect(t.withdrawn).toBe(41_000);
    expect(t.moved).toBe(641_000);
    const vault = t.byAccount.find((a) => a.category === "vault")!;
    expect(vault.deposited).toBe(100_000);
    expect(vault.withdrawn).toBe(40_000);
    expect(t.byAccount.find((a) => a.category === "mystery_pool")).toBeUndefined();
  });
});

/* faction trend + user milestones ----------------------------------------- */

describe("faction snapshot trend", () => {
  it("collapses same-moment duplicates and computes respect/member deltas", () => {
    const trend = buildFactionTrend([
      { t: 0, respect: 1000, members: 50 },
      { t: 100, respect: 1010, members: 50 }, // duplicate bucket -> earliest wins
      { t: 2 * 86_400, respect: 1200, members: 52 },
    ]);
    expect(trend.series).toHaveLength(2);
    expect(trend.delta.respect.delta).toBe(200);
    expect(trend.delta.members.delta).toBe(2);
    expect(trend.delta.trackingSince).toBe(0);
  });

  it("returns a single-point delta without fabricated rates", () => {
    const trend = buildFactionTrend([{ t: 0, respect: 10, members: 5 }]);
    expect(trend.delta.respect.delta).toBeNull();
  });
});

describe("user milestones", () => {
  it("reports observed level/rank/faction transitions only", () => {
    const milestones = buildUserMilestones([
      { t: 0, level: 40, rank: "Underboss", factionId: 1 },
      { t: 100, level: 41, rank: "Underboss", factionId: 1 },
      { t: 200, level: 41, rank: "Boss", factionId: 1 },
      { t: 300, level: 41, rank: "Boss", factionId: 2 },
    ]);
    expect(milestones).toEqual([
      { t: 100, kind: "level", from: 40, to: 41 },
      { t: 200, kind: "rank", from: "Underboss", to: "Boss" },
      { t: 300, kind: "faction", from: 1, to: 2 },
    ]);
  });

  it("never fabricates a transition when data is unchanged", () => {
    expect(buildUserMilestones([{ t: 0, level: 10, rank: "Thug", factionId: null }])).toEqual([]);
  });
});

/* crime skill progression -------------------------------------------------- */

describe("crime skill progression", () => {
  it("tracks per-crime level, ups/downs and net delta", () => {
    const stats = buildCrimeSkillProgression([
      { t: 0, crime: "burglary", level: 80, direction: "up" },
      { t: 100, crime: "burglary", level: 81, direction: "up" },
      { t: 200, crime: "burglary", level: 80, direction: "down" },
      { t: 300, crime: "skimming", level: 99, direction: "up" },
    ]);
    const burglary = stats.find((s) => s.crime === "burglary")!;
    expect(burglary.level).toBe(80);
    expect(burglary.opening).toBe(80);
    expect(burglary.delta).toBe(0);
    expect(burglary.levelUps).toBe(2);
    expect(burglary.levelDowns).toBe(1);
    const skimming = stats.find((s) => s.crime === "skimming")!;
    expect(skimming.delta).toBe(0); // single observation: no fabricated delta
  });

  // 2.8.0: personalstats snapshot as the per-crime skill AUTHORITY —
  // real production shapes (crimes.skills map vs log crime names).
  it("merges snapshot levels without overwriting log-observed levels", () => {
    const logStats = buildCrimeSkillProgression([
      { t: 0, crime: "shoplifting", level: 76, direction: "up" },
      { t: 100, crime: "skimming", level: 94, direction: "up" },
    ]);
    // Real snapshot keys: underscored names; "skimming" (log) vs
    // "card_skimming" (snapshot) stay SEPARATE — never guessed onto each other.
    const merged = mergeCrimeSkillSnapshot(logStats, {
      shoplifting: 100, // matches the log crime (normalized)
      card_skimming: 98, // snapshot-only name — new row
      forgery: 1, // snapshot-only, never played in logs
    });
    const shop = merged.find((s) => s.crime === "shoplifting")!;
    expect(shop.level).toBe(76); // log-observed level untouched
    expect(shop.snapshotLevel).toBe(100); // authority rides alongside
    const skimming = merged.find((s) => s.crime === "skimming")!;
    expect(skimming.level).toBe(94);
    expect(skimming.snapshotLevel).toBeNull(); // no defensible name match
    const card = merged.find((s) => s.crime === "card_skimming")!;
    expect(card.snapshotLevel).toBe(98);
    expect(card.level).toBeNull();
    const forgery = merged.find((s) => s.crime === "forgery")!;
    expect(forgery.snapshotLevel).toBe(1);
  });

  it("tolerates missing/invalid snapshot skill maps", () => {
    const logStats = buildCrimeSkillProgression([{ t: 0, crime: "burglary", level: 8, direction: "up" }]);
    expect(mergeCrimeSkillSnapshot(logStats, null)).toEqual(logStats);
    expect(mergeCrimeSkillSnapshot(logStats, { burglary: "high" })).toEqual(logStats); // non-numeric ignored
  });
});
