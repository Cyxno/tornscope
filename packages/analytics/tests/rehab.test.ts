import { describe, expect, it } from "vitest";
import { calculateRehabStats } from "../src/rehab.js";

/**
 * Rehab contract: rehab is an EXPENSE. Costs are stored positive (money out)
 * and rendered negative by the UI; Torn's rehab logs carry no rehab percent,
 * so the percent field must stay null instead of being invented.
 */
describe("calculateRehabStats", () => {
  const from = 0;
  const to = 1_000_000;

  it("sums costs and exposes exact provenance when every visit has a cost", () => {
    const s = calculateRehabStats(
      [
        { occurredAt: 100, cost: 750_000, rehabPercent: null },
        { occurredAt: 200, cost: 1_000_000, rehabPercent: null },
      ],
      from,
      to
    );
    expect(s.trips).toBe(2);
    expect(s.totalSpend).toBe(1_750_000);
    expect(s.averageSpend).toBe(875_000);
    expect(s.latestAt).toBe(200);
    expect(s.provenance).toBe("exact");
  });

  it("keeps rehabPercent null when Torn provides none (no fake 0%)", () => {
    const s = calculateRehabStats([{ occurredAt: 100, cost: 500_000, rehabPercent: null }], from, to);
    expect(s.history[0]!.rehabPercent).toBeNull();
  });

  it("reports unknown spend as null (never a misleading $0)", () => {
    const s = calculateRehabStats([{ occurredAt: 100, cost: null, rehabPercent: null }], from, to);
    expect(s.totalSpend).toBeNull();
    expect(s.provenance).toBe("estimated");
  });

  it("is an empty confirmed zero when no visits exist", () => {
    const s = calculateRehabStats([], from, to);
    expect(s.trips).toBe(0);
    expect(s.totalSpend).toBe(0);
  });
});
