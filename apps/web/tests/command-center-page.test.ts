import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Command Center — Overview integration contract (2.0). The Overview page
 * mounts the CommandCenter feed and loads it through the typed API client
 * (never raw fetch); the feed itself is a semantic list whose items keep
 * whole-row analytics links, an accessible priority label and a calm empty
 * state. Mirrors the overview-live-status static-contract style.
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const overview = read("../src/routes/+page.svelte");
const component = read("../src/lib/components/CommandCenter.svelte");
const view = read("../src/lib/command-center-view.ts");

describe("Command Center — Overview integration", () => {
  it("the Overview imports CommandCenter and calls the command-center endpoint", () => {
    expect(overview).toContain('import CommandCenter from "$lib/components/CommandCenter.svelte"');
    expect(overview).toMatch(/endpoints\s*\.commandCenter\(\)/);
    expect(overview).toContain("<CommandCenter");
  });

  it("the command-center load is non-blocking (fired alongside today(), outside the awaited Promise.all)", () => {
    expect(overview).toMatch(/void endpoints\s*\.commandCenter\(\)/);
    const promiseAll = overview.indexOf("await Promise.all");
    const ccCall = overview.indexOf(".commandCenter()");
    expect(promiseAll).toBeGreaterThan(-1);
    expect(ccCall).toBeGreaterThan(-1);
    expect(ccCall).toBeLessThan(promiseAll);
  });

  it("renders inside the cockpit zone, after the live-status block (mobile order: state first, then attention)", () => {
    const cc = overview.indexOf("<CommandCenter items=");
    const live = overview.indexOf("<LiveNow");
    expect(cc).toBeGreaterThan(-1);
    expect(live).toBeGreaterThan(-1);
    expect(live).toBeLessThan(cc);
  });

  it("the Overview caps the feed to the few items that matter NOW", () => {
    expect(overview).toContain("maxItems={3}");
  });
});

describe("Command Center — component contract", () => {
  it("the feed is a semantic list labelled Needs attention", () => {
    expect(component).toContain('role="list"');
    expect(component).toContain('role="listitem"');
    expect(component).toContain('aria-label="Needs attention"');
    expect(component).toContain(">Needs attention</p>");
    expect(component).toContain("item{feed.length === 1");
  });

  it("a whole-row stretched anchor carries the analytics destination (visible focus, no nested links)", () => {
    expect(component).toContain('class="absolute inset-0 rounded-xl focus-visible:outline-2');
    expect(component).toContain("{#if entry.analyticsUrl}");
  });

  it("priority is conveyed by text, not color alone", () => {
    expect(component).toContain("sr-only");
    expect(component).toContain("entry.tone.label");
  });

  it("future deadlines tick through the shared Countdown component", () => {
    expect(component).toContain("<Countdown");
  });

  it("an empty feed renders a calm one-liner (no big empty section)", () => {
    expect(component).toContain("Nothing needs attention — all clear.");
  });

  it("no raw client fetch — data flows only through $lib/api", () => {
    expect(component).not.toMatch(/\bfetch\(/);
    expect(view).not.toMatch(/\bfetch\(/);
    expect(view).toContain('@tornscope/shared"');
  });
});
