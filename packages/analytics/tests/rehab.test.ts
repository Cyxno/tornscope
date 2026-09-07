import { describe, expect, it } from "vitest";
import { calculateRehabStats, clusterRehabTrips } from "../src/rehab.js";

/**
 * Rehab contract: rehab is an EXPENSE. Costs are stored positive (money out)
 * and rendered negative by the UI; Torn's rehab logs carry no rehab percent,
 * so the percent field must stay null instead of being invented.
 * Trips are CLUSTERS of sessions (gap > 12h starts a new trip) — the raw log
 * count is "sessions", never conflated with trips.
 */
describe("calculateRehabStats", () => {
  const from = 0;
  const to = 1_000_000_000;

  it("sums costs and exposes exact provenance when every visit has a cost", () => {
    const s = calculateRehabStats(
      [
        { occurredAt: 100, cost: 750_000, rehabPercent: null },
        { occurredAt: 200, cost: 1_000_000, rehabPercent: null },
      ],
      from,
      to
    );
    expect(s.trips).toBe(1);
    expect(s.sessions).toBe(2);
    expect(s.totalSpend).toBe(1_750_000);
    expect(s.averageCostPerSession).toBe(875_000);
    expect(s.latestAt).toBe(200);
    expect(s.provenance).toBe("exact");
  });

  it("clusters consecutive sessions into trips (4-5 sessions per hospital trip)", () => {
    const H = 3600;
    const sessions = [
      { occurredAt: 0, cost: 500_000, rehabPercent: null },
      { occurredAt: H, cost: 750_000, rehabPercent: null },
      { occurredAt: 2 * H, cost: 1_000_000, rehabPercent: null },
      { occurredAt: 3 * H, cost: 1_500_000, rehabPercent: null },
      // new trip 2 days later
      { occurredAt: 48 * H, cost: 500_000, rehabPercent: null },
      { occurredAt: 49 * H, cost: 750_000, rehabPercent: null },
    ];
    const s = calculateRehabStats(sessions, 0, 100 * H);
    expect(s.trips).toBe(2);
    expect(s.sessions).toBe(6);
    expect(s.averageSessionsPerTrip).toBeCloseTo(3, 5);
    expect(s.tripClusters[0]!.cost).toBe(3_750_000);
    expect(s.averageCostPerTrip).toBe(Math.round((3_750_000 + 1_250_000) / 2));
  });

  it("a session more than 12h after the previous one starts a new trip", () => {
    const trips = clusterRehabTrips([
      { occurredAt: 0, cost: 100, rehabPercent: null },
      { occurredAt: 13 * 3600, cost: 100, rehabPercent: null },
      { occurredAt: 14 * 3600, cost: 100, rehabPercent: null },
    ]);
    expect(trips).toHaveLength(2);
    expect(trips[1]!.sessions).toBe(2);
  });

  it("keeps rehabPercent null when Torn provides none (no fake 0%)", () => {
    const s = calculateRehabStats([{ occurredAt: 100, cost: 500_000, rehabPercent: null }], 0, to);
    expect(s.history[0]!.rehabPercent).toBeNull();
  });

  it("reports unknown spend as null (never a misleading $0)", () => {
    const s = calculateRehabStats([{ occurredAt: 100, cost: null, rehabPercent: null }], 0, to);
    expect(s.totalSpend).toBeNull();
    expect(s.provenance).toBe("estimated");
  });

  it("is an empty confirmed zero when no visits exist", () => {
    const s = calculateRehabStats([], 0, to);
    expect(s.trips).toBe(0);
    expect(s.totalSpend).toBe(0);
  });
});
