import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { barFullDisplay, barFillPct } from "../src/lib/live";
import { deriveLiveBoard } from "../src/lib/live-now";
import {
  loadCockpitSnapshot,
  shouldSkipTodayRequest,
  snapshotAgeMs,
  type CockpitSnapshot,
} from "../src/lib/cockpit-cache";
import type { TodayResponse } from "@tornscope/shared";

/**
 * 2.6.2 live-state invariants (production bug: Overview showed Energy
 * "25 / 150 — Full · 100%", Nerve "1 / 49 — Full", travel stale for hours).
 *
 * Root cause chain proven here, link by link:
 *  1. a cockpit snapshot re-saved with a fresh storage timestamp kept an old
 *     `today` payload "fresh" forever → /api/today never revalidated;
 *  2. on that aging payload every bar's fullAt boundary eventually passed,
 *     and an expired fullAt promoted the bar to "Full" (100%) next to the
 *     stale current/max — current < max can never honestly be Full.
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const NOW_MS = 1_750_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function bar(over: Partial<Parameters<typeof barFullDisplay>[0]> = {}): { current: number; max: number; fullAt: number | null; regenState: string } {
  return { current: 25, max: 150, fullAt: null, regenState: "paused", ...over };
}

describe("invariant: current < max ⇒ never Full", () => {
  it("production case 25/150 — corrupt cached regenState 'full' is not believed", () => {
    const d = barFullDisplay(bar({ current: 25, max: 150, fullAt: null, regenState: "full" }), NOW_MS);
    expect(d!.full).toBe(false);
    expect(d!.text).not.toBe("Full");
  });

  it("production case 1/49 — expired fullAt never fabricates Full", () => {
    const d = barFullDisplay(bar({ current: 1, max: 49, regenState: "regenerating", fullAt: NOW_SEC - 3600 }), NOW_MS);
    expect(d!.full).toBe(false);
    expect(d!.text).not.toBe("Full");
    expect(d!.remainingSeconds).toBeNull();
    expect(d!.boundaryPassed).toBe(true); // stale snapshot marker, honestly rendered
  });

  it("production case 4911/5025 — genuinely regenerating bar counts down with derived fill", () => {
    const d = barFullDisplay(bar({ current: 4911, max: 5025, regenState: "regenerating", fullAt: NOW_SEC + 600 }), NOW_MS);
    expect(d!.full).toBe(false);
    expect(d!.text).toBe("Full in 10m");
    expect(d!.pct).toBeCloseTo((4911 / 5025) * 100, 1);
  });

  it("production case 170/1732 — low bar stays low", () => {
    const d = barFullDisplay(bar({ current: 170, max: 1732, regenState: "regenerating", fullAt: NOW_SEC + 7200 }), NOW_MS);
    expect(d!.full).toBe(false);
    expect(d!.pct).toBeCloseTo((170 / 1732) * 100, 1);
    expect(d!.pct).toBeLessThan(10);
  });

  it("current === max IS Full (regenState agrees or not — the numbers rule)", () => {
    expect(barFullDisplay(bar({ current: 150, max: 150, regenState: "full" }), NOW_MS)!.full).toBe(true);
    expect(barFullDisplay(bar({ current: 150, max: 150, regenState: "regenerating", fullAt: NOW_SEC + 5 }), NOW_MS)!.full).toBe(true);
  });

  it("stacked (400/150) keeps its real numbers, never Full", () => {
    const d = barFullDisplay(bar({ current: 400, max: 150 }), NOW_MS);
    expect(d!.overCap).toBe(true);
    expect(d!.full).toBe(false);
    expect(d!.text).toContain("+250 over cap");
  });
});

describe("invariant: percent derived from current/max, cached percent never trusted", () => {
  it("barFillPct ignores a cached 100% on a quarter-full bar", () => {
    expect(barFillPct({ current: 25, max: 150 })).toBeCloseTo(16.67, 1);
    expect(barFillPct({ current: 1, max: 49 })).toBeCloseTo(2.04, 1);
    expect(barFillPct({ current: 0, max: 0 })).toBe(0);
  });

  it("Overview bar rows use the derived fill, not the payload percent field", () => {
    const liveNow = read("../src/lib/live-now.ts");
    expect(liveNow).toContain("barFillPct(bar)");
    expect(liveNow).not.toMatch(/pct:[^\n]*bar\.percent/);
  });
});

describe("invariant: Overview == Today for the same payload", () => {
  it("Today delegates to the same canonical derivation as Overview", () => {
    const today = read("../src/routes/today/+page.svelte");
    expect(today).toContain("barFullDisplay(bar, serverNowMs)");
    // No parallel full-decision logic may remain: Today must not decide
    // Full from regenState or an elapsed fullAt by itself.
    expect(today).not.toMatch(/regenState\s*===\s*"full"/);
    expect(today).not.toMatch(/left\s*<=\s*0[^\n]*Full/);
  });

  it("same stale payload → Overview bars carry no 'Full' state and Today shows the revalidate note", () => {
    const staleBars = {
      energy: { key: "energy", label: "Energy", current: 25, max: 150, percent: 100, overCap: 0, increment: 1, intervalSeconds: 60, fullAt: NOW_SEC - 7200, remainingSeconds: 0, regenPerHour: 60, regenState: "regenerating", provenance: "exact" },
      nerve: { key: "nerve", label: "Nerve", current: 1, max: 49, percent: 100, overCap: 0, increment: 1, intervalSeconds: 90, fullAt: NOW_SEC - 600, remainingSeconds: 0, regenPerHour: 40, regenState: "full", provenance: "exact" },
      happy: { key: "happy", label: "Happy", current: 4911, max: 5025, percent: 97.7, overCap: 0, increment: 3, intervalSeconds: 90, fullAt: NOW_SEC + 600, remainingSeconds: 600, regenPerHour: 120, regenState: "regenerating", provenance: "exact" },
      life: { key: "life", label: "Life", current: 170, max: 1732, percent: 9.8, overCap: 0, increment: 42, intervalSeconds: 300, fullAt: NOW_SEC + 86_400, remainingSeconds: 86_400, regenPerHour: 504, regenState: "regenerating", provenance: "exact" },
    } as TodayResponse["bars"];
    const today = {
      fetchedAt: NOW_MS - 3 * 3600_000,
      serverTime: NOW_SEC - 3 * 3600,
      demo: false,
      player: { name: "P", level: 10, status: { state: "Okay", description: null, details: null, until: null } },
      bars: staleBars,
      cooldowns: { drug: null, booster: null, medical: null },
      travel: { state: "home", country: null, direction: null, method: null, departedAt: null, landsAt: null, remainingSeconds: null, durationSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
      bank: { state: "none", amount: null, principal: null, profit: null, returnPct: null, annualizedPct: null, durationDays: null, investedAt: null, maturesAt: null, remainingSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
      education: { state: "none", courseId: null, courseName: null, categoryName: null, completesAt: null, remainingSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
      hospital: null,
      jail: null,
      upcoming: [],
      access: { level: null, type: "full", note: null },
    } as unknown as TodayResponse;

    const board = deriveLiveBoard(today, null, NOW_MS, () => "");
    const energy = board.bars.find((b) => b.key === "energy")!;
    const nerve = board.bars.find((b) => b.key === "nerve")!;
    expect(energy.state).toBe("25 / 150");
    expect(energy.relative).toBeNull(); // "—" → no invented timer, no Full
    expect(energy.pct).toBeCloseTo((25 / 150) * 100, 1);
    expect(nerve.state).toBe("1 / 49");
    expect(nerve.pct).toBeCloseTo((1 / 49) * 100, 1);
    // And the same payload through the canonical helper agrees (Overview==Today).
    expect(barFullDisplay(staleBars.energy, NOW_MS)!.full).toBe(false);
    expect(barFullDisplay(staleBars.nerve, NOW_MS)!.full).toBe(false);
  });
});

describe("cockpit snapshot: atomic freshness, corrupt/mixed invalidation", () => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };

  const payloadFetchedAtMs = NOW_MS - 3 * 3600_000; // payload is 3h old
  function mixedSnapshot(): CockpitSnapshot {
    // The production shape: storage timestamp re-stamped "now" around an
    // hours-old payload.
    return {
      schema: 1,
      userId: "user-a",
      fetchedAtMs: NOW_MS,
      today: {
        fetchedAt: payloadFetchedAtMs, // TodayResponse.fetchedAt is epoch ms
        bars: { energy: null, nerve: null, happy: null, life: null },
      },
      ocs: [],
      travelDurations: null,
    };
  }

  it("mixed snapshot (fresh fetchedAtMs, old payload) is NOT fresh — today revalidates", () => {
    const snap = mixedSnapshot();
    expect(snapshotAgeMs(snap, NOW_MS)).toBe(3 * 3600_000);
    expect(shouldSkipTodayRequest(snap, NOW_MS)).toBe(false);
  });

  it("corrupt payload (no finite today.fetchedAt) invalidates the snapshot", () => {
    store.set("tornscope.cockpit.v1:user-a", JSON.stringify({ schema: 1, userId: "user-a", fetchedAtMs: NOW_MS, today: { bars: {} }, ocs: [], travelDurations: null }));
    expect(loadCockpitSnapshot("user-a")).toBeNull();
    store.set("tornscope.cockpit.v1:user-a", JSON.stringify({ schema: 1, userId: "user-a", fetchedAtMs: NOW_MS, today: { fetchedAt: Number.NaN, bars: {} }, ocs: [], travelDurations: null }));
    expect(loadCockpitSnapshot("user-a")).toBeNull();
  });

  it("snapshot without a bars object invalidates (not a live-status payload)", () => {
    store.set("tornscope.cockpit.v1:user-a", JSON.stringify({ schema: 1, userId: "user-a", fetchedAtMs: NOW_MS, today: { fetchedAt: Math.floor(NOW_MS / 1000) }, ocs: [], travelDurations: null }));
    expect(loadCockpitSnapshot("user-a")).toBeNull();
    store.clear();
  });

  it("Overview never re-stamps snapshot freshness with Date.now()", () => {
    const overview = read("../src/routes/+page.svelte");
    expect(overview).toContain("fetchedAtMs: today.fetchedAt");
    expect(overview).not.toContain("fetchedAtMs: Date.now()");
  });
});
