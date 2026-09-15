import { describe, expect, it } from "vitest";
import { TtlMap } from "../src/ttl-cache.js";

/**
 * Bounded TTL map contract (V1.0 hardening): every module-level cache with a
 * TTL must be unable to retain expired entries forever, and must have a hard
 * size bound. Fully deterministic via the injected clock — these tests also
 * act as the memory-hygiene probe: many expired entries, then a sweep, then
 * the retained count must fall back down.
 */

describe("TtlMap — expiry semantics", () => {
  it("returns live values and drops expired entries on read", () => {
    let now = 1_000;
    const map = new TtlMap<string>({ ttlMs: 60_000, now: () => now });
    map.set("a", "value-a");
    expect(map.get("a")).toBe("value-a");
    now += 59_999;
    expect(map.get("a")).toBe("value-a");
    now += 1; // exactly ttl passed
    expect(map.get("a")).toBeUndefined(); // expired — dropped on read
    expect(map.size).toBe(0);
  });

  it("set() refreshes the entry TTL (sliding window)", () => {
    let now = 0;
    const map = new TtlMap<number>({ ttlMs: 10_000, now: () => now });
    map.set("k", 1);
    now += 9_000;
    map.set("k", 2); // refresh
    now += 9_000;
    expect(map.get("k")).toBe(2); // original expiry would have passed
  });
});

describe("TtlMap — bounded retained state (memory-hygiene probe)", () => {
  it("sweeping after mass expiry brings the retained count back down", () => {
    let now = 0;
    const map = new TtlMap<number>({ ttlMs: 1_000, now: () => now, sweepEvery: Number.POSITIVE_INFINITY, maxEntries: 50_000 });
    for (let i = 0; i < 50_000; i++) {
      map.set(`ip-${i}`, i);
    }
    expect(map.size).toBe(50_000);
    now += 2_000; // everything expired
    const removed = map.sweep(now);
    expect(removed).toBe(50_000);
    expect(map.size).toBe(0); // nothing retained forever
  });

  it("sweeps lazily on set() at most once per sweepEvery writes", () => {
    let now = 0;
    const map = new TtlMap<number>({ ttlMs: 1_000, now: () => now, sweepEvery: 32 });
    for (let i = 0; i < 100; i++) map.set(`k${i}`, i);
    now += 2_000;
    // One more set triggers the lazy sweep: all expired entries vanish.
    map.set("fresh", 42);
    expect(map.get("fresh")).toBe(42);
    for (let i = 0; i < 100; i++) {
      expect(map.get(`k${i}`)).toBeUndefined();
    }
  });

  it("enforces maxEntries: expired entries evicted first, then oldest inserts", () => {
    let now = 0;
    const map = new TtlMap<number>({ ttlMs: 10_000, now: () => now, sweepEvery: Number.POSITIVE_INFINITY, maxEntries: 3 });
    map.set("a", 1);
    map.set("b", 2);
    now += 20_000; // a and b expired
    map.set("c", 3); // bound enforced: c survives, expired entries evicted
    expect(map.size).toBe(1);
    now = 0 + 100; // back to live time for fresh inserts below
    const map2 = new TtlMap<number>({ ttlMs: 10_000, now: () => now, sweepEvery: Number.POSITIVE_INFINITY, maxEntries: 2 });
    map2.set("a", 1);
    map2.set("b", 2);
    map2.set("c", 3); // all live: oldest insert (a) evicted
    expect(map2.has("a")).toBe(false);
    expect(map2.get("b")).toBe(2);
    expect(map2.get("c")).toBe(3);
  });

  it("size counts only live entries", () => {
    let now = 0;
    const map = new TtlMap<number>({ ttlMs: 5_000, now: () => now });
    map.set("x", 1);
    map.set("y", 2);
    now += 6_000;
    expect(map.size).toBe(0);
  });
});
