import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_REASONS,
  DATA_CONFIDENCE_STATES,
  deriveDataConfidence,
  kpiAvailabilityFromConfidence,
  worstConfidence,
  worstKpiAvailability,
  type ConfidenceFacts,
} from "../src/confidence.js";

/**
 * The data-confidence derivation matrix (v0.2 roadmap item #1).
 *
 * Every state the product promises — complete, partial, stale_permission,
 * unavailable — and the boundary between a VALID ZERO and UNAVAILABLE.
 */

const NOW = 1_760_000_000; // fixed "now" — unix seconds

function facts(overrides: Partial<ConfidenceFacts> = {}): ConfidenceFacts {
  return {
    permissionAllowed: true,
    isWalkResource: true,
    status: "idle",
    lastSuccessAt: NOW - 300,
    recordsCollected: 1200,
    stopReason: "history_boundary_reached",
    hasCategoryProblems: false,
    coverageFrom: NOW - 180 * 86_400,
    coverageTo: NOW - 300,
    freshnessToleranceSeconds: 1800,
    ...overrides,
  };
}

const fullRange = { from: NOW - 30 * 86_400, to: NOW - 60 };

describe("deriveDataConfidence — complete", () => {
  it("capability present + sync successful + range covered → complete", () => {
    const meta = deriveDataConfidence(facts(), fullRange, NOW);
    expect(meta.confidence).toBe("complete");
    expect(meta.reason).toBeNull();
    expect(meta.lastRefreshedAt).toBe(NOW - 300);
  });

  it("valid zero: clean walk, no rows collected at all → complete (zero is meaningful)", () => {
    const meta = deriveDataConfidence(facts({ recordsCollected: 0, coverageFrom: null, coverageTo: null }), fullRange, NOW);
    expect(meta.confidence).toBe("complete");
    expect(meta.reason).toBeNull();
  });

  it("snapshot resource with a successful sync → complete", () => {
    const meta = deriveDataConfidence(facts({ isWalkResource: false, stopReason: null, coverageFrom: null, coverageTo: null }), fullRange, NOW);
    expect(meta.confidence).toBe("complete");
  });
});

describe("deriveDataConfidence — actual zero vs unavailable", () => {
  it("complete coverage → value 0 stays available ('ok')", () => {
    const meta = deriveDataConfidence(facts(), fullRange, NOW);
    expect(kpiAvailabilityFromConfidence(meta)).toBe("ok");
  });

  it("no permission + no retained data → unavailable, never a zero", () => {
    const meta = deriveDataConfidence(facts({ permissionAllowed: false, recordsCollected: 0, coverageFrom: null, coverageTo: null }), fullRange, NOW);
    expect(meta.confidence).toBe("unavailable");
    expect(meta.reason).toBe("missing_permission");
    expect(kpiAvailabilityFromConfidence(meta)).toBe("unavailable");
  });

  it("never synced → unavailable/never_synced", () => {
    const meta = deriveDataConfidence(facts({ lastSuccessAt: null, recordsCollected: 0, coverageFrom: null, coverageTo: null, stopReason: null }), fullRange, NOW);
    expect(meta.confidence).toBe("unavailable");
    expect(meta.reason).toBe("never_synced");
  });

  it("revoked key (caps null) with no data → unavailable, not stale", () => {
    const meta = deriveDataConfidence(facts({ permissionAllowed: false, recordsCollected: 0, coverageFrom: null, coverageTo: null }), fullRange, NOW);
    expect(meta.confidence).toBe("unavailable");
  });
});

describe("deriveDataConfidence — stale_permission", () => {
  it("history exists + current permission missing → stale_permission, history retained", () => {
    const meta = deriveDataConfidence(facts({ permissionAllowed: false }), fullRange, NOW);
    expect(meta.confidence).toBe("stale_permission");
    expect(meta.reason).toBe("historical_permission_lost");
    expect(meta.lastRefreshedAt).toBe(NOW - 300);
  });

  it("runtime capability_denied overrides an allow-listed caps blob → stale_permission", () => {
    const meta = deriveDataConfidence(facts({ status: "capability_denied" }), fullRange, NOW);
    expect(meta.confidence).toBe("stale_permission");
    expect(meta.reason).toBe("historical_permission_lost");
  });

  it("stale_permission with retained data → value availability stays 'ok' (real history)", () => {
    const meta = deriveDataConfidence(facts({ permissionAllowed: false }), fullRange, NOW);
    expect(kpiAvailabilityFromConfidence(meta)).toBe("ok");
  });

  it("stale_permission with nothing stored → unavailable", () => {
    const meta = deriveDataConfidence(facts({ permissionAllowed: false, recordsCollected: 0, coverageFrom: null, coverageTo: null }), fullRange, NOW);
    expect(meta.confidence).toBe("unavailable");
  });
});

describe("deriveDataConfidence — partial coverage", () => {
  it("requested range begins before available history → partial/range_before_coverage", () => {
    const meta = deriveDataConfidence(facts(), { from: NOW - 400 * 86_400, to: NOW - 60 }, NOW);
    expect(meta.confidence).toBe("partial");
    expect(meta.reason).toBe("range_before_coverage");
    expect(meta.coverage.from).toBe(NOW - 180 * 86_400);
  });

  it("backfill running with usable data → partial/backfill_in_progress", () => {
    const meta = deriveDataConfidence(facts({ status: "running" }), fullRange, NOW);
    expect(meta.confidence).toBe("partial");
    expect(meta.reason).toBe("backfill_in_progress");
    expect(kpiAvailabilityFromConfidence(meta)).toBe("importing");
  });

  it("backfill running with no data yet → unavailable/backfill_in_progress (importing, not 0)", () => {
    const meta = deriveDataConfidence(facts({ status: "running", recordsCollected: 0, coverageFrom: null, coverageTo: null, stopReason: null }), fullRange, NOW);
    expect(meta.confidence).toBe("unavailable");
    expect(meta.reason).toBe("backfill_in_progress");
    expect(kpiAvailabilityFromConfidence(meta)).toBe("importing");
  });

  it("bounded walk (max_pages) → partial/sync_incomplete", () => {
    const meta = deriveDataConfidence(facts({ stopReason: "max_pages" }), fullRange, NOW);
    expect(meta.confidence).toBe("partial");
    expect(meta.reason).toBe("sync_incomplete");
    expect(meta.coverage.hasKnownGaps).toBe(false);
  });

  it("failed category inside the window → partial/sync_incomplete", () => {
    const meta = deriveDataConfidence(facts({ hasCategoryProblems: true }), fullRange, NOW);
    expect(meta.confidence).toBe("partial");
    expect(meta.reason).toBe("sync_incomplete");
  });

  it("walk never ran despite success → partial/backfill_in_progress", () => {
    const meta = deriveDataConfidence(facts({ stopReason: null, coverageFrom: null }), fullRange, NOW);
    expect(meta.confidence).toBe("partial");
    expect(meta.reason).toBe("backfill_in_progress");
  });

  it("refresh tail stopped inside the range → partial/sync_incomplete", () => {
    // last success 3 days ago, range reaches "now", tolerance 30 min.
    const meta = deriveDataConfidence(facts({ lastSuccessAt: NOW - 3 * 86_400, coverageTo: NOW - 3 * 86_400 }), { from: NOW - 30 * 86_400, to: NOW }, NOW);
    expect(meta.confidence).toBe("partial");
    expect(meta.reason).toBe("sync_incomplete");
  });
});

describe("deriveDataConfidence — sync errors keep history", () => {
  it("temporary sync error: previous history remains visible → partial/sync_error", () => {
    const meta = deriveDataConfidence(facts({ status: "failed" }), fullRange, NOW);
    expect(meta.confidence).toBe("partial");
    expect(meta.reason).toBe("sync_error");
    expect(meta.lastRefreshedAt).toBe(NOW - 300);
  });

  it("first sync failed with nothing collected → unavailable/sync_error", () => {
    const meta = deriveDataConfidence(facts({ status: "failed", recordsCollected: 0, coverageFrom: null, coverageTo: null, stopReason: null }), fullRange, NOW);
    expect(meta.confidence).toBe("unavailable");
    expect(meta.reason).toBe("sync_error");
  });
});

describe("deriveDataConfidence — snapshot resources", () => {
  it("snapshot source with success but zero rows → unavailable/source_unavailable", () => {
    const meta = deriveDataConfidence(facts({ isWalkResource: false, recordsCollected: 0, stopReason: null, coverageFrom: null, coverageTo: null }), fullRange, NOW);
    expect(meta.confidence).toBe("unavailable");
    expect(meta.reason).toBe("source_unavailable");
  });
});

describe("combining helpers", () => {
  it("worstConfidence picks the most severe meta", () => {
    const complete = deriveDataConfidence(facts(), fullRange, NOW);
    const stale = deriveDataConfidence(facts({ permissionAllowed: false }), fullRange, NOW);
    const unavailable = deriveDataConfidence(facts({ permissionAllowed: false, recordsCollected: 0, coverageFrom: null, coverageTo: null }), fullRange, NOW);
    expect(worstConfidence([complete, stale])?.confidence).toBe("stale_permission");
    expect(worstConfidence([complete, unavailable])?.confidence).toBe("unavailable");
    expect(worstConfidence([complete])?.confidence).toBe("complete");
    expect(worstConfidence([])).toBeNull();
  });

  it("worstKpiAvailability: unavailable > incomplete > importing > ok", () => {
    expect(worstKpiAvailability("ok", "incomplete")).toBe("incomplete");
    expect(worstKpiAvailability("importing", "incomplete")).toBe("incomplete");
    expect(worstKpiAvailability("unavailable", "ok")).toBe("unavailable");
    expect(worstKpiAvailability("ok", "ok")).toBe("ok");
  });

  it("every state and reason code is enumerable (contract stability)", () => {
    expect([...DATA_CONFIDENCE_STATES]).toEqual(["complete", "partial", "stale_permission", "unavailable"]);
    expect(CONFIDENCE_REASONS).toContain("historical_permission_lost");
    expect(CONFIDENCE_REASONS).toContain("range_before_coverage");
  });
});
