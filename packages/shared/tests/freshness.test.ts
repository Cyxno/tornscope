import { describe, expect, it } from "vitest";
import { buildDataFreshness, deriveDomainFreshness, deriveResourceFreshness, FRESHNESS_POLICY, type FreshnessResourceFacts } from "../src/freshness.js";

const NOW = 1_750_000_000;

function facts(overrides: Partial<FreshnessResourceFacts> & { resource: string }): FreshnessResourceFacts {
  return {
    status: "idle",
    lastAttemptAt: NOW - 60,
    lastSuccessAt: NOW - 60,
    nextRunAt: NOW + 240,
    frequencySeconds: 300,
    errorCount: 0,
    lastErrorKind: null,
    ...overrides,
  };
}

describe("deriveResourceFreshness", () => {
  it("reads fresh within twice the cadence", () => {
    const r = deriveResourceFreshness(facts({ resource: "bars", lastSuccessAt: NOW - 600 }), NOW);
    expect(r.status).toBe("fresh");
    expect(r.ageSeconds).toBe(600);
    expect(r.freshAfterSeconds).toBe(600);
  });

  it("reads delayed past fresh age but within the delayed multiple", () => {
    const r = deriveResourceFreshness(facts({ resource: "bars", lastSuccessAt: NOW - 1800 }), NOW);
    expect(r.status).toBe("delayed");
    expect(r.lastErrorKind).toBeNull();
  });

  it("reads stale beyond the delayed multiple", () => {
    const r = deriveResourceFreshness(facts({ resource: "bars", lastSuccessAt: NOW - 4 * 3600 }), NOW);
    expect(r.status).toBe("stale");
  });

  it("escalates to failed only when the last attempt failed AND data is past fresh", () => {
    const recentFailure = deriveResourceFreshness(facts({ resource: "money_logs", status: "failed", lastErrorKind: "rate_limited", lastSuccessAt: NOW - 120, errorCount: 2 }), NOW);
    expect(recentFailure.status).toBe("delayed"); // data still fresh, retry scheduled
    const oldFailure = deriveResourceFreshness(facts({ resource: "money_logs", status: "failed", lastErrorKind: "rate_limited", lastSuccessAt: NOW - 3600, errorCount: 2 }), NOW);
    expect(oldFailure.status).toBe("failed");
    expect(oldFailure.lastErrorKind).toBe("rate_limited");
  });

  it("never reads fresh while the last attempt failed, but only escalates past fresh age", () => {
    const recentFailure = deriveResourceFreshness(facts({ resource: "networth", status: "failed", lastErrorKind: "timeout", lastSuccessAt: NOW - 1000, frequencySeconds: 3600 }), NOW);
    expect(recentFailure.status).toBe("delayed"); // data still fresh, retry scheduled — never "fresh" while failing
    const oldFailure = deriveResourceFreshness(facts({ resource: "networth", status: "failed", lastErrorKind: "timeout", lastSuccessAt: NOW - 9 * 3600, frequencySeconds: 3600 }), NOW);
    expect(oldFailure.status).toBe("failed");
  });

  it("reports unavailable for capability-denied and never-attempted resources", () => {
    expect(deriveResourceFreshness(facts({ resource: "faction", status: "capability_denied" }), NOW).status).toBe("unavailable");
    expect(deriveResourceFreshness(facts({ resource: "faction", lastAttemptAt: null, lastSuccessAt: null }), NOW).status).toBe("unavailable");
  });

  it("reports unavailable when attempts exist but no success ever arrived", () => {
    const r = deriveResourceFreshness(facts({ resource: "events", lastSuccessAt: null, status: "failed", lastErrorKind: "network_error" }), NOW);
    expect(r.status).toBe("unavailable");
  });

  it("clamps cadence to policy bounds", () => {
    const fast = deriveResourceFreshness(facts({ resource: "x", frequencySeconds: 10 }), NOW);
    expect(fast.freshAfterSeconds).toBe(FRESHNESS_POLICY.MIN_CADENCE_SECONDS * FRESHNESS_POLICY.FRESH_AGE_MULTIPLE);
    const slow = deriveResourceFreshness(facts({ resource: "y", frequencySeconds: 100_000 }), NOW);
    expect(slow.freshAfterSeconds).toBe(FRESHNESS_POLICY.MAX_CADENCE_SECONDS * FRESHNESS_POLICY.FRESH_AGE_MULTIPLE);
  });
});

describe("deriveDomainFreshness", () => {
  it("aggregates worst-wins with the fixed precedence", () => {
    const fresh = deriveResourceFreshness(facts({ resource: "a" }), NOW);
    const stale = deriveResourceFreshness(facts({ resource: "b", lastSuccessAt: NOW - 9 * 3600 }), NOW);
    const failed = deriveResourceFreshness(facts({ resource: "c", status: "failed", lastSuccessAt: NOW - 9 * 3600, lastErrorKind: "timeout" }), NOW);
    const unavailable = deriveResourceFreshness(facts({ resource: "d", lastAttemptAt: null, lastSuccessAt: null }), NOW);
    expect(deriveDomainFreshness([fresh])).toBe("fresh");
    expect(deriveDomainFreshness([fresh, stale])).toBe("stale");
    expect(deriveDomainFreshness([stale, failed])).toBe("failed");
    expect(deriveDomainFreshness([failed, unavailable])).toBe("unavailable");
    expect(deriveDomainFreshness([])).toBe("unavailable");
  });
});

describe("buildDataFreshness", () => {
  it("maps sync resources onto the user-facing domains", () => {
    const input = [
      facts({ resource: "money_logs", lastSuccessAt: NOW - 120, frequencySeconds: 600 }),
      facts({ resource: "profile", lastSuccessAt: NOW - 120 }),
      facts({ resource: "faction", lastSuccessAt: NOW - 9 * 3600, frequencySeconds: 3600 }),
      facts({ resource: "faction_basic", lastSuccessAt: NOW - 120, frequencySeconds: 21_600 }),
    ];
    const table = buildDataFreshness(input, NOW);
    const money = table.find((d) => d.domain === "money")!;
    expect(money.status).toBe("fresh");
    expect(money.live).toBe(false);
    const faction = table.find((d) => d.domain === "faction")!;
    expect(faction.status).toBe("stale"); // faction resource stale, worst wins
    expect(faction.resources).toHaveLength(2); // only resources with facts
    expect(table.find((d) => d.domain === "stocks")).toMatchObject({ live: true, status: "fresh" });
  });

  it("marks live domains unavailable when the Torn API is down", () => {
    const table = buildDataFreshness([], NOW, false);
    expect(table.find((d) => d.domain === "stocks")).toMatchObject({ live: true, status: "unavailable", lastErrorKind: "torn_api_unreachable" });
  });

  it("returns every registered domain exactly once", () => {
    const table = buildDataFreshness([], NOW);
    expect(table).toHaveLength(14);
    expect(new Set(table.map((d) => d.domain)).size).toBe(14);
  });
});
