import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Static source contract for the Insights page (same style as
 * product-finish.test.ts). Pins the load path, the manual (non-polled)
 * refresh, the category filter, evidence + provenance rendering and the
 * honest empty states.
 */

const read = (p: string) => readFileSync(join(__dirname, "../src", p), "utf8");
const page = () => read("routes/insights/+page.svelte");

describe("insights page loads through the typed API client", () => {
  it("uses endpoints.insights with the typed error channel", () => {
    const src = page();
    expect(src).toContain("endpoints.insights()");
    expect(src).toContain("ApiClientError");
  });

  it("never calls fetch directly and never assigns window.location", () => {
    const src = page();
    expect(src).not.match(/\bfetch\(/);
    expect(src).not.match(/window\.location\.href\s*=/);
  });

  it("does not poll — insights are slow-moving, refresh is manual", () => {
    const src = page();
    expect(src).not.toContain("setInterval");
    expect(src).toContain("Refreshing…");
    expect(src).toContain("void load(true)");
  });
});

describe("category filter", () => {
  it("chips sit in an accessible group with an All reset and pressed state", () => {
    const src = page();
    expect(src).toContain('role="group"');
    expect(src).toContain('aria-label="Filter insights by category"');
    expect(src).toContain("aria-pressed");
    expect(src).toContain('category === "all"');
    expect(src).toContain("categoryChips(");
    // The All chip itself is built by the pure helper.
    expect(read("lib/insights-view.ts")).toContain('category: "all"');
  });
});

describe("insight cards render the full evidence trail", () => {
  it("each card shows kind label, comparison and the evidence line with sample size", () => {
    const src = page();
    expect(src).toContain("kindLabel(");
    expect(src).toContain("comparisonParts(");
    expect(src).toContain("evidenceLine(");
    expect(src).toContain("→");
  });

  it("confidence and provenance badges render from existing components/vocabulary", () => {
    const src = page();
    expect(src).toContain("confidenceChip(");
    expect(src).toContain("<ProvenanceBadge");
    expect(src).toContain('"inferred"');
  });
});

describe("empty and short-history states", () => {
  it("the all-clear empty state stays positive", () => {
    const src = page();
    expect(src).toContain("Nothing worth flagging right now");
    expect(src).toContain("That's a good thing");
  });

  it("insufficient history is explained without hiding existing insights", () => {
    const src = page();
    expect(src).toContain("insufficientHistory");
    expect(src).toContain("Insights need more history");
  });

  it("an empty category filter shows a compact nudge, not a dead panel", () => {
    const src = page();
    expect(src).toContain("No insights in this category");
  });
});
