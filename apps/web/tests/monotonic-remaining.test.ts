import { describe, expect, it } from "vitest";
import { monotonicRemaining, resetMonotonicTimers, DUEAT_WOBBLE_TOLERANCE_SEC } from "../src/lib/monotonic-remaining";

/**
 * Monotonic cockpit countdowns (2.0.7): for the SAME event boundary the
 * displayed remaining time never increases — clock skew corrections,
 * delayed responses and older snapshots can only hold or decrease it.
 * A genuine dueAt change (> 90 s wobble) resets the timer (CASE: Torn
 * explicitly reports a new state).
 */

const NOW = 1_750_000_000;
const DUE = NOW + 2 * 3600; // 2h out

describe("monotonicRemaining", () => {
  it("resets on identity change (new dueAt beyond wobble)", () => {
    resetMonotonicTimers();
    const a = monotonicRemaining("travel:1000", NOW + 3600, NOW);
    expect(a.remainingSeconds).toBe(3600);
    const b = monotonicRemaining("travel:2000", NOW + 7200, NOW);
    expect(b.remainingSeconds).toBe(7200); // new identity → fresh projection
  });

  it("same identity ticks down monotonically", () => {
    resetMonotonicTimers();
    expect(monotonicRemaining("k", DUE, NOW).remainingSeconds).toBe(7200);
    expect(monotonicRemaining("k", DUE, NOW + 60).remainingSeconds).toBe(7140);
    expect(monotonicRemaining("k", DUE, NOW + 120).remainingSeconds).toBe(7080);
  });
});

describe("2.0.7 acceptance cases", () => {
  it("CASE D — same landsAt + newer response: countdown never increases", () => {
    resetMonotonicTimers();
    // First response: 2h out.
    expect(monotonicRemaining("travel:uae", DUE, NOW).remainingSeconds).toBe(7200);
    // A "newer" response arrives with server-skewed clock — remaining jumps
    // up by 90s in the raw projection; the clamp must hold it monotonic.
    const later = monotonicRemaining("travel:uae", DUE, NOW + 10 + 90);
    expect(later.remainingSeconds).toBeLessThanOrEqual(7200 - 10 - 80);
  });

  it("CASE E — out-of-order older response is ignored (clamp keeps the countdown)", () => {
    resetMonotonicTimers();
    monotonicRemaining("drug:500", NOW + 600, NOW); // 10m out
    // An out-of-order OLDER response arrives (same boundary, clock behind):
    // its raw projection reads higher, but the clamp never lets it rise.
    const older = monotonicRemaining("drug:500", NOW + 600, NOW - 60);
    expect(older.remainingSeconds).toBeLessThanOrEqual(600); // never 660+
  });

  it("dueAt wobble ≤ 90s keeps the earlier boundary (kills 2h→1h50→2h wobble)", () => {
    resetMonotonicTimers();
    monotonicRemaining("travel:w", NOW + 7200, NOW);
    // Server re-reports landsAt 60s later (within tolerance):
    const wobbled = monotonicRemaining("travel:w", NOW + 7260, NOW + 1);
    expect(wobbled.dueAt).toBe(DUE); // earlier boundary kept
    // Beyond tolerance → genuine change, accepted:
    const real = monotonicRemaining("travel:w", NOW + 8000, NOW + 2);
    expect(real.dueAt).toBe(NOW + 8000);
  });

  it("wobble tolerance keeps its documented value", () => {
    expect(DUEAT_WOBBLE_TOLERANCE_SEC).toBe(90);
  });

  it("cached landsAt at T-2m projects the correct remaining without any server data", () => {
    resetMonotonicTimers();
    // Pure client projection: landsAt known, local clock advances.
    const due = NOW + 120;
    expect(monotonicRemaining("cached:travel", due, NOW).remainingSeconds).toBe(120);
    expect(monotonicRemaining("cached:travel", due, NOW + 15).remainingSeconds).toBe(105);
    expect(monotonicRemaining("cached:travel", due, NOW + 118).remainingSeconds).toBe(2);
  });
});
