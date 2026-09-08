import { describe, expect, it } from "vitest";
import { humanLabel, incomeLabel, expenseLabel, CANONICAL_LABELS } from "../src/labels.js";

/**
 * Canonical label contract: ONE mapping for every backend slug. No page may
 * render raw lowercase slugs or hand-roll its own title-casing.
 */
describe("humanLabel (canonical map)", () => {
  it("maps the confirmed production leaks", () => {
    expect(humanLabel("plushie")).toBe("Plushies");
    expect(humanLabel("casino")).toBe("Casino");
  });

  it("maps the spec's required domain terms", () => {
    expect(humanLabel("bank_investment")).toBe("Bank Investment");
    expect(humanLabel("city_bank")).toBe("City Bank");
    expect(humanLabel("ranked_war")).toBe("Ranked War");
    expect(humanLabel("item_market")).toBe("Item Market");
    expect(humanLabel("housing")).toBe("Property");
    expect(humanLabel("faction")).toBe("Faction");
    expect(humanLabel("travel")).toBe("Travel Goods");
  });

  it("uses plural group labels for multi-item categories", () => {
    expect(CANONICAL_LABELS["plushie"]).toBe("Plushies");
    expect(CANONICAL_LABELS["flower"]).toBe("Flowers");
    expect(CANONICAL_LABELS["xanax"]).toBe("Xanax"); // drug name: singular is official
    expect(CANONICAL_LABELS["drugs"]).toBe("Drugs");
    expect(CANONICAL_LABELS["weapon"]).toBe("Weapons");
    expect(CANONICAL_LABELS["vehicle"]).toBe("Vehicles");
  });

  it("never returns an all-lowercase slug for known or snake_case terms", () => {
    for (const slug of ["plushie", "casino", "city_bank", "ranked_war", "drug_pack"]) {
      const label = humanLabel(slug);
      expect(label[0]).toBe(label[0]!.toUpperCase());
      expect(label).not.toBe(slug);
    }
  });
});

describe("finance context labels (charts and tables share these)", () => {
  it("income context uses sales-oriented noun phrases", () => {
    expect(incomeLabel("bazaar")).toBe("Bazaar Sales");
    expect(incomeLabel("items")).toBe("Item Market Sales");
    expect(incomeLabel("crime")).toBe("Crime Cash");
    expect(incomeLabel("faction")).toBe("Faction Income");
    expect(incomeLabel("salary")).toBe("Salary");
    expect(incomeLabel("other")).toBe("Other Received");
  });

  it("expense context uses purchase/expense noun phrases", () => {
    expect(expenseLabel("plushie")).toBe("Plushies Bought");
    expect(expenseLabel("flower")).toBe("Flowers Bought");
    expect(expenseLabel("travel")).toBe("Travel Goods Bought");
    expect(expenseLabel("items")).toBe("Item Market Purchases");
    expect(expenseLabel("housing")).toBe("Property Rent & Upkeep");
    expect(expenseLabel("gym")).toBe("Gym Membership");
    expect(expenseLabel("rehab")).toBe("Rehab");
  });

  it("is the same source the analytics breakdown uses", async () => {
    const analytics = await import("../src/labels.js");
    // analytics money.ts re-uses the shared maps (single source of truth)
    const money = await import("../../analytics/src/money.js");
    expect(money.CASH_INCOME_LABELS).toBe(analytics.INCOME_LABELS);
    expect(money.CASH_EXPENSE_LABELS).toBe(analytics.EXPENSE_LABELS);
  });
});
