import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Semantic unit contracts (roadmap #9, phase 72) — source-level guarantees:
 *  - battlestat / energy surfaces NEVER render currency formatters;
 *  - the net-worth label never claims "profit";
 *  - happy-jump inference is never called "confirmed";
 *  - every /economy click target is gone (the route is /money).
 *
 * Reading page source keeps these testable without a browser, and a future
 * edit that reintroduces the bug fails CI instead of shipping.
 */

const read = (p: string): string => readFileSync(join(__dirname, "../src", p), "utf8");

describe("unit semantics: no currency on non-money metrics", () => {
  const progression = read("routes/progression/+page.svelte");
  // Rendered markup only (imports/代码 excluded by cutting at </script>).
  const progressionMarkup = progression.split("</script>").slice(1).join("</script>");

  it("progression page does not use currency formatters", () => {
    expect(progression).not.toMatch(/formatMoney(Compact|Full|Signed|SignedCompact)?\(/);
    expect(progression).not.toMatch(/formatSignedMoney/);
    // and it uses the number formatters instead
    expect(progression).toContain("formatNumberCompact(");
    expect(progression).toContain("formatSignedNumberCompact(");
  });

  it("progression energy flow has no literal $ in copy", () => {
    // No hand-written currency sign in the energy/battlestat copy. A "$"
    // that is part of a template interpolation (`${expr}`) is fine — this
    // matches only LITERAL dollar signs that would reach the page.
    const literalDollars = progressionMarkup.match(/(?<!\{)\$(?!\{)/g);
    expect(literalDollars, "no literal $ in progression copy").toBeNull();
  });

  it("overview progression glimpse uses number formatters", () => {
    const overview = read("routes/+page.svelte");
    expect(overview).toContain("formatNumberCompact(data.progression.battlestatGain.value)");
    expect(overview).toContain("formatNumberCompact(data.progression.energyTrained.value)");
  });

  it("daily summary training strip uses number formatters", () => {
    const daily = read("lib/components/DailySummary.svelte");
    expect(daily).toContain("formatNumberCompact(summary.progression.battlestatGain.value)");
  });
});

describe("financial semantics", () => {
  it("net worth surfaces never say profit; the disclaimer exists", () => {
    const overview = read("routes/+page.svelte");
    const daily = read("lib/components/DailySummary.svelte");
    // Labels/headings never claim profit...
    const labeled = overview + daily;
    expect(labeled).not.toMatch(/label="[^"]*[Nn]et [Ww]orth[^"]*profit/);
    expect(labeled).not.toMatch(/label="[^"]*[Nn]et [Ww]orth[^"]*"[^>]*>s*[Pp]rofit/);
    // ...and the honest delta disclaimer is present where NW is shown.
    expect(overview).toContain("Not a profit figure");
  });

  it("daily summary costs are not signed as gains", () => {
    const daily = read("lib/components/DailySummary.svelte");
    // highlightCopy signs only genuine signed movements; magnitudes stay unsigned.
    expect(daily).toContain('h.kind === "large_cash_in"');
    expect(daily).toMatch(/asset_conversion|drug_use|rehab/);
  });
});

describe("inference honesty", () => {
  it("happy jumps are never called confirmed", () => {
    const progression = read("routes/progression/+page.svelte");
    expect(progression.toLowerCase()).not.toContain("confirmed");
    // inference strength vocabulary
    expect(progression).toContain("Likely happy jump");
  });

  it("notification registry never emits a confirmed tier", () => {
    const shared = readFileSync(join(__dirname, "../../../packages/shared/src/notifications.ts"), "utf8");
    expect(shared).not.toMatch(/"confirmed"|'confirmed'/);
  });
});

describe("route integrity", () => {
  it("no click target points at the dead /economy route", () => {
    const sharedNotifications = readFileSync(join(__dirname, "../../../packages/shared/src/notifications.ts"), "utf8");
    const workerProducers = readFileSync(join(__dirname, "../../../apps/worker/src/notifications/producers.ts"), "utf8");
    for (const [name, src] of [["shared/notifications", sharedNotifications], ["worker/producers", workerProducers]] as const) {
      expect(src, name).not.toContain('"/economy"');
    }
  });
});
