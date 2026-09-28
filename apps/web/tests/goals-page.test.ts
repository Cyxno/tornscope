import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Static source contract for the Goals page (same style as
 * product-finish.test.ts). Pins the load path, the accessible create form,
 * the honest empty state, the progressbar semantics and the "never a full
 * page reload / never a raw fetch" rule.
 */

const read = (p: string) => readFileSync(join(__dirname, "../src", p), "utf8");
const page = () => read("routes/goals/+page.svelte");

describe("goals page loads through the typed API client", () => {
  it("uses endpoints.goals and reloads after every mutation", () => {
    const src = page();
    expect(src).toContain("endpoints.goals(");
    expect(src).toContain("endpoints.createGoal(");
    expect(src).toContain("endpoints.updateGoal(");
    expect(src).toContain("endpoints.deleteGoal(");
    expect(src).toContain("ApiClientError");
  });

  it("never calls fetch directly and never assigns window.location (no full-page reloads)", () => {
    const src = page();
    expect(src).not.match(/\bfetch\(/);
    expect(src).not.match(/window\.location\.href\s*=/);
    expect(src).not.match(/document\.location/);
  });
});

describe("goals page renders an accessible create form", () => {
  it("the form, its metric select and its controls carry accessible names", () => {
    const src = page();
    expect(src).toContain('aria-label="New goal"');
    expect(src).toMatch(/<form[^>]*aria-label="New goal"/);
    expect(src).toContain("<select");
    expect(src).toContain('type="number"');
    expect(src).toContain('type="date"');
    expect(src).toContain('type="submit"');
    // Metric options come from the response registry, not a hand-written list.
    expect(src).toContain("data.metrics");
  });

  it("validation and API errors surface as inline text, never alerts", () => {
    const src = page();
    expect(src).toContain('role="alert"');
    expect(src).toContain("createError");
    expect(src).not.match(/window\.alert\(/);
  });
});

describe("goals page shows the inviting empty state", () => {
  it("uses StateMessage with copy that invites the first goal", () => {
    const src = page();
    expect(src).toContain("<StateMessage");
    expect(src).toContain("No goals yet");
    expect(src).toContain("Set a target — TornScope projects when you'll get there from your own history.");
  });
});

describe("goal cards are honest and accessible", () => {
  it("the progress bar exposes progressbar semantics", () => {
    const src = page();
    expect(src).toContain('role="progressbar"');
    expect(src).toContain("aria-valuemin");
    expect(src).toContain("aria-valuemax");
    expect(src).toContain("aria-valuenow");
  });

  it("a missing current value renders 'No data yet', never a zero", () => {
    const src = page();
    expect(src).toContain("No data yet");
  });

  it("withheld projections render mapped copy — never the machine reason codes", () => {
    const src = page();
    expect(src).toContain("insufficientReasonLabel");
    for (const code of ["insufficient_history", "no_positive_trend", "too_volatile", "beyond_horizon", "target_reached"]) {
      expect(src).not.toContain(code);
    }
  });

  it("projected goals show the date, velocity and confidence", () => {
    const src = page();
    expect(src).toContain("Projected:");
    expect(src).toContain("formatVelocity");
    expect(src).toContain("confidenceChip");
  });
});

describe("lookback selector is a segmented control", () => {
  it("groups 7/30/90 behind an accessible group with pressed state", () => {
    const src = page();
    expect(src).toContain('role="group"');
    expect(src).toContain('aria-label="Projection window"');
    expect(src).toContain("aria-pressed");
    expect(src).toContain("[7, 30, 90]");
  });

  it("changing the lookback reloads through the client, not the browser", () => {
    const src = page();
    expect(src).toContain("setLookback");
    expect(src).toContain("void load()");
  });
});
