import { describe, expect, it, beforeAll } from "vitest";

const store = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as Record<string, unknown>).localStorage = localStorage;
import {
  saveCockpitSnapshot,
  loadCockpitSnapshot,
  clearCockpitSnapshot,
  shouldSkipTodayRequest,
  COCKPIT_FRESH_MS,
} from "../src/lib/cockpit-cache";

/**
 * Browser cockpit snapshot (2.0.7): cache-first cockpit rendering with
 * per-user versioned storage. CASE K (user switch/logout) clears or
 * isolates the snapshot; no secrets/API keys are ever stored.
 */

const USER_A = "user-a";
const USER_B = "user-b";
const NOW = 1_750_000_000_000;

function snapshot(fetchedAtMs = NOW) {
  return { schema: 1, userId: "user-a", fetchedAtMs, today: { fetchedAt: fetchedAtMs, bars: { energy: null }, player: { name: "X" } }, ocs: [{ name: "OC" }], travelDurations: { UAE: 43_200 } };
}

describe("cockpit snapshot", () => {
  it("saves and loads per user (CASE A: instant cache-first render)", () => {
    saveCockpitSnapshot(USER_A, snapshot());
    const loaded = loadCockpitSnapshot(USER_A);
    expect(loaded).not.toBeNull();
    expect(loaded!.userId).toBe(USER_A);
    expect(loaded!.travelDurations).toEqual({ UAE: 43_200 });
  });

  it("CASE K — a different profile never reads another's snapshot", () => {
    saveCockpitSnapshot(USER_A, snapshot());
    expect(loadCockpitSnapshot(USER_B)).toBeNull();
    clearCockpitSnapshot(USER_A);
  });

  it("CASE K — logout/user switch clears the snapshot", () => {
    saveCockpitSnapshot(USER_A, snapshot());
    clearCockpitSnapshot(USER_A);
    expect(loadCockpitSnapshot(USER_A)).toBeNull();
  });

  it("wrong schema version is rejected", () => {
    saveCockpitSnapshot(USER_A, snapshot());
    // Simulate an old schema: overwrite with version 0.
    const raw = localStorage.getItem(`tornscope.cockpit.v1:${USER_A}`)!;
    localStorage.setItem(`tornscope.cockpit.v0:${USER_A}`, raw);
    expect(loadCockpitSnapshot(USER_A)).not.toBeNull(); // v1 still there
    localStorage.removeItem(`tornscope.cockpit.v1:${USER_A}`);
    expect(loadCockpitSnapshot(USER_A)).toBeNull();
    localStorage.setItem(`tornscope.cockpit.v1:${USER_A}`, raw.replace('"schema":1', '"schema":99'));
    expect(loadCockpitSnapshot(USER_A)).toBeNull();
    localStorage.removeItem(`tornscope.cockpit.v1:${USER_A}`);
  });

  it("malformed JSON degrades to null, never throws", () => {
    localStorage.setItem(`tornscope.cockpit.v1:${USER_A}`, "{broken");
    expect(loadCockpitSnapshot(USER_A)).toBeNull();
    localStorage.removeItem(`tornscope.cockpit.v1:${USER_A}`);
  });
});

describe("mount policy", () => {
  it("fresh snapshot skips the today request; old snapshot revalidates", () => {
    const snap = snapshot(NOW);
    expect(shouldSkipTodayRequest(snap, NOW + 60_000)).toBe(true); // 1 min old
    expect(shouldSkipTodayRequest(snap, NOW + COCKPIT_FRESH_MS - 1)).toBe(true);
    expect(shouldSkipTodayRequest(snap, NOW + COCKPIT_FRESH_MS + 1)).toBe(false);
  });

  it("no snapshot → always fetch", () => {
    expect(shouldSkipTodayRequest(null, NOW)).toBe(false);
  });
});
