import { describe, expect, it } from "vitest";
import {
  assembleTrips,
  calculateItemProfit,
  calculateProfitPerHour,
  calculateTravelProfit,
  calculateTripEconomics,
  type TravelTripLike,
} from "../src/travel.js";

const HOUR = 3600;
const DAY = 86_400;
const T0 = Date.UTC(2026, 0, 10) / 1000;

function trip(id: string, destination: string, departedAt: number, durationSeconds: number | null, items: TravelTripLike["items"]): TravelTripLike {
  return {
    id,
    destination,
    departedAt,
    returnedAt: durationSeconds !== null ? departedAt + durationSeconds : null,
    durationSeconds,
    items,
  };
}

const plushies = (qty: number, unitCost: number, estUnit: number) => [
  { id: "i", category: "plushie", itemId: 445, itemName: "Teddy", quantity: qty, unitCost, totalCost: qty * unitCost, estimatedUnitValue: estUnit },
];

describe("calculateProfitPerHour", () => {
  it("normalizes profit to an hourly rate", () => {
    expect(calculateProfitPerHour(500, 2 * HOUR)).toBe(250);
  });
  it("returns null when duration unknown", () => {
    expect(calculateProfitPerHour(500, null)).toBeNull();
  });
});

describe("calculateItemProfit", () => {
  it("uses realized value when present", () => {
    const profit = calculateItemProfit({ id: "i", category: "plushie", itemId: 1, itemName: "x", quantity: 2, unitCost: 100, totalCost: 200, realizedTotalValue: 400 });
    expect(profit).toBe(200);
  });
  it("falls back to estimated unit value", () => {
    const profit = calculateItemProfit({ id: "i", category: "plushie", itemId: 1, itemName: "x", quantity: 2, unitCost: 100, totalCost: 200, estimatedUnitValue: 150 });
    expect(profit).toBe(100);
  });
  it("is null without price data (never guesses)", () => {
    const profit = calculateItemProfit({ id: "i", category: "plushie", itemId: 1, itemName: "x", quantity: 2, unitCost: 100, totalCost: 200 });
    expect(profit).toBeNull();
  });
});

describe("calculateTravelProfit", () => {
  it("aggregates spend, revenue, profit, per-trip and per-hour", () => {
    const trips = [
      trip("t1", "Argentina", T0, 6 * HOUR, plushies(10, 20_000, 26_000)),
      trip("t2", "Argentina", T0 + DAY, 6 * HOUR, plushies(5, 20_000, 26_000)),
    ];
    const summary = calculateTravelProfit(trips);
    expect(summary.trips).toBe(2);
    expect(summary.totalSpend).toBe(300_000);
    expect(summary.estimatedRevenue).toBe(390_000);
    expect(summary.estimatedProfit).toBe(90_000);
    expect(summary.averageProfitPerTrip).toBe(45_000);
    expect(summary.averageProfitPerHour).toBeCloseTo(7_500);
    expect(summary.provenance).toBe("estimated");
  });

  it("drops to null profit when any item lacks price data", () => {
    const trips = [
      trip("t1", "Canada", T0, HOUR, [{ id: "i", category: "other", itemId: 9, itemName: null, quantity: 1, unitCost: 10, totalCost: 10 }]),
      trip("t2", "Canada", T0 + DAY, HOUR, plushies(1, 100, 150)),
    ];
    const summary = calculateTravelProfit(trips);
    expect(summary.estimatedRevenue).toBeNull();
    expect(summary.estimatedProfit).toBeNull();
    expect(summary.totalSpend).toBe(110);
  });

  it("breaks down by destination sorted by profit", () => {
    const trips = [
      trip("t1", "Mexico", T0, HOUR, plushies(1, 100, 200)),
      trip("t2", "Japan", T0 + HOUR, HOUR, plushies(1, 100, 500)),
    ];
    const summary = calculateTravelProfit(trips);
    expect(summary.byDestination[0]!.destination).toBe("Japan");
    expect(summary.mostProfitableDestination?.destination).toBe("Japan");
  });

  it("respects the [from, to] window", () => {
    const trips = [trip("t1", "Mexico", T0, HOUR, plushies(1, 100, 200)), trip("t2", "Mexico", T0 + 10 * DAY, HOUR, plushies(1, 100, 200))];
    const summary = calculateTravelProfit(trips, T0, T0 + DAY);
    expect(summary.trips).toBe(1);
  });
});

describe("calculateTripEconomics", () => {
  it("computes per-trip economics with provenance", () => {
    const econ = calculateTripEconomics(trip("t1", "Switzerland", T0, 5 * HOUR, plushies(2, 50_000, 60_000)));
    expect(econ.spend).toBe(100_000);
    expect(econ.estimatedRevenue).toBe(120_000);
    expect(econ.estimatedProfit).toBe(20_000);
    expect(econ.profitPerHour).toBe(4_000);
    expect(econ.provenance).toBe("estimated");
  });
});

describe("assembleTrips", () => {
  it("closes trips with the matching arrival and attaches items by window", () => {
    const events = [
      { id: "d1", destination: "Argentina", departedAt: T0, arrivedAt: null, returnedAt: T0 + 6 * HOUR, status: "departed" },
      { id: "a1", destination: "Argentina", departedAt: T0 + 6 * HOUR, arrivedAt: T0 + 6 * HOUR, returnedAt: null, status: "returned" },
    ];
    const items = [
      { id: "i1", itemId: 445, itemName: "Teddy", category: "plushie", quantity: 3, unitCost: 100, totalCost: 300, occurredAt: T0 + 2 * HOUR, destination: "Argentina", estimatedUnitValue: 150 },
    ];
    const trips = assembleTrips(events, items);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.returnedAt).toBe(T0 + 6 * HOUR);
    expect(trips[0]!.items).toHaveLength(1);
    expect(trips[0]!.open).toBe(false);
  });

  it("keeps an open trip when no arrival exists yet", () => {
    const events = [{ id: "d1", destination: "Canada", departedAt: T0, arrivedAt: null, returnedAt: null, status: "departed" }];
    const trips = assembleTrips(events, []);
    expect(trips[0]!.open).toBe(true);
  });

  it("treats a self-contained row (returnedAt set) as a complete trip", () => {
    const events = [
      { id: "d1", destination: "Mexico", departedAt: T0, arrivedAt: T0 + HOUR, returnedAt: T0 + 5 * HOUR, status: "returned" },
    ];
    const items = [
      { id: "i1", itemId: 445, itemName: "Teddy", category: "plushie", quantity: 2, unitCost: 100, totalCost: 200, occurredAt: T0 + 2 * HOUR, destination: "Mexico", estimatedUnitValue: 150 },
    ];
    const trips = assembleTrips(events, items);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.returnedAt).toBe(T0 + 5 * HOUR);
    expect(trips[0]!.open).toBe(false);
    expect(trips[0]!.items).toHaveLength(1);
  });
});
