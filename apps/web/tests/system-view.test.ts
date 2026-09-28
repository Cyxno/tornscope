import { describe, expect, it } from "vitest";
import type { DataFreshnessEntry, DataFreshnessStatus, SystemHealthResponse } from "@tornscope/shared";
import { DATA_FRESHNESS_STATUS_LABELS } from "@tornscope/shared";
import {
  deriveFailingResources,
  deriveServiceRows,
  deriveSyncSummary,
  formatAge,
  formatAgeCompact,
  freshnessChip,
  humanizeErrorKind,
  queueSummary,
  serviceStatusChip,
  sortFreshnessWorstFirst,
} from "../src/lib/system-view";

/**
 * System health view derivation (2.0). Logic-level tests: status chips are
 * semantic (success/critical/warning/neutral) AND text-labelled, ages read
 * "2m ago" / "3m" style, error kinds are humanized (raw codes never leak),
 * the queue collapses into one calm line and freshness sorts worst-first.
 */

const NOW = 1_000_000;

function freshnessEntry(over: Partial<DataFreshnessEntry> = {}): DataFreshnessEntry {
  return {
    domain: "money",
    label: "Money logs",
    status: "fresh",
    ageSeconds: 60,
    lastSuccessAt: NOW - 60,
    lastErrorKind: null,
    resources: [],
    live: false,
    ...over,
  };
}

function healthFixture(over: Partial<SystemHealthResponse> = {}): SystemHealthResponse {
  return {
    generatedAt: NOW,
    services: {
      api: { status: "ok", version: "1.0.4", gitSha: "a1b2c3d4e5f6", environment: "production" },
      database: { status: "ok" },
      redis: { status: "ok" },
      worker: { status: "ok", heartbeatAgeSeconds: 120 },
      tornApi: { status: "ok", lastSuccessAt: NOW - 30, note: "All Torn endpoints responding." },
    },
    sync: {
      running: true,
      failingResources: [],
      lastSuccessAt: NOW - 300,
      queue: { waiting: 0, active: 1, delayed: 0, failed: 0, oldestOutstandingAt: NOW - 90 },
    },
    freshness: [],
    ...over,
  } as SystemHealthResponse;
}

describe("service status chips", () => {
  it("ok reads as success, degraded as warning, unreachable/stale as critical", () => {
    expect(serviceStatusChip("ok")).toEqual({ label: "Operational", chip: "chip-positive" });
    expect(serviceStatusChip("degraded").chip).toBe("chip-warning");
    expect(serviceStatusChip("unreachable").chip).toBe("chip-negative");
    expect(serviceStatusChip("stale").chip).toBe("chip-negative");
  });

  it("unknown statuses stay neutral and never render a raw code", () => {
    const chip = serviceStatusChip("something_else");
    expect(chip.chip).toBe("");
    expect(chip.label).toBe("Something Else");
    expect(chip.label).not.toContain("_");
  });

  it("every chip carries a text label — status is never color alone", () => {
    for (const status of ["ok", "degraded", "unreachable", "stale", "unknown", "mystery"]) {
      expect(serviceStatusChip(status).label.length).toBeGreaterThan(0);
    }
  });
});

describe("service rows", () => {
  it("renders the five services in order with human names", () => {
    const rows = deriveServiceRows(healthFixture().services);
    expect(rows.map((r) => r.name)).toEqual(["API", "PostgreSQL", "Redis", "Worker", "Torn API"]);
  });

  it("the API row shows the version and the SHORT git sha", () => {
    const api = deriveServiceRows(healthFixture().services)[0]!;
    expect(api.detail).toBe("1.0.4 · a1b2c3d");
    expect(api.detail!.length).toBeLessThan(20);
  });

  it("the Worker row shows the heartbeat age, or admits there is none", () => {
    const rows = deriveServiceRows(healthFixture().services);
    expect(rows[3]!.detail).toBe("Heartbeat 2m ago");
    const quiet = deriveServiceRows(healthFixture({ services: { ...healthFixture().services, worker: { status: "stale", heartbeatAgeSeconds: null } } }).services);
    expect(quiet[3]!.detail).toBe("No heartbeat yet");
    expect(quiet[3]!.chip.chip).toBe("chip-negative");
  });

  it("the Torn API row carries the note", () => {
    const torn = deriveServiceRows(healthFixture().services)[4]!;
    expect(torn.detail).toBe("All Torn endpoints responding.");
  });
});

describe("ages", () => {
  it("formatAge reads 2m-ago style", () => {
    expect(formatAge(45)).toBe("just now");
    expect(formatAge(120)).toBe("2m ago");
    expect(formatAge(3 * 3_600)).toBe("3h ago");
    expect(formatAge(2 * 86_400)).toBe("2d ago");
    expect(formatAge(null)).toBe("—");
    expect(formatAge(-5)).toBe("—");
  });

  it("formatAgeCompact reads compact table-cell style", () => {
    expect(formatAgeCompact(45)).toBe("45s");
    expect(formatAgeCompact(180)).toBe("3m");
    expect(formatAgeCompact(7_200)).toBe("2h");
    expect(formatAgeCompact(5 * 86_400)).toBe("5d");
    expect(formatAgeCompact(null)).toBe("—");
  });
});

describe("error kind humanization", () => {
  it("maps the system-level why-codes", () => {
    expect(humanizeErrorKind("torn_api_unreachable")).toBe("Torn API unreachable");
  });

  it("reuses the sync-health reason copy where applicable", () => {
    expect(humanizeErrorKind("rate_limited")).toBe("Rate limited by Torn");
    expect(humanizeErrorKind("timeout")).toBe("Timed out");
    expect(humanizeErrorKind("capability_denied")).toBe("Permission missing");
  });

  it("a null, undefined or 'none' error kind renders nothing", () => {
    expect(humanizeErrorKind(null)).toBeNull();
    expect(humanizeErrorKind(undefined)).toBeNull();
    expect(humanizeErrorKind("none")).toBeNull();
  });

  it("unknown kinds get a human label — raw codes never leak", () => {
    const label = humanizeErrorKind("brand_new_failure");
    expect(label).toBe("Brand New Failure");
    expect(label).not.toContain("_");
  });
});

describe("queue summary", () => {
  it("collapses nonzero counts into one line, human words first", () => {
    expect(queueSummary({ waiting: 2, active: 1, delayed: 3, failed: 1, oldestOutstandingAt: null })).toBe(
      "1 running · 2 waiting · 3 scheduled · 1 failed"
    );
  });

  it("an all-zero queue reads as calm, not broken", () => {
    expect(queueSummary({ waiting: 0, active: 0, delayed: 0, failed: 0, oldestOutstandingAt: null })).toBe(
      "Queue is empty — every job has run."
    );
  });
});

describe("sync summary", () => {
  it("summarizes running state, queue, ages and failing resources", () => {
    const sync = healthFixture({
      sync: {
        running: false,
        lastSuccessAt: NOW - 600,
        failingResources: [{ resource: "money_logs", state: "retrying", lastErrorKind: "rate_limited" }],
        queue: { waiting: 1, active: 0, delayed: 0, failed: 1, oldestOutstandingAt: NOW - 3_600 },
      },
    }).sync;
    const summary = deriveSyncSummary(sync, NOW);
    expect(summary.running).toBe(false);
    expect(summary.queueLine).toBe("1 waiting · 1 failed");
    expect(summary.oldestOutstanding).toBe("1h ago");
    expect(summary.lastSuccess).toBe("10m ago");
    expect(summary.failing).toHaveLength(1);
    expect(summary.failing[0]!.name).toBe("Economy & money logs");
    expect(summary.failing[0]!.stateLabel).toBe("Retrying");
    expect(summary.failing[0]!.errorLabel).toBe("Rate limited by Torn");
  });

  it("a clear queue has no oldest-outstanding age and no failures", () => {
    const sync = healthFixture({
      sync: { running: false, failingResources: [], lastSuccessAt: null, queue: { waiting: 0, active: 0, delayed: 0, failed: 0, oldestOutstandingAt: null } },
    }).sync;
    const summary = deriveSyncSummary(sync, NOW);
    expect(summary.oldestOutstanding).toBeNull();
    expect(summary.lastSuccess).toBe("never");
    expect(summary.failing).toEqual([]);
  });

  it("unknown resource/state codes humanize without leaking raw slugs", () => {
    const rows = deriveFailingResources([{ resource: "brand_new_resource", state: "brand_new_state", lastErrorKind: null }]);
    expect(rows[0]!.name).toBe("Brand New Resource");
    expect(rows[0]!.stateLabel).toBe("Brand New State");
    expect(rows[0]!.errorLabel).toBeNull();
  });
});

describe("data freshness", () => {
  it("sorts worst-first: failed, stale, delayed, unavailable, fresh", () => {
    const rows = sortFreshnessWorstFirst([
      freshnessEntry({ domain: "a", status: "fresh" }),
      freshnessEntry({ domain: "b", status: "failed" }),
      freshnessEntry({ domain: "c", status: "delayed" }),
      freshnessEntry({ domain: "d", status: "stale" }),
      freshnessEntry({ domain: "e", status: "unavailable" }),
    ]);
    expect(rows.map((r) => r.status)).toEqual(["failed", "stale", "delayed", "unavailable", "fresh"]);
  });

  it("does not mutate the input and keeps registry order within a rank", () => {
    const input = [
      freshnessEntry({ domain: "a", status: "delayed" }),
      freshnessEntry({ domain: "b", status: "fresh" }),
      freshnessEntry({ domain: "c", status: "delayed" }),
    ];
    const rows = sortFreshnessWorstFirst(input);
    expect(input.map((r) => r.domain)).toEqual(["a", "b", "c"]);
    expect(rows.map((r) => r.domain)).toEqual(["a", "c", "b"]);
  });

  it("chips use the shared status labels with semantic classes", () => {
    const expected: Record<DataFreshnessStatus, string> = {
      fresh: "chip-positive",
      delayed: "chip-warning",
      stale: "chip-warning",
      failed: "chip-negative",
      unavailable: "chip-warning",
    };
    for (const [status, chip] of Object.entries(expected) as Array<[DataFreshnessStatus, string]>) {
      const result = freshnessChip(status);
      expect(result.chip).toBe(chip);
      expect(result.label).toBe(DATA_FRESHNESS_STATUS_LABELS[status]);
    }
  });
});
