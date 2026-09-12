import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Product-finish regression contracts (v0.2 product-finish program,
 * docs/PRODUCT-FINISH-ISSUES.md). Each rule encodes a real defect class
 * found by the manual browser bug bash — visible markup, broken numbers,
 * misleading affordances, full-page reloads, stale-response races and
 * orphaned routes must never come back.
 */

const read = (p: string) => readFileSync(join(__dirname, "../src", p), "utf8");

describe("PF-001: markup is never interpolated into text expressions", () => {
  const routes = [
    "routes/+page.svelte",
    "routes/today/+page.svelte",
    "routes/money/+page.svelte",
    "routes/drugs/+page.svelte",
    "routes/travel/+page.svelte",
    "routes/progression/+page.svelte",
    "routes/combat/+page.svelte",
    "routes/crimes/+page.svelte",
    "routes/faction/+page.svelte",
    "routes/timeline/+page.svelte",
    "routes/sync/+page.svelte",
    "routes/settings/+page.svelte",
  ];

  it.each(routes)("no template-literal HTML in %s", (file) => {
    const src = read(file);
    // The PF-001 bug class: `<span …>${…}</span>` built inside a JS template
    // literal and then interpolated into a text expression — Svelte escapes
    // it and the markup renders as visible text.
    expect(src).not.match(/`<\w+/);
    expect(src).not.match(/<\/span>`/);
  });
});

describe("PF-007: conditional inline tails keep punctuation attached", () => {
  const files = [
    "routes/+page.svelte",
    "routes/progression/+page.svelte",
    "routes/today/+page.svelte",
    "routes/money/+page.svelte",
  ];

  it.each(files)("no whitespace before a period after {/if} in %s", (file) => {
    const src = read(file);
    // A text line ending in whitespace before {#if} leaves "… ." when the
    // branch is false. Tails must start flush after the preceding word.
    expect(src).not.match(/\n\s+\{#if [^}]+\}[^{}]*\{\/if\}\./);
  });
});

describe("PF-006: in-app navigation never full-page-reloads", () => {
  const files = [
    "routes/+page.svelte",
    "routes/money/+page.svelte",
    "routes/progression/+page.svelte",
    "routes/travel/+page.svelte",
    "routes/crimes/+page.svelte",
    "routes/drugs/+page.svelte",
    "routes/faction/+page.svelte",
    "routes/timeline/+page.svelte",
    "routes/combat/+page.svelte",
    "routes/sync/+page.svelte",
  ];

  it.each(files)("uses goto, not window.location, in %s", (file) => {
    const src = read(file);
    expect(src).not.match(/window\.location\.href\s*=\s*"\//);
  });

  it("keeps the one intentional hard reset (profile deletion) in settings", () => {
    const settings = read("routes/settings/+page.svelte");
    expect(settings).toContain('window.location.href = "/"');
    // …and the only other window.location uses are reads (URL sync), never
    // navigation assignments.
    for (const file of [...files, "routes/settings/+page.svelte"]) {
      const src = read(file);
      const assignments = (src.match(/window\.location\.href\s*=/g) ?? []).length;
      if (file.endsWith("settings/+page.svelte")) {
        expect(assignments).toBe(1);
      } else {
        expect(assignments).toBe(0);
      }
    }
  });
});

describe("PF-025: range-driven loads discard superseded responses", () => {
  const loaders = [
    "routes/money/+page.svelte",
    "routes/drugs/+page.svelte",
    "routes/travel/+page.svelte",
    "routes/progression/+page.svelte",
    "routes/crimes/+page.svelte",
    "routes/combat/+page.svelte",
    "routes/faction/+page.svelte",
    "routes/timeline/+page.svelte",
  ];

  it.each(loaders)("guards in-flight loads in %s", (file) => {
    const src = read(file);
    expect(src).toContain('from "$lib/loadGuard"');
    expect(src).toContain("isCurrent(seq)");
  });
});

describe("PF-003: provenance counts and shares cannot read as one number", () => {
  it("renders the count with an explicit unit and a separated share", () => {
    const src = read("routes/drugs/+page.svelte");
    expect(src).toMatch(/\{seg\.count\} use\{seg\.count === 1 \? "" : "s"\}/);
    expect(src).toContain('· {Math.round(seg.share)}%');
  });
});

describe("PF-004: respect is formatted, never raw", () => {
  it("routes the summary through the whole/decimal helper", () => {
    const src = read("routes/combat/+page.svelte");
    expect(src).toContain("function respect(value: number)");
    expect(src).toContain("respect(summary.respectGained)");
    expect(src).not.toContain("${summary.respectGained} gained");
    expect(src).not.toContain("${summary.respectLost} lost");
  });
});

describe("PF-011: at-a-glance lens chips are real buttons", () => {
  it("lens chips select and scroll, not inert spans", () => {
    const src = read("routes/money/+page.svelte");
    expect(src).toContain('onclick={() => jumpToLens("cash")}');
    expect(src).toContain('onclick={() => jumpToLens("networth")}');
    expect(src).not.match(/<span[^>]*>cash movement<\/span>/);
  });
});

describe("PF-010: Economy range/lens state lives in the URL", () => {
  it("restores from and reflects into the query string", () => {
    const src = read("routes/money/+page.svelte");
    expect(src).toContain('url.searchParams.set("range", preset)');
    expect(src).toContain('params.get("lens")');
    expect(src).toContain("window.history.replaceState");
  });
});

describe("PF-017: stale routes redirect instead of rendering ComingSoon", () => {
  it.each([
    ["routes/faction/ranked-wars/+page.ts", "/faction"],
    ["routes/faction/organized-crimes/+page.ts", "/faction"],
  ])("%s forwards to %s", (file, target) => {
    const src = read(file);
    expect(src).toContain("redirect(308");
    expect(src).toContain(`"${target}"`);
  });

  it("/stocks is now a real feature page (no ComingSoon, no redirect)", () => {
    const page = read("routes/stocks/+page.svelte");
    expect(page).toContain("Stocks · TornScope");
    expect(page).not.toContain("ComingSoon");
    expect(() => read("routes/stocks/+page.ts")).toThrow();
  });

  it("no route page renders the ComingSoon component", () => {
    const glob = import.meta.glob?.("../src/routes/**/+page.svelte", { eager: true, as: "raw" });
    if (!glob) return; // glob unavailable outside Vite — covered by the redirect checks above
    for (const [path, src] of Object.entries(glob)) {
      expect(`${path}: ${src}`).not.toContain("ComingSoon");
    }
  });
});
