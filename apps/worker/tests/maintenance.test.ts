import { describe, expect, it } from "vitest";
import { isGuestCleanupEligible } from "../src/maintenance.js";
import { checkRateLimit } from "../../api/src/ratelimit.js";

/**
 * Public deployment safety: abandoned guest profiles are cleaned up
 * conservatively (only provably-empty, stale profiles), and session abuse
 * cannot grow the users table unbounded.
 */

const DAY = 86_400_000;

describe("guest cleanup eligibility", () => {
  const base = {
    role: "user",
    isDemo: false,
    hasActiveCredential: false,
    hasTornAccount: false,
    hasAnyHistory: false,
    hasActiveSession: false,
    lastActivityAt: Date.now() - 61 * DAY,
  };

  it("an empty, stale guest profile is eligible", () => {
    expect(isGuestCleanupEligible(base, Date.now(), 60)).toBe(true);
  });

  it("recent activity keeps the profile", () => {
    expect(isGuestCleanupEligible({ ...base, lastActivityAt: Date.now() - 5 * DAY }, Date.now(), 60)).toBe(false);
  });

  it("profiles with an active credential are never deleted", () => {
    expect(isGuestCleanupEligible({ ...base, hasActiveCredential: true }, Date.now(), 60)).toBe(false);
  });

  it("profiles with a Torn account (synced identity) are never deleted", () => {
    expect(isGuestCleanupEligible({ ...base, hasTornAccount: true }, Date.now(), 60)).toBe(false);
  });

  it("profiles with any normalized history are never deleted", () => {
    expect(isGuestCleanupEligible({ ...base, hasAnyHistory: true }, Date.now(), 60)).toBe(false);
  });

  it("profiles with an active session are never deleted", () => {
    expect(isGuestCleanupEligible({ ...base, hasActiveSession: true }, Date.now(), 60)).toBe(false);
  });

  it("owner and demo profiles are never eligible", () => {
    expect(isGuestCleanupEligible({ ...base, role: "owner" }, Date.now(), 60)).toBe(false);
    expect(isGuestCleanupEligible({ ...base, isDemo: true }, Date.now(), 60)).toBe(false);
  });
});

describe("rate limiter", () => {
  it("allows up to the limit then blocks with retry-after", () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < 3; i += 1) {
      expect(checkRateLimit("bucket", key, 3, 60_000).ok).toBe(true);
    }
    const blocked = checkRateLimit("bucket", key, 3, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("distinct subjects have independent budgets", () => {
    const key = `iso-${Math.random()}`;
    expect(checkRateLimit("b2", `${key}-a`, 1, 60_000).ok).toBe(true);
    expect(checkRateLimit("b2", `${key}-b`, 1, 60_000).ok).toBe(true);
  });
});
