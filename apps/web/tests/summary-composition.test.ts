import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * V1.0 summary-composition contracts (product-wide hierarchy pass).
 *
 * Pins the conditional, range-aware summary rules at source level:
 *  - gain/day appears only when the analytics make it meaningful;
 *  - awards never occupy a hero slot (zero or otherwise) — they live in
 *    Milestones and only when non-zero;
 *  - the gym-attributed card appears only when the split is informative;
 *  - the summary grid renders however many cards earn a slot.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const progression = read("../../web/src/routes/progression/+page.svelte");
const uiDesign = read("../../../docs/UI-DESIGN.md");

describe("progression summary composition", () => {
  it("gain/day is promoted only when a full day of history makes it meaningful", () => {
    // The card is built strictly inside the non-null guard — no dead card,
    // no "less than a day of history" placeholder in the grid.
    expect(progression).toContain("if (p.summary.gainPerDay.value !== null)");
    expect(progression).not.toContain("less than a day of history");
  });

  it("awards never occupy a summary slot — they live in Milestones when non-zero", () => {
    expect(progression).not.toContain('label: "Awards');
    expect(progression).not.toContain('Awards {period}');
    const milestones = progression.indexOf('Panel title="Milestones"');
    const awardRow = progression.indexOf("Awards earned");
    expect(awardRow).toBeGreaterThan(milestones);
    expect(progression).toContain("awardsDelta !== 0");
  });

  it("gym-attributed card appears only when the split is informative", () => {
    expect(progression).toContain("gym !== p.summary.totalDelta.value");
  });

  it("the grid renders conditionally — however many cards earn a slot", () => {
    expect(progression).toContain("{#each summaryCards as card, i (card.label)}");
    expect(progression).toContain("summaryGridClass");
  });

  it("the period is named once — human range headline replaces repeated tokens", () => {
    expect(progression).toContain("rangeHeadline");
    expect(progression).toContain('"Training — current Torn day"');
    expect(progression).toContain('"Training — last 7 Torn days"');
    expect(progression).toContain('"Training — selected range"');
    expect(progression).not.toContain("{period} in training");
    expect(progression).not.toContain('label="{period} change"');
  });
});

describe("product-wide summary rules", () => {
  it("the summary admission / zero / conditional composition rules are documented", () => {
    expect(uiDesign).toContain("Summary admission rule");
    expect(uiDesign).toContain("Range-aware rule");
    expect(uiDesign).toContain("Zero / unavailable rule");
    expect(uiDesign).toContain("Conditional composition");
  });
});
