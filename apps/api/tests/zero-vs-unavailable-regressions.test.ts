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

  it("presents net-worth drivers as an exact category reconciliation", () => {
    // Real-user finding: the old "Unexplained" row was a double-count
    // artifact. Drivers now sum to the change exactly; activity flows are
    // separate annotations.
    expect(daily).toContain("Category movements — they add up to the change above");
    expect(daily).toContain("Activity behind the moves");
    expect(daily).toContain("already included in the category rows above");
    expect(daily).not.toContain("Likely contributors");
  });

  it("the Today masthead always shows a real date — never an empty/dash placeholder", () => {
    // Real-user finding: while the summary request was in flight (and in the
    // date picker, whose value used to bind the empty today key) the masthead
    // rendered blanks/dashes instead of today's date.
    // 1. The picker always carries a concrete day; picking today's own key
    //    normalizes back to the canonical "" representation.
    expect(daily).toContain("value={date || todayKey}");
    expect(daily).toContain('setDay(v === todayKey ? "" : v)');
    // 2. While the summary is in flight, displayDate falls back to the
    //    selected day key itself — never "".
    expect(daily).toContain("const displayDate = $derived.by(");
    expect(daily).toContain("const key = date || todayKey;");
    expect(daily).toMatch(/if \(summary\) return formatDateInZone\(summary\.range\.from, timeZone\);[\s\S]*const key = date \|\| todayKey;/);
    // 3. The date resolves in the USER'S timezone, not UTC (a local-midnight
    //    range.from can be the previous UTC date).
    expect(daily).toContain("formatDateInZone(summary.range.from, timeZone)");
    // The old empty-string fallback must not come back.
    expect(daily).not.toContain('summary ? formatDate(summary.range.from) : ""');
  });

  it("unexplained money is inspectable, never hidden and never mislabeled", () => {
    // Real-user finding: a persistent $500k–$800k "Unexplained" row. The
    // category partition now sums to the snapshot delta exactly, and the
    // wallet equation behind the Cash row is exposed as an inspectable
    // disclosure with graded reconciliation quality.
    const wallet = read("../../web/src/lib/components/WalletEquation.svelte");
    expect(daily).toContain("WalletEquation");
    expect(wallet).toContain("Why did cash move?");
    // Human labels and the graded states — never raw internal enums.
    expect(wallet).toContain("Fully reconciled");
    expect(wallet).toContain("Partially reconciled");
    expect(wallet).toContain("Unexplained movement");
    expect(wallet).toContain("data-testid=\"wallet-equation\"");
    // The equation itself: opening + received − spent = expected vs actual.
    expect(wallet).toContain("Opening wallet");
    expect(wallet).toContain("Known cash received");
    expect(wallet).toContain("Known cash spent");
    expect(wallet).toContain("Expected closing");
    expect(wallet).toContain("Actual closing wallet");
    expect(wallet).toContain("Unexplained");
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
