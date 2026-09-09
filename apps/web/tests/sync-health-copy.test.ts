import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SYNC_OPERATION_REASONS, SYNC_OPERATIONAL_STATES } from "@tornscope/shared";
import {
  INCIDENT_KIND_COPY,
  INCIDENT_REASON_COPY,
  OPERATION_REASON_COPY,
  OPERATIONAL_LABELS,
  operationalTitle,
  SEVERITY_LABELS,
  SEVERITY_STYLES,
} from "../src/lib/syncHealth.js";

/**
 * Sync Status copy contract (v0.2 roadmap item #3).
 *
 * Every machine state/reason code must have localized copy — raw codes like
 * "stale_running" or "rate_limited" must never render. The copy module is
 * the ONLY place status strings live, mirroring confidence.ts.
 */

const PAGE_SOURCE = readFileSync(fileURLToPath(new URL("../src/routes/sync/+page.svelte", import.meta.url)), "utf8");

describe("operational state copy", () => {
  it("has a label for every operational state", () => {
    for (const state of SYNC_OPERATIONAL_STATES) {
      const style = OPERATIONAL_LABELS[state];
      expect(style, `missing label for state ${state}`).toBeTruthy();
      expect(style.label.length).toBeGreaterThan(0);
      expect(style.dot).toContain("bg-");
    }
  });

  it("has copy for every machine reason code", () => {
    for (const reason of SYNC_OPERATION_REASONS) {
      expect(OPERATION_REASON_COPY[reason], `missing tooltip copy for reason ${reason}`).toBeTruthy();
      // "none" is a healthy state — it has no incident wording by design.
      expect(reason === "none" || INCIDENT_REASON_COPY[reason], `missing incident copy for reason ${reason}`).toBeTruthy();
    }
  });

  it("builds tooltips from state meaning + reason, never from raw codes", () => {
    const title = operationalTitle({
      state: "retrying",
      reason: "rate_limited",
      since: null,
      overdueBySeconds: null,
      retryAt: 42,
      recoverable: true,
      severity: "info",
    });
    expect(title).toContain("automatic retry is scheduled");
    expect(title).toContain("rate-limited");
    expect(title).not.toContain("rate_limited");
    expect(title).not.toContain("retrying");
  });

  it("covers incident kinds and severity styles", () => {
    for (const kind of ["sync_failures", "stale_recovered", "capability_denied"] as const) {
      expect(INCIDENT_KIND_COPY[kind]).toBeTruthy();
    }
    // Severity styles are chip modifiers (v0.2 design system): combined with
    // the .chip primitive they must produce a visible status treatment —
    // warning and error are color-coded, info stays intentionally neutral.
    for (const severity of ["info", "warning", "error"] as const) {
      expect(SEVERITY_LABELS[severity]).toBe(severity);
      expect(["", "chip-warning", "chip-negative"]).toContain(SEVERITY_STYLES[severity]);
    }
  });

  it("the Sync Status page maps states through the copy module (no raw state rendering)", () => {
    // The page imports the copy module...
    expect(PAGE_SOURCE).toContain('"$lib/syncHealth"');
    // ...and never renders the raw operational state/reason fields.
    expect(PAGE_SOURCE).not.toMatch(/\{row\.operational\.state\}/);
    expect(PAGE_SOURCE).not.toMatch(/\{op\.state\}/);
    expect(PAGE_SOURCE).not.toMatch(/\{op\.reason\}/);
    expect(PAGE_SOURCE).not.toMatch(/\{row\.status\}/);
  });
});
