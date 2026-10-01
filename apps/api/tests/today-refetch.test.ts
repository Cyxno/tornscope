import { describe, expect, it } from "vitest";
import { shouldStartTodayRefresh } from "../src/services/today";

/**
 * F5-storm guard (2.0.7): a served persisted Today copy revalidates at most
 * once per min-spacing window per user. 10 rapid F5s must trigger at most
 * ONE upstream refresh (the rest render the cached cockpit).
 */
describe("shouldStartTodayRefresh — F5 storm gate", () => {
  it("first ever load starts a refresh", () => {
    expect(shouldStartTodayRefresh(null, 1_000_000)).toBe(true);
  });

  it("rapid reloads within the window do NOT start new refreshes", () => {
    const first = 1_000_000;
    for (const delta of [500, 2_000, 5_000, 10_000, 14_999]) {
      expect(shouldStartTodayRefresh(first, first + delta)).toBe(false);
    }
  });

  it("after the window the next revalidation is allowed (and re-arms the gate)", () => {
    const first = 1_000_000;
    expect(shouldStartTodayRefresh(first, first + 15_000)).toBe(true);
    // and the gate re-arms from the new anchor
    expect(shouldStartTodayRefresh(first + 15_000, first + 20_000)).toBe(false);
    expect(shouldStartTodayRefresh(first + 15_000, first + 30_001)).toBe(true);
  });

  it("boundary: exactly at the spacing threshold the refresh is allowed", () => {
    expect(shouldStartTodayRefresh(1_000_000, 1_015_000)).toBe(true);
    expect(shouldStartTodayRefresh(1_000_000, 1_014_999)).toBe(false);
  });
});
