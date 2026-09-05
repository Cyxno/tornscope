import { describe, expect, it } from "vitest";
import { autoInterval, resolveDateRange } from "../src/index.js";

const NOW = Date.UTC(2026, 8, 4, 15, 30, 0) / 1000; // 2026-09-04 15:30 UTC

describe("resolveDateRange", () => {
  it("today starts at UTC midnight and ends at end of today", () => {
    const r = resolveDateRange({ preset: "today" }, NOW);
    expect(r.from).toBe(Date.UTC(2026, 8, 4) / 1000);
    expect(r.to).toBe(Date.UTC(2026, 8, 4) / 1000 + 86_399);
  });

  it("7d covers the last 7 days inclusive", () => {
    const r = resolveDateRange({ preset: "7d" }, NOW);
    expect(r.to - r.from + 1).toBe(7 * 86_400);
    expect(r.to).toBe(Date.UTC(2026, 8, 4) / 1000 + 86_399);
  });

  it("this_month starts at the first of the month", () => {
    const r = resolveDateRange({ preset: "this_month" }, NOW);
    expect(r.from).toBe(Date.UTC(2026, 8, 1) / 1000);
  });

  it("prev_month covers exactly the previous calendar month", () => {
    const r = resolveDateRange({ preset: "prev_month" }, NOW);
    expect(r.from).toBe(Date.UTC(2026, 7, 1) / 1000);
    expect(r.to).toBe(Date.UTC(2026, 8, 1) / 1000 - 1);
  });

  it("this_year starts at Jan 1", () => {
    const r = resolveDateRange({ preset: "this_year" }, NOW);
    expect(r.from).toBe(Date.UTC(2026, 0, 1) / 1000);
  });

  it("all spans from epoch", () => {
    const r = resolveDateRange({ preset: "all" }, NOW);
    expect(r.from).toBe(0);
  });

  it("custom uses explicit bounds and clamps to end of today", () => {
    const r = resolveDateRange({ preset: "custom", from: Date.UTC(2026, 0, 10) / 1000, to: Date.UTC(2027, 0, 1) / 1000 }, NOW);
    expect(r.from).toBe(Date.UTC(2026, 0, 10) / 1000);
    expect(r.to).toBe(Date.UTC(2026, 8, 4) / 1000 + 86_399);
  });
});

describe("autoInterval", () => {
  const day = 86_400;
  it("selects hour for very short ranges", () => {
    expect(autoInterval({ from: NOW, to: NOW + 2 * day })).toBe("hour");
  });
  it("selects day for weeks", () => {
    expect(autoInterval({ from: NOW, to: NOW + 30 * day })).toBe("day");
  });
  it("selects week for months", () => {
    expect(autoInterval({ from: NOW, to: NOW + 200 * day })).toBe("week");
  });
  it("selects month for years", () => {
    expect(autoInterval({ from: NOW, to: NOW + 800 * day })).toBe("month");
  });
});
