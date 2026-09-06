import { describe, expect, it } from "vitest";
import { assembleTripsFromTransitionRows } from "../src/travel/assemble.js";
import { normalizeLogEntry, type NormalizeContext } from "../src/normalizers/logs.js";
import { travelDepartTorn, travelArriveAbroad, travelDepartAbroad, travelArriveTorn } from "./fixtures/logs.js";

/**
 * Trip assembly: trips are built strictly from chronological transitions —
 * a departure must always exist, and re-processing must be deterministic
 * (re-normalization idempotency).
 */

function transition(id: string, type: string, country: string | null, countryId: number | null, minutesAfterStart: number) {
  return { id, occurredAt: new Date((1_756_000_000 + minutesAfterStart * 60) * 1000), type, country, countryId };
}

describe("trip assembly from transitions", () => {
  it("assembles a complete trip from the full lifecycle", () => {
    const { trips, unmatched } = assembleTripsFromTransitionRows([
      transition("t1", "DEPARTED_TORN", "UAE", 11, 0),
      transition("t2", "ARRIVED_ABROAD", "UAE", 11, 200),
      transition("t3", "DEPARTED_ABROAD", "UAE", 11, 800),
      transition("t4", "ARRIVED_TORN", "Torn", 1, 1_000),
    ]);
    expect(unmatched).toBe(0);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ destination: "UAE", status: "completed" });
    expect(trips[0]!.returnedAt!.getTime() - trips[0]!.departedAt.getTime()).toBe(1_000 * 60 * 1_000);
  });

  it("keeps a trip in progress when the return has not happened", () => {
    const { trips } = assembleTripsFromTransitionRows([
      transition("t1", "DEPARTED_TORN", "UAE", 11, 0),
      transition("t2", "ARRIVED_ABROAD", "UAE", 11, 200),
    ]);
    expect(trips[0]).toMatchObject({ status: "in_progress", returnedAt: null });
  });

  it("closes an abandoned trip as incomplete when a new departure starts", () => {
    const { trips } = assembleTripsFromTransitionRows([
      transition("t1", "DEPARTED_TORN", "UAE", 11, 0),
      transition("t2", "DEPARTED_TORN", "Mexico", 8, 5_000),
    ]);
    expect(trips).toHaveLength(2);
    expect(trips[0]).toMatchObject({ status: "incomplete", returnedAt: null });
    // The incomplete trip's purchase window ends at the NEXT departure —
    // otherwise an old open trip would swallow every future purchase.
    expect(trips[0]!.windowEndedAt!.getTime()).toBe(trips[1]!.departedAt.getTime());
    expect(trips[1]).toMatchObject({ status: "in_progress" });
    expect(trips[1]!.windowEndedAt).toBeNull(); // genuinely still abroad
  });

  it("bounds a completed trip's window at its return", () => {
    const { trips } = assembleTripsFromTransitionRows([
      transition("t1", "DEPARTED_TORN", "UAE", 11, 0),
      transition("t2", "ARRIVED_TORN", "Torn", 1, 1_000),
    ]);
    expect(trips[0]!.windowEndedAt!.getTime()).toBe(trips[0]!.returnedAt!.getTime());
  });

  it("counts arrivals without departure evidence as unmatched (never fabricates a departure)", () => {
    const departureAt = new Date((1_756_000_000 + 20 * 60) * 1000);
    const { trips, unmatched } = assembleTripsFromTransitionRows([
      transition("t1", "ARRIVED_TORN", "Torn", 1, 10),
      transition("t2", "DEPARTED_TORN", "UAE", 11, 20),
      transition("t3", "ARRIVED_ABROAD", "UAE", 11, 30),
    ]);
    expect(unmatched).toBe(1);
    expect(trips).toHaveLength(1);
    // departedAt comes from the real departure transition — never invented.
    expect(trips[0]!.departedAt.getTime()).toBe(departureAt.getTime());
    expect(trips[0]).toMatchObject({ destination: "UAE", status: "in_progress" });
  });

  it("is deterministic across runs (renormalization idempotency)", () => {
    const transitions = [
      travelDepartTorn,
      travelArriveAbroad,
      travelDepartAbroad,
      travelArriveTorn,
      travelDepartTorn,
      travelArriveAbroad,
    ].map((log, i) => {
      const writes = normalizeLogEntry(log, { itemNameById: new Map() });
      const t = writes.travelTransitions[0]!;
      return { id: `log-${i}`, occurredAt: new Date((1_756_000_000 + i * 3_600) * 1000), type: t.type, country: t.country, countryId: t.countryId };
    });

    const run1 = assembleTripsFromTransitionRows(transitions);
    const run2 = assembleTripsFromTransitionRows([...transitions].reverse());
    expect(run2).toEqual(run1);
  });
});
