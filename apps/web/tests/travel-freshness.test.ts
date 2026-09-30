import { describe, expect, it } from "vitest";
import type { TodayResponse } from "@tornscope/shared";
import { deriveLiveBoard, deriveTravelStatus, TRAVEL_STALE_AFTER_SECONDS, LANDING_CONFIRM_GRACE_SECONDS } from "../src/lib/live-now";

/**
 * Travel freshness semantics (2.0.6 hotfix): travel freshness is
 * RESOURCE-SPECIFIC — a global payload stale flag (one failed upstream
 * refresh) can never mark travel stale, and the landing boundary gets an
 * honest "Landing…" transition instead of a stale claim or a fake Home.
 *
 * Freshness inputs: payload stale flag + fetchedAt + travel.syncedAt
 * (worker travel-resource confirmation carried in the payload).
 */

const HOUR = 3600;
const MIN = 60;
const NOW_SEC = 1_750_000_000;
const NOW_MS = NOW_SEC * 1000;
const fakeDisplayTime = (tsSec: number): string => `T${tsSec % 100_000}`;

function travelPayload(over: {
  stale?: boolean;
  fetchedAtSec?: number;
  syncedAtSec?: number | null;
  travel?: Partial<TodayResponse["travel"]>;
}): TodayResponse {
  return {
    player: { name: "Test", level: 10, status: { state: "Okay", description: "Okay", details: null } },
    bars: {
      energy: { current: 50, max: 100, percent: 50, fullAt: NOW_SEC + HOUR, regenState: "regenerating" },
      nerve: { current: 5, max: 10, percent: 50, fullAt: NOW_SEC + HOUR, regenState: "regenerating" },
      happy: { current: 100, max: 200, percent: 50, fullAt: NOW_SEC + HOUR, regenState: "regenerating" },
      life: null,
    },
    cooldowns: {
      drug: { kind: "drug", label: "Drug", state: "active", endsAt: NOW_SEC + 2 * HOUR, remainingSeconds: 2 * HOUR, provenance: "exact" },
      booster: { kind: "booster", label: "Booster", state: "ready", endsAt: null, remainingSeconds: null, provenance: "exact" },
      medical: null,
    },
    education: { state: "idle", completesAt: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
    bank: { state: "none", amount: null, principal: null, profit: null, returnPct: null, annualizedPct: null, durationDays: null, investedAt: null, maturesAt: null, remainingSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
    fetchedAt: (over.fetchedAtSec ?? NOW_SEC) * 1000,
    stale: over.stale ?? false,
    travel: {
      state: "home", country: null, direction: null, method: null, departedAt: null,
      landsAt: null, remainingSeconds: null, durationSeconds: null, provenance: "exact",
      unavailableReason: null, requiredAccess: null, syncedAt: over.syncedAtSec ?? null,
      ...over.travel,
    },
  } as unknown as TodayResponse;
}

function viewOf(payload: TodayResponse): ReturnType<typeof deriveTravelStatus> {
  return deriveTravelStatus(payload, NOW_SEC, NOW_MS, fakeDisplayTime);
}

/** The travel row as the Overview board actually renders it. */
function travelRowOf(payload: TodayResponse): { found: boolean; state: string | null; priority: boolean } {
  const row = deriveLiveBoard(payload, null, NOW_MS, fakeDisplayTime).timers.find((i) => i.key === "travel");
  return { found: row !== undefined, state: row?.state ?? null, priority: row?.priority ?? false };
}

function flyingTo(landsInSec: number, over: { stale?: boolean; fetchedAtSec?: number; syncedAtSec?: number | null } = {}): TodayResponse {
  return travelPayload({
    travel: { state: "traveling", country: "UAE", direction: "outbound", method: "Plane", departedAt: NOW_SEC - HOUR, landsAt: NOW_SEC + landsInSec, remainingSeconds: landsInSec, durationSeconds: 12 * HOUR, provenance: "exact", unavailableReason: null, requiredAccess: null, syncedAt: null },
    ...over,
  });
}

describe("travel freshness — resource-specific (CASE A/B)", () => {
  it("CASE A: global payload stale but travel synced recently → travel is NOT stale (Home stands)", () => {
    const p = travelPayload({ stale: true, syncedAtSec: NOW_SEC - 5 * MIN });
    const v = viewOf(p);
    expect(v.kind).toBe("home");
    expect(v.stale).toBe(false);
    expect(travelRowOf(p).state).toBe("Home");
  });

  it("CASE B: stale unrelated sections never suppress the explicit travel row", () => {
    const p = travelPayload({ stale: true, syncedAtSec: NOW_SEC - 2 * MIN });
    const row = travelRowOf(p);
    expect(row.found).toBe(true); // canonical: the row always renders
  });
});

describe("travel freshness — flight phases (CASE C/D/E)", () => {
  it("CASE C: flight lands in 2 minutes → Flying + countdown, priority", () => {
    const v = viewOf(flyingTo(2 * MIN));
    expect(v.kind).toBe("flying");
    expect(v.priority).toBe(true);
    expect(v.relative).toBe("2m");
    expect(v.stale).toBe(false);
  });

  it("CASE D: landsAt just passed with no fresh confirmation → Landing… (never stale, never Home)", () => {
    const p = flyingTo(-20, { stale: true, fetchedAtSec: NOW_SEC - 3 * MIN }); // copy predates landing
    const v = viewOf(p);
    expect(v.kind).toBe("landing");
    expect(v.state).toBe("Landing…");
    expect(v.priority).toBe(true);
    expect(v.stale).toBe(false);
    const row = travelRowOf(p);
    expect(row.found).toBe(true);
    expect(row.state).toBe("Landing…");
  });

  it("CASE E: a fresh post-landing payload confirms the real state (abroad)", () => {
    const p = travelPayload({
      travel: { state: "abroad", country: "Argentina", direction: null, method: "Plane", departedAt: NOW_SEC - 3 * HOUR, landsAt: null, remainingSeconds: null, durationSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null, syncedAt: NOW_SEC - 10 },
    });
    const v = viewOf(p);
    expect(v.kind).toBe("abroad");
    expect(v.state).toBe("Abroad · Argentina");
    expect(v.stale).toBe(false);
  });

  it("a fresh live payload still saying traveling after landsAt is trusted (flight state confirmed)", () => {
    // fetched AFTER the recorded landing and Torn still reports traveling —
    // trust the fresh read (flight extended), never downgrade to stale.
    const p = flyingTo(-20, { fetchedAtSec: NOW_SEC - 10 });
    const v = viewOf(p);
    expect(v.kind).toBe("flying");
    expect(v.stale).toBe(false);
  });
});

describe("travel freshness — real staleness (CASE F)", () => {
  it("CASE F: landing unconfirmed beyond the grace window → honestly stale, with landing age", () => {
    const p = flyingTo(-10 * MIN, { stale: true, fetchedAtSec: NOW_SEC - 12 * MIN });
    const v = viewOf(p);
    expect(v.kind).toBe("stale");
    expect(v.state).toContain("Travel data stale");
    expect(v.state).toContain("since landing");
    const row = travelRowOf(p);
    expect(row.state).toContain("Travel data stale");
  });

  it("home on a payload with no travel confirmation for days → stale, never fake Home", () => {
    const p = travelPayload({ stale: true, fetchedAtSec: NOW_SEC - 2 * 86_400, syncedAtSec: NOW_SEC - 2 * 86_400 });
    const v = viewOf(p);
    expect(v.kind).toBe("stale");
  });

  it("UNAVAILABLE section states the outage regardless of freshness", () => {
    const p = travelPayload({
      travel: { state: "unavailable", country: null, direction: null, method: null, departedAt: null, landsAt: null, remainingSeconds: null, durationSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: "Minimal", syncedAt: NOW_SEC },
    });
    expect(viewOf(p).kind).toBe("unavailable");
  });

  it("grace + stale windows keep their documented values", () => {
    expect(LANDING_CONFIRM_GRACE_SECONDS).toBe(5 * MIN);
    expect(TRAVEL_STALE_AFTER_SECONDS).toBe(30 * MIN);
  });
});
