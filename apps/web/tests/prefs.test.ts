import { describe, expect, it } from "vitest";
import {
  DATE_PRESETS,
  DEFAULT_RANGE_PRESETS,
  PREF_KEYS,
  isRememberablePreset,
  parseDashboardMode,
  parseDefaultRange,
  parseFocus,
  parseRouteRanges,
  parseTimeDisplay,
} from "../src/lib/prefs.js";

/**
 * Browser-local preference storage contract (V1.0 sanity pass).
 *
 * Every parser must honor the same three rules:
 *   absent   → shipped default (first run / pre-QoL upgrade path)
 *   malformed → shipped default (garbage in storage never crashes a page)
 *   unknown  → shipped default (forward compatibility with future versions)
 */

describe("pref keys", () => {
  it("keeps the historical versioned key names (upgrade path intact)", () => {
    expect(PREF_KEYS.timeDisplay).toBe("tornscope.timeDisplay.v1");
    expect(PREF_KEYS.defaultRange).toBe("tornscope.defaultRange.v1");
    expect(PREF_KEYS.routeRanges).toBe("tornscope.routeRange.v1");
    expect(PREF_KEYS.mode).toBe("tornscope.mode.v1");
    expect(PREF_KEYS.focus).toBe("tornscope.focus.v1");
  });
});

describe("time display fallback", () => {
  it("defaults to local when absent (first run and existing-user upgrade)", () => {
    expect(parseTimeDisplay(null)).toBe("local");
    expect(parseTimeDisplay("")).toBe("local");
  });

  it("keeps an explicit torn preference", () => {
    expect(parseTimeDisplay("torn")).toBe("torn");
  });

  it("falls back to local on invalid values instead of crashing", () => {
    expect(parseTimeDisplay("utc")).toBe("local");
    expect(parseTimeDisplay("TORN")).toBe("local"); // case-sensitive contract
    expect(parseTimeDisplay('{"mode":"torn"}')).toBe("local");
    expect(parseTimeDisplay("null")).toBe("local");
  });
});

describe("default range fallback", () => {
  it("defaults to 30d when absent", () => {
    expect(parseDefaultRange(null)).toBe("30d");
  });

  it("accepts exactly the Settings-offered presets", () => {
    for (const r of DEFAULT_RANGE_PRESETS) expect(parseDefaultRange(r)).toBe(r);
  });

  it("rejects presets the Settings control does not offer", () => {
    expect(parseDefaultRange("all")).toBe("30d");
    expect(parseDefaultRange("custom")).toBe("30d");
    expect(parseDefaultRange("90")).toBe("30d");
    expect(parseDefaultRange(undefined as unknown as string)).toBe("30d");
  });
});

describe("route range map fallback", () => {
  it("empty storage means no route has memory (first visit uses Settings default)", () => {
    expect(parseRouteRanges(null)).toEqual({});
    expect(parseRouteRanges("")).toEqual({});
  });

  it("parses a well-formed map", () => {
    expect(parseRouteRanges(JSON.stringify({ "/money": "7d", "/progression": "30d" }))).toEqual({
      "/money": "7d",
      "/progression": "30d",
    });
  });

  it("drops unknown presets but keeps valid siblings", () => {
    expect(parseRouteRanges(JSON.stringify({ "/money": "7d", "/crimes": "bogus" }))).toEqual({ "/money": "7d" });
  });

  it("survives malformed JSON without throwing", () => {
    expect(parseRouteRanges("{not json")).toEqual({});
    expect(parseRouteRanges('{"broken": ')).toEqual({});
  });

  it("survives non-object JSON shapes (arrays, strings, numbers)", () => {
    expect(parseRouteRanges('["1d"]')).toEqual({});
    expect(parseRouteRanges('"7d"')).toEqual({});
    expect(parseRouteRanges("7")).toEqual({});
    expect(parseRouteRanges("null")).toEqual({});
  });

  it("drops non-string preset values", () => {
    expect(parseRouteRanges(JSON.stringify({ "/money": 7, "/combat": null }))).toEqual({});
  });

  it("recognizes exactly the range-control presets as rememberable", () => {
    for (const p of DATE_PRESETS) expect(isRememberablePreset(p.value)).toBe(true);
    expect(isRememberablePreset("custom")).toBe(false);
    expect(isRememberablePreset("today")).toBe(false);
  });
});

describe("presentation mode and focus fallback", () => {
  it("mode defaults to simple on absent/invalid", () => {
    expect(parseDashboardMode(null)).toBe("simple");
    expect(parseDashboardMode("advanced")).toBe("advanced");
    expect(parseDashboardMode("simple")).toBe("simple");
    expect(parseDashboardMode("expert")).toBe("simple");
  });

  it("focus falls back to everything on absent/invalid values", () => {
    const valid = ["everything", "wealth", "training", "combat"] as const;
    expect(parseFocus(null, valid, "everything")).toBe("everything");
    expect(parseFocus("wealth", valid, "everything")).toBe("wealth");
    expect(parseFocus("money", valid, "everything")).toBe("everything");
  });
});
