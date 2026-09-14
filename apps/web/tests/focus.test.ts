import { describe, expect, it } from "vitest";
import { FOCUS_AREAS, DASHBOARD_MODES, overviewSectionOrder } from "../src/lib/focus.js";

/**
 * Focus areas + Simple/Advanced presentation preferences (product
 * simplification). Pure logic lives in lib/focus.ts (runes-free) so the
 * ordering contract is unit-testable; persistence is browser-local.
 */
describe("focus areas", () => {
  it("everything is the default and preserves the historical Overview order", () => {
    expect(FOCUS_AREAS[0]!.value).toBe("everything");
    expect(overviewSectionOrder("everything")).toEqual({ live: 1, networth: 2, today: 3, activity: 4, beyond: 5 });
  });

  it("wealth focus leads with the net worth hero", () => {
    const order = overviewSectionOrder("wealth");
    expect(order.networth).toBe(1);
    expect(order.today).toBe(2);
    expect(order.live).toBeGreaterThan(order.networth);
  });

  it("training focus leads with live energy and progression", () => {
    const order = overviewSectionOrder("training");
    expect(order.live).toBe(1);
    expect(order.beyond).toBe(2); // progression glimpse lives in Beyond the wallet
    expect(order.networth).toBeGreaterThan(order.beyond);
  });

  it("combat focus leads with recent activity (combat/faction/crimes)", () => {
    const order = overviewSectionOrder("combat");
    expect(order.activity).toBe(1);
    expect(order.networth).toBe(5);
  });

  it("every focus keeps ALL sections present — personalization, not permissions", () => {
    for (const f of FOCUS_AREAS) {
      const order = overviewSectionOrder(f.value);
      expect(Object.keys(order).sort()).toEqual(["activity", "beyond", "live", "networth", "today"]);
      expect(new Set(Object.values(order))).toEqual(new Set([1, 2, 3, 4, 5]));
    }
  });

  it("Simple/Advanced modes exist with Simple as the default", () => {
    expect(DASHBOARD_MODES.map((m) => m.value)).toEqual(["simple", "advanced"]);
  });
});
