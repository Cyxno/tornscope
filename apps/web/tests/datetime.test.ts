import { describe, expect, it } from "vitest";
import {
  alternateTimeTooltip,
  alternateZone,
  browserTimeZone,
  chartDayLabel,
  chartHourLabel,
  displayDate,
  displayDateTime,
  displayTime,
  plural,
  type TimeDisplayMode,
} from "../src/lib/datetime.js";

/**
 * Time display contract (V1.0 QOL pass) — deterministic timezone coverage.
 *
 * Canonical storage is UTC epoch seconds; these helpers take the DISPLAY
 * zone explicitly so host/container timezone can never leak into results.
 * Coverage: UTC (Torn time), Europe/Amsterdam (DST), America/New_York,
 * Asia/Tokyo — same raw event, different wall clocks, same ordering.
 */

// 2026-03-29 19:43:30 UTC — same instant shown in every zone below.
const T = Date.UTC(2026, 2, 29, 19, 43, 30) / 1000;

const ZONES = ["UTC", "Europe/Amsterdam", "America/New_York", "Asia/Tokyo"] as const;

describe("same instant, four zones", () => {
  it("renders different wall clocks for the same event", () => {
    expect(displayTime(T, "UTC")).toBe("19:43");
    expect(displayTime(T, "Europe/Amsterdam")).toBe("21:43"); // CEST (UTC+2, after the Mar 29 switch)
    expect(displayTime(T, "America/New_York")).toBe("15:43"); // EDT (UTC−4)
    expect(displayTime(T, "Asia/Tokyo")).toBe("04:43"); // Mar 30, JST (UTC+9)
    expect(displayDate(T, "UTC")).toBe("29-03-2026");
    expect(displayDate(T, "Europe/Amsterdam")).toBe("29-03-2026");
    expect(displayDate(T, "Asia/Tokyo")).toBe("30-03-2026"); // date shifts near midnight
  });

  it("keeps chronological ordering identical across zones", () => {
    const t2 = T + 3600;
    for (const zone of ZONES) {
      const a = displayDateTime(T, zone);
      const b = displayDateTime(t2, zone);
      expect(a < b).toBe(true);
    }
  });

  it("formats the exact same string regardless of host timezone", () => {
    // The pure helpers only read the zone argument — run twice to ensure no
    // lazy host caching bleeds between calls.
    expect(displayDateTime(T, "UTC")).toBe(displayDateTime(T, "UTC"));
    expect(displayDateTime(T, "UTC")).toBe("29-03-2026 19:43");
  });
});

describe("DST — Europe/Amsterdam historical offsets", () => {
  // 2026: CET→CEST on Mar 29 01:00 UTC; CEST→CET on Oct 25 01:00 UTC.
  it("winter event renders CET (UTC+1)", () => {
    const winter = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
    expect(displayTime(winter, "Europe/Amsterdam")).toBe("13:00");
  });

  it("summer event renders CEST (UTC+2)", () => {
    const summer = Date.UTC(2026, 6, 15, 12, 0, 0) / 1000;
    expect(displayTime(summer, "Europe/Amsterdam")).toBe("14:00");
  });

  it("events on the transition day each use their own historical offset", () => {
    const before = Date.UTC(2026, 2, 29, 0, 30, 0) / 1000; // still CET
    const after = Date.UTC(2026, 2, 29, 2, 30, 0) / 1000; // already CEST
    expect(displayTime(before, "Europe/Amsterdam")).toBe("01:30");
    expect(displayTime(after, "Europe/Amsterdam")).toBe("04:30");
  });
});

describe("Torn time mode is plain UTC", () => {
  const cases: Array<[TimeDisplayMode, string]> = [
    ["torn", "UTC"],
    ["local", browserTimeZone()],
  ];
  it.each(cases)("mode %s resolves the expected display zone", (mode, zone) => {
    expect(alternateZone(mode, browserTimeZone())).toBe(zone);
  });

  it("UTC display never depends on the host timezone", () => {
    expect(displayDate(T, "UTC")).toBe("29-03-2026");
    expect(displayTime(T, "UTC")).toBe("19:43");
  });
});

describe("alternate-time tooltips", () => {
  it("local mode shows the Torn (UTC) time", () => {
    expect(alternateTimeTooltip(T, "local", "Europe/Amsterdam")).toBe("29-03-2026 19:43 Torn time (UTC)");
  });

  it("torn mode shows the local time, zone named", () => {
    expect(alternateTimeTooltip(T, "torn", "Europe/Amsterdam")).toBe("29-03-2026 21:43 local time");
  });
});

describe("chart axis labels follow the display zone", () => {
  it("compact day/hour labels", () => {
    expect(chartDayLabel(T, "UTC")).toBe("29/3");
    expect(chartDayLabel(T, "Asia/Tokyo")).toBe("30/3");
    expect(chartHourLabel(T, "Europe/Amsterdam")).toBe("21:43");
  });
});

describe("SSR safety and pluralization", () => {
  it("browserTimeZone resolves to UTC outside the browser (hydration-stable)", () => {
    // vitest runs in node: no window. The SSR path uses the same branch.
    expect(browserTimeZone()).toBe("UTC");
  });

  it("plural keeps unit names correct", () => {
    expect(plural(1, "session")).toBe("1 session");
    expect(plural(2, "session")).toBe("2 sessions");
    expect(plural(2, "Xanax", "Xanax")).toBe("2 Xanax");
  });
});
