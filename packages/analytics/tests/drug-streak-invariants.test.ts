import { describe, expect, it } from "vitest";
import { buildDrugStreak } from "../src/drugs.js";

/**
 * Drug-streak invariants (2.5.1). The Drugs page juxtaposes
 * "N used (M good)" (population: in-range uses, overdoses included — a
 * used pill is consumed regardless of outcome) with "Good streak" (current
 * consecutive successful uses since the last overdose, full history to the
 * range end). These invariants pin the streak semantics so the two numbers
 * can be explained rather than accidentally equal.
 *
 * Core invariant: current streak <= total qualifying good uses, with
 * equality exactly when every good use lies in the current (unbroken) run.
 */
const DAY = 86_400;
function ev(day: number, outcome: "success" | "overdose") {
  return { occurredAt: day * DAY, outcome };
}

describe("drug streak invariants", () => {
  it("no events: zero streak, never fabricated", () => {
    const s = buildDrugStreak([]);
    expect(s.current).toBe(0);
    expect(s.longest).toBe(0);
    expect(s.currentSince).toBeNull();
    expect(s.lastUseAt).toBeNull();
  });

  it("single success: current 1, longest 1, boundaries exact", () => {
    const s = buildDrugStreak([ev(5, "success")]);
    expect(s.current).toBe(1);
    expect(s.longest).toBe(1);
    expect(s.currentSince).toBe(5 * DAY);
    expect(s.lastUseAt).toBe(5 * DAY);
    expect(s.lastOverdoseAt).toBeNull();
  });

  it("all-good history: current == total good uses (equality invariant)", () => {
    const events = Array.from({ length: 7 }, (_, i) => ev(i, "success"));
    const s = buildDrugStreak(events);
    expect(s.current).toBe(7);
    expect(s.longest).toBe(7);
    expect(s.currentSince).toBe(0);
  });

  it("good-good-bad-good: reset after overdose, current counts since it", () => {
    const s = buildDrugStreak([ev(1, "success"), ev(2, "success"), ev(3, "overdose"), ev(4, "success")]);
    expect(s.current).toBe(1);
    expect(s.longest).toBe(2);
    expect(s.currentSince).toBe(4 * DAY);
    expect(s.lastOverdoseAt).toBe(3 * DAY);
    // total good = 3 > current 1
    expect(s.current).toBeLessThan(3);
  });

  it("trailing overdose: current resets to zero even with a long prior run", () => {
    const s = buildDrugStreak([ev(1, "success"), ev(2, "success"), ev(3, "success"), ev(4, "overdose")]);
    expect(s.current).toBe(0);
    expect(s.longest).toBe(3);
    expect(s.lastOverdoseAt).toBe(4 * DAY);
  });

  it("unordered input is ordered internally (same result as sorted)", () => {
    const sorted = buildDrugStreak([ev(1, "success"), ev(2, "overdose"), ev(3, "success"), ev(4, "success")]);
    const shuffled = buildDrugStreak([ev(4, "success"), ev(1, "success"), ev(3, "success"), ev(2, "overdose")]);
    expect(shuffled).toEqual(sorted);
    expect(sorted.current).toBe(2);
  });

  it("property sweep: current <= total good, with equality iff unbroken tail", () => {
    // Exhaustive over every 6-event outcome sequence.
    const total = 6;
    for (let mask = 0; mask < 1 << total; mask++) {
      const events = Array.from({ length: total }, (_, i) => ev(i, (mask >> i) & 1 ? "overdose" : "success"));
      const s = buildDrugStreak(events);
      const good = events.filter((e) => e.outcome === "success").length;
      expect(s.current).toBeLessThanOrEqual(good);
      const lastOd = [...events].reverse().find((e) => e.outcome === "overdose");
      const tailGood = lastOd ? events.filter((e) => e.occurredAt > lastOd.occurredAt && e.outcome === "success").length : good;
      expect(s.current).toBe(tailGood);
      if (lastOd === undefined) expect(s.current).toBe(good);
    }
  });
});
