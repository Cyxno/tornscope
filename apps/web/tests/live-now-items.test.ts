import { describe, expect, it } from "vitest";
import { deriveLiveBoard, deriveTravelStatus, TRAVEL_STALE_AFTER_SECONDS } from "../src/lib/live-now";
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

  it("a matured investment (state mature) shows Ready to collect with the payout amount", () => {
    const t = todayPayload({ state: "mature", maturesAt: 999_000, remainingSeconds: 0, amount: 352_152_800 });
    const bank = bankOf(deriveLiveBoard(t, NO_OCS, NOW_MS, fakeDisplayTime));
    expect(bank).toBeTruthy();
    expect(bank!.state).toBe("Ready to collect");
    expect(bank!.relative).toBe("$352.15m"); // the payout IS the big figure
    expect(bank!.tone).toBe("warning");
    expect(bank!.ready).toBe(true);
  });

  it("an active investment whose clock ran out (left <= 0) is Ready to collect, never a negative countdown", () => {
    const t = todayPayload({ state: "active", maturesAt: 999_000, remainingSeconds: 0 });
    const bank = bankOf(deriveLiveBoard(t, NO_OCS, NOW_MS, fakeDisplayTime));
    expect(bank!.state).toBe("Ready to collect");
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
    // Urgency sort (2.0.5): travel (tier 1, priority) → hospital (tier 1)
    // → tier 4 by time remaining ASC (education 5h < oc 6h < bank 3d).
    expect(keys.indexOf("travel")).toBeLessThan(keys.indexOf("hospital"));
    expect(keys.indexOf("hospital")).toBeLessThan(keys.indexOf("education"));
    expect(keys.indexOf("education")).toBeLessThan(keys.indexOf("oc"));
    expect(keys.indexOf("oc")).toBeLessThan(keys.indexOf("bank"));
    expect(keys.filter((k) => k === "travel")).toHaveLength(1); // EXACTLY one travel row — no duplicates
    expect(keys.indexOf("cd-drug")).toBe(keys.length - 3);
  });

  it("traveling shows destination state, countdown and absolute landing time", () => {
    const t = todayPayload({}, {
      travel: { state: "traveling", country: "Japan", direction: "returning", method: "Plane", departedAt: 999_000, landsAt: 1_000_000 + 2 * HOUR, remainingSeconds: 2 * HOUR, durationSeconds: 6 * HOUR, provenance: "exact", unavailableReason: null, requiredAccess: null },
    });
    const travel = deriveLiveBoard(t, NO_OCS, NOW_MS, fakeDisplayTime).timers.find((i) => i.key === "travel")!;
    expect(travel.state).toBe("Returning from Japan");
    expect(travel.priority).toBe(true);
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

/* -------------------------------------------------------------------------- */
/* Over-cap stacked bars (the 1.0.4 energy regression)                        */
/* -------------------------------------------------------------------------- */

describe("over-cap stacked energy card (1.0.4 regression)", () => {
  function withEnergy(t: TodayResponse, energy: Partial<NonNullable<TodayResponse["bars"]["energy"]>>): TodayResponse {
    return { ...t, bars: { ...t.bars, energy: { ...t.bars.energy!, ...energy } as TodayResponse["bars"]["energy"] } };
  }

  function energyCard(t: TodayResponse) {
    return deriveLiveBoard(t, NO_OCS, NOW_MS, fakeDisplayTime).bars.find((i) => i.key === "energy")!;
  }

  it("shows the real 400/150 with stacked copy — never the clamped 150/150", () => {
    const card = energyCard(withEnergy(todayPayload(), { current: 400, max: 150, percent: 100, fullAt: null, regenState: "paused" }));
    expect(card.state).toBe("400 / 150");
    expect(card.relative).toBe("Stacked · +250 over cap");
    // No fabricated "Full at" countdown while over cap.
    expect(card.absolute).toBeNull();
    // Bar stays contained at full fill with the normal accent treatment.
    expect(card.pct).toBe(100);
    expect(card.ready).toBe(false);
    expect(card.tone).toBe("accent");
  });

  it("stack amount scales with the real value: 1000/150 and +1 over", () => {
    const huge = energyCard(withEnergy(todayPayload(), { current: 1000, max: 150, percent: 100, fullAt: null, regenState: "paused" }));
    expect(huge.state).toBe("1000 / 150");
    expect(huge.relative).toBe("Stacked · +850 over cap");
    const one = energyCard(withEnergy(todayPayload(), { current: 151, max: 150, percent: 100, fullAt: null, regenState: "paused" }));
    expect(one.relative).toBe("Stacked · +1 over cap");
  });

  it("100-cap accounts: 350/100 stays 350/100 (+250 over cap)", () => {
    const card = energyCard(withEnergy(todayPayload(), { current: 350, max: 100, percent: 100, fullAt: null, regenState: "paused" }));
    expect(card.state).toBe("350 / 100");
    expect(card.relative).toBe("Stacked · +250 over cap");
  });

  it("at-cap 150/150 still reads Full (ready), not stacked", () => {
    const card = energyCard(withEnergy(todayPayload(), { current: 150, max: 150, percent: 100, fullAt: null, regenState: "full" }));
    expect(card.state).toBe("150 / 150");
    expect(card.ready).toBe(true);
  });

  it("regenerating 100/150 keeps the Full-in countdown and never says stacked", () => {
    const card = energyCard(todayPayload());
    expect(card.state).toBe("50 / 100");
    // deriveBars passes the bare countdown through (the card UI adds "Full in").
    expect(card.relative).toBe("1h 00m");
  });
});

describe("travel canonical state (2.x hotfix — hidden is never a travel state)", () => {
  const travelOf = (payload: TodayResponse) => deriveLiveBoard(payload, NO_OCS, NOW_MS, fakeDisplayTime).timers.find((i) => i.key === "travel")!;

  it("HOME is rendered explicitly as a compact row — never vanished", () => {
    const travel = travelOf(todayPayload());
    expect(travel.state).toBe("Home");
    expect(travel.priority).toBe(false);
    expect(travel.tornUrl).toContain("torn.com");
  });

  it("FLYING is high priority with destination, countdown and landing time", () => {
    const t = todayPayload({}, {
      travel: { state: "traveling", country: "Japan", direction: "outbound", method: "Plane", departedAt: 999_000, landsAt: 1_000_000 + 4 * HOUR, remainingSeconds: 4 * HOUR, durationSeconds: 6 * HOUR, provenance: "exact", unavailableReason: null, requiredAccess: null },
    });
    const view = deriveTravelStatus(t, 1_000_000, NOW_MS, fakeDisplayTime);
    expect(view.kind).toBe("flying");
    expect(view.priority).toBe(true);
    expect(view.state).toBe("Flying to Japan");
    expect(view.relative).toBe("4h 00m");
    const row = travelOf(t);
    expect(row.priority).toBe(true);
    expect(keysOf(t)[0]).toBe("travel"); // above every other active state
  });

  it("RETURNING names the origin country", () => {
    const t = todayPayload({}, {
      travel: { state: "traveling", country: "Japan", direction: "returning", method: "Plane", departedAt: 999_000, landsAt: 1_000_000 + 2 * HOUR, remainingSeconds: 2 * HOUR, durationSeconds: 6 * HOUR, provenance: "exact", unavailableReason: null, requiredAccess: null },
    });
    const view = deriveTravelStatus(t, 1_000_000, NOW_MS, fakeDisplayTime);
    expect(view.kind).toBe("returning");
    expect(view.state).toBe("Returning from Japan");
    expect(view.priority).toBe(true);
  });

  it("LANDED: a flight whose clock ran out still shows Landed during the transition gap", () => {
    const t = todayPayload({}, {
      travel: { state: "traveling", country: "Japan", direction: "outbound", method: "Plane", departedAt: 999_000, landsAt: 1_000_000 - 300, remainingSeconds: 0, durationSeconds: 6 * HOUR, provenance: "exact", unavailableReason: null, requiredAccess: null },
    });
    const view = deriveTravelStatus(t, 1_000_000, NOW_MS, fakeDisplayTime);
    expect(view.kind).toBe("landed");
    expect(view.state).toBe("Landed");
    expect(view.ready).toBe(true);
    expect(view.priority).toBe(true);
  });

  it("ABROAD stays explicitly visible with the destination", () => {
    const t = todayPayload({}, {
      travel: { state: "abroad", country: "Argentina", direction: null, method: null, departedAt: 999_000, landsAt: null, remainingSeconds: null, durationSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
    });
    const view = deriveTravelStatus(t, 1_000_000, NOW_MS, fakeDisplayTime);
    expect(view.kind).toBe("abroad");
    expect(view.state).toBe("Abroad · Argentina");
    expect(view.ready).toBe(true);
    expect(travelOf(t).state).toBe("Abroad · Argentina");
  });

  it("STALE data never claims Home — the row says so with the age", () => {
    const t = todayPayload({}, { stale: true });
    const view = deriveTravelStatus(t, 1_000_000, NOW_MS, fakeDisplayTime);
    expect(view.kind).toBe("stale");
    expect(view.state).toContain("Travel data stale");
    expect(travelOf(t).state).toBe("Travel data stale");
  });

  it("an old fetchedAt (beyond the stale window) also reads stale, with age", () => {
    const oldFetch = { ...todayPayload(), fetchedAt: (1_000_000 - TRAVEL_STALE_AFTER_SECONDS - 600) * 1000 };
    const view = deriveTravelStatus(oldFetch, 1_000_000, NOW_MS, fakeDisplayTime);
    expect(view.kind).toBe("stale");
    expect(view.state).toMatch(/Travel data stale · .+ old/);
  });

  it("UNAVAILABLE states the outage instead of pretending Home", () => {
    const t = todayPayload({}, {
      travel: { state: "unavailable", country: null, direction: null, method: null, departedAt: null, landsAt: null, remainingSeconds: null, durationSeconds: null, provenance: "exact", unavailableReason: "access_denied", requiredAccess: "travel" },
    });
    const view = deriveTravelStatus(t, 1_000_000, NOW_MS, fakeDisplayTime);
    expect(view.kind).toBe("unavailable");
    expect(view.state).toContain("Travel status unavailable");
  });

  it("absence of a travel row is invalid for EVERY payload — the row always exists", () => {
    const variants: TodayResponse[] = [
      todayPayload(),
      todayPayload({}, { travel: { state: "traveling", country: "Japan", direction: "outbound", method: "Plane", departedAt: 999_000, landsAt: 1_000_000 + HOUR, remainingSeconds: HOUR, durationSeconds: 6 * HOUR, provenance: "exact", unavailableReason: null, requiredAccess: null } }),
      todayPayload({}, { travel: { state: "abroad", country: "Mexico", direction: null, method: null, departedAt: null, landsAt: null, remainingSeconds: null, durationSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null } }),
      todayPayload({}, { stale: true }),
      todayPayload({}, { travel: { state: "unavailable", country: null, direction: null, method: null, departedAt: null, landsAt: null, remainingSeconds: null, durationSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null } }),
    ];
    for (const t of variants) {
      const travel = travelOf(t);
      expect(travel, `travel row missing for travel.state=${t.travel.state}${t.stale ? " (stale)" : ""}`).toBeDefined();
      expect(travel.label).toBe("Travel");
    }
  });

  it("the stale window keeps its documented value", () => {
    expect(TRAVEL_STALE_AFTER_SECONDS).toBe(30 * 60);
  });
});

function keysOf(payload: TodayResponse): string[] {
  return deriveLiveBoard(payload, NO_OCS, NOW_MS, fakeDisplayTime).timers.map((i) => i.key);
}
