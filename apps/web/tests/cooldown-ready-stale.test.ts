import { describe, expect, it, beforeAll } from "vitest";
import { buildCooldown, formatCountdownCompact, remainingSeconds } from "@tornscope/shared";
import { TodayResponseSchema } from "@tornscope/shared";
import { cooldownDisplay, isNewerTodayPayload, PAYLOAD_CLOCK_TOLERANCE_MS, plausibleClockOffsetMs } from "../src/lib/live";
import { deriveLiveBoard } from "../src/lib/live-now";
import { loadCockpitSnapshot, saveCockpitSnapshot } from "../src/lib/cockpit-cache";
import type { TodayResponse } from "@tornscope/shared";

/**
 * Production regression 2.6.2 — "all cooldowns green/ready, countdowns
 * frozen". The API chain (Torn /user/cooldowns seconds → buildCooldown →
 * TodayResponse → persisted last-known) was verified byte-correct; the
 * breakage was client-side: the Overview cockpit trusted the localStorage
 * snapshot unconditionally. One payload with an impossible-future fetchedAt
 * (1) fast-forwarded the shared MONOTONIC dashboard clock — every cooldown
 * then rendered "Ready" with a frozen countdown — and (2) its fetchedAt made
 * the response gate `res.fetchedAt < today.fetchedAt` discard every fresh
 * /api/today response forever, while each dashboard success re-persisted the
 * poisoned snapshot. Permanent across reloads; the Today page (own offset,
 * no snapshot) showed the truth — Overview ≠ Today.
 *
 * The fixtures below mirror the REAL served payload shapes (audited live
 * 2026-10-08: Torn v2 answers {"cooldowns":{"drug":10876,"medical":0,
 * "booster":0}}; the API serves absolute-seconds cooldown states with the
 * stale-while-revalidate `stale` flag).
 */

const store = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as Record<string, unknown>).localStorage = localStorage;

const USER = "user-regression";
// Real audit reference point: the payload the API persisted at 16:45:45Z.
const FETCHED_MS = 1_791_477_945_615;
const FETCHED_SEC = Math.floor(FETCHED_MS / 1000);
const DRUG_ENDS_AT = FETCHED_SEC + 10_770; // active ~3h — Torn reported 10876s
const TRAVEL_LANDS_AT = FETCHED_SEC + 7_759;

/** REAL shape: exactly what /api/today serves (schema-validated below). */
function realTodayPayload(over: Partial<TodayResponse> = {}): TodayResponse {
  const payload: TodayResponse = {
    fetchedAt: FETCHED_MS,
    serverTime: FETCHED_SEC,
    demo: false,
    player: { name: "Cyxno", level: 34, status: { state: "Traveling", description: "Traveling", details: null, until: TRAVEL_LANDS_AT } },
    bars: {
      energy: { key: "energy", label: "Energy", current: 78, max: 150, percent: 52, overCap: 0, increment: 1, intervalSeconds: 15, fullAt: FETCHED_SEC + 10_800, remainingSeconds: 10_800, regenPerHour: 240, regenState: "regenerating", provenance: "exact" },
      nerve: { key: "nerve", label: "Nerve", current: 10, max: 55, percent: 18.2, overCap: 0, increment: 1, intervalSeconds: 120, fullAt: FETCHED_SEC + 5_400, remainingSeconds: 5_400, regenPerHour: 30, regenState: "regenerating", provenance: "exact" },
      happy: { key: "happy", label: "Happy", current: 2_300, max: 5_000, percent: 46, overCap: 0, increment: 45, intervalSeconds: 60, fullAt: FETCHED_SEC + 3_600, remainingSeconds: 3_600, regenPerHour: 2700, regenState: "regenerating", provenance: "exact" },
      life: { key: "life", label: "Life", current: 4_150, max: 4_150, percent: 100, overCap: 0, increment: null, intervalSeconds: null, fullAt: null, remainingSeconds: null, regenPerHour: null, regenState: "full", provenance: "exact" },
    },
    cooldowns: {
      drug: { kind: "drug", label: "Drug cooldown", state: "active", endsAt: DRUG_ENDS_AT, remainingSeconds: 10_770, provenance: "exact" },
      booster: { kind: "booster", label: "Booster cooldown", state: "ready", endsAt: null, remainingSeconds: null, provenance: "exact" },
      medical: { kind: "medical", label: "Medical cooldown", state: "ready", endsAt: null, remainingSeconds: null, provenance: "exact" },
    },
    travel: { state: "traveling", country: "Mexico", direction: "outbound", method: "Airliner", departedAt: FETCHED_SEC - 2_000, landsAt: TRAVEL_LANDS_AT, remainingSeconds: 7_759, durationSeconds: 9_759, provenance: "exact", unavailableReason: null, requiredAccess: null, syncedAt: FETCHED_SEC },
    bank: { state: "active", amount: 2_000_000, principal: 1_950_000, profit: 50_000, returnPct: 2.56, annualizedPct: 31.2, durationDays: 30, investedAt: FETCHED_SEC - 1_000_000, maturesAt: FETCHED_SEC + 7_000_000, remainingSeconds: 7_000_000, provenance: "exact", unavailableReason: null, requiredAccess: null },
    education: { state: "active", courseId: 74, courseName: "Cognitive Psychology", categoryName: "Bachelor of Psychology", completesAt: FETCHED_SEC + 300_000, remainingSeconds: 300_000, provenance: "exact", unavailableReason: null, requiredAccess: null },
    hospital: null,
    jail: null,
    upcoming: [
      { id: "travel:landing", category: "travel", title: "Land in Mexico", at: TRAVEL_LANDS_AT, remainingSeconds: 7_759, severity: "info" },
      { id: "cooldown:drug", category: "cooldown", title: "Drug cooldown ready", at: DRUG_ENDS_AT, remainingSeconds: 10_770, severity: "success" },
    ],
    access: { level: 4, type: "Full Access", note: null },
    ...over,
  };
  // The served payload must satisfy the real contract, not a hand-wave.
  return TodayResponseSchema.parse(payload);
}

const fakeDisplayTime = (tsSec: number): string => `T${tsSec % 100_000}`;

describe("real payload: active cooldown counts down, zero cooldown is Ready (Overview = Today)", () => {
  it("active drug cooldown renders a live countdown — never Ready", () => {
    const t = realTodayPayload();
    const serverNowMs = FETCHED_MS; // fresh payload, zero skew
    const cd = t.cooldowns.drug;
    expect(cd!.state).toBe("active");
    expect(cd!.endsAt! > serverNowMs / 1000).toBe(true);

    // THE shared rule both surfaces render from — identical state by construction.
    const display = cooldownDisplay(cd, serverNowMs);
    expect(display!.active).toBe(true);
    expect(display!.text).toBe("2h 59m"); // 10_770s minus the sub-second fetch fraction
    expect(display!.remainingSeconds).toBe(10_769);

    // Overview tile agrees with the shared display…
    const board = deriveLiveBoard(t, null, serverNowMs, fakeDisplayTime);
    const drugTile = board.timers.find((i) => i.key === "cd-drug");
    expect(drugTile!.ready).toBe(false);
    expect(drugTile!.state).toBeNull();
    expect(drugTile!.relative).toBe(display!.text);
    // …and the Today page's chip is the same classification of the same payload.
    const todayChipActive = cooldownDisplay(cd, serverNowMs)!.active;
    expect(todayChipActive).toBe(true);
  });

  it("zero cooldowns (Torn: drug 0 / medical 0 / booster 0) are Ready, with no countdown", () => {
    // The raw upstream shape for a cleared account: all three seconds at 0.
    const nowSec = 1_791_477_945;
    for (const seconds of [0, 0, 0]) {
      const built = buildCooldown(nowSec, "drug", seconds);
      expect(built.state).toBe("ready");
      expect(built.endsAt).toBeNull();
      expect(built.remainingSeconds).toBeNull();
      expect(cooldownDisplay(built, (nowSec + 30) * 1000)!.text).toBe("Ready");
    }
  });

  it("a genuinely active countdown ticks down client-side from the absolute timestamp", () => {
    const t = realTodayPayload();
    const laterMs = FETCHED_MS + 60_000;
    expect(remainingSeconds(laterMs, t.cooldowns.drug!.endsAt)).toBe(10_709);
    expect(formatCountdownCompact(remainingSeconds(laterMs, t.cooldowns.drug!.endsAt))).toBe("2h 58m");
  });
});

describe("cached-active whose clock ran out is Ready NOW (fresh payload only)", () => {
  it("fresh payload (≤ cache window old): expired-active reads Ready", () => {
    const t = realTodayPayload();
    const justAfterEnds = (t.cooldowns.drug!.endsAt! + 5) * 1000; // 5s past, payload ~3h old → wait: see next case
    expect(cooldownDisplay(t.cooldowns.drug, justAfterEnds)!.text).toBe("Ready");
  });

  it("the same expired-active on a STALE-served copy still resolves Ready, and the payload is marked stale", () => {
    // The API serves the persisted last-known copy with stale: true once the
    // cache window passed — the flag must ride along (transient case).
    const t = realTodayPayload({ stale: true });
    const pastEnds = (t.cooldowns.drug!.endsAt! + 10) * 1000;
    expect(t.stale).toBe(true);
    expect(cooldownDisplay(t.cooldowns.drug, pastEnds)!.text).toBe("Ready");
  });
});

describe("the permanent-ready trap: impossible fetchedAt must never own the state", () => {
  const nowMs = FETCHED_MS + 10 * 60_000; // ten minutes after the real payload
  const fresh: TodayResponse = realTodayPayload({ fetchedAt: nowMs, serverTime: Math.floor(nowMs / 1000) });
  const poisoned = FETCHED_MS + 48 * 3600_000; // +48h — broken clock at fetch time

  it("a held future-stamped payload never suppresses a fresh response", () => {
    expect(isNewerTodayPayload(poisoned, fresh.fetchedAt, nowMs)).toBe(true);
  });

  it("genuine out-of-order delivery still keeps the held (newer) payload", () => {
    const held = realTodayPayload({ fetchedAt: nowMs });
    const older: TodayResponse = realTodayPayload({ fetchedAt: nowMs - 30_000 });
    expect(isNewerTodayPayload(held.fetchedAt, older.fetchedAt, nowMs)).toBe(false);
  });

  it("an incoming future-stamped response is rejected (held plausible payload kept)", () => {
    const held = realTodayPayload({ fetchedAt: nowMs - 30_000 });
    expect(isNewerTodayPayload(held.fetchedAt, poisoned, nowMs)).toBe(false);
  });

  it("clock sync rejects impossible offsets in both directions and accepts plausible ones", () => {
    expect(plausibleClockOffsetMs(poisoned, nowMs)).toBeNull();
    expect(plausibleClockOffsetMs(0, nowMs)).toBeNull();
    expect(plausibleClockOffsetMs(Number.NaN, nowMs)).toBeNull();
    expect(plausibleClockOffsetMs(nowMs + 90_000, nowMs)).toBe(90_000);
    expect(plausibleClockOffsetMs(nowMs - 90_000, nowMs)).toBe(-90_000);
    // 6 minutes behind (an old cached response) is NOT a clock correction.
    expect(plausibleClockOffsetMs(nowMs - PAYLOAD_CLOCK_TOLERANCE_MS - 1, nowMs)).toBeNull();
  });
});

describe("cockpit snapshot self-heal (2.6.2)", () => {
  it("a snapshot whose today payload is stamped in the impossible future is rejected AND removed", () => {
    const poisonedMs = Date.now() + 48 * 3600_000;
    saveCockpitSnapshot(USER, {
      fetchedAtMs: poisonedMs,
      today: realTodayPayload({ fetchedAt: poisonedMs }),
      ocs: null,
      travelDurations: null,
    });
    expect(loadCockpitSnapshot(USER)).toBeNull();
    // Removed from storage — the browser heals on the next load.
    expect(store.has(`tornscope.cockpit.v1:${USER}`)).toBe(false);
  });

  it("a plausible (aged) snapshot still loads — cache-first rendering is untouched", () => {
    const aged = Date.now() - 60 * 60_000; // 1h old, but plausible
    saveCockpitSnapshot(USER, {
      fetchedAtMs: aged,
      today: realTodayPayload({ fetchedAt: aged }),
      ocs: null,
      travelDurations: null,
    });
    expect(loadCockpitSnapshot(USER)).not.toBeNull();
  });
});
