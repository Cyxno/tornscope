import { describe, expect, it } from "vitest";
import { deriveResourceIncidents, summarizeSyncMetrics, type SyncRunFact } from "../src/sync-health.js";

/**
 * Incident history + metrics derivation (v0.2 roadmap item #3), from
 * EXISTING SyncRun history — no new tables. Consecutive failures collapse
 * into one episode; a later success marks the episode auto-recovered; a
 * "recovered" row (written by the scheduler when it re-enqueues an orphan)
 * becomes a stale_recovered incident.
 */

const NOW = 1_800_000_000;
const MIN = 60;
const HOUR = 3600;

function run(status: string, startedAt: number, finishedAt: number | null = startedAt + 30, errorKind: string | null = null): SyncRunFact {
  return { status, startedAt, finishedAt, errorKind };
}

describe("incident derivation", () => {
  it("a single failure followed by success is one auto-recovered info episode", () => {
    const incidents = deriveResourceIncidents(
      [run("success", NOW - 3 * 3600), run("failed", NOW - 20 * MIN, NOW - 19 * MIN, "timeout"), run("success", NOW - 18 * MIN)],
      NOW
    );
    expect(incidents).toHaveLength(1);
    const inc = incidents[0]!;
    expect(inc.kind).toBe("sync_failures");
    expect(inc.reason).toBe("timeout");
    expect(inc.autoRecovered).toBe(true);
    expect(inc.failureCount).toBe(1);
    expect(inc.severity).toBe("info");
    expect(inc.endedAt).toBe(NOW - 19 * MIN);
  });

  it("consecutive failures collapse into ONE episode, not three alarms", () => {
    const incidents = deriveResourceIncidents(
      [
        run("failed", NOW - 60 * MIN, NOW - 59 * MIN, "rate_limited"),
        run("failed", NOW - 50 * MIN, NOW - 49 * MIN, "rate_limited"),
        run("failed", NOW - 40 * MIN, NOW - 39 * MIN, "rate_limited"),
        run("success", NOW - 30 * MIN),
      ],
      NOW
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.failureCount).toBe(3);
    expect(incidents[0]!.autoRecovered).toBe(true);
    expect(incidents[0]!.severity).toBe("warning");
    expect(incidents[0]!.reason).toBe("rate_limited");
  });

  it("three unrecovered failures escalate to error severity", () => {
    const incidents = deriveResourceIncidents(
      [run("failed", NOW - 60 * MIN), run("failed", NOW - 45 * MIN), run("failed", NOW - 30 * MIN)],
      NOW
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.severity).toBe("error");
    expect(incidents[0]!.autoRecovered).toBe(false);
    expect(incidents[0]!.endedAt).toBe(NOW - 30 * MIN + 30);
  });

  it("a recovered orphan run becomes a stale_recovered incident (auto-recovered)", () => {
    const incidents = deriveResourceIncidents(
      [
        run("success", NOW - 2 * 3600),
        // Scheduler wrote this row when it re-enqueued the orphaned run:
        run("recovered", NOW - 80 * MIN, NOW - 79 * MIN),
        run("success", NOW - 78 * MIN),
      ],
      NOW
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.kind).toBe("stale_recovered");
    expect(incidents[0]!.reason).toBe("worker_interrupted");
    expect(incidents[0]!.autoRecovered).toBe(true);
    expect(incidents[0]!.severity).toBe("info");
  });

  it("a recovered orphan NOT followed by success stays a warning", () => {
    const incidents = deriveResourceIncidents(
      [run("recovered", NOW - 80 * MIN, NOW - 79 * MIN), run("failed", NOW - 78 * MIN)],
      NOW
    );
    expect(incidents.some((i) => i.kind === "stale_recovered" && i.severity === "warning")).toBe(true);
  });

  it("capability-denied skips surface as permission incidents", () => {
    const incidents = deriveResourceIncidents(
      [run("success", NOW - 3 * 3600), run("skipped", NOW - HOUR, NOW - HOUR + 10)],
      NOW
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.kind).toBe("capability_denied");
    expect(incidents[0]!.reason).toBe("capability_denied");
  });

  it("episodes outside the window are dropped", () => {
    const incidents = deriveResourceIncidents(
      [run("failed", NOW - 30 * 3600, NOW - 29 * 3600), run("success", NOW - 28 * 3600), run("success", NOW - MIN)],
      NOW,
      24 * 3600
    );
    expect(incidents).toHaveLength(0);
  });

  it("ongoing failure streak has endedAt=null (still open)", () => {
    const incidents = deriveResourceIncidents([run("failed", NOW - 5 * MIN, null)], NOW);
    expect(incidents[0]!.endedAt).toBeNull();
  });
});

describe("run metrics summary", () => {
  it("computes success rate, failures, recoveries and average duration", () => {
    const metrics = summarizeSyncMetrics(
      [
        run("success", NOW - 3600, NOW - 3600 + 5),
        run("failed", NOW - 1800, NOW - 1800 + 2, "timeout"),
        run("recovered", NOW - 900, NOW - 890),
        run("success", NOW - 600, NOW - 600 + 9),
      ],
      NOW
    );
    expect(metrics.successRate24h).toBeCloseTo(2 / 3);
    expect(metrics.failures24h).toBe(1);
    expect(metrics.recoveries24h).toBe(1);
    expect(metrics.avgDurationMs24h).toBe(Math.round(((5 + 2 + 9) / 3) * 1000));
  });

  it("returns null success rate when nothing ran", () => {
    const metrics = summarizeSyncMetrics([], NOW);
    expect(metrics.successRate24h).toBeNull();
    expect(metrics.failures24h).toBe(0);
  });
});
