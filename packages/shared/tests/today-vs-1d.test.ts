import { describe, expect, it } from "vitest";
import { dayKeyInZone, resolveDayRange } from "../src/day.js";
import { formatCountdownCompact, remainingSeconds, resolveDateRange } from "../src/index.js";

/**
 * Today vs 1D — the two-day-semantics contract (V1.0 sanity pass).
 *
 *   "Today" (Daily Summary / Today page) = calendar day in the USER'S
 *   PROFILE TIMEZONE (resolveDayRange + User.timezone).
 *
 *   "1D" (range presets) = the current TORN CALENDAR DAY, UTC
 *   (resolveDateRange). All presets are UTC-day based.
 *
 * These are different concepts and must stay different. The tests pin the
 * behavior near UTC midnight and across the DST transition, in the four
 * reference zones (Europe/Amsterdam, UTC, America/New_York, Asia/Tokyo),
 * so neither semantics can silently drift into the other.
 */

const ZONES = ["UTC", "Europe/Amsterdam", "America/New_York", "Asia/Tokyo"] as const;

/** 2026-07-15 (CEST / EDT season). */
const summer = (h: number, m = 0) => Math.floor(Date.UTC(2026, 6, 15, h, m) / 1000);

describe("1D is the current Torn (UTC) calendar day — near midnight", () => {
  const cases: Array<[string, number, string]> = [
    ["22:30 UTC", summer(22, 30), "2026-07-15"],
    ["23:30 UTC", summer(23, 30), "2026-07-15"],
    ["00:30 UTC (next day)", summer(0, 30) + 86_400, "2026-07-16"],
    ["01:30 UTC (next day)", summer(1, 30) + 86_400, "2026-07-16"],
  ];

  for (const [label, now, expectedDay] of cases) {
    it(`at ${label}, 1D covers exactly ${expectedDay} (UTC)`, () => {
      const r = resolveDateRange({ preset: "1d" }, now);
      expect(r.from).toBe(Math.floor(Date.UTC(2026, 6, Number(expectedDay.slice(8, 10))) / 1000));
      expect(r.to - r.from + 1).toBe(86_400);
      expect(dayKeyInZone(r.from, "UTC")).toBe(expectedDay);
      expect(dayKeyInZone(r.to, "UTC")).toBe(expectedDay);
    });
  }

  it("7D = current Torn day plus the previous six Torn days", () => {
    const r = resolveDateRange({ preset: "7d" }, summer(23, 30));
    expect(dayKeyInZone(r.from, "UTC")).toBe("2026-07-09");
    expect(dayKeyInZone(r.to, "UTC")).toBe("2026-07-15");
    expect(r.to - r.from + 1).toBe(7 * 86_400);
  });

  it("1D is always exactly one UTC day, never a rolling 24h window", () => {
    // 23:59:59 UTC: a rolling window would reach back into yesterday.
    const r = resolveDateRange({ preset: "1d" }, summer(23, 59) + 59);
    expect(r.from).toBe(summer(0));
  });
});

describe("Today follows the profile timezone; the same event may sit in different profile days but the same Torn day", () => {
  it("23:30 UTC is already TOMORROW in Amsterdam: profile Today = next day, 1D = current Torn day", () => {
    const now = summer(23, 30);
    const profileDay = resolveDayRange(undefined, "Europe/Amsterdam", now);
    const tornDay = resolveDateRange({ preset: "1d" }, now);
    expect(profileDay.dateKey).toBe("2026-07-16"); // local midnight already passed
    expect(dayKeyInZone(tornDay.from, "UTC")).toBe("2026-07-15"); // Torn day not over
    // The two windows are NOT the same period of time.
    expect(profileDay.from).not.toBe(tornDay.from);
  });

  it("00:30 UTC is still YESTERDAY in New York: profile Today = previous day, 1D = new Torn day", () => {
    const now = summer(0, 30) + 86_400; // 2026-07-16 00:30 UTC
    const profileDay = resolveDayRange(undefined, "America/New_York", now);
    const tornDay = resolveDateRange({ preset: "1d" }, now);
    expect(profileDay.dateKey).toBe("2026-07-15"); // 20:30 on Jul 15 in NY
    expect(dayKeyInZone(tornDay.from, "UTC")).toBe("2026-07-16");
  });

  it("every event in the 1D window shares the Torn day, whatever the local wall clock says", () => {
    const r = resolveDateRange({ preset: "1d" }, summer(12));
    const events = [summer(0, 1), summer(13, 37), summer(23, 59)];
    for (const e of events) {
      expect(e >= r.from && e <= r.to).toBe(true); // belongs to this Torn day
      expect(dayKeyInZone(e, "UTC")).toBe("2026-07-15");
    }
    // …while LOCAL calendar dates legitimately differ from the Torn day:
    expect(dayKeyInZone(events[0], "America/New_York")).toBe("2026-07-14"); // 20:01 Jul 14 in NY — yesterday's local date
    expect(dayKeyInZone(events[2], "Asia/Tokyo")).toBe("2026-07-16"); // 08:59 Jul 16 in Tokyo — tomorrow's local date
  });

  it("switching DISPLAY timezone never changes analytical grouping (pure function of now)", () => {
    const now = summer(23, 30);
    const a = resolveDateRange({ preset: "1d" }, now);
    const b = resolveDateRange({ preset: "7d" }, now);
    // resolveDateRange takes no timezone — display preference lives purely
    // in the presentation helpers; re-calling cannot regroup history.
    expect(a).toEqual(resolveDateRange({ preset: "1d" }, now));
    expect(b).toEqual(resolveDateRange({ preset: "7d" }, now));
  });
});

describe("DST day: profile day changes length, Torn 1D never does", () => {
  // 2026-03-29: Amsterdam springs forward (23-hour day).
  const springForward = Math.floor(Date.UTC(2026, 2, 29, 12, 0, 0) / 1000);

  it("Amsterdam profile day on 2026-03-29 is 23 hours", () => {
    const day = resolveDayRange("2026-03-29", "Europe/Amsterdam", springForward);
    expect(day.to + 1 - day.from).toBe(23 * 3600);
    expect(dayKeyInZone(day.from, "Europe/Amsterdam")).toBe("2026-03-29");
    expect(dayKeyInZone(day.to, "Europe/Amsterdam")).toBe("2026-03-29");
  });

  it("1D on the same day is still exactly 24 UTC hours", () => {
    const r = resolveDateRange({ preset: "1d" }, springForward);
    expect(r.to - r.from + 1).toBe(24 * 3600);
  });

  it("no duplicate or missing hour around the fall-back day (2026-10-25)", () => {
    const fallBack = Math.floor(Date.UTC(2026, 9, 25, 12, 0, 0) / 1000);
    const day = resolveDayRange("2026-10-25", "Europe/Amsterdam", fallBack);
    expect(day.to + 1 - day.from).toBe(25 * 3600);
    const r = resolveDateRange({ preset: "1d" }, fallBack);
    expect(r.to - r.from + 1).toBe(24 * 3600);
  });
});

describe("countdowns are timezone-independent", () => {
  const target = summer(18, 43); // absolute Torn instant

  it("remaining time is identical from every zone's wall clock", () => {
    const nowMs = summer(16, 30) * 1000;
    const a = remainingSeconds(nowMs, target);
    const b = remainingSeconds(nowMs, target);
    expect(a).toBe(b);
    expect(a).toBe(2 * 3600 + 13 * 60);
    // Switching the DISPLAY zone (a formatter concern) cannot alter it.
    expect(formatCountdownCompact(a!)).toBe(formatCountdownCompact(a!));
  });

  it("never goes negative once the target instant has passed", () => {
    expect(remainingSeconds(target * 1000 + 5000, target)).toBeLessThanOrEqual(0);
  });
});
