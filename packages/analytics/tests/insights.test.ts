import { describe, expect, it } from "vitest";
import { deriveInsights, INSIGHT_POLICY, type InsightInputs } from "../src/insights.js";
import type { MoneyEventLike } from "../src/money.js";
import type { NetworthSnapshotFields } from "../src/networth.js";
import type { TrainingSession } from "../src/progression.js";
import type { RehabEventLike } from "../src/rehab.js";
import type { TravelTripLike } from "../src/travel.js";

const DAY = 86_400;
const NOW = 1_750_000_000; // aligned-ish "now"

function emptyInputs(): InsightInputs {
  return {
    now: NOW,
    networthSnapshots: [],
    moneyEvents: [],
    travelTrips: [],
    rehabEvents: [],
    xanaxCounter: [],
    trainingSessions: [],
    energyCappedHours: [],
  };
}

function money(occurredAt: number, amount: number, category: string, direction: "income" | "expense"): MoneyEventLike {
  return { id: `m:${occurredAt}:${amount}:${category}`, occurredAt, category, direction, amount };
}

function networthField(total: number, capturedAt: number): NetworthSnapshotFields {
  return {
    capturedAt,
    total,
    pending: 0, wallet: 0, vault: 0, bookie: 0, cityBank: 0, caymanBank: 0, piggyBank: 0,
    inventory: 0, displayCase: 0, bazaar: 0, trades: 0, itemMarket: 0, auctionHouse: 0,
    enlistedCars: 0, property: 0, stockMarket: 0, company: 0, points: 0,
  };
}

function session(startedAt: number, gainPerEnergy: number, totalGain: number): TrainingSession {
  return {
    startedAt,
    endedAt: startedAt + 600,
    energySpent: 150,
    energyKnown: true,
    gains: null,
    gymGain: totalGain,
    totalGain,
    nonGymJobGain: 0,
    friendTrains: 0,
    gainPerEnergy,
    primaryStat: "strength",
    inference: "likely",
    evidence: [],
    bracketShared: false,
  };
}

describe("deriveInsights", () => {
  it("emits nothing on empty inputs and flags insufficient history", () => {
    const result = deriveInsights(emptyInputs());
    expect(result.insights).toEqual([]);
    expect(result.insufficientHistory).toBe(true);
  });

  it("emits a net worth record when the latest snapshot is an all-time high", () => {
    const inputs = emptyInputs();
    inputs.networthSnapshots = Array.from({ length: 20 }, (_, i) => networthField(1_000_000_000 + i * 5_000_000, NOW - (20 - i) * DAY));
    const result = deriveInsights(inputs);
    const record = result.insights.find((i) => i.kind === "networth_record");
    expect(record).not.toBeUndefined();
    expect(record!.confidence).toBe("high");
    expect(record!.sensitiveDetail).toContain("$");
    expect(record!.detail.toLowerCase()).not.toContain("$"); // privacy-first title/detail
    expect(record!.dedupeKey).toMatch(/^networth_record:\d+$/);
  });

  it("does not celebrate a stale net worth peak", () => {
    const inputs = emptyInputs();
    inputs.networthSnapshots = Array.from({ length: 20 }, (_, i) => networthField(1_000_000_000 + i * 5_000_000, NOW - (20 - i) * DAY - 5 * DAY));
    const result = deriveInsights(inputs);
    expect(result.insights.find((i) => i.kind === "networth_record")).toBeUndefined();
  });

  it("detects a spending spike above 1.5x a meaningful baseline", () => {
    const inputs = emptyInputs();
    // Baseline month: ~200k/day true expense; current week: ~1M/day.
    for (let d = 37; d >= 8; d--) {
      inputs.moneyEvents.push(money(NOW - d * DAY + 3600, 200_000, "hospital", "expense"));
    }
    for (let d = 7; d >= 1; d--) {
      inputs.moneyEvents.push(money(NOW - d * DAY + 3600, 1_000_000, "hospital", "expense"));
    }
    const result = deriveInsights(inputs);
    const spike = result.insights.find((i) => i.kind === "spending_spike");
    expect(spike).not.toBeUndefined();
    expect(spike!.comparison.deltaPct).toBeGreaterThan(INSIGHT_POLICY.SHIFT_RELATIVE_PCT);
    // Asset sales are NOT income and conversions are NOT expense:
    expect(spike!.comparison.metric).toBe("Daily spending");
  });

  it("never treats asset sales as income", () => {
    const inputs = emptyInputs();
    // Baseline and current week have IDENTICAL true income; a huge ASSET sale
    // in the current week must not create an income shift.
    for (let d = 37; d >= 1; d--) inputs.moneyEvents.push(money(NOW - d * DAY + 3600, 300_000, "salary", "income"));
    inputs.moneyEvents.push(money(NOW - 3 * DAY, 50_000_000, "items", "income"));
    const result = deriveInsights(inputs);
    const income = result.insights.find((i) => i.kind === "income_shift");
    expect(income).toBeUndefined();
  });

  it("suppresses income shifts under the money floor", () => {
    const inputs = emptyInputs();
    for (let d = 37; d >= 8; d--) inputs.moneyEvents.push(money(NOW - d * DAY + 3600, 50_000, "salary", "income"));
    for (let d = 7; d >= 1; d--) inputs.moneyEvents.push(money(NOW - d * DAY + 3600, 150_000, "salary", "income"));
    const result = deriveInsights(inputs);
    expect(result.insights.find((i) => i.kind === "income_shift")).toBeUndefined();
  });

  it("requires baseline sessions before claiming a training efficiency shift", () => {
    const inputs = emptyInputs();
    // Current week: 4 great sessions; baseline: only 2 (below MIN).
    const base = NOW - 15 * DAY;
    inputs.trainingSessions = [
      session(base, 10, 1500),
      session(base + DAY, 10.2, 1530),
      ...Array.from({ length: 4 }, (_, i) => session(NOW - (6 - i) * DAY, 13.5, 2025)),
    ];
    const result = deriveInsights(inputs);
    expect(result.insights.find((i) => i.kind === "training_efficiency_shift")).toBeUndefined();
  });

  it("emits a training efficiency shift with enough baseline", () => {
    const inputs = emptyInputs();
    const baseline = Array.from({ length: 8 }, (_, i) => session(NOW - (15 + i) * DAY, 10, 1500));
    const current = Array.from({ length: 4 }, (_, i) => session(NOW - (6 - i) * DAY, 14, 2100));
    inputs.trainingSessions = [...baseline, ...current];
    const result = deriveInsights(inputs);
    const shift = result.insights.find((i) => i.kind === "training_efficiency_shift");
    expect(shift).not.toBeUndefined();
    expect(shift!.comparison.deltaPct).toBeGreaterThanOrEqual(INSIGHT_POLICY.TRAINING_EFFICIENCY_PCT);
    expect(shift!.provenance).toBe("inferred");
    // No causality in the wording:
    expect(shift!.detail.toLowerCase()).not.toMatch(/because|caused by|due to/);
  });

  it("detects a best training week record", () => {
    const inputs = emptyInputs();
    const weeks: Array<{ offsetDays: number; gain: number }> = [
      { offsetDays: 28, gain: 10_000 },
      { offsetDays: 21, gain: 12_000 },
      { offsetDays: 14, gain: 11_000 },
      { offsetDays: 2, gain: 20_000 }, // live week (current)
    ];
    inputs.trainingSessions = weeks.flatMap((w) => [session(NOW - w.offsetDays * DAY, 10, w.gain * 0.6), session(NOW - (w.offsetDays + 1) * DAY, 10, w.gain * 0.4)]);
    const result = deriveInsights(inputs);
    const record = result.insights.find((i) => i.kind === "personal_record");
    expect(record).not.toBeUndefined();
    expect(record!.comparison.currentValue).toBeGreaterThan(record!.comparison.baselineValue);
  });

  it("flags elevated energy-at-cap hours", () => {
    const inputs = emptyInputs();
    for (let d = 37; d >= 8; d--) inputs.energyCappedHours.push({ t: NOW - d * DAY, hours: 1 });
    for (let d = 7; d >= 1; d--) inputs.energyCappedHours.push({ t: NOW - d * DAY, hours: 4 });
    const result = deriveInsights(inputs);
    const capped = result.insights.find((i) => i.kind === "energy_capped_elevated");
    expect(capped).not.toBeUndefined();
    expect(capped!.comparison.unit).toBe("hours");
  });

  it("requires rehab baseline history", () => {
    const inputs = emptyInputs();
    inputs.rehabEvents = Array.from({ length: 2 }, (_, i): RehabEventLike => ({ occurredAt: NOW - i * DAY, cost: 1_000_000 }));
    const result = deriveInsights(inputs);
    expect(result.insights.find((i) => i.kind === "rehab_spend_high")).toBeUndefined();
  });

  it("flags rehab spend at a 90-day high", () => {
    const inputs = emptyInputs();
    for (let d = 30; d >= 8; d--) inputs.rehabEvents.push({ occurredAt: NOW - d * DAY, cost: 100_000 });
    inputs.rehabEvents.push({ occurredAt: NOW - 2 * DAY, cost: 2_500_000 });
    const result = deriveInsights(inputs);
    const rehab = result.insights.find((i) => i.kind === "rehab_spend_high");
    expect(rehab).not.toBeUndefined();
    expect(rehab!.comparison.baselineLabel).toContain("90-day");
  });

  it("requires priced items before claiming a travel profit shift", () => {
    const inputs = emptyInputs();
    const trip = (departedAt: number, unit: number | null): TravelTripLike => ({
      id: `trip:${departedAt}`,
      destination: "Mexico",
      departedAt,
      returnedAt: departedAt + 12 * 3600,
      durationSeconds: 12 * 3600,
      items: [{ id: "i1", category: "plushie", itemId: 1, itemName: "Plushie", quantity: 10, unitCost: 1000, totalCost: 10_000, estimatedUnitValue: unit, estimatedTotalValue: unit === null ? null : unit * 10 }],
    });
    for (let d = 30; d >= 10; d -= 3) inputs.travelTrips.push(trip(NOW - d * DAY, 1300));
    for (let d = 6; d >= 1; d -= 2) inputs.travelTrips.push(trip(NOW - d * DAY, 2200));
    const result = deriveInsights(inputs);
    expect(result.insights.find((i) => i.kind === "travel_profit_shift")).not.toBeUndefined();
  });

  it("detects a xanax usage shift from the cumulative counter", () => {
    const inputs = emptyInputs();
    // Prior month: ~2/day. Current month: ~3.07/day. 4+ points per window.
    inputs.xanaxCounter = [
      { t: NOW - 60 * DAY, xanax: 0 },
      { t: NOW - 50 * DAY, xanax: 20 },
      { t: NOW - 40 * DAY, xanax: 40 },
      { t: NOW - 31 * DAY, xanax: 58 },
      { t: NOW - 25 * DAY, xanax: 72 },
      { t: NOW - 15 * DAY, xanax: 102 },
      { t: NOW - 8 * DAY, xanax: 126 },
      { t: NOW - 2 * DAY, xanax: 144 },
    ];
    const result = deriveInsights(inputs);
    const xan = result.insights.find((i) => i.kind === "xanax_usage_shift");
    expect(xan).not.toBeUndefined();
    expect(xan!.comparison.currentValue).toBeCloseTo((144 - 72) / 23, 2);
    expect(xan!.comparison.baselineValue).toBeCloseTo(58 / 29, 2);
  });

  it("emits at most one insight per kind and caps the feed", () => {
    const inputs = emptyInputs();
    inputs.networthSnapshots = Array.from({ length: 30 }, (_, i) => networthField(1_000_000_000 + i * 20_000_000, NOW - (30 - i) * DAY));
    const result = deriveInsights(inputs);
    const kinds = result.insights.map((i) => i.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(result.insights.length).toBeLessThanOrEqual(INSIGHT_POLICY.MAX_INSIGHTS);
  });

  it("is deterministic for identical inputs", () => {
    const mk = (): InsightInputs => ({
      now: NOW,
      networthSnapshots: Array.from({ length: 25 }, (_, i) => networthField(1_000_000_000 + i * 10_000_000, NOW - (25 - i) * DAY)),
      moneyEvents: Array.from({ length: 40 }, (_, i) => money(NOW - (40 - i) * DAY + 3600, i < 30 ? 150_000 : 400_000, "salary", "income")),
      travelTrips: [],
      rehabEvents: [],
      xanaxCounter: [],
      trainingSessions: [],
      energyCappedHours: [],
    });
    expect(deriveInsights(mk())).toEqual(deriveInsights(mk()));
  });

  it("survives malformed rows without throwing", () => {
    const inputs = emptyInputs();
    inputs.moneyEvents = [{ id: "x", occurredAt: NaN, category: "", direction: "sideways" as never, amount: NaN }];
    inputs.networthSnapshots = [{ ...networthField(NaN, NaN) }];
    inputs.travelTrips = [{ id: "t", destination: "", departedAt: NaN, returnedAt: null, durationSeconds: null, items: [] }];
    expect(() => deriveInsights(inputs)).not.toThrow();
  });
});
