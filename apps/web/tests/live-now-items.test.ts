import { describe, expect, it } from "vitest";
import { deriveLiveBoard } from "../src/lib/live-now";
import type { TodayResponse } from "@tornscope/shared";

/**
 * "Right now" board derivation (1.0.3 polish). Logic-level tests: the Bank
 * investment card must render for ANY active investment (the regression:
 * investments maturing beyond 7 days disappeared), ready/matured states
 * warn positively, zero/negative countdown edges never render as timers,
 * and every card — including the Medical cooldown — carries the same
 * whole-card Torn action shape.
 */

const HOUR = 3600;
const DAY = 86_400;
const fakeDisplayTime = (tsSec: number): string => `T${tsSec % 100_000}`;

function todayPayload(bank: Partial<TodayResponse["bank"]> = {}, over: Partial<TodayResponse> = {}): TodayResponse {
  return {
    fetchedAt: 1_000_000_000_000,
    player: { name: "Test", level: 10, status: { state: "okay", description: "Okay", details: null } as TodayResponse["player"]["status"],
    },
    bars: {
      energy: { current: 50, max: 100, percent: 50, fullAt: 1_000_000 + HOUR, regenState: "regenerating" },
      nerve: { current: 5, max: 10, percent: 50, fullAt: 1_000_000 + HOUR, regenState: "regenerating" },
      happy: { current: 100, max: 200, percent: 50, fullAt: 1_000_000 + HOUR, regenState: "regenerating" },
      life: null,
    },
    cooldowns: {
      drug: { state: "active", endsAt: 1_000_000 + 2 * HOUR },
      booster: { state: "ready", endsAt: null },
      medical: { state: "active", endsAt: 1_000_000 + 30 * 60 },
    },
    travel: { state: "home", country: null, direction: null, method: null, departedAt: null, landsAt: null, remainingSeconds: null, durationSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
    hospital: null,
    jail: null,
    education: { state: "idle", completesAt: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
    bank: { state: "none", amount: null, principal: null, profit: null, returnPct: null, annualizedPct: null, durationDays: null, investedAt: null, maturesAt: null, remainingSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null, ...bank },
    ...over,
  } as TodayResponse;
}

const NO_OCS = null;
const NOW_MS = 1_000_000_000;

function bankOf(board: ReturnType<typeof deriveLiveBoard>) {
  return board.timers.find((i) => i.key === "bank");
}

describe("bank investment card (the 1.0.3 regression)", () => {
  it("renders an active investment maturing far beyond 7 days", () => {
    const t = todayPayload({ state: "active", maturesAt: 1_000_000 + 21 * DAY, remainingSeconds: 21 * DAY, amount: 2_000_000 });
    const bank = bankOf(deriveLiveBoard(t, NO_OCS, NOW_MS, fakeDisplayTime));
    expect(bank).toBeTruthy();
    expect(bank!.state).toBe("Investment active");
    expect(bank!.relative).toBe("21d 0h");
    expect(bank!.absolute).toBe(fakeDisplayTime(1_000_000 + 21 * DAY));
    expect(bank!.tone).toBe("neutral");
    expect(bank!.ready).toBe(false);
  });

  it("renders an active investment with unknown maturity as Active (no timer invented)", () => {
    const t = todayPayload({ state: "active", maturesAt: null, remainingSeconds: null });
    const bank = bankOf(deriveLiveBoard(t, NO_OCS, NOW_MS, fakeDisplayTime));
    expect(bank).toBeTruthy();
    expect(bank!.state).toBe("Investment active");
    expect(bank!.relative).toBeNull();
    expect(bank!.absolute).toBeNull();
    expect(bank!.tornUrl).toBe("https://www.torn.com/bank.php");
  });

  it("renders an active investment with amount 0 — value plays no role in visibility", () => {
    const t = todayPayload({ state: "active", maturesAt: 1_000_000 + 2 * DAY, amount: 0, principal: 0, profit: 0 });
    const bank = bankOf(deriveLiveBoard(t, NO_OCS, NOW_MS, fakeDisplayTime));
    expect(bank).toBeTruthy();
    expect(bank!.state).toBe("Investment active");
  });

  it("a matured investment (state mature) warns and is ready", () => {
    const t = todayPayload({ state: "mature", maturesAt: 999_000, remainingSeconds: 0 });
    const bank = bankOf(deriveLiveBoard(t, NO_OCS, NOW_MS, fakeDisplayTime));
    expect(bank).toBeTruthy();
    expect(bank!.state).toBe("Investment matured");
    expect(bank!.tone).toBe("warning");
    expect(bank!.ready).toBe(true);
    expect(bank!.relative).toBeNull();
  });

  it("an active investment whose clock ran out (left <= 0) is matured, never a negative countdown", () => {
    const t = todayPayload({ state: "active", maturesAt: 999_000, remainingSeconds: 0 });
    const bank = bankOf(deriveLiveBoard(t, NO_OCS, NOW_MS, fakeDisplayTime));
    expect(bank!.state).toBe("Investment matured");
    expect(bank!.ready).toBe(true);
  });

  it("no investment renders nothing", () => {
    const t = todayPayload({ state: "none" });
    expect(bankOf(deriveLiveBoard(t, NO_OCS, NOW_MS, fakeDisplayTime))).toBeUndefined();
  });

  it("an unavailable bank section renders nothing", () => {
    const t = todayPayload({ state: "unavailable", unavailableReason: "missing money access" });
    expect(bankOf(deriveLiveBoard(t, NO_OCS, NOW_MS, fakeDisplayTime))).toBeUndefined();
  });
});

describe("whole-card action shape (uniformity)", () => {
  it("every timer item — including the Medical cooldown — carries the same Torn action fields", () => {
    const t = todayPayload();
    const board = deriveLiveBoard(t, NO_OCS, NOW_MS, fakeDisplayTime);
    const medical = board.timers.find((i) => i.key === "cd-medical")!;
    expect(medical).toBeTruthy();
    for (const timer of board.timers) {
      expect(timer.tornUrl).toMatch(/^https:\/\/www\.torn\.com\//);
      expect(timer.tornLabel.length).toBeGreaterThan(3);
    }
    // Cooldowns are uniform with each other: same destination shape.
    const drug = board.timers.find((i) => i.key === "cd-drug")!;
    expect(drug.tornUrl).toBe(medical.tornUrl);
    // Medical shows its countdown while active, like Drug does.
    expect(medical.relative).toBeTruthy();
    expect(drug.relative).toBeTruthy();
  });

  it("a Ready cooldown is positive/ready with no countdown", () => {
    const t = todayPayload();
    const booster = deriveLiveBoard(t, NO_OCS, NOW_MS, fakeDisplayTime).timers.find((i) => i.key === "cd-booster")!;
    expect(booster.state).toBe("Ready");
    expect(booster.ready).toBe(true);
    expect(booster.tone).toBe("positive");
    expect(booster.relative).toBeNull();
  });

  it("priority order: OC, travel, education, bank before hospital/jail before cooldowns", () => {
    const t = todayPayload(
      { state: "active", maturesAt: 1_000_000 + 3 * DAY },
      {
        hospital: { kind: "hospital" as const, reason: "Hit by a car", releasedAt: 1_000_000 + HOUR, remainingSeconds: HOUR, provenance: "exact" },
        education: { state: "active", completesAt: 1_000_000 + 5 * HOUR, remainingSeconds: 5 * HOUR, courseId: 1, courseName: null, categoryName: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
        travel: { state: "traveling", country: "Japan", direction: "outbound", method: "Plane", departedAt: 999_000, landsAt: 1_000_000 + 4 * HOUR, remainingSeconds: 4 * HOUR, durationSeconds: 6 * HOUR, provenance: "exact", unavailableReason: null, requiredAccess: null },
      }
    );
    const ocs = [{ name: "Stage Fright", tier: 8, status: "Planning", readyAt: 1_000_000 + 6 * HOUR, myParticipation: true }];
    const keys = deriveLiveBoard(t, ocs, NOW_MS, fakeDisplayTime).timers.map((i) => i.key);
    expect(keys.indexOf("oc")).toBeLessThan(keys.indexOf("travel"));
    expect(keys.indexOf("travel")).toBeLessThan(keys.indexOf("education"));
    expect(keys.indexOf("education")).toBeLessThan(keys.indexOf("bank"));
    expect(keys.indexOf("bank")).toBeLessThan(keys.indexOf("hospital"));
    expect(keys.indexOf("cd-drug")).toBe(keys.length - 3);
  });

  it("traveling shows destination state, countdown and absolute landing time", () => {
    const t = todayPayload({}, {
      travel: { state: "traveling", country: "Japan", direction: "returning", method: "Plane", departedAt: 999_000, landsAt: 1_000_000 + 2 * HOUR, remainingSeconds: 2 * HOUR, durationSeconds: 6 * HOUR, provenance: "exact", unavailableReason: null, requiredAccess: null },
    });
    const travel = deriveLiveBoard(t, NO_OCS, NOW_MS, fakeDisplayTime).timers.find((i) => i.key === "travel")!;
    expect(travel.state).toBe("Returning to Torn");
    expect(travel.relative).toBe("2h 00m");
    expect(travel.absolute).toBe(fakeDisplayTime(1_000_000 + 2 * HOUR));
    expect(travel.scopeHref).toBe("/travel");
  });

  it("bars and timers are empty without a payload", () => {
    const board = deriveLiveBoard(null, null, NOW_MS, fakeDisplayTime);
    expect(board.bars).toEqual([]);
    expect(board.timers).toEqual([]);
  });
});
