import { describe, expect, it } from "vitest";
import { dayKeyInZone, isValidDayKey, isValidTimeZone, resolveDayRange } from "../src/day.js";

/**
 * Daily Summary day-boundary semantics: a "day" is the calendar day in the
 * user's timezone. UTC profiles (the default) behave exactly like the rest
 * of the app; real timezones shift the boundaries and handle DST.
 */

const NOW = Math.floor(Date.UTC(2026, 8, 9, 12, 0, 0) / 1000); // 2026-09-09 12:00 UTC

describe("day keys", () => {
  it("validates YYYY-MM-DD keys strictly", () => {
    expect(isValidDayKey("2026-09-09")).toBe(true);
    expect(isValidDayKey("2026-02-29")).toBe(false); // not a leap year
    expect(isValidDayKey("2024-02-29")).toBe(true); // leap year
    expect(isValidDayKey("2026-13-01")).toBe(false);
    expect(isValidDayKey("2026-09")).toBe(false);
    expect(isValidDayKey("yesterday")).toBe(false);
  });

  it("detects valid IANA timezones", () => {
    expect(isValidTimeZone("Europe/Amsterdam")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });

  it("computes the calendar day of an instant in a timezone", () => {
    // 23:00 UTC is already tomorrow in Amsterdam (UTC+2 in summer).
    const t = Math.floor(Date.UTC(2026, 6, 15, 23, 0, 0) / 1000);
    expect(dayKeyInZone(t, "UTC")).toBe("2026-07-15");
    expect(dayKeyInZone(t, "Europe/Amsterdam")).toBe("2026-07-16");
    expect(dayKeyInZone(t, "America/Los_Angeles")).toBe("2026-07-15");
  });
});

describe("resolveDayRange", () => {
  it("defaults to today (UTC) with full-day bounds", () => {
    const day = resolveDayRange(undefined, "UTC", NOW);
    expect(day.dateKey).toBe("2026-09-09");
    expect(day.from).toBe(Date.UTC(2026, 8, 9) / 1000);
    expect(day.to).toBe(Date.UTC(2026, 8, 9) / 1000 + 86_399);
    expect(day.isToday).toBe(true);
    expect(day.ongoing).toBe(true);
  });

  it("resolves a specific past day as not ongoing", () => {
    const day = resolveDayRange("2026-09-08", "UTC", NOW);
    expect(day.from).toBe(Date.UTC(2026, 8, 8) / 1000);
    expect(day.to).toBe(Date.UTC(2026, 8, 8) / 1000 + 86_399);
    expect(day.isToday).toBe(false);
    expect(day.ongoing).toBe(false);
  });

  it("shifts boundaries with the timezone (Amsterdam = UTC+2 in summer)", () => {
    const day = resolveDayRange("2026-07-15", "Europe/Amsterdam", NOW);
    // Local midnight 2026-07-15 = 2026-07-14 22:00 UTC.
    expect(day.from).toBe(Date.UTC(2026, 6, 14, 22, 0, 0) / 1000);
    // Local end of day 23:59:59 = 2026-07-15 21:59:59 UTC.
    expect(day.to).toBe(Date.UTC(2026, 6, 15, 21, 59, 59) / 1000);
  });

  it("shifts the other way for America/Los_Angeles (UTC-7 in summer)", () => {
    const day = resolveDayRange("2026-07-15", "America/Los_Angeles", NOW);
    expect(day.from).toBe(Date.UTC(2026, 6, 15, 7, 0, 0) / 1000);
    expect(day.to).toBe(Date.UTC(2026, 6, 16, 6, 59, 59) / 1000);
  });

  it("handles the DST spring-forward day (Amsterdam, 23-hour day)", () => {
    // 2026-03-29: clocks jump 02:00 → 03:00 CET→CEST.
    const day = resolveDayRange("2026-03-29", "Europe/Amsterdam", NOW);
    expect(day.from).toBe(Date.UTC(2026, 2, 28, 23, 0, 0) / 1000);
    const lengthSeconds = day.to + 1 - day.from;
    expect(lengthSeconds).toBe(23 * 3600);
    expect(dayKeyInZone(day.from, "Europe/Amsterdam")).toBe("2026-03-29");
    expect(dayKeyInZone(day.to, "Europe/Amsterdam")).toBe("2026-03-29");
  });

  it("handles the DST fall-back day (Amsterdam, 25-hour day)", () => {
    // 2026-10-25: clocks fall back 03:00 → 02:00 CEST→CET.
    const decemberNow = Math.floor(Date.UTC(2026, 11, 1, 12, 0, 0) / 1000);
    const day = resolveDayRange("2026-10-25", "Europe/Amsterdam", decemberNow);
    const lengthSeconds = day.to + 1 - day.from;
    expect(lengthSeconds).toBe(25 * 3600);
    expect(dayKeyInZone(day.from, "Europe/Amsterdam")).toBe("2026-10-25");
    expect(dayKeyInZone(day.to, "Europe/Amsterdam")).toBe("2026-10-25");
  });

  it("falls back to UTC for a malformed timezone", () => {
    const day = resolveDayRange("2026-09-08", "Not/AZone", NOW);
    expect(day.from).toBe(Date.UTC(2026, 8, 8) / 1000);
  });

  it("rejects future dates", () => {
    expect(() => resolveDayRange("2026-09-10", "UTC", NOW)).toThrow("future");
    // Future in a timezone is still rejected (tomorrow exists somewhere).
    expect(() => resolveDayRange("2026-09-10", "America/Los_Angeles", NOW)).toThrow("future");
  });

  it("rejects malformed dates", () => {
    expect(() => resolveDayRange("2026-09", "UTC", NOW)).toThrow("invalid date");
    expect(() => resolveDayRange("not-a-date", "UTC", NOW)).toThrow("invalid date");
  });
});
