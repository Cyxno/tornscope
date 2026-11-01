import { describe, expect, it } from "vitest";
import {
  alertQuietEndSec,
  alertTrigger,
  cooldownKindsFromConfig,
  diffAlertTimers,
  diffSyncHealth,
  evaluateNetworthDrop,
  formatMoney,
  isAlertQuietNow,
  normalizeAlertConfig,
  AlertConfigError,
  networthEpisodeKey,
  parseAlertQuietHours,
  parseAlertRuleState,
  syncIncidentSignature,
  type AlertTimerState,
  type NetWorthDropConfig,
} from "../src/alerts.js";
import { localMinutesInZone } from "../src/day.js";

/**
 * Proactive-alerts pure evaluators (2.9.0): quiet-hours policy, timer
 * transition edge detection, net-worth threshold semantics and sync-health
 * diffing. Deterministic instants only — no test relies on the real clock.
 */

/* -------------------------------------------------------------------------- */
/* Quiet hours                                                                */
/* -------------------------------------------------------------------------- */

describe("parseAlertQuietHours", () => {
  it("accepts a valid window with a valid IANA timezone", () => {
    expect(parseAlertQuietHours({ start: "23:00", end: "07:00", tz: "Europe/Amsterdam" })).toEqual({
      start: "23:00",
      end: "07:00",
      tz: "Europe/Amsterdam",
    });
  });

  it("returns null for a malformed clock or a bogus timezone (fail-safe off)", () => {
    expect(parseAlertQuietHours({ start: "24:00", end: "07:00", tz: "UTC" })).toBeNull();
    expect(parseAlertQuietHours({ start: "23:00", end: "07:00", tz: "not-a-zone" })).toBeNull();
    expect(parseAlertQuietHours("quiet")).toBeNull();
    expect(parseAlertQuietHours(null)).toBeNull();
  });
});

describe("isAlertQuietNow", () => {
  const window = { start: "09:00", end: "17:00", tz: "UTC" };
  const overnight = { start: "23:00", end: "07:00", tz: "UTC" };

  const utcAt = (h: number, m = 0): number => Date.UTC(2026, 0, 15, h, m) / 1000;

  it("handles a same-day window", () => {
    expect(isAlertQuietNow(window, utcAt(10))).toBe(true);
    expect(isAlertQuietNow(window, utcAt(18))).toBe(false);
    expect(isAlertQuietNow(window, utcAt(9))).toBe(true); // inclusive start
    expect(isAlertQuietNow(window, utcAt(17))).toBe(false); // exclusive end
  });

  it("handles a midnight-crossing window", () => {
    expect(isAlertQuietNow(overnight, utcAt(23, 30))).toBe(true);
    expect(isAlertQuietNow(overnight, utcAt(3))).toBe(true);
    expect(isAlertQuietNow(overnight, utcAt(12))).toBe(false);
  });

  it("treats start == end as a FULL-DAY window (mirrors the push engine)", () => {
    const fullDay = { start: "05:00", end: "05:00", tz: "UTC" };
    expect(isAlertQuietNow(fullDay, utcAt(5))).toBe(true);
    expect(isAlertQuietNow(fullDay, utcAt(15))).toBe(true);
  });

  it("resolves the wall clock in the configured timezone, not the server's", () => {
    // Amsterdam is UTC+1 in January: 22:30 UTC is 23:30 local → quiet.
    const amsterdam = { start: "23:00", end: "07:00", tz: "Europe/Amsterdam" };
    expect(isAlertQuietNow(amsterdam, utcAt(22, 30))).toBe(true);
    expect(isAlertQuietNow(amsterdam, utcAt(21, 59))).toBe(false);
  });

  it("handles a DST transition safely (CEST is UTC+2 in summer)", () => {
    const amsterdam = { start: "23:00", end: "07:00", tz: "Europe/Amsterdam" };
    const summerUtcAt = (h: number, m = 0): number => Date.UTC(2026, 5, 15, h, m) / 1000;
    expect(isAlertQuietNow(amsterdam, summerUtcAt(21, 1))).toBe(true); // 23:01 local
    expect(isAlertQuietNow(amsterdam, summerUtcAt(20, 59))).toBe(false); // 22:59 local
  });
});

describe("alertQuietEndSec", () => {
  it("returns the next 07:00 wall-clock occurrence in the window's timezone", () => {
    const amsterdam = { start: "23:00", end: "07:00", tz: "Europe/Amsterdam" };
    // 2026-01-15 23:30 UTC = 00:30 local → end is 07:00 local (06:00 UTC).
    const end = alertQuietEndSec(amsterdam, Date.UTC(2026, 0, 15, 23, 30) / 1000);
    expect(localMinutesInZone(end, "Europe/Amsterdam")).toBe(7 * 60);
    expect(end).toBeGreaterThan(Date.UTC(2026, 0, 15, 23, 30) / 1000);
  });
});

/* -------------------------------------------------------------------------- */
/* Timer transition edge detection                                            */
/* -------------------------------------------------------------------------- */

const NOW = 1_800_000_000;
const GAP = 12 * 3600;

describe("diffAlertTimers", () => {
  const prev = { observedAt: NOW - 300, timers: { cooldownDrugEndsAt: NOW - 60 } as AlertTimerState };

  it("fires on a genuine active → ready transition", () => {
    const events = diffAlertTimers(prev, { cooldownDrugEndsAt: null }, NOW, ["cooldown_drug"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "cooldown_drug", endSec: NOW - 60 });
  });

  it("does not fire while the cooldown is still active", () => {
    const events = diffAlertTimers(prev, { cooldownDrugEndsAt: NOW + 3600 }, NOW, ["cooldown_drug"]);
    expect(events).toEqual([]);
  });

  it("honors the grace window: end ≤ now + grace still fires", () => {
    const events = diffAlertTimers(prev, { cooldownDrugEndsAt: NOW + 60 }, NOW, ["cooldown_drug"]);
    expect(events).toHaveLength(1);
  });

  it("never fires retroactively for a timer that was ALREADY expired at the previous observation", () => {
    const stalePrev = { observedAt: NOW - 300, timers: { cooldownDrugEndsAt: NOW - 1200 } as AlertTimerState };
    expect(diffAlertTimers(stalePrev, { cooldownDrugEndsAt: null }, NOW, ["cooldown_drug"])).toEqual([]);
  });

  it("re-baselines instead of fabricating a crossing across a stale gap", () => {
    const oldPrev = { observedAt: NOW - GAP - 60, timers: prev.timers };
    expect(diffAlertTimers(oldPrev, { cooldownDrugEndsAt: null }, NOW, ["cooldown_drug"], GAP)).toEqual([]);
  });

  it("fires even on a same-second re-observation when the timer genuinely flipped (push-engine parity)", () => {
    // prev observation captured the same second the cooldown cleared: the
    // active-at-previous check (not an elapsed-time minimum) is the bound.
    const sameSecond = { observedAt: NOW, timers: { cooldownDrugEndsAt: NOW + 30 } as AlertTimerState };
    const events = diffAlertTimers(sameSecond, { cooldownDrugEndsAt: null }, NOW, ["cooldown_drug"]);
    expect(events).toHaveLength(1);
    expect(events[0]!.endSec).toBe(NOW + 30);
  });

  it("detects travel / education / bank transitions with their stable identities", () => {
    const travelPrev = { observedAt: NOW - 120, timers: { travelLandsAt: NOW - 30 } as AlertTimerState };
    const events = diffAlertTimers(
      travelPrev,
      { travelLandsAt: null, educationEndsAt: null, bankMaturesAt: null },
      NOW,
      ["travel", "education", "bank"]
    );
    expect(events.map((e) => e.kind)).toEqual(["travel"]);
    expect(events[0]!.endSec).toBe(NOW - 30);
  });

  it("keeps a timer that became active and expired between observations silent (never observed active)", () => {
    // prev observation saw ready (null), current also ready → nothing.
    const readyPrev = { observedAt: NOW - 120, timers: { cooldownDrugEndsAt: null } as AlertTimerState };
    expect(diffAlertTimers(readyPrev, { cooldownDrugEndsAt: null }, NOW, ["cooldown_drug"])).toEqual([]);
  });
});

describe("cooldownKindsFromConfig", () => {
  it("defaults to all kinds and filters invalid values", () => {
    expect(cooldownKindsFromConfig({})).toEqual(["drug", "booster", "medical"]);
    expect(cooldownKindsFromConfig({ cooldowns: ["drug", "bogus"] })).toEqual(["drug"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Net-worth threshold                                                        */
/* -------------------------------------------------------------------------- */

const NW_CONFIG: NetWorthDropConfig = { pct: 5, window_hours: 24 };
const NW_NOW = 1_800_000_000;

function point(id: string, capturedAt: number, total: string) {
  return { id, capturedAt, total };
}

describe("evaluateNetworthDrop", () => {
  it("fires on a percentage drop over the window (baseline within tolerance)", () => {
    const baseline = point("snap-a", NW_NOW - 20 * 3600, "100000000");
    const current = point("snap-b", NW_NOW - 3600, "94000000");
    const result = evaluateNetworthDrop(baseline, current, NW_CONFIG, NW_NOW, null);
    expect(result.eligible).toBe(true);
    expect(result.dropPct).toBeCloseTo(6, 5);
  });

  it("rejects a baseline outside the window tolerance (no historical storms)", () => {
    const baseline = point("snap-old", NW_NOW - 24 * 3600 - 4 * 3600, "100000000");
    const current = point("snap-b", NW_NOW - 3600, "90000000");
    expect(evaluateNetworthDrop(baseline, current, NW_CONFIG, NW_NOW, null).reason).toBe("baseline_outside_window");
  });

  it("rejects a stale current snapshot", () => {
    const baseline = point("snap-a", NW_NOW - 20 * 3600, "100000000");
    const current = point("snap-b", NW_NOW - 13 * 3600, "90000000");
    expect(evaluateNetworthDrop(baseline, current, NW_CONFIG, NW_NOW, null).reason).toBe("stale_current");
  });

  it("never interprets missing or nonpositive baselines as a total loss", () => {
    const current = point("snap-b", NW_NOW - 3600, "90000000");
    expect(evaluateNetworthDrop(null, current, NW_CONFIG, NW_NOW, null).reason).toBe("missing_baseline");
    expect(evaluateNetworthDrop(point("z", NW_NOW - 3600, "0"), current, NW_CONFIG, NW_NOW, null).reason).toBe("nonpositive_baseline");
    expect(evaluateNetworthDrop(point("neg", NW_NOW - 3600, "-50"), current, NW_CONFIG, NW_NOW, null).reason).toBe("nonpositive_baseline");
    const baseline = point("snap-a", NW_NOW - 20 * 3600, "100000000");
    expect(evaluateNetworthDrop(baseline, null, NW_CONFIG, NW_NOW, null).reason).toBe("missing_current");
  });

  it("does not re-fire while the episode is open; the key is the baseline", () => {
    const baseline = point("snap-a", NW_NOW - 20 * 3600, "100000000");
    const current = point("snap-b", NW_NOW - 3600, "94000000");
    const open = evaluateNetworthDrop(baseline, current, NW_CONFIG, NW_NOW, networthEpisodeKey(baseline.id));
    expect(open.eligible).toBe(false);
    expect(open.reason).toBe("still_open_episode");
    // A different (newer) baseline starts a new episode: a full-size drop
    // from it fires even though the OLD episode is still open.
    const newBaseline = point("snap-c", NW_NOW - 5 * 3600, "100000000");
    expect(evaluateNetworthDrop(newBaseline, current, NW_CONFIG, NW_NOW, networthEpisodeKey(baseline.id)).eligible).toBe(true);
  });

  it("re-arms after recovery: a drop below threshold clears the episode", () => {
    const baseline = point("snap-a", NW_NOW - 20 * 3600, "100000000");
    const recovered = point("snap-b", NW_NOW - 3600, "99000000");
    const result = evaluateNetworthDrop(baseline, recovered, NW_CONFIG, NW_NOW, networthEpisodeKey(baseline.id));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBeUndefined(); // no open-episode lock anymore — the engine clears it
    // ...and a later drop fires again (the engine passes the CLEARED episode).
    const dropped = point("snap-c", NW_NOW - 1800, "93000000");
    expect(evaluateNetworthDrop(baseline, dropped, NW_CONFIG, NW_NOW, null).eligible).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Sync-health diffing                                                        */
/* -------------------------------------------------------------------------- */

describe("diffSyncHealth", () => {
  it("first observation is a baseline, never an alert", () => {
    expect(diffSyncHealth(null, ["money_logs"])).toEqual({ failures: [], recoveries: [] });
  });
  it("reports newly failing and recovered resources", () => {
    expect(diffSyncHealth(["money_logs"], ["money_logs", "attacks"])).toEqual({ failures: ["attacks"], recoveries: [] });
    expect(diffSyncHealth(["money_logs", "attacks"], ["money_logs"])).toEqual({ failures: [], recoveries: ["attacks"] });
    expect(diffSyncHealth(["money_logs"], ["money_logs"])).toEqual({ failures: [], recoveries: [] });
  });
  it("builds a stable incident signature", () => {
    expect(syncIncidentSignature(["b", "a"])).toBe("a,b");
    expect(syncIncidentSignature(["a", "b"])).toBe(syncIncidentSignature(["b", "a"]));
  });
});

/* -------------------------------------------------------------------------- */
/* Config normalization + rule state                                          */
/* -------------------------------------------------------------------------- */

describe("normalizeAlertConfig", () => {
  it("fills documented defaults per trigger", () => {
    expect(normalizeAlertConfig("net_worth_drop", undefined)).toEqual({ pct: 5, window_hours: 24 });
    expect(normalizeAlertConfig("net_worth_drop", { pct: 10 })).toEqual({ pct: 10, window_hours: 24 });
    expect(normalizeAlertConfig("cooldown_ready", undefined)).toEqual({});
  });

  it("rejects invalid values and unknown trigger types", () => {
    expect(() => normalizeAlertConfig("net_worth_drop", { pct: 500 })).toThrow(AlertConfigError);
    expect(() => normalizeAlertConfig("net_worth_drop", { window_hours: 0 })).toThrow(AlertConfigError);
    expect(() => normalizeAlertConfig("made_up_trigger", {})).toThrow(/unsupported trigger type/i);
    // Strict schemas reject unknown keys (typo protection).
    expect(() => normalizeAlertConfig("net_worth_drop", { pctt: 5 })).toThrow(AlertConfigError);
  });

  it("exposes the full registry with the six gameplay + two operational triggers", () => {
    expect(alertTrigger("cooldown_ready")?.group).toBe("gameplay");
    expect(alertTrigger("oc_ready")?.needsLiveFetch).toBe(false);
    expect(alertTrigger("travel_landed")?.needsLiveFetch).toBe(true);
    expect(alertTrigger("net_worth_drop")?.needsLiveFetch).toBe(false);
    expect(alertTrigger("sync_failure")?.group).toBe("operational");
    expect(alertTrigger("sync_recovery")?.group).toBe("operational");
    expect(alertTrigger("browser_push")).toBeUndefined();
  });
});

describe("parseAlertRuleState", () => {
  it("accepts a valid state and rejects junk", () => {
    expect(parseAlertRuleState({ observedAt: 123 })).toMatchObject({ observedAt: 123 });
    expect(parseAlertRuleState(null)).toBeNull();
    expect(parseAlertRuleState({ noObservedAt: true })).toBeNull();
    expect(parseAlertRuleState([1, 2])).toBeNull();
  });
});

describe("formatMoney", () => {
  it("formats bounded, human amounts", () => {
    expect(formatMoney(214_100_000)).toBe("$214.10m");
    expect(formatMoney(-1_500_000_000)).toBe("-$1.50b");
    expect(formatMoney(12_345)).toBe("$12k");
    expect(formatMoney(999)).toBe("$999");
  });
});
