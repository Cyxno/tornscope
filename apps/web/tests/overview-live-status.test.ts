import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Overview live-status (1.0.3 polish): the board renders as compact cards
 * where the WHOLE CARD is the primary Torn.com action — implemented as a
 * stretched semantic <a> (keyboard activatable, labelled) with the
 * TornScope analytics link layered above it (z-10, never nested anchors).
 * No standalone "Torn ↗" / "Open ↗" pills remain; a faint corner ↗ is the
 * only external hint. Medical cooldown uses the identical card pattern.
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const liveNow = read("../src/lib/components/LiveNow.svelte");
const liveNowLogic = read("../src/lib/live-now.ts");
const overview = read("../src/routes/+page.svelte");

describe("LiveNow — whole-card Torn actions", () => {
  it("the primary action is a stretched semantic anchor covering the card", () => {
    const anchors = [...liveNow.matchAll(/class="absolute inset-0[^"]*"/g)];
    expect(anchors.length).toBe(2); // bar cards + timer cards
    expect(liveNow).toContain('aria-label={`${item.tornLabel} on Torn.com (opens in a new tab)`}');
    expect(liveNow).toContain("{...TORN_LINK_ATTRS}");
    expect(liveNow).toContain("focus-visible:outline-2");
  });

  it("no separate Torn/Open pills remain", () => {
    expect(liveNow).not.toMatch(/>\s*Torn\s*</);
    expect(liveNow).not.toMatch(/>\s*Open\s*↗?\s*</);
    expect(liveNow).not.toContain("rounded-full border border-border px-2.5 py-1.5");
  });

  it("the external hint is a subtle corner arrow, not a button", () => {
    expect((liveNow.match(/pointer-events-none absolute right-2\.5 top-2 text-\[11px\]/g) ?? []).length).toBe(2);
    expect((liveNow.match(/aria-hidden="true">↗<\/span>/g) ?? []).length).toBe(2);
  });

  it("cards show pointer cursor via the anchor and a hover state", () => {
    expect(liveNow).toContain("group relative flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2");
    expect((liveNow.match(/hover:border-accent\/60 hover:bg-accent\/5/g) ?? []).length).toBe(2);
  });

  it("secondary analytics links sit above the stretched link (no nested anchors)", () => {
    // The inner link is a sibling of (not a child of) the primary anchor.
    expect(liveNow).toContain('class="relative z-10 ml-auto text-[11px]');
    // The primary stretched anchor is empty — no children to nest.
    const emptyAnchors = [...liveNow.matchAll(/\{...\s*TORN_LINK_ATTRS\}\s*><\/a>/g)];
    expect(emptyAnchors.length).toBe(2);
    // The secondary destinations survive in the derivation module.
    expect(liveNowLogic).toContain('scopeHref: "/travel"');
    expect(liveNowLogic).toContain('scopeHref: "/faction"');
    expect(liveNowLogic).toContain('scopeHref: "/money"');
  });
});

describe("LiveNow — Torn destinations and compactness", () => {
  it("all primary actions come from the audited Torn map", () => {
    const assignments = [...liveNowLogic.matchAll(/tornUrl: ([A-Za-z][^,\n};]*)/g)]
      .map((m) => m[1]!.trim())
      .filter((a) => a !== "string"); // skip the interface type annotation
    expect(assignments.length).toBeGreaterThanOrEqual(9);
    for (const assignment of assignments) {
      // `url` is the bar-kinds loop variable bound to TORN_URLS constants.
      const ok = assignment.includes("TORN_URLS.") || assignment === "url";
      expect(ok, `tornUrl from ${assignment}`).toBe(true);
    }
    expect(liveNow).toContain("safeTornUrl(url) ?? TORN_URLS.items");
  });

  it("the middle row is compact: smaller padding than the first pass, tighter gaps", () => {
    // 1.0.3 first pass used px-3.5 py-3 cards with mt-2.5/mt-2 grid gaps.
    expect(liveNow).not.toContain("px-3.5 py-3");
    expect(liveNow).toContain("px-3 py-2");
    expect(liveNow).toContain("gap-1.5");
    // Type sizes unchanged: labels, values, timers keep their first-pass sizes.
    expect(liveNow).toContain("text-[16px] font-semibold");
    expect(liveNow).toContain("text-[15px] font-semibold");
    expect(liveNow).toContain("h-2 w-full"); // bars stay scannable
  });

  it("uniform card rhythm: secondary links share the time row instead of adding height", () => {
    // Secondary link renders inside the time row (ml-auto) with a min-height row.
    expect(liveNowLogic).not.toMatch(/scopeHref[^\n]*\n[^\n]*relative/); // never its own block
    expect(liveNow).toContain("min-h-[18px]");
    expect(liveNow).toContain("ml-auto");
  });

  it("the Overview page keeps its structure", () => {
    expect(overview).toContain("<LiveNow");
    expect(overview).toContain("today={today}");
  });
});
