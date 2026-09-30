import { describe, expect, it } from "vitest";
import type { TodayResponse } from "@tornscope/shared";
import {
  deriveHeadsUpCues,
  deriveTravelOcConflict,
  deriveUpcomingActions,
  HEADSUP_THRESHOLD_DEFAULTS,
  HEADSUP_STALE_AFTER_SECONDS,
  TRAVEL_OC_CONFLICT_POLICY,
  type UpcomingAction,
} from "../src/lib/headsup";

const HOUR = 3600;
const DAY = 86_400;
const MIN = 60;
const NOW_SEC = 1_750_000_000;
const NOW_MS = NOW_SEC * 1000;

function todayPayload(over: Partial<TodayResponse> = {}): TodayResponse {
  return {
    fetchedAt: NOW_MS,
    stale: false,
    bars: {
      energy: { current: 50, max: 100, percent: 50, fullAt: NOW_SEC + HOUR, regenState: "regenerating" },
      nerve: { current: 5, max: 10, percent: 50, fullAt: NOW_SEC + HOUR, regenState: "regenerating" },
      happy: { current: 100, max: 200, percent: 50, fullAt: NOW_SEC + HOUR, regenState: "regenerating" },
      life: null,
    },
    cooldowns: {
      drug: { kind: "drug", label: "Drug", state: "active", endsAt: NOW_SEC + 10 * MIN, remainingSeconds: 10 * MIN, provenance: "exact" },
      booster: { kind: "booster", label: "Booster", state: "active", endsAt: NOW_SEC + 8 * MIN, remainingSeconds: 8 * MIN, provenance: "exact" },
      medical: null,
    },
    travel: { state: "home", country: null, direction: null, method: null, departedAt: null, landsAt: null, remainingSeconds: null, durationSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
    hospital: null,
    jail: null,
    education: { state: "idle", completesAt: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
    bank: { state: "none", amount: null, principal: null, profit: null, returnPct: null, annualizedPct: null, durationDays: null, investedAt: null, maturesAt: null, remainingSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
    ...over,
  } as TodayResponse;
}

function cuesFor(over: Partial<TodayResponse> = {}, thresholds: Partial<typeof HEADSUP_THRESHOLD_DEFAULTS> = {}, ocs: Parameters<typeof deriveUpcomingActions>[1] = null): ReturnType<typeof deriveHeadsUpCues> {
  const upcoming = deriveUpcomingActions(todayPayload(over), ocs, NOW_SEC);
  return deriveHeadsUpCues(upcoming, { ...HEADSUP_THRESHOLD_DEFAULTS, ...thresholds }, NOW_SEC);
}

const keys = (cues: ReturnType<typeof deriveHeadsUpCues>) => cues.map((c) => c.eventKey);

describe("deriveUpcomingActions", () => {
  it("collects travel landing, cooldowns, bank, education and OC with urgency tiers", () => {
    const t = todayPayload({
      travel: { state: "traveling", country: "UAE", direction: "outbound", method: "Plane", departedAt: NOW_SEC - HOUR, landsAt: NOW_SEC + 3 * HOUR, remainingSeconds: 3 * HOUR, durationSeconds: 4 * HOUR, provenance: "exact", unavailableReason: null, requiredAccess: null },
      education: { state: "active", completesAt: NOW_SEC + 30 * MIN, remainingSeconds: 30 * MIN, courseId: 1, courseName: "Biology", categoryName: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
      bank: { state: "active", amount: 10_000_000, principal: 9_000_000, profit: 500_000, returnPct: 5.5, annualizedPct: null, durationDays: 7, investedAt: NOW_SEC - 7 * DAY, maturesAt: NOW_SEC + 8 * MIN, remainingSeconds: 8 * MIN, provenance: "exact", unavailableReason: null, requiredAccess: null },
    });
    const ocs = [{ name: "Break-in", tier: 5, status: "Recruiting", readyAt: NOW_SEC + 6 * HOUR, myParticipation: true }];
    const upcoming = deriveUpcomingActions(t, ocs, NOW_SEC);
    const types = upcoming.map((u) => u.type);
    expect(types).toContain("travel_landing");
    expect(types).toContain("drug_ready");
    expect(types).toContain("booster_ready");
    expect(types).toContain("bank_matured");
    expect(types).toContain("education_complete");
    expect(types).toContain("oc_ready");
    // Urgency sort: tier 1 travel first, tier 2 bank (8m) before drug (10m),
    // tier 3 education (30m) before oc (6h).
    expect(upcoming[0]!.type).toBe("travel_landing");
    const order = upcoming.map((u) => u.type);
    expect(order.indexOf("bank_matured")).toBeLessThan(order.indexOf("drug_ready"));
    expect(order.indexOf("education_complete")).toBeLessThan(order.indexOf("oc_ready"));
  });

  it("excludes far-future timers and never includes a duplicate type", () => {
    const t = todayPayload();
    const upcoming = deriveUpcomingActions(t, null, NOW_SEC);
    // drug 10m is within the window; booster 40m is NOT; medical absent.
    expect(upcoming.map((u) => u.type).sort()).toEqual(["booster_ready", "drug_ready"]);
  });
});

describe("deriveHeadsUpCues — travel", () => {
  const flying = (landsInSec: number): Partial<TodayResponse> => ({
    travel: { state: "traveling", country: "UAE", direction: "outbound", method: "Plane", departedAt: NOW_SEC - HOUR, landsAt: NOW_SEC + landsInSec, remainingSeconds: landsInSec, durationSeconds: 4 * HOUR, provenance: "exact", unavailableReason: null, requiredAccess: null },
  });

  it("default 2-minute threshold fires exactly once inside the window", () => {
    const cues = cuesFor(flying(90)); // 1m30s left < 2m
    expect(keys(cues)).toEqual([`travel:${NOW_SEC + 90}:2`]);
  });

  it("5 minutes does NOT fire on the default 2-minute threshold", () => {
    const cues = cuesFor(flying(5 * MIN));
    expect(cues).toEqual([]);
  });

  it("custom 5-minute threshold DOES fire at 4 minutes left", () => {
    const cues = cuesFor(flying(4 * MIN), { travel_landing: 5 });
    expect(keys(cues)).toContain(`travel:${NOW_SEC + 4 * MIN}:5`);
  });

  it("at landing (0 left) the at-cue fires — and the pre-cue is gone", () => {
    const cues = cuesFor(flying(0));
    expect(keys(cues)).toEqual([`travel:${NOW_SEC + 0}:0`]);
    expect(cues[0]!.kind).toBe("at");
  });

  it("returning works like flying for the heads-up", () => {
    const t = todayPayload({
      travel: { state: "traveling", country: "UAE", direction: "returning", method: "Plane", departedAt: NOW_SEC - 3 * HOUR, landsAt: NOW_SEC + 90, remainingSeconds: 90, durationSeconds: 4 * HOUR, provenance: "exact", unavailableReason: null, requiredAccess: null },
    });
    const cues = deriveHeadsUpCues(deriveUpcomingActions(t, null, NOW_SEC), HEADSUP_THRESHOLD_DEFAULTS, NOW_SEC);
    expect(cues[0]!.eventKey).toBe(`travel:${NOW_SEC + 90}:2`);
  });

  it("abroad without a landing time produces no travel cue", () => {
    const t = todayPayload({
      travel: { state: "abroad", country: "UAE", direction: null, method: null, departedAt: null, landsAt: null, remainingSeconds: null, durationSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
    });
    expect(cuesFor(t)).toEqual([]);
  });
});

describe("deriveHeadsUpCues — cooldowns, bank, education", () => {
  it("drug: default 2-minute threshold fires, dedupe keeps one cue per key", () => {
    const cues = cuesFor({ cooldowns: { drug: { kind: "drug", label: "Drug", state: "active", endsAt: NOW_SEC + MIN, remainingSeconds: MIN, provenance: "exact" }, booster: null, medical: null } });
    expect(keys(cues)).toEqual([`drug:${NOW_SEC + MIN}:2`]);
    // Same window re-derived → identical keys (dedupe is the caller's Set).
    const again = cuesFor({ cooldowns: { drug: { kind: "drug", label: "Drug", state: "active", endsAt: NOW_SEC + MIN, remainingSeconds: MIN, provenance: "exact" }, booster: null, medical: null } });
    expect(again.map((c) => c.eventKey)).toEqual(keys(cues));
  });

  it("drug: custom 5-minute threshold fires earlier", () => {
    const cues = cuesFor({ cooldowns: { drug: { kind: "drug", label: "Drug", state: "active", endsAt: NOW_SEC + 4 * MIN, remainingSeconds: 4 * MIN, provenance: "exact" }, booster: null, medical: null } }, { drug_ready: 5 });
    expect(keys(cues)).toContain(`drug:${NOW_SEC + 4 * MIN}:5`);
  });

  it("drug at ready (clock passed) fires the at-cue once", () => {
    const cues = cuesFor({ cooldowns: { drug: { kind: "drug", label: "Drug", state: "active", endsAt: NOW_SEC - 30, remainingSeconds: 0, provenance: "exact" }, booster: null, medical: null } });
    expect(cues.map((c) => c.kind)).toEqual(["at"]);
    expect(keys(cues)).toEqual([`drug:${NOW_SEC - 30}:0`]);
  });

  it("bank: default 10-minute threshold fires; matured stays actionable", () => {
    const soon = cuesFor({ bank: { state: "active", amount: 1, principal: 1, profit: 1, returnPct: null, annualizedPct: null, durationDays: 7, investedAt: NOW_SEC, maturesAt: NOW_SEC + 8 * MIN, remainingSeconds: 8 * MIN, provenance: "exact", unavailableReason: null, requiredAccess: null } });
    expect(soon.map((c) => c.eventKey)).toContain(`bank:${NOW_SEC + 8 * MIN}:10`);
    const matured = cuesFor({ bank: { state: "mature", amount: 1, principal: 1, profit: 1, returnPct: null, annualizedPct: null, durationDays: 7, investedAt: NOW_SEC, maturesAt: null, remainingSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null } });
    expect(matured.map((c) => c.eventKey)).toContain("bank:matured:0");
  });

  it("education: no sound/cue on defaults — visual only", () => {
    const t = todayPayload({
      education: { state: "active", completesAt: NOW_SEC + 10 * MIN, remainingSeconds: 10 * MIN, courseId: 1, courseName: null, categoryName: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
    });
    const upcoming = deriveUpcomingActions(t, null, NOW_SEC);
    const cues = deriveHeadsUpCues(upcoming, HEADSUP_THRESHOLD_DEFAULTS, NOW_SEC);
    expect(cues.filter((c) => c.type === "education_complete")).toEqual([]);
  });
});

describe("stale suppression", () => {
  it("stale payload suppresses every actionable cue (travel, drug, bank)", () => {
    const t = todayPayload({
      stale: true,
      travel: { state: "traveling", country: "UAE", direction: "outbound", method: "Plane", departedAt: NOW_SEC - HOUR, landsAt: NOW_SEC + MIN, remainingSeconds: MIN, durationSeconds: 4 * HOUR, provenance: "exact", unavailableReason: null, requiredAccess: null },
      bank: { state: "active", amount: 1, principal: 1, profit: 1, returnPct: null, annualizedPct: null, durationDays: 7, investedAt: NOW_SEC, maturesAt: NOW_SEC + 8 * MIN, remainingSeconds: 8 * MIN, provenance: "exact", unavailableReason: null, requiredAccess: null },
    });
    const upcoming = deriveUpcomingActions(t, null, NOW_SEC);
    expect(upcoming.every((u) => u.stale)).toBe(true);
    expect(deriveHeadsUpCues(upcoming, HEADSUP_THRESHOLD_DEFAULTS, NOW_SEC)).toEqual([]);
  });

  it("an old fetchedAt beyond the staleness window marks entries stale too", () => {
    const t = todayPayload();
    t.fetchedAt = (NOW_SEC - HEADSUP_STALE_AFTER_SECONDS - 600) * 1000;
    const upcoming = deriveUpcomingActions(t, null, NOW_SEC);
    expect(upcoming.every((u) => u.stale)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Travel / OC conflict                                                        */
/* -------------------------------------------------------------------------- */

const flyingToUAE = {
  travel: {
    state: "traveling" as const, country: "UAE", direction: "outbound" as const, method: "Plane",
    departedAt: NOW_SEC - HOUR, landsAt: NOW_SEC + 2 * HOUR, remainingSeconds: 2 * HOUR,
    durationSeconds: 12 * HOUR, provenance: "exact" as const, unavailableReason: null, requiredAccess: null,
  },
};

function conflictOf(over: { ocInSec?: number; landsInSec?: number; direction?: "outbound" | "returning"; durationSec?: number | null; stale?: boolean }): ReturnType<typeof deriveTravelOcConflict> {
  const landsIn = over.landsInSec ?? 2 * HOUR;
  const direction = over.direction ?? "outbound";
  return deriveTravelOcConflict({
    travel: {
      state: "traveling", country: "UAE", direction, method: "Plane", departedAt: NOW_SEC - HOUR,
      landsAt: NOW_SEC + landsIn, remainingSeconds: landsIn, durationSeconds: 12 * HOUR,
      provenance: "exact", unavailableReason: null, requiredAccess: null,
    },
    nowSec: NOW_SEC,
    ocReadyAt: over.ocInSec !== undefined ? NOW_SEC + over.ocInSec : NOW_SEC + 5 * HOUR,
    ocLabel: "OC · Break-in",
    destinationDurationSeconds: over.durationSec !== undefined ? over.durationSec : 12 * HOUR,
    stale: over.stale ?? false,
  });
}

describe("deriveTravelOcConflict", () => {
  it("outbound round trip longer than the OC window → warning with numbers", () => {
    // lands in 2h + 10m purchase + 12h return + 15m safety ≈ 14h25m > OC in 5h.
    const c = conflictOf({ ocInSec: 5 * HOUR });
    expect(c).not.toBeNull();
    expect(c!.phase).toBe("outbound");
    expect(c!.ocInMinutes).toBe(300);
    expect(c!.estimatedReturnInMinutes).toBeGreaterThan(c!.ocInMinutes);
  });

  it("plenty of time → no warning", () => {
    const c = conflictOf({ ocInSec: 30 * HOUR }); // OC in 30h ≫ round trip
    expect(c).toBeNull();
  });

  it("the safety margin decides the exact boundary", () => {
    // required ≈ 2h + 10m + 12h + 15m = 865 min. Conflict is STRICT:
    // required > ocIn → warning; equal or less → none (no false alarm at the
    // exact boundary).
    const requiredMin = 120 + 10 + 720 + 15;
    expect(conflictOf({ ocInSec: (requiredMin - 1) * MIN })?.phase).toBe("outbound");
    expect(conflictOf({ ocInSec: requiredMin * MIN })).toBeNull();
    expect(conflictOf({ ocInSec: (requiredMin + 5) * MIN })).toBeNull();
  });

  it("returning only needs the remaining flight + safety", () => {
    const c = conflictOf({ direction: "returning", landsInSec: 90 * MIN, ocInSec: 80 * MIN });
    expect(c).not.toBeNull();
    expect(c!.phase).toBe("returning");
    // Landing 10 minutes AFTER the OC starts → conflict.
    const fine = conflictOf({ direction: "returning", landsInSec: 60 * MIN, ocInSec: 80 * MIN });
    expect(fine).toBeNull();
  });

  it("stale travel data suppresses the warning", () => {
    expect(conflictOf({ ocInSec: 5 * HOUR, stale: true })).toBeNull();
  });

  it("unknown destination duration → no fake warning on outbound", () => {
    expect(conflictOf({ ocInSec: 5 * HOUR, durationSec: null })).toBeNull();
  });

  it("an OC that is already ready → no warning", () => {
    expect(conflictOf({ ocInSec: -MIN })).toBeNull();
  });

  it("pins the documented policy constants", () => {
    expect(TRAVEL_OC_CONFLICT_POLICY.PURCHASE_BUFFER_MIN).toBe(10);
    expect(TRAVEL_OC_CONFLICT_POLICY.SAFETY_BUFFER_MIN).toBe(15);
  });
});
