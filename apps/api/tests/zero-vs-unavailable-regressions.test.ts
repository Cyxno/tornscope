import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONFIDENCE_REASONS } from "@tornscope/shared";
import { CONFIDENCE_LABELS, CONFIDENCE_REASON_COPY } from "../../web/src/lib/confidence.js";

/**
 * Zero-vs-unavailable regression guards (v0.2 roadmap item #1) and
 * localization completeness for the confidence layer.
 *
 * The null-safe mechanism exists (`formatKpiValue` + KpiValue.availability +
 * response-level confidence metadata) — these source-level guards keep the
 * known bypass sites from creeping back: missing backend values silently
 * rendered as numeric 0, or sign/tone classes derived from a fake zero.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const overview = read("../../web/src/routes/+page.svelte");
const money = read("../../web/src/routes/money/+page.svelte");
const timeline = read("../../web/src/routes/timeline/+page.svelte");
const travel = read("../../web/src/routes/travel/+page.svelte");

describe("zero-vs-unavailable regressions", () => {
  it("Overview: missing wallet bridge endpoints never render as $0", () => {
    expect(overview).not.toContain("expectedEndingCash ?? 0");
    expect(overview).not.toContain("actualEndingCash ?? 0");
  });

  it("Overview: money feed sign is derived from the real amount, not a fake zero", () => {
    expect(overview).not.toContain("(event.amount ?? 0) >= 0");
  });

  it("Overview: net worth change tone is null-guarded", () => {
    expect(overview).not.toContain("(data.networthChange.value ?? 0) >= 0");
  });

  it("Economy: expense total and networth table totals are null-safe", () => {
    expect(money).not.toContain("expenses.value ?? 0");
    expect(money).not.toContain("networth.baseline ?? 0");
    expect(money).not.toContain("networth.current.value ?? 0");
  });

  it("Economy: tones never derive from `?? 0`", () => {
    expect(money).not.toContain("netCashFlow.value ?? 0");
    expect(money).not.toContain("change.value ?? 0");
    expect(money).not.toContain("estimatedProfit.value ?? 0");
    expect(money).not.toContain("economicResult ?? 0");
  });

  it("Timeline: sign classes use the guarded amount", () => {
    expect(timeline).not.toContain("(event.amount ?? 0) >= 0");
  });

  it("Travel: estimated profit tones are null-guarded", () => {
    expect(travel).not.toContain("(summary.estimatedProfit.value ?? 0)");
    expect(travel).not.toContain("(trip.estimatedProfit ?? 0)");
    expect(travel).not.toContain("(item.estimatedProfit ?? 0)");
  });
});

describe("confidence UI wiring", () => {
  it("Overview renders badges; Economy wires confidence into its stats", () => {
    expect(overview).toContain("ConfidenceBadge");
    expect(money).toContain("confidence={economy.confidence");
    expect(read("../../web/src/routes/sync/+page.svelte")).toContain("ConfidenceBadge");
  });

  it("the Stat component carries dataset confidence beside the label", () => {
    const stat = read("../../web/src/lib/components/Stat.svelte");
    expect(stat).toContain("confidence");
  });
});

describe("daily summary UI (v0.2 item #2)", () => {
  const daily = read("../../web/src/lib/components/DailySummary.svelte");

  it("renders through the shared confidence model — no duplicated badge system", () => {
    expect(daily).toContain("ConfidenceBadge");
    expect(daily).toContain("confidenceTitle");
    expect(daily).toContain("formatKpiValue");
    // Unavailable values render through KpiValue/—, never numeric coercion.
    expect(daily).not.toMatch(/\?\? 0/);
  });

  it("keeps the financial concepts explicitly separate", () => {
    expect(daily).toContain("Cash flow");
    expect(daily).toContain("Economic effect");
    expect(daily).toContain("Conversions");
    expect(daily).toContain("not a profit figure");
  });

  it("words net-worth drivers as contributors, never causes", () => {
    expect(daily).toContain("Likely contributors — recorded movements, not causes");
    expect(daily).toMatch(/contributor/i);
    expect(daily).not.toMatch(/\bcaused\b/i);
  });

  it("labels travel profit as estimated and xanax value as consumption", () => {
    expect(daily).toContain(">estimated<");
    expect(daily).toContain("Estimated consumption value");
    expect(daily).toContain("estimated value");
  });

  it("supports date navigation without future dates and URL state", () => {
    expect(daily).toContain("no future days");
    expect(daily).toContain("history.replaceState");
    expect(daily).toContain('type="date"');
  });

  it("shows a calm empty state on quiet days", () => {
    expect(daily).toContain("A quiet day — nothing notable recorded.");
  });

  it("the new day_in_progress reason ships with localized copy", () => {
    const lib = read("../../web/src/lib/confidence.ts");
    expect(lib).toContain("day_in_progress");
    expect(daily).toContain("day in progress");
  });
});

describe("localization completeness", () => {
  it("every machine reason code has localized copy — no raw codes in the UI", () => {
    for (const reason of CONFIDENCE_REASONS) {
      expect(CONFIDENCE_REASON_COPY[reason], `missing copy for ${reason}`).toBeTruthy();
    }
  });

  it("every confidence state has a human label", () => {
    for (const state of ["complete", "partial", "stale_permission", "unavailable"] as const) {
      expect(CONFIDENCE_LABELS[state]).toBeTruthy();
    }
  });

  it("the badge component maps copy from the central module, not inline literals", () => {
    const badge = read("../../web/src/lib/components/ConfidenceBadge.svelte");
    expect(badge).toContain("CONFIDENCE_LABELS");
    expect(badge).toContain("confidenceTitle");
  });
});
