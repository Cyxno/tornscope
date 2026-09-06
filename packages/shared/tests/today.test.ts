import { describe, expect, it } from "vitest";
import {
  buildCooldown,
  buildLiveBar,
  buildUpcomingEvents,
  detectTransitions,
  filterNewTransitions,
  formatCountdownClock,
  formatCountdownCompact,
  accessLevelName,
  remainingSeconds,
  TORN_URLS,
  type UpcomingEvent,
} from "../src/index.js";

/* -------------------------------------------------------------------------- */
/* Bars                                                                       */
/* -------------------------------------------------------------------------- */

describe("buildLiveBar", () => {
  const now = 1_792_000_000;

  it("computes percentage, remaining time and regen rate", () => {
    const bar = buildLiveBar(now, "energy", { current: 120, maximum: 150, increment: 1, interval: 300, full_time: now + 2520 });
    expect(bar.current).toBe(120);
    expect(bar.max).toBe(150);
    expect(bar.percent).toBeCloseTo(80, 1);
    expect(bar.regenState).toBe("regenerating");
    expect(bar.remainingSeconds).toBe(2520);
    // 1 unit per 300s = 12 units/hour
    expect(bar.regenPerHour).toBe(12);
  });

  it("marks full bars and drops the countdown", () => {
    const bar = buildLiveBar(now, "nerve", { current: 55, maximum: 55, increment: 1, interval: 900, full_time: 0 });
    expect(bar.regenState).toBe("full");
    expect(bar.fullAt).toBeNull();
    expect(bar.remainingSeconds).toBeNull();
  });

  it("flags paused/capped regen when full_time is 0 but the bar is not full", () => {
    const bar = buildLiveBar(now, "energy", { current: 30, maximum: 150, increment: 1, interval: 300, full_time: 0 });
    expect(bar.regenState).toBe("paused");
    expect(bar.remainingSeconds).toBeNull();
    expect(bar.fullAt).toBeNull();
  });

  it("clamps values above 100% (Torn may report current > maximum transiently)", () => {
    const bar = buildLiveBar(now, "life", { current: 4200, maximum: 4150, increment: 30, interval: 900, full_time: 0 });
    expect(bar.percent).toBeLessThanOrEqual(100);
    expect(bar.current).toBeLessThanOrEqual(bar.max);
  });

  it("keeps full times exact across timezones (pure absolute arithmetic)", () => {
    // A bar that crosses the EU DST switch (2026-10-25 03:00 CEST -> 02:00 CET).
    const dstSwitchUtc = Math.floor(Date.UTC(2026, 9, 25, 1, 0, 0) / 1000);
    const bar = buildLiveBar(dstSwitchUtc - 3600, "happy", { current: 0, maximum: 5000, increment: 60, interval: 1800, full_time: dstSwitchUtc + 3600 });
    expect(bar.remainingSeconds).toBe(7200); // independent of any timezone rules
  });

  it("treats Torn v2 full_time as seconds remaining (regenerating bars never show 0s)", () => {
    // Live-verified payload shape: energy 25/150 -> full_time 14540 (seconds).
    const bar = buildLiveBar(now, "energy", { current: 25, maximum: 150, increment: 5, interval: 600, tick_time: 140, full_time: 14540 } as never);
    expect(bar.regenState).toBe("regenerating");
    expect(bar.fullAt).toBe(now + 14540);
    expect(bar.remainingSeconds).toBe(14540);
  });
});

/* -------------------------------------------------------------------------- */
/* Cooldowns                                                                  */
/* -------------------------------------------------------------------------- */

describe("buildCooldown", () => {
  const now = 1_792_000_000;

  it("derives an absolute ready-at timestamp from seconds remaining", () => {
    const cd = buildCooldown(now, "drug", 2531);
    expect(cd.state).toBe("active");
    expect(cd.endsAt).toBe(now + 2531);
    expect(cd.remainingSeconds).toBe(2531);
  });

  it("marks ready when the remaining time is zero", () => {
    const cd = buildCooldown(now, "medical", 0);
    expect(cd.state).toBe("ready");
    expect(cd.endsAt).toBeNull();
    expect(cd.remainingSeconds).toBeNull();
  });

  it("keeps active and ready cooldowns distinct (no regen logic reuse)", () => {
    const active = buildCooldown(now, "drug", 600);
    const ready = buildCooldown(now, "booster", 0);
    expect(active.state).toBe("active");
    expect(active.remainingSeconds! > 0).toBe(true);
    expect(ready.state).toBe("ready");
    expect(ready.remainingSeconds).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Countdown math + formatting                                                */
/* -------------------------------------------------------------------------- */

describe("remainingSeconds", () => {
  it("is timezone-safe: pure arithmetic on absolute timestamps", () => {
    // Instant that falls inside a DST transition wall-clock hour; the result
    // must not depend on local offset interpretation.
    const endsAt = Math.floor(Date.UTC(2026, 2, 29, 2, 30, 0) / 1000); // EU spring-forward night
    const nowMs = Date.UTC(2026, 2, 29, 1, 0, 0);
    expect(remainingSeconds(nowMs, endsAt)).toBe(5400);
  });

  it("reaching zero clamps to 0 — the UI must show Full/Ready, never '0s left'", () => {
    expect(remainingSeconds(10_000, 5)).toBe(0);
    expect(remainingSeconds(5_000_000, 5_000)).toBe(0); // same instant
  });

  it("returns null for missing timestamps", () => {
    expect(remainingSeconds(1000, null)).toBeNull();
  });
});

describe("formatCountdownClock", () => {
  it("renders hh:mm:ss and day-prefixed variants", () => {
    expect(formatCountdownClock(2531)).toBe("00:42:11");
    expect(formatCountdownClock(8048)).toBe("02:14:08");
    expect(formatCountdownClock(2 * 86_400 + 3 * 3600 + 60)).toBe("2d 03:01:00");
  });

  it("clamps at zero", () => {
    expect(formatCountdownClock(0)).toBe("00:00:00");
    expect(formatCountdownClock(-5)).toBe("00:00:00");
    expect(formatCountdownClock(null)).toBe("00:00:00");
  });
});

describe("formatCountdownCompact", () => {
  it("matches the Today page examples", () => {
    expect(formatCountdownCompact(2520)).toBe("42m");
    expect(formatCountdownCompact(1122)).toBe("18m 42s");
    expect(formatCountdownCompact(4680)).toBe("1h 18m");
    expect(formatCountdownCompact(3 * 86_400 + 18 * 3600)).toBe("3d 18h");
    expect(formatCountdownCompact(11 * 86_400 + 7 * 3600)).toBe("11d 7h");
    expect(formatCountdownCompact(197)).toBe("3m 17s");
  });

  it("handles extremes", () => {
    expect(formatCountdownCompact(59)).toBe("59s");
    expect(formatCountdownCompact(0)).toBe("0s");
    expect(formatCountdownCompact(undefined)).toBe("0s");
  });
});

/* -------------------------------------------------------------------------- */
/* Upcoming                                                                   */
/* -------------------------------------------------------------------------- */

describe("buildUpcomingEvents", () => {
  const base: UpcomingEvent = { id: "x", category: "bar", title: "X", at: 0, remainingSeconds: 0, severity: "info" };
  const e = (id: string, at: number, category: UpcomingEvent["category"] = "bar", severity: UpcomingEvent["severity"] = "info"): UpcomingEvent => ({
    ...base,
    id,
    at,
    remainingSeconds: at - 1_792_000_000,
    category,
    severity,
  });

  it("sorts soonest first", () => {
    const list = buildUpcomingEvents([
      e("bank", 1_792_000_000 + 11 * 86_400),
      e("bar:happy", 1_792_000_000 + 1080),
      e("bar:nerve", 1_792_000_000 + 1860),
      e("travel", 1_792_000_000 + 4680),
    ]);
    expect(list.map((x) => x.id)).toEqual(["bar:happy", "bar:nerve", "travel", "bank"]);
  });

  it("drops past and invalid timestamps", () => {
    const list = buildUpcomingEvents([e("past", 5), e("invalid", Number.NaN), e("future", 1_792_000_500)]);
    expect(list.map((x) => x.id)).toEqual(["future"]);
  });

  it("keeps hospital/jail critical severity and cooldowns success", () => {
    const list = buildUpcomingEvents([
      e("status:hospital", 1_792_000_600, "status", "critical"),
      e("cooldown:drug", 1_792_000_700, "cooldown", "success"),
    ]);
    expect(list[0]?.severity).toBe("critical");
    expect(list[1]?.severity).toBe("success");
  });

  it("applies the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => e(`e${i}`, 1_792_000_000 + i * 60));
    expect(buildUpcomingEvents(many, 12)).toHaveLength(12);
  });
});

/* -------------------------------------------------------------------------- */
/* Transitions                                                                */
/* -------------------------------------------------------------------------- */

describe("detectTransitions + filterNewTransitions", () => {
  const landsAt = 1_792_005_100;
  const traveling = {
    travel: { state: "traveling" as const, landsAt, country: "Argentina" },
    education: null,
    bank: null,
    hospital: null,
    jail: null,
  };
  const home = {
    travel: { state: "home" as const, landsAt: null, country: null },
    education: null,
    bank: null,
    hospital: null,
    jail: null,
  };

  it("detects travel landing with a stable key", () => {
    const events = detectTransitions(traveling, home);
    expect(events).toHaveLength(1);
    expect(events[0]?.key).toBe(`travel:landed:${landsAt}`);
    expect(events[0]?.kind).toBe("travel_landed");
  });

  it("never re-emits the same transition (dedup by stable key)", () => {
    const first = detectTransitions(traveling, home);
    const { fresh, seenKeys } = filterNewTransitions(first, new Set());
    expect(fresh).toHaveLength(1);

    // Polling again (same data) must produce nothing new.
    const second = detectTransitions(traveling, home);
    const again = filterNewTransitions(second, seenKeys);
    expect(again.fresh).toHaveLength(0);

    // A *different* trip (different landing timestamp) is a new event.
    const nextTrip = { ...traveling, travel: { state: "traveling" as const, landsAt: landsAt + 86_400, country: "Japan" } };
    const third = filterNewTransitions(detectTransitions(nextTrip, home), again.seenKeys);
    expect(third.fresh).toHaveLength(1);
  });

  it("detects education completion, bank maturity, hospital and jail release", () => {
    const before = {
      travel: null,
      education: { state: "active" as const, completesAt: 1000, courseName: "Cognitive Psychology" },
      bank: { state: "active" as const, maturesAt: 2000 },
      hospital: { releasedAt: 3000 },
      jail: { releasedAt: 4000 },
    };
    const after = {
      travel: null,
      education: { state: "complete" as const, completesAt: 1000, courseName: "Cognitive Psychology" },
      bank: { state: "mature" as const, maturesAt: 2000 },
      hospital: null,
      jail: null,
    };
    const events = detectTransitions(before, after);
    expect(events.map((e) => e.kind).sort()).toEqual(
      ["bank_matured", "education_complete", "hospital_released", "jail_released"].sort()
    );
    // Every key is stable and unique per (kind, timestamp).
    expect(new Set(events.map((e) => e.key)).size).toBe(events.length);
  });

  it("does not report transitions when nothing changed", () => {
    expect(detectTransitions(home, home)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Access levels                                                              */
/* -------------------------------------------------------------------------- */

describe("accessLevelName", () => {
  it("maps numeric access levels to names", () => {
    expect(accessLevelName(1)).toBe("Public");
    expect(accessLevelName(2)).toBe("Minimal");
    expect(accessLevelName(3)).toBe("Limited");
    expect(accessLevelName(4)).toBe("Full");
    expect(accessLevelName(null)).toBe("unknown");
  });
});

/* -------------------------------------------------------------------------- */
/* External Torn links                                                        */
/* -------------------------------------------------------------------------- */

describe("TORN_URLS", () => {
  it("uses the live travel hub (travel.php was removed by Torn and 404s)", () => {
    expect(TORN_URLS.travel).toBe("https://www.torn.com/page.php?sid=travel");
    expect(TORN_URLS.travel).not.toContain("travel.php");
  });

  it("points cooldown cards at the inventory page where items are used", () => {
    expect(TORN_URLS.items).toBe("https://www.torn.com/item.php");
  });
});
