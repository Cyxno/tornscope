import { describe, expect, it } from "vitest";
import { buildDrugStreak, buildDrugStreaksByDrug } from "../src/drugs.js";
import { calculateRehabDeepStats } from "../src/rehab.js";
import { buildTravelOverview, type TravelOverviewTrip } from "../src/travel.js";

const T = 1_750_000_000;
const DAY = 86_400;

describe("drug streaks", () => {
  it("resets on overdose and counts the current good run", () => {
    const info = buildDrugStreak([
      { occurredAt: T, outcome: "success" },
      { occurredAt: T + 3600, outcome: "success" },
      { occurredAt: T + 7200, outcome: "overdose" },
      { occurredAt: T + 86_400, outcome: "success" },
      { occurredAt: T + 90_000, outcome: "success" },
      { occurredAt: T + 94_000, outcome: "success" },
    ]);
    expect(info.current).toBe(3);
    expect(info.currentSince).toBe(T + 86_400);
    expect(info.lastOverdoseAt).toBe(T + 7200);
    expect(info.lastUseAt).toBe(T + 94_000);
    expect(info.longest).toBe(3);
    expect(info.longestFrom).toBe(T + 86_400);
  });

  it("treats a history without overdose as one long streak", () => {
    const info = buildDrugStreak([
      { occurredAt: T, outcome: "success" },
      { occurredAt: T + 100, outcome: "success" },
    ]);
    expect(info.current).toBe(2);
    expect(info.longest).toBe(2);
    expect(info.lastOverdoseAt).toBeNull();
  });

  it("returns the zero streak for empty history (never fabricated)", () => {
    expect(buildDrugStreak([]).current).toBe(0);
    expect(buildDrugStreak([]).lastUseAt).toBeNull();
  });

  it("computes per-drug streaks independently", () => {
    const map = buildDrugStreaksByDrug([
      { occurredAt: T, outcome: "success", drugName: "Xanax" },
      { occurredAt: T + 10, outcome: "overdose", drugName: "Cannabis" },
      { occurredAt: T + 20, outcome: "success", drugName: "Xanax" },
      { occurredAt: T + 30, outcome: "success", drugName: "Xanax" },
    ]);
    expect(map.get("Xanax")?.current).toBe(3);
    expect(map.get("Cannabis")?.current).toBe(0);
    expect(map.get("Cannabis")?.lastOverdoseAt).toBe(T + 10);
  });
});

describe("rehab deep stats", () => {
  it("sums explicit addiction points and derives cost per AP only on full data", () => {
    const stats = calculateRehabDeepStats([
      { occurredAt: T, cost: 1000, addictionPointsRemoved: 10 },
      { occurredAt: T + DAY, cost: 2000, addictionPointsRemoved: 20 },
    ]);
    expect(stats.addictionPointsRemoved).toBe(30);
    expect(stats.costPerAddictionPoint).toBe(100); // 3000 / 30
    expect(stats.estimatedNextCost).toBe(1500); // median of recent costs
  });

  it("refuses cost/AP when some AP values are missing (biased ratio)", () => {
    const stats = calculateRehabDeepStats([
      { occurredAt: T, cost: 1000, addictionPointsRemoved: 10 },
      { occurredAt: T + DAY, cost: 2000, addictionPointsRemoved: null },
    ]);
    expect(stats.addictionPointsRemoved).toBe(10);
    expect(stats.costPerAddictionPoint).toBeNull();
  });

  it("stays null on missing data and empty history (no divide-by-zero)", () => {
    expect(calculateRehabDeepStats([]).addictionPointsRemoved).toBeNull();
    expect(calculateRehabDeepStats([]).estimatedNextCost).toBeNull();
    const noAp = calculateRehabDeepStats([{ occurredAt: T, cost: 500 }]);
    expect(noAp.addictionPointsRemoved).toBeNull();
    expect(noAp.estimatedNextCost).toBe(500);
  });
});

describe("travel overview", () => {
  const from = T;
  const to = T + 10 * DAY;

  function trip(overrides: Partial<TravelOverviewTrip> & { destination: string; departedAt: number }): TravelOverviewTrip {
    return { returnedAt: null, durationSeconds: null, items: [], ...overrides };
  }

  it("counts trips, sums exact flight time and groups destinations", () => {
    const trips = [
      trip({ destination: "UAE", departedAt: from + DAY, returnedAt: from + DAY + 14_400, durationSeconds: 14_400 }),
      trip({ destination: "UAE", departedAt: from + 2 * DAY, returnedAt: from + 2 * DAY + 14_400, durationSeconds: 14_400 }),
      trip({ destination: "Canada", departedAt: from + 3 * DAY, returnedAt: from + 3 * DAY + 10_800, durationSeconds: 10_800 }),
      // Open trip: counted, but contributes no flight time.
      trip({ destination: "Mexico", departedAt: from + 4 * DAY }),
    ];
    const overview = buildTravelOverview(trips, from, to);
    expect(overview.trips).toBe(4);
    expect(overview.flightTimeSeconds).toBe(14_400 * 2 + 10_800);
    expect(overview.destinationsVisited).toBe(3);
    const uae = overview.byDestination.find((d) => d.destination === "UAE")!;
    expect(uae.trips).toBe(2);
    expect(uae.averageFlightSeconds).toBe(14_400);
    expect(uae.lastVisitAt).toBe(from + 2 * DAY);
    // Open trip has no duration → average over timed trips only.
    const mexico = overview.byDestination.find((d) => d.destination === "Mexico")!;
    expect(mexico.averageFlightSeconds).toBeNull();
  });

  it("derives trips per day over the covered range", () => {
    const trips = [trip({ destination: "UAE", departedAt: from + DAY }), trip({ destination: "UAE", departedAt: from + 2 * DAY })];
    const overview = buildTravelOverview(trips, from, from + 10 * DAY);
    expect(overview.tripsPerDay.value).toBeCloseTo(0.2, 5);
    expect(overview.tripsPerDay.coveredDays).toBe(10);
  });

  it("applies range boundaries and builds the daily series", () => {
    const trips = [
      trip({ destination: "UAE", departedAt: from - 1000 }),
      trip({ destination: "UAE", departedAt: from + DAY }),
      trip({ destination: "Canada", departedAt: from + DAY + 3600 }),
    ];
    const overview = buildTravelOverview(trips, from, to);
    expect(overview.trips).toBe(2);
    expect(overview.daily).toHaveLength(1);
    expect(overview.daily[0]!.trips).toBe(2);
  });
});
