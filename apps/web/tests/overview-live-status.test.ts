import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Overview live-status (1.0.3): the "Right now" board must be scannable at
 * a glance — LABEL → STATE → TIME(relative + absolute) → ACTION — with the
 * PRIMARY action opening Torn.com (never an internal analytics route) and
 * TornScope analytics kept as explicit secondary links. Markup contracts
 * pinned here follow the repo's rendered-surface test style.
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const liveNow = read("../src/lib/components/LiveNow.svelte");
const overview = read("../src/routes/+page.svelte");

describe("LiveNow — direct Torn actions", () => {
  it("travel state uses the Torn travel page, never /travel as primary", () => {
    const travelSection = liveNow.slice(liveNow.indexOf('key: "travel"'), liveNow.indexOf('key: "abroad"'));
    expect(travelSection).toContain("TORN_URLS.travel");
    expect(travelSection).not.toMatch(/tornUrl:\s*"\/travel"/);
    expect(travelSection).toContain('scopeHref: "/travel"'); // secondary history link stays
    expect(travelSection).toContain("Travel history");
  });

  it("organized crime opens the Torn faction crimes tab, /faction stays secondary", () => {
    const ocSection = liveNow.slice(liveNow.indexOf("const ocItem"), liveNow.indexOf("const liveActions"));
    expect(ocSection).toContain("TORN_URLS.organizedCrime");
    expect(ocSection).not.toMatch(/tornUrl:\s*"\/faction"/);
    expect(ocSection).toContain('scopeHref: "/faction"');
  });

  it("bank action opens Torn bank, Money analytics stays secondary", () => {
    const bankSection = liveNow.slice(liveNow.indexOf('key: "bank"'), liveNow.indexOf("const ocItem"));
    expect(bankSection).toContain("TORN_URLS.bank");
    expect(bankSection).toContain('scopeHref: "/money"');
  });

  it("education action opens Torn education", () => {
    const eduSection = liveNow.slice(liveNow.indexOf('key: "education"'), liveNow.indexOf("if (t.bank.state"));
    expect(eduSection).toContain("TORN_URLS.education");
  });

  it("bars act into Torn: energy→gym, nerve→crimes, happy→items", () => {
    const barSection = liveNow.slice(liveNow.indexOf("function barItem"), liveNow.indexOf("const barItems"));
    expect(barSection).toContain("TORN_URLS.gym");
    expect(barSection).toContain("TORN_URLS.crimes");
    expect(barSection).toContain("TORN_URLS.items");
  });

  it("hospital/jail link Torn, Today stays secondary", () => {
    const noticeSection = liveNow.slice(liveNow.indexOf("// Hospital / jail"), liveNow.indexOf("// Travel —"));
    expect(noticeSection).toContain("TORN_URLS.hospital");
    expect(noticeSection).toContain("TORN_URLS.jail");
    expect(noticeSection).toContain('scopeHref: "/today"');
  });

  it("no live item hardcodes an internal route as its primary tornUrl", () => {
    // tornUrl must only ever be assigned from the audited Torn map (the
    // interface's `tornUrl: string;` type annotation is not an assignment).
    const tornUrlAssignments = [...liveNow.matchAll(/tornUrl:\s*([A-Za-z][^,\n}]*)/g)]
      .map((m) => m[1]!.trim())
      .filter((a) => a !== "string;");
    expect(tornUrlAssignments.length).toBeGreaterThanOrEqual(7);
    for (const assignment of tornUrlAssignments) {
      // Direct map entries or ternaries between map entries — never a
      // string-literal route.
      expect(assignment.includes("TORN_URLS."), `tornUrl assigned from ${assignment}`).toBe(true);
      expect(assignment.match(/"\/[a-z]/) ?? []).toEqual([]);
    }
  });
});

describe("LiveNow — safe external links and time display", () => {
  it("every external anchor spreads TORN_LINK_ATTRS (target/_blank + rel/noopener noreferrer)", () => {
    const anchorCount = (liveNow.match(/href=\{externalHref\(/g) ?? []).length;
    expect(anchorCount).toBe(2); // bar cards + timer cards
    expect((liveNow.match(/\{\.\.\.TORN_LINK_ATTRS\}/g) ?? []).length).toBe(2);
    // The attributes themselves live on the shared map (single source).
    const shared = read("../../../packages/shared/src/torn.ts");
    expect(shared).toContain('target: "_blank"');
    expect(shared).toContain('rel: "noopener noreferrer"');
  });

  it("renders hrefs through the domain guard, with a safe fallback", () => {
    expect(liveNow).toContain("function externalHref(url: string): string");
    expect(liveNow).toContain("safeTornUrl(url) ?? TORN_URLS.items");
  });

  it("shows relative countdown AND absolute clock time together", () => {
    // barFullDisplay-derived absolute time next to the relative countdown
    expect(liveNow).toContain("displayTime(atSec)");
    expect(liveNow).toContain("displayTime(oc.readyAt)");
    // travel absolute landing time via bothTimes
    expect(liveNow).toContain("bothTimes(formatCountdownCompact(t.travel.landsAt - nowSec), t.travel.landsAt)");
  });
});

describe("LiveNow — hierarchy contracts", () => {
  it("labels, big values, and supporting text are visually distinct tiers", () => {
    // Labels: small uppercase tracking
    expect(liveNow).toContain("uppercase tracking-[0.08em]");
    // Timer values: 16px semibold (previously 13px muted sentence text)
    expect(liveNow).toContain("text-[16px] font-semibold");
    // Bar values: 15px semibold numerals
    expect(liveNow).toContain("text-[15px] font-semibold");
  });

  it("bars render a visible fill track, larger than the old 6px strip", () => {
    expect(liveNow).toContain("h-2 w-full"); // 8px track, full card width
  });

  it("the external action is visually marked before tapping (arrow glyph + title)", () => {
    expect(liveNow).toContain("↗");
    expect(liveNow).toContain("on Torn.com");
  });

  it("urgency stays restrained: tones mark READY states, not running timers", () => {
    // ready (full/matured/landed) drives positive emphasis; running timers are neutral/accent
    expect(liveNow).toContain("ready: true");
    const warningUses = [...liveNow.matchAll(/tone: "warning"/g)].length;
    expect(warningUses).toBeLessThanOrEqual(3); // jail + matured bank only
  });

  it("the Overview page keeps its structure and does not regress to boxes-everywhere", () => {
    expect(overview).toContain("<LiveNow");
    expect(overview).toContain("today={today}");
  });
});
