import { describe, expect, it } from "vitest";
import {
  deriveSyncOperationalState,
  SYNC_HEALTH_POLICY,
  SYNC_OPERATION_REASONS,
  SYNC_OPERATIONAL_STATES,
  type SyncOperationalFacts,
} from "../src/sync-health.js";

/**
 * Operational sync health derivation matrix (v0.2 roadmap item #3).
 * Pure tests: facts in, verdict out — same inputs MUST always yield the
 * same operational state. Covers the acceptance matrix: healthy, running,
 * stale-running heartbeat semantics, delayed tolerance boundaries,
 * retrying → caught_up / failed, rate-limited reasons, parked capability
 * denial, degraded detection and recovery, never-run and demo-style states.
 */

const MIN = 60;
const HOUR = 3600;

function facts(overrides: Partial<SyncOperationalFacts> = {}): SyncOperationalFacts {
  return {
    status: "idle",
    lastAttemptAt: null,
    lastStartedAt: null,
    lastHeartbeatAt: null,
    lastSuccessAt: null,
    nextRunAt: null,
    frequencySeconds: 600,
    errorCount: 0,
    lastErrorKind: null,
    hasCategoryProblems: false,
    ...overrides,
  };
}

const NOW = 1_800_000_000; // fixed "now" (unix seconds)

describe("operational state derivation", () => {
  it("exposes the full state and reason vocabulary", () => {
    expect([...SYNC_OPERATIONAL_STATES]).toEqual([
      "caught_up", "running", "backfilling", "delayed", "retrying",
      "degraded", "failed", "parked", "stale_running", "never_run",
    ]);
    for (const reason of SYNC_OPERATION_REASONS) expect(reason).toBeTruthy();
  });

  it("1. healthy resource with a recent success and scheduled next run is caught_up", () => {
    const meta = deriveSyncOperationalState(
      facts({ lastAttemptAt: NOW - MIN, lastSuccessAt: NOW - MIN, nextRunAt: NOW + 9 * MIN }),
      NOW
    );
    expect(meta.state).toBe("caught_up");
    expect(meta.reason).toBe("none");
    expect(meta.severity).toBe("info");
    expect(meta.since).toBe(NOW - MIN);
  });

  it("2. running with a fresh heartbeat is running", () => {
    const meta = deriveSyncOperationalState(
      facts({ status: "running", lastAttemptAt: NOW - MIN, lastStartedAt: NOW - MIN, lastHeartbeatAt: NOW - 30, lastSuccessAt: NOW - HOUR }),
      NOW
    );
    expect(meta.state).toBe("running");
    expect(meta.since).toBe(NOW - MIN);
  });

  it("3. running with a dead heartbeat is stale_running (heartbeat semantics, not updatedAt)", () => {
    const meta = deriveSyncOperationalState(
      facts({
        status: "running",
        lastAttemptAt: NOW - 20 * MIN,
        lastStartedAt: NOW - 20 * MIN,
        lastHeartbeatAt: NOW - 16 * MIN,
      }),
      NOW
    );
    expect(meta.state).toBe("stale_running");
    expect(meta.reason).toBe("worker_interrupted");
    expect(meta.severity).toBe("warning");
    expect(meta.recoverable).toBe(true);
  });

  it("3b. stale threshold boundary: heartbeat exactly at the threshold is stale, just inside is running", () => {
    const at = SYNC_HEALTH_POLICY.RUNNING_STALE_AFTER_SECONDS;
    const inside = deriveSyncOperationalState(
      facts({ status: "running", lastAttemptAt: NOW - 2 * HOUR, lastHeartbeatAt: NOW - (at - 1), lastSuccessAt: NOW - 2 * HOUR }),
      NOW
    );
    const atBoundary = deriveSyncOperationalState(
      facts({ status: "running", lastAttemptAt: NOW - 2 * HOUR, lastHeartbeatAt: NOW - at, lastSuccessAt: NOW - 2 * HOUR }),
      NOW
    );
    expect(inside.state).toBe("running");
    expect(atBoundary.state).toBe("stale_running");
  });

  it("3c. persistent stale-running (4x threshold) escalates to error severity", () => {
    const meta = deriveSyncOperationalState(
      facts({ status: "running", lastAttemptAt: NOW - 2 * HOUR, lastHeartbeatAt: NOW - 61 * MIN, lastStartedAt: NOW - 61 * MIN }),
      NOW
    );
    expect(meta.state).toBe("stale_running");
    expect(meta.severity).toBe("error");
  });

  it("4. first-ever run with a fresh heartbeat is backfilling", () => {
    const meta = deriveSyncOperationalState(
      facts({ status: "running", lastAttemptAt: NOW - MIN, lastStartedAt: NOW - MIN, lastHeartbeatAt: NOW - 30, lastSuccessAt: null }),
      NOW
    );
    expect(meta.state).toBe("backfilling");
  });

  it("5. delayed only after nextRunAt + cadence-aware grace (not seconds late)", () => {
    // 10-min cadence → grace 10 min: due 5 min ago is still caught_up.
    const soon = deriveSyncOperationalState(
      facts({ lastAttemptAt: NOW - 15 * MIN, lastSuccessAt: NOW - 15 * MIN, nextRunAt: NOW - 5 * MIN }),
      NOW
    );
    expect(soon.state).toBe("caught_up");
    // Due 11 min ago (grace + 1) is delayed.
    const late = deriveSyncOperationalState(
      facts({ lastAttemptAt: NOW - 21 * MIN, lastSuccessAt: NOW - 21 * MIN, nextRunAt: NOW - 11 * MIN }),
      NOW
    );
    expect(late.state).toBe("delayed");
    expect(late.reason).toBe("overdue");
    expect(late.severity).toBe("warning");
    expect(late.overdueBySeconds).toBe(11 * MIN);
  });

  it("5b. grace scales with cadence (5 min floor, 30 min cap)", () => {
    expect(SYNC_HEALTH_POLICY.delayGraceSeconds(60)).toBe(5 * MIN);
    expect(SYNC_HEALTH_POLICY.delayGraceSeconds(10 * MIN)).toBe(10 * MIN);
    expect(SYNC_HEALTH_POLICY.delayGraceSeconds(HOUR)).toBe(30 * MIN);
    expect(SYNC_HEALTH_POLICY.delayGraceSeconds(6 * HOUR)).toBe(30 * MIN);
  });

  it("5c. delayed falls back to lastSuccessAt + cadence when nextRunAt is missing", () => {
    const meta = deriveSyncOperationalState(
      facts({ lastAttemptAt: NOW - 2 * HOUR, lastSuccessAt: NOW - 2 * HOUR, nextRunAt: null }),
      NOW
    );
    expect(meta.state).toBe("delayed");
    // "Since" is the missed expected-run time, not the last success.
    expect(meta.since).toBe(NOW - 2 * HOUR + 10 * MIN);
  });

  it("6. single transient failure with a scheduled retry is retrying (not failed)", () => {
    const meta = deriveSyncOperationalState(
      facts({
        status: "failed",
        lastAttemptAt: NOW - MIN,
        lastSuccessAt: NOW - HOUR,
        nextRunAt: NOW + 4 * MIN,
        errorCount: 1,
        lastErrorKind: "timeout",
      }),
      NOW
    );
    expect(meta.state).toBe("retrying");
    expect(meta.reason).toBe("timeout");
    expect(meta.retryAt).toBe(NOW + 4 * MIN);
    expect(meta.severity).toBe("info");
  });

  it("7. retry overdue beyond grace becomes failed (error severity)", () => {
    const meta = deriveSyncOperationalState(
      facts({
        status: "failed",
        lastAttemptAt: NOW - HOUR,
        nextRunAt: NOW - 20 * MIN,
        errorCount: 2,
        lastErrorKind: "network",
      }),
      NOW
    );
    expect(meta.state).toBe("failed");
    expect(meta.reason).toBe("network_error");
    expect(meta.severity).toBe("error");
    expect(meta.overdueBySeconds).toBeGreaterThan(0);
  });

  it("7b. rate-limited failure reads as retrying with the rate_limited reason", () => {
    const meta = deriveSyncOperationalState(
      facts({ status: "failed", lastAttemptAt: NOW - MIN, nextRunAt: NOW + 5 * MIN, errorCount: 1, lastErrorKind: "rate_limited" }),
      NOW
    );
    expect(meta.state).toBe("retrying");
    expect(meta.reason).toBe("rate_limited");
  });

  it("7c. stored operational reasons (worker_interrupted) pass through unchanged", () => {
    const meta = deriveSyncOperationalState(
      facts({ status: "failed", lastAttemptAt: NOW - MIN, nextRunAt: NOW + MIN, errorCount: 1, lastErrorKind: "worker_interrupted" }),
      NOW
    );
    expect(meta.state).toBe("retrying");
    expect(meta.reason).toBe("worker_interrupted");
  });

  it("7d. unknown stored kinds degrade to unknown_error, never raw prose", () => {
    const meta = deriveSyncOperationalState(
      facts({ status: "failed", lastAttemptAt: NOW - MIN, nextRunAt: NOW + MIN, errorCount: 1, lastErrorKind: "SELECT * FROM secrets" }),
      NOW
    );
    expect(meta.reason).toBe("unknown_error");
  });

  it("8. capability_denied is parked — a permission state, never a failure", () => {
    const meta = deriveSyncOperationalState(
      facts({ status: "capability_denied", lastAttemptAt: NOW - HOUR, nextRunAt: NOW + 5 * HOUR }),
      NOW
    );
    expect(meta.state).toBe("parked");
    expect(meta.reason).toBe("capability_denied");
    expect(meta.severity).toBe("warning");
  });

  it("9. no attempt ever is never_run (not delayed)", () => {
    const meta = deriveSyncOperationalState(facts({ status: "idle", nextRunAt: NOW - HOUR }), NOW);
    expect(meta.state).toBe("never_run");
  });

  it("10. repeated failures (errorCount >= 3) are degraded, above retrying", () => {
    const meta = deriveSyncOperationalState(
      facts({
        status: "failed",
        lastAttemptAt: NOW - MIN,
        nextRunAt: NOW + 4 * MIN,
        errorCount: 3,
        lastErrorKind: "upstream_error",
      }),
      NOW
    );
    expect(meta.state).toBe("degraded");
    expect(meta.reason).toBe("upstream_error");
    expect(meta.severity).toBe("warning");
  });

  it("10b. a recovered resource resets errorCount → caught_up again (not degraded forever)", () => {
    const meta = deriveSyncOperationalState(
      facts({ lastAttemptAt: NOW - MIN, lastSuccessAt: NOW - MIN, nextRunAt: NOW + 9 * MIN, errorCount: 0 }),
      NOW
    );
    expect(meta.state).toBe("caught_up");
  });

  it("10c. idle with failing categories is degraded with category_failure reason", () => {
    const meta = deriveSyncOperationalState(
      facts({ lastAttemptAt: NOW - MIN, lastSuccessAt: NOW - MIN, nextRunAt: NOW + 9 * MIN, hasCategoryProblems: true }),
      NOW
    );
    expect(meta.state).toBe("degraded");
    expect(meta.reason).toBe("category_failure");
  });

  it("11. demo-style fabricated state (success + future run) is caught_up", () => {
    const meta = deriveSyncOperationalState(
      facts({ lastAttemptAt: NOW - 30, lastSuccessAt: NOW - 30, nextRunAt: NOW + 570, frequencySeconds: 600 }),
      NOW
    );
    expect(meta.state).toBe("caught_up");
  });
});
