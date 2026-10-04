import { describe, expect, it } from "vitest";
import {
  buildDecisionSignals,
  normalizeDecisionPrefs,
  reconcileLifecycle,
  scaledMad,
  median,
  windowStat,
  BASELINE_WINDOW_SEC,
  RECENT_WINDOW_SEC,
  type DecisionFacts,
} from "../src/decision-intelligence.js";

/**
 * Decision Intelligence engine tests (2.3.0): baselines, thresholds,
 * lifecycle keys, coverage guards, provenance vs confidence, and the
 * no-live-recommendation rule for travel.
 */

const NOW = 1_790_000_000;
const DAY = 86_400;

function baseFacts(overrides: Partial<DecisionFacts> = {}): DecisionFacts {
  return {
    now: NOW,
    money: { events: [], trackingSince: NOW - 120 * DAY },
    drugs: { events: [], rehab: [], trackingSince: NOW - 120 * DAY },
    travel: { trips: [], trackingSince: NOW - 120 * DAY },
    energy: { gym: [], refills: [], xanaxUses: [], trackingSince: NOW - 120 * DAY },
    goals: { paced: [], networthPerDay: null },
    ...overrides,
  };
}

const prefs = normalizeDecisionPrefs({});

/* -------------------------------------------------------------------------- */
/* Baselines & robust statistics                                               */
/* -------------------------------------------------------------------------- */

describe("baselines & robust statistics", () => {
  it("windowStat computes totals, events and per-covered-day rates", () => {
    // Day-aligned fixtures: two events on one UTC day, one on the next.
    const day0 = Math.floor(NOW / DAY) * DAY;
    const stat = windowStat(
      [
        { t: day0 + 3600, value: 10 },
        { t: day0 + 7200, value: 20 },
        { t: day0 + DAY + 3600, value: 5 },
      ],
      day0,
      day0 + 2 * DAY
    );
    expect(stat.total).toBe(35);
    expect(stat.events).toBe(3);
    expect(stat.coveredDays).toBe(2);
    expect(stat.perCoveredDay).toBe(17.5);
  });

  it("median and scaledMad are outlier-robust", () => {
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 1000];
    expect(median(values)).toBe(10);
    // A single outlier barely moves the MAD-based band.
    expect(scaledMad(values)!).toBeLessThan(5);
  });

  it("recent vs baseline windows do not overlap", () => {
    expect(RECENT_WINDOW_SEC).toBe(7 * DAY);
    expect(BASELINE_WINDOW_SEC).toBe(30 * DAY);
  });

  it("normalizes prefs from raw JSON (domain toggles, clamped max)", () => {
    const p = normalizeDecisionPrefs({ enabled: false, domains: { travel: false }, maxOverviewSignals: 99 });
    expect(p.enabled).toBe(false);
    expect(p.domains.travel).toBe(false);
    expect(p.domains.money).toBe(true);
    expect(p.maxOverviewSignals).toBe(5);
  });
});

/* -------------------------------------------------------------------------- */
/* Money signals                                                               */
/* -------------------------------------------------------------------------- */

describe("money signals", () => {
  function moneyScenario(recentDaily: number[], baselineDaily: number[]): DecisionFacts {
    const events: DecisionFacts["money"]["events"] = [];
    let t = NOW - 3600;
    for (const v of recentDaily) {
      events.push({ t, category: "other", direction: "expense", amount: v });
      t -= DAY;
    }
    t = NOW - RECENT_WINDOW_SEC - DAY;
    for (const v of baselineDaily) {
      events.push({ t, category: "other", direction: "expense", amount: v });
      t -= DAY;
    }
    return baseFacts({ money: { events, trackingSince: NOW - 120 * DAY } });
  }

  it("flags a spending anomaly above median + 3×MAD", () => {
    // Calm 30-day baseline; a hot recent week.
    const facts = moneyScenario([5000, 5200, 4800, 5100, 4950, 5050, 5000], Array.from({ length: 30 }, () => 1000));
    const result = buildDecisionSignals({ facts, coverage: { money: { coveredDays: 7, events: 37, trackingSince: null }, drugs: { coveredDays: 0, events: 0, trackingSince: null }, travel: { coveredDays: 0, events: 0, trackingSince: null }, energy: { coveredDays: 0, events: 0, trackingSince: null } }, prefs });
    const signal = result.signals.find((s) => s.id === "money.spending-anomaly");
    expect(signal).toBeDefined();
    expect(signal!.provenance).toBe("exact");
    expect(signal!.metricAfter).toBeGreaterThan(signal!.metricBefore!);
  });

  it("does not flag normal variation (robust outlier behavior)", () => {
    const facts = moneyScenario([1100, 900, 1050, 950, 1000, 1020, 980], Array.from({ length: 30 }, (_, i) => 900 + (i % 5) * 50));
    const result = buildDecisionSignals({ facts, coverage: { money: { coveredDays: 7, events: 37, trackingSince: null }, drugs: { coveredDays: 0, events: 0, trackingSince: null }, travel: { coveredDays: 0, events: 0, trackingSince: null }, energy: { coveredDays: 0, events: 0, trackingSince: null } }, prefs });
    expect(result.signals.find((s) => s.id === "money.spending-anomaly")).toBeUndefined();
  });

  it("excludes transfers (neutral) from spending", () => {
    const events: DecisionFacts["money"]["events"] = [
      { t: NOW - 100, category: "city_bank", direction: "neutral", amount: 50_000_000 },
      { t: NOW - 200, category: "other", direction: "expense", amount: 1000 },
    ];
    const facts = baseFacts({ money: { events, trackingSince: NOW - 120 * DAY } });
    const result = buildDecisionSignals({ facts, coverage: { money: { coveredDays: 2, events: 2, trackingSince: null }, drugs: { coveredDays: 0, events: 0, trackingSince: null }, travel: { coveredDays: 0, events: 0, trackingSince: null }, energy: { coveredDays: 0, events: 0, trackingSince: null } }, prefs });
    // A 50m bank transfer must never read as 50m of spending.
    expect(result.signals.find((s) => s.id === "money.spending-anomaly")).toBeUndefined();
  });

  it("suppresses comparisons with insufficient baseline coverage", () => {
    const facts = moneyScenario([5000, 5200, 4800, 5100, 4950, 5050, 5000], [1000, 1000, 1000]);
    const result = buildDecisionSignals({ facts, coverage: { money: { coveredDays: 3, events: 10, trackingSince: null }, drugs: { coveredDays: 0, events: 0, trackingSince: null }, travel: { coveredDays: 0, events: 0, trackingSince: null }, energy: { coveredDays: 0, events: 0, trackingSince: null } }, prefs });
    expect(result.signals.find((s) => s.id === "money.spending-anomaly")).toBeUndefined();
    expect(result.suppressedInsufficientData).toBeGreaterThanOrEqual(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Travel signals                                                              */
/* -------------------------------------------------------------------------- */

describe("travel signals", () => {
  function trip(destination: string, departedAt: number, hours: number, spend: number, valuePerItem: number | null): DecisionFacts["travel"]["trips"][number] {
    return {
      destination,
      departedAt,
      durationSeconds: hours * 3600,
      items: valuePerItem === null ? [] : [{ totalCost: spend, estimatedUnitValue: valuePerItem, quantity: 1 }],
    };
  }

  it("computes median profit/hour and never recommends a live destination", () => {
    const trips = [
      trip("UAE", NOW - 2 * DAY, 4, 1_000_000, 2_000_000), // 250k/h recent
      trip("UAE", NOW - 3 * DAY, 4, 1_000_000, 1_800_000),
      trip("UAE", NOW - 4 * DAY, 4, 1_000_000, 1_900_000),
      ...Array.from({ length: 6 }, (_, i) => trip("UAE", NOW - (10 + i) * DAY, 4, 1_000_000, 2_400_000 + i * 10_000)), // baseline ~2.4m/h
    ];
    const facts = baseFacts({ travel: { trips, trackingSince: NOW - 120 * DAY } });
    const result = buildDecisionSignals({ facts, coverage: { money: { coveredDays: 0, events: 0, trackingSince: null }, drugs: { coveredDays: 0, events: 0, trackingSince: null }, travel: { coveredDays: 9, events: 9, trackingSince: null }, energy: { coveredDays: 0, events: 0, trackingSince: null } }, prefs });
    const drop = result.signals.find((s) => s.id === "travel.profit-hour-drop");
    expect(drop).toBeDefined();
    expect(drop!.provenance).toBe("estimated");
    expect(drop!.summary).not.toMatch(/fly to|go to .*now/i);
    expect(drop!.limitations.join(" ")).toMatch(/not a live recommendation/i);
  });

  it("suppresses travel comparisons with insufficient trips", () => {
    const trips = [trip("UAE", NOW - 2 * DAY, 4, 1_000_000, 2_000_000)];
    const facts = baseFacts({ travel: { trips, trackingSince: NOW - 120 * DAY } });
    const result = buildDecisionSignals({ facts, coverage: { money: { coveredDays: 0, events: 0, trackingSince: null }, drugs: { coveredDays: 0, events: 0, trackingSince: null }, travel: { coveredDays: 1, events: 1, trackingSince: null }, energy: { coveredDays: 0, events: 0, trackingSince: null } }, prefs });
    expect(result.signals.filter((s) => s.domain === "travel" && s.id !== "travel.best-destination")).toHaveLength(0);
  });

  it("best-destination signal needs at least 3 trips per destination", () => {
    const trips = [
      trip("UAE", NOW - 2 * DAY, 4, 100, 1_000_000),
      trip("UAE", NOW - 3 * DAY, 4, 100, 1_000_000),
      trip("Canada", NOW - 4 * DAY, 4, 100, 5_000_000),
      trip("Canada", NOW - 5 * DAY, 4, 100, 5_000_000),
    ];
    const facts = baseFacts({ travel: { trips, trackingSince: NOW - 120 * DAY } });
    const result = buildDecisionSignals({ facts, coverage: { money: { coveredDays: 0, events: 0, trackingSince: null }, drugs: { coveredDays: 0, events: 0, trackingSince: null }, travel: { coveredDays: 4, events: 4, trackingSince: null }, energy: { coveredDays: 0, events: 0, trackingSince: null } }, prefs });
    expect(result.signals.find((s) => s.id === "travel.best-destination")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Drugs signals                                                               */
/* -------------------------------------------------------------------------- */

describe("drugs signals", () => {
  it("compares xanax pace descriptively (no prescriptions)", () => {
    const events: DecisionFacts["drugs"]["events"] = [];
    for (let i = 0; i < 10; i++) events.push({ t: NOW - (i % 5) * DAY - 100, drugName: "Xanax", outcome: "success" });
    for (let i = 0; i < 40; i++) events.push({ t: NOW - RECENT_WINDOW_SEC - i * DAY - 100, drugName: "Xanax", outcome: "success" });
    const facts = baseFacts({ drugs: { events, rehab: [], trackingSince: NOW - 120 * DAY } });
    const result = buildDecisionSignals({ facts, coverage: { money: { coveredDays: 0, events: 0, trackingSince: null }, drugs: { coveredDays: 45, events: 45, trackingSince: null }, travel: { coveredDays: 0, events: 0, trackingSince: null }, energy: { coveredDays: 0, events: 0, trackingSince: null } }, prefs });
    const pace = result.signals.find((s) => s.id === "drugs.xanax-pace");
    expect(pace).toBeDefined();
    expect(pace!.title).toMatch(/your recent baseline/i);
    expect(pace!.summary).not.toMatch(/must|should take/i);
  });

  it("raises the OD-rate signal only on a doubling with enough samples", () => {
    const events: DecisionFacts["drugs"]["events"] = [];
    for (let i = 0; i < 12; i++) events.push({ t: NOW - i * 3600 - 100, drugName: "Xanax", outcome: i < 3 ? "overdose" : "success" });
    for (let i = 0; i < 40; i++) events.push({ t: NOW - RECENT_WINDOW_SEC - i * DAY - 100, drugName: "Xanax", outcome: i === 0 ? "overdose" : "success" });
    const facts = baseFacts({ drugs: { events, rehab: [], trackingSince: NOW - 120 * DAY } });
    const result = buildDecisionSignals({ facts, coverage: { money: { coveredDays: 0, events: 0, trackingSince: null }, drugs: { coveredDays: 52, events: 52, trackingSince: null }, travel: { coveredDays: 0, events: 0, trackingSince: null }, energy: { coveredDays: 0, events: 0, trackingSince: null } }, prefs });
    const od = result.signals.find((s) => s.id === "drugs.od-rate-up");
    expect(od).toBeDefined();
    expect(od!.category).toBe("RISK");
    expect(od!.provenance).toBe("exact");
  });
});

/* -------------------------------------------------------------------------- */
/* Energy signals                                                              */
/* -------------------------------------------------------------------------- */

describe("energy signals", () => {
  it("uses exact gym payload energy and never claims a cap loss", () => {
    const gym: DecisionFacts["energy"]["gym"] = [];
    for (let i = 0; i < 6; i++) gym.push({ t: NOW - i * DAY - 100, energyUsed: 900 });
    for (let i = 0; i < 30; i++) gym.push({ t: NOW - RECENT_WINDOW_SEC - i * DAY - 100, energyUsed: 300 });
    const facts = baseFacts({ energy: { gym, refills: [], xanaxUses: [], trackingSince: NOW - 120 * DAY } });
    const result = buildDecisionSignals({ facts, coverage: { money: { coveredDays: 0, events: 0, trackingSince: null }, drugs: { coveredDays: 0, events: 0, trackingSince: null }, travel: { coveredDays: 0, events: 0, trackingSince: null }, energy: { coveredDays: 36, events: 36, trackingSince: null } }, prefs });
    const gymSignal = result.signals.find((s) => s.id === "energy.gym-allocation");
    expect(gymSignal).toBeDefined();
    expect(gymSignal!.provenance).toBe("exact");
    expect(JSON.stringify(result.signals)).not.toMatch(/cap loss|lost at cap/i);
  });

  it("improving trend produces the below-baseline variant, not an anomaly", () => {
    const gym: DecisionFacts["energy"]["gym"] = [];
    for (let i = 0; i < 6; i++) gym.push({ t: NOW - i * DAY - 100, energyUsed: 200 });
    for (let i = 0; i < 30; i++) gym.push({ t: NOW - RECENT_WINDOW_SEC - i * DAY - 100, energyUsed: 500 });
    const facts = baseFacts({ energy: { gym, refills: [], xanaxUses: [], trackingSince: NOW - 120 * DAY } });
    const result = buildDecisionSignals({ facts, coverage: { money: { coveredDays: 0, events: 0, trackingSince: null }, drugs: { coveredDays: 0, events: 0, trackingSince: null }, travel: { coveredDays: 0, events: 0, trackingSince: null }, energy: { coveredDays: 36, events: 36, trackingSince: null } }, prefs });
    const gymSignal = result.signals.find((s) => s.id === "energy.gym-allocation");
    expect(gymSignal).toBeDefined();
    expect(gymSignal!.title).toMatch(/below/i);
    expect(gymSignal!.category).toBe("TREND");
  });
});

/* -------------------------------------------------------------------------- */
/* Goals                                                                       */
/* -------------------------------------------------------------------------- */

describe("goals pacing", () => {
  it("paces only against an explicit target date", () => {
    const facts = baseFacts({
      goals: {
        paced: [{ id: "g1", label: "2b net worth", metric: "networth", target: 2_000_000_000, targetDate: NOW + 30 * DAY }],
        networthPerDay: 10_000_000, // far below the required ~66m/day
      },
    });
    const result = buildDecisionSignals({ facts, coverage: { money: { coveredDays: 0, events: 0, trackingSince: null }, drugs: { coveredDays: 0, events: 0, trackingSince: null }, travel: { coveredDays: 0, events: 0, trackingSince: null }, energy: { coveredDays: 0, events: 0, trackingSince: null } }, prefs, networthPaceRecent: { perDay: 10_000_000, coveredDays: 6 } });
    const pace = result.signals.find((s) => s.id === "goals.pace-g1");
    expect(pace).toBeDefined();
    expect(pace!.summary).toMatch(/target date/);
  });

  it("never paces a goal without a target date", () => {
    const facts = baseFacts({ goals: { paced: [], networthPerDay: 10_000_000 } });
    const result = buildDecisionSignals({ facts, coverage: { money: { coveredDays: 0, events: 0, trackingSince: null }, drugs: { coveredDays: 0, events: 0, trackingSince: null }, travel: { coveredDays: 0, events: 0, trackingSince: null }, energy: { coveredDays: 0, events: 0, trackingSince: null } }, prefs, networthPaceRecent: { perDay: 1, coveredDays: 7 } });
    expect(result.signals.filter((s) => s.domain === "goals")).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Lifecycle & prefs gating                                                    */
/* -------------------------------------------------------------------------- */

describe("lifecycle & prefs", () => {
  it("reconciles stable keys: new on first sight, active on rerun, resolved when gone", () => {
    const first = reconcileLifecycle(["money.spending-anomaly"], {}, NOW * 1000);
    expect(first.newKeys.has("money.spending-anomaly")).toBe(true);
    const second = reconcileLifecycle(["money.spending-anomaly"], first.nextState, NOW * 1000 + 1000);
    expect(second.newKeys.has("money.spending-anomaly")).toBe(false);
    expect(second.nextState["money.spending-anomaly"]!.resolvedAt).toBeNull();
    const third = reconcileLifecycle([], second.nextState, NOW * 1000 + 2000);
    expect(third.nextState["money.spending-anomaly"]!.resolvedAt).toBe(NOW * 1000 + 2000);
  });

  it("domain toggle suppresses the whole domain", () => {
    const facts = moneyScenarioForToggle();
    const result = buildDecisionSignals({
      facts,
      coverage: { money: { coveredDays: 7, events: 37, trackingSince: null }, drugs: { coveredDays: 0, events: 0, trackingSince: null }, travel: { coveredDays: 0, events: 0, trackingSince: null }, energy: { coveredDays: 0, events: 0, trackingSince: null } },
      prefs: normalizeDecisionPrefs({ domains: { money: false } }),
    });
    expect(result.signals.filter((s) => s.domain === "money")).toHaveLength(0);
  });

  function moneyScenarioForToggle(): DecisionFacts {
    const events: DecisionFacts["money"]["events"] = [];
    let t = NOW - 3600;
    for (const v of [5000, 5200, 4800, 5100, 4950, 5050, 5000]) {
      events.push({ t, category: "other", direction: "expense", amount: v });
      t -= DAY;
    }
    t = NOW - RECENT_WINDOW_SEC - DAY;
    for (const v of Array.from({ length: 30 }, () => 1000)) {
      events.push({ t, category: "other", direction: "expense", amount: v });
      t -= DAY;
    }
    return baseFacts({ money: { events, trackingSince: NOW - 120 * DAY } });
  }

  it("includeLowConfidence=false drops low-confidence signals", () => {
    const trips = [
      trip("UAE", NOW - 2 * DAY, 4, 100, 1_000_000),
      trip("UAE", NOW - 3 * DAY, 4, 100, 900_000),
      trip("UAE", NOW - 4 * DAY, 4, 100, 950_000),
      trip("Canada", NOW - 5 * DAY, 4, 100, 900_000),
      trip("Canada", NOW - 6 * DAY, 4, 100, 920_000),
      trip("Canada", NOW - 7 * DAY, 4, 100, 910_000),
    ];
    const facts = baseFacts({ travel: { trips, trackingSince: NOW - 120 * DAY } });
    const result = buildDecisionSignals({
      facts,
      coverage: { money: { coveredDays: 0, events: 0, trackingSince: null }, drugs: { coveredDays: 0, events: 0, trackingSince: null }, travel: { coveredDays: 6, events: 6, trackingSince: null }, energy: { coveredDays: 0, events: 0, trackingSince: null } },
      prefs: normalizeDecisionPrefs({ includeLowConfidence: false }),
    });
    expect(result.signals.every((s) => s.confidence !== "low")).toBe(true);
  });

  function trip(destination: string, departedAt: number, hours: number, spend: number, value: number): DecisionFacts["travel"]["trips"][number] {
    return {
      destination,
      departedAt,
      durationSeconds: hours * 3600,
      items: [{ totalCost: spend, estimatedUnitValue: value, quantity: 1 }],
    };
  }
});
