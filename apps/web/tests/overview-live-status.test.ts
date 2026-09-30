import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Overview live-status cockpit (dashboard-first redesign, 2.x): LiveNow is
 * the dominant LIVE block — four big bar rows (Energy/Nerve/Happy/Life),
 * compact cooldown tiles and current-state rows only. Every row/tile is the
 * primary Torn.com action via a stretched semantic <a> (keyboard
 * activatable, labelled); TornScope analytics links layer above it (z-10,
 * never nested anchors). STATE lives here — actions live in Needs Attention.
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const liveNow = read("../src/lib/components/LiveNow.svelte");
const liveNowLogic = read("../src/lib/live-now.ts");
const overview = read("../src/routes/+page.svelte");

describe("LiveNow cockpit — whole-row Torn actions", () => {
  it("the primary action is a stretched semantic anchor in every sub-block (bars, cooldown tiles, active states)", () => {
    const anchors = [...liveNow.matchAll(/class="absolute inset-0 [^"]*"/g)];
    expect(anchors.length).toBe(3);
    expect((liveNow.match(/\{\.\.\.TORN_LINK_ATTRS\}\s*><\/a>/g) ?? []).length).toBe(3);
    expect((liveNow.match(/aria-label=\{`\$\{item\.tornLabel\} on Torn\.com \(opens in a new tab\)`\}/g) ?? []).length).toBe(3);
    expect(liveNow).toContain("focus-visible:outline-2");
  });

  it("no separate Torn/Open pills remain", () => {
    expect(liveNow).not.toMatch(/>\s*Torn\s*</);
    expect(liveNow).not.toMatch(/>\s*Open\s*↗?\s*</);
  });

  it("render-time guard: every href passes the Torn-domain check", () => {
    expect(liveNow).toContain("safeTornUrl(url) ?? TORN_URLS.items");
    const assignments = [...liveNowLogic.matchAll(/tornUrl: ([A-Za-z][^,\n};]*)/g)]
      .map((m) => m[1]!.trim())
      .filter((a) => a !== "string");
    expect(assignments.length).toBeGreaterThanOrEqual(9);
    for (const assignment of assignments) {
      const ok = assignment.includes("TORN_URLS.") || assignment === "url";
      expect(ok, `tornUrl from ${assignment}`).toBe(true);
    }
  });

  it("secondary analytics links sit above the stretched link (no nested anchors)", () => {
    expect(liveNow).toContain('class="relative z-10 text-[11px]');
    expect(liveNowLogic).toContain('scopeHref: "/travel"');
    expect(liveNowLogic).toContain('scopeHref: "/faction"');
    expect(liveNowLogic).toContain('scopeHref: "/money"');
  });
});

describe("LiveNow cockpit — dominant live status", () => {
  it("bars are big and scanable: 20px numerals, cap muted, full-width bar, compact timer", () => {
    expect(liveNow).toContain("text-[20px] font-semibold");
    expect(liveNow).toContain('text-[13px] font-medium text-fg-faint"> / ');
    expect(liveNow).toContain("h-2.5 w-full");
    expect(liveNow).toContain("text-[12.5px]");
  });

  it("bars expose progressbar semantics with live values", () => {
    expect(liveNow).toContain('role="progressbar"');
    expect(liveNow).toContain("aria-valuemin={0}");
    expect(liveNow).toContain("aria-valuemax={100}");
    expect(liveNow).toContain("aria-valuenow=");
  });

  it("over-cap energy keeps the real current value (no fake clamp)", () => {
    // Derivation contract: state carries the real "400 / 150" and the
    // sub-row carries the honest "Stacked · +250 over cap" note.
    expect(liveNowLogic).toContain("const bar = today.bars[kind];");
    expect(liveNowLogic).toContain('state: `${bar.current} / ${bar.max}`');
    expect(liveNowLogic).toContain("d.overCap");
  });

  it("Life joins the dominant bar block (timer only when relevant)", () => {
    expect(liveNowLogic).toContain('kind: "life"');
    expect(liveNowLogic).toContain('label: "Life"');
  });

  it("STATE ≠ ATTENTION: the live block renders state only — no generic duplicated attention copy", () => {
    expect(liveNow).not.toContain("capped for");
    expect(liveNow).not.toContain("needs attention");
  });
});

describe("LiveNow cockpit — cooldown tiles and active states", () => {
  it("cooldowns are compact tiles: READY instantly recognizable, otherwise a big countdown", () => {
    expect(liveNow).toContain("READY");
    expect(liveNow).toContain("grid-cols-3 gap-2");
    expect(liveNow).toContain('item.ready ? "READY" : item.relative ?? "—"');
  });

  it("tiles only render for cooldowns the payload actually carries", () => {
    expect(liveNow).toContain('board.timers.filter((t) => t.key.startsWith("cd-"))');
    expect(liveNow).toContain('board.timers.filter((t) => !t.key.startsWith("cd-"))');
    expect(liveNowLogic).toContain("if (cd === null) continue;");
  });

  it("active states render ONLY current states, in a divided compact block", () => {
    expect(liveNow).toContain('aria-label="Active states"');
    expect(liveNow).toContain("divide-y divide-border/60");
    // No empty-state filler: the block disappears when nothing is active.
    expect(liveNow).not.toContain("Nothing active");
  });

  it("one shared tick — the whole cockpit reads the single dashboard clock", () => {
    expect(liveNow).toContain('from "$lib/dashboard-clock.svelte"');
    expect(liveNow).not.toMatch(/setInterval\(/);
    const cmd = read("../src/lib/components/CommandCenter.svelte");
    expect(cmd).toContain('from "$lib/dashboard-clock.svelte"');
    expect(cmd).not.toMatch(/setInterval\(/);
  });

  it("the Overview page mounts the cockpit with the shared payloads", () => {
    expect(overview).toContain("<LiveNow");
    expect(overview).toContain("today={today}");
    expect(overview).toContain("ocs={myOcs}");
  });

  it("the cockpit is a real desktop grid, not a stretched mobile column", () => {
    expect(overview).toContain("xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]");
  });
});
