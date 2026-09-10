import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Economy page copy contracts (roadmap #6, phase 34).
 *
 * The Economy page must keep cash movement, conversions, economic effect and
 * net worth semantically distinct in its USER-FACING words: "cash received",
 * never "income"; "economic effect", never "profit"; residuals worded as
 * "unexplained by available money logs", never "missing". Reading the page
 * source keeps these guarantees testable without a browser.
 */
const page = readFileSync(join(__dirname, "../src/routes/money/+page.svelte"), "utf8");

describe("economy page semantic copy", () => {
  it("labels cash movement as cash, never as income/expenses", () => {
    expect(page).toContain("Cash received");
    expect(page).toContain("Cash spent");
    expect(page).toContain("Net cash movement");
    // The words Income/Expenses must not appear as KPI labels.
    expect(page).not.toMatch(/label="\{period\} Income"/);
    expect(page).not.toMatch(/label="\{period\} Expenses"/);
    expect(page).not.toMatch(/label="Income"/);
    expect(page).not.toMatch(/label="Expenses"/);
  });

  it("never claims profit — economic effect and hedges only", () => {
    expect(page).toContain("economic effect, not profit");
    expect(page).toContain("not profit");
    // Any occurrence of the word profit must be inside a negation/hedge or
    // the travel-profit label (itself provenance-marked estimated).
    for (const match of page.matchAll(/[Pp]rofit/g)) {
      const context = page.slice(Math.max(0, match.index! - 60), match.index! + 60);
      expect(context, `unhedged "profit" near: …${context}…`).toMatch(
        /not profit|not called profit|never labeled profit|not "profit"|never "profit"|is not profit|travel profit|estimatedProfit/i
      );
    }
  });

  it("keeps conversion wording explicit", () => {
    expect(page).toContain("Asset conversions");
    expect(page).toContain("asset conversion");
    expect(page).toContain("Cash → assets");
    expect(page).toContain("Assets → cash");
  });

  it("words residuals honestly — unexplained, never missing", () => {
    expect(page).toContain("unexplained by available money logs");
    expect(page).toContain("Residual");
    // No "is missing" / "missing $" claims about money.
    expect(page).not.toMatch(/is missing/i);
  });

  it("presents net worth as a snapshot movement with hedged contributors", () => {
    expect(page).toContain("not profit");
    expect(page).toContain("recorded movements, not proven causes");
    expect(page).toContain("Insufficient history");
  });

  it("keeps provenance visible and confidence wired from the API", () => {
    expect(page).toMatch(/provenance="estimated"|ProvenanceBadge level="estimated"/);
    expect(page).toContain("estimated");
    expect(page).toContain("confidence={economy.confidence");
    expect(page).toContain("confidence={economy.economicEffect.confidence}");
  });

  it("distinguishes zero from unavailable through the shared formatter", () => {
    // formatKpiValue renders $0 only for confirmed zeros and — otherwise.
    expect(page).toContain("formatKpiValue(");
    expect(page).toContain('"Insufficient history"');
  });

  it("renders a keyboard-accessible lens switcher on small screens", () => {
    expect(page).toContain("LensSwitcher");
    expect(page).toContain('role="tabpanel"');
  });

  it("surfaces the wallet reconciliation with snapshot anchors", () => {
    expect(page).toContain("Wallet reconciliation");
    expect(page).toContain("Opening wallet");
    expect(page).toContain("Expected closing");
    expect(page).toContain("Actual closing");
    expect(page).toContain("% of the wallet movement is explained by available history");
  });

  it("shows major movements with their semantic role", () => {
    expect(page).toContain("Major movements");
    expect(page).toContain("m.role.replace");
  });
});
