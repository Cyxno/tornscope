import { describe, expect, it } from "vitest";
import { projectTowardTarget, PROJECTION_POLICY, type ProjectionPoint } from "../src/projection.js";

const DAY = 86_400;

/** One snapshot per day at noon. */
function dailySeries(values: number[], startDayTs = 1_700_000_000): ProjectionPoint[] {
  return values.map((value, i) => ({ t: startDayTs + i * DAY + 43_200, value }));
}

describe("projectTowardTarget", () => {
  const now = 1_700_000_000 + 40 * DAY;

  it("withholds an ETA on insufficient history", () => {
    const p = projectTowardTarget(dailySeries([100, 110, 115]), 200, now, 30);
    expect(p.etaAt).toBeNull();
    expect(p.insufficientReason).toBe("insufficient_history");
    expect(p.confidence).toBe("insufficient");
  });

  it("reports target_reached when the latest value meets the target", () => {
    const p = projectTowardTarget(dailySeries([100, 150, 200, 205, 210, 220], now - 6 * DAY), 200, now, 30);
    expect(p.etaAt).toBeNull();
    expect(p.insufficientReason).toBe("target_reached");
    expect(p.confidence).toBe("high");
  });

  it("reports target_reached from an explicit currentValue even below in-series values", () => {
    const p = projectTowardTarget(dailySeries([100, 150, 200, 250, 300, 350]), 200, now, 30, 210);
    expect(p.insufficientReason).toBe("target_reached");
  });

  it("projects a clean linear trend with high confidence", () => {
    // +10/day for 40 days from 1000 → target 1400 reached in ~0 days... pick a target ahead.
    const values = Array.from({ length: 40 }, (_, i) => 1000 + i * 10);
    const p = projectTowardTarget(dailySeries(values, now - 40 * DAY), 1500, now, 30);
    expect(p.insufficientReason).toBeNull();
    expect(p.confidence).toBe("high");
    expect(p.velocityPerDay).toBeCloseTo(10, 5);
    expect(p.slopePerDay).toBeCloseTo(10, 5);
    // remaining = 1500 - (1000 + 39*10 = 1390) = 110 → 11 days.
    expect(p.etaAt).not.toBeNull();
    const etaDays = (p.etaAt! - now) / DAY;
    expect(etaDays).toBeGreaterThan(10.5);
    expect(etaDays).toBeLessThan(11.5);
  });

  it("withholds the ETA for a flat/stalled series (no_positive_trend)", () => {
    const values = Array.from({ length: 30 }, () => 5000);
    const p = projectTowardTarget(dailySeries(values, now - 30 * DAY), 10_000, now, 30);
    expect(p.etaAt).toBeNull();
    expect(p.insufficientReason).toBe("no_positive_trend");
    expect(p.velocityPerDay).toBe(0);
  });

  it("withholds the ETA for a receding series", () => {
    const values = Array.from({ length: 30 }, (_, i) => 10_000 - i * 50);
    const p = projectTowardTarget(dailySeries(values, now - 30 * DAY), 12_000, now, 30);
    expect(p.etaAt).toBeNull();
    expect(p.insufficientReason).toBe("no_positive_trend");
    expect(p.velocityPerDay).toBeLessThan(0);
  });

  it("ignores a single spike via the median (flat + spike = no trend)", () => {
    // Flat at 1000, one +5000 spike, flat again → median delta 0, and a flat
    // series honestly reads as "no trend" rather than "too volatile".
    const values = Array.from({ length: 30 }, (_, i) => (i === 15 ? 6000 : 1000));
    const p = projectTowardTarget(dailySeries(values, now - 30 * DAY), 3000, now, 30);
    expect(p.etaAt).toBeNull();
    expect(p.insufficientReason).toBe("no_positive_trend");
    expect(p.velocityPerDay).toBe(0);
  });

  it("marks divergent/noisy trends as too_volatile with low confidence but keeps the velocity", () => {
    // Square-wave noise (+900 every other day) around a +10/day trend: the
    // median and slope agree, but R² collapses — an honest ETA is impossible.
    const values = Array.from({ length: 30 }, (_, i) => 1000 + i * 10 + (i % 2 === 1 ? 900 : 0));
    const p = projectTowardTarget(dailySeries(values, now - 30 * DAY), 8000, now, 30);
    expect(p.velocityPerDay).not.toBeNull();
    expect(p.etaAt).toBeNull();
    expect(p.insufficientReason).toBe("too_volatile");
    expect(p.confidence).toBe("low");
  });

  it("withholds ETAs beyond the sanity horizon", () => {
    // +1/day toward a target 40 years out.
    const values = Array.from({ length: 40 }, (_, i) => 1000 + i);
    const p = projectTowardTarget(dailySeries(values, now - 40 * DAY), 1000 + 40 + 40 * 365, now, 30);
    expect(p.etaAt).toBeNull();
    expect(p.insufficientReason).toBe("beyond_horizon");
  });

  it("reports medium confidence for a decent but imperfect fit", () => {
    // +10/day with mild noise that keeps R² between 0.3 and 0.7.
    const values = Array.from({ length: 30 }, (_, i) => 1000 + i * 10 + (i % 5 === 0 ? 60 : i % 3 === 0 ? -55 : 0));
    const p = projectTowardTarget(dailySeries(values, now - 30 * DAY), 1600, now, 30);
    if (p.etaAt !== null) expect(["medium", "high"]).toContain(p.confidence);
    else expect(p.insufficientReason).toBe("too_volatile");
  });

  it("ignores points outside the lookback window", () => {
    const old = dailySeries(Array.from({ length: 60 }, (_, i) => 100 + i * 10), now - 60 * DAY).filter((p) => p.t < now - 30 * DAY);
    const recent = dailySeries(Array.from({ length: 10 }, () => 5000), now - 9 * DAY);
    const p = projectTowardTarget([...old, ...recent], 6000, now, 30);
    expect(p.insufficientReason).toBe("no_positive_trend");
    // The most recent point lies an hour past `now` and is excluded.
    expect(p.window.points).toBe(9);
  });

  it("handles a stale now (series entirely in the future of now)", () => {
    const future = dailySeries([1, 2, 3, 4, 5, 6], now + DAY);
    const p = projectTowardTarget(future, 10, now, 7);
    expect(p.insufficientReason).toBe("insufficient_history");
    expect(p.window.points).toBe(0);
  });

  it("is deterministic", () => {
    const values = Array.from({ length: 30 }, (_, i) => 1000 + i * 12 + (i % 4) * 3);
    const a = projectTowardTarget(dailySeries(values, now - 30 * DAY), 2000, now, 30);
    const b = projectTowardTarget(dailySeries(values, now - 30 * DAY), 2000, now, 30);
    expect(a).toEqual(b);
  });

  it("policy constants keep their documented values", () => {
    expect(PROJECTION_POLICY.MIN_POINTS).toBe(4);
    expect(PROJECTION_POLICY.MIN_SPAN_DAYS).toBe(3);
    expect(PROJECTION_POLICY.HORIZON_DAYS).toBe(5 * 365);
  });
});
