import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * System health page contract (2.0). The /system page loads through the
 * typed API client (never raw fetch), renders its three sections with aria
 * headings, keeps real table semantics for the freshness table and pauses
 * its 30s poll while the tab is hidden. Mirrors the sync-health-copy
 * static-contract style.
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const page = read("../src/routes/system/+page.svelte");
const view = read("../src/lib/system-view.ts");

describe("System health page — data contract", () => {
  it("loads system health through the typed api client", () => {
    expect(page).toContain("endpoints.systemHealth()");
    expect(page).toContain('"$lib/api"');
  });

  it("no raw client fetch anywhere", () => {
    expect(page).not.toMatch(/\bfetch\(/);
    expect(view).not.toMatch(/\bfetch\(/);
  });

  it("bootstraps on mount (client-only) and cleans up its poll timer", () => {
    expect(page).toContain("onMount(");
    expect(page).toMatch(/return \(\) => clearInterval\(poll\);/);
  });

  it("polls every 30s and pauses while the tab is hidden", () => {
    expect(page).toContain("30_000");
    expect(page).toMatch(/setInterval\(\(\) => \{\s*if \(document\.visibilityState === "visible"\) void load\(\);\s*\}, 30_000\)/);
  });
});

describe("System health page — sections", () => {
  it("renders the three sections with aria headings", () => {
    expect(page).toContain('aria-label="Services"');
    expect(page).toContain('aria-label="Sync"');
    expect(page).toContain('aria-label="Data freshness"');
  });

  it("services render as named status rows driven by the view mapping", () => {
    expect(page).toContain("deriveServiceRows(");
    expect(page).toContain("row.chip.label");
  });

  it("the sync section shows the running indicator, queue line and failing resources", () => {
    expect(page).toContain("deriveSyncSummary(");
    expect(page).toContain("sync.queueLine");
    expect(page).toContain("sync.failing");
    expect(page).toContain("live-dot");
  });

  it("the freshness table keeps real table semantics", () => {
    expect(page).toContain("<table");
    expect(page).toMatch(/<th [^>]*scope="col"/);
    expect(page).toContain("<caption");
    expect(page).toContain("sortFreshnessWorstFirst(");
  });

  it("status is conveyed by text chips built from the shared labels — never color alone", () => {
    expect(page).toContain("freshnessChip(");
    expect(view).toContain("DATA_FRESHNESS_STATUS_LABELS");
    expect(view).toContain('torn_api_unreachable: "Torn API unreachable"');
  });

  it("live domains read as on-demand, not as a stale age", () => {
    expect(page).toContain("Live (on demand)");
    expect(page).toContain("row.live");
  });

  it("humanizes last error kinds only when present", () => {
    expect(page).toMatch(/\{#if row\.lastErrorKind\}/);
    expect(page).toContain("humanizeErrorKind(");
  });
});
