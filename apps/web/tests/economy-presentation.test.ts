import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Economy Simple/Advanced presentation contracts (product simplification).
 *
 * Simple answers "did I get richer or poorer, and why?" first. Wallet
 * turnover is supporting detail (in Torn, money passing through the wallet
 * is normal — players store wealth elsewhere), never a headline. Advanced
 * keeps the full analytics surface: every lens, the wallet bridge and the
 * reconciliation detail.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const simple = read("../../web/src/lib/components/EconomySimple.svelte");
const money = read("../../web/src/routes/money/+page.svelte");
const liveNow = read("../../web/src/lib/components/LiveNow.svelte");
const overview = read("../../web/src/routes/+page.svelte");

describe("economy simple view", () => {
  it("leads with the official net worth change", () => {
    expect(simple).toContain("Net worth change");
    expect(simple).toContain("exact · official Torn snapshots");
    expect(simple.indexOf("Net worth change")).toBeLessThan(simple.indexOf("Real gains &amp; costs"));
  });

  it("shows what changed: official category movements, largest first", () => {
    expect(simple).toContain("What changed");
    expect(simple).toContain("Official category movements");
    expect(simple).toContain("incl. price moves");
  });

  it("explains real gains & costs — conversions excluded", () => {
    expect(simple).toContain("Real gains &amp; costs");
    expect(simple).toContain("Known income minus true costs — moving money between assets does not count.");
  });

  it("shows asset shifts as value changing form — never gains or losses", () => {
    expect(simple).toContain("Asset shifts");
    expect(simple).toContain("not gains, not losses");
  });

  it("surfaces the unexplained residual when material", () => {
    expect(simple).toContain("Unexplained");
    expect(simple).toContain("the remainder is shown, not forced into a category");
  });

  it("demotes wallet turnover to a cash-details disclosure with the Torn explanation", () => {
    expect(simple).toContain("data-testid=\"cash-details\"");
    expect(simple).toContain("Cash details — wallet turnover &amp; reconciliation");
    // The Torn-specific wallet explanation must be present.
    expect(simple).toContain("players store money in banks, stocks and items");
  });

  it("offers the switch to Advanced from the disclosure", () => {
    expect(simple).toContain('setDashboardMode("advanced")');
  });
});

describe("economy advanced view", () => {
  it("keeps the full analytics surface behind the Advanced mode", () => {
    expect(money).toContain('prefs.mode === "advanced"');
    expect(money).toContain("Wallet reconciliation");
    expect(money).toContain("Conversion pairs");
    expect(money).toContain("How these lenses relate");
    expect(money).toContain("The cash ledger");
  });

  it("carries the Simple/Advanced toggle and renders the simple component in simple mode", () => {
    expect(money).toContain("aria-label=\"Presentation mode\"");
    expect(money).toContain("EconomySimple");
    expect(money).toContain('prefs.mode === "simple"');
  });
});

describe("overview hierarchy", () => {
  it("simple mode leads the strip with the wealth story, not wallet turnover", () => {
    expect(overview).toContain("{period} economic effect");
    expect(overview).toContain("{period} moved into assets");
    // Within the strip, wallet turnover exists only on the Advanced branch:
    // the simple branch comes first and never mentions it.
    const stripStart = overview.indexOf('<dl class="mt-6 grid');
    const stripEnd = overview.indexOf("</dl>", stripStart);
    const strip = overview.slice(stripStart, stripEnd);
    const simpleBranch = strip.indexOf('prefs.mode === "simple"');
    const advancedBranch = strip.indexOf("{:else}");
    const walletTurnover = strip.indexOf("net wallet movement");
    expect(simpleBranch).toBeGreaterThan(-1);
    expect(advancedBranch).toBeGreaterThan(simpleBranch);
    expect(walletTurnover).toBeGreaterThan(advancedBranch);
    expect(strip.slice(simpleBranch, advancedBranch)).not.toContain("wallet");
  });

  it("explains the Torn wallet context and the net-worth-vs-effect distinction", () => {
    expect(overview).toContain("players store money in banks, stocks and items rather than holding cash");
    expect(overview).toContain("Known income minus true costs. Moving money between assets does not count.");
  });

  it("focus ordering applies to every Overview section without hiding any", () => {
    expect(overview).toContain("overviewSectionOrder(prefs.focus)");
    expect(overview).toContain("aria-label=\"Net worth\" style=\"order: {order.networth};\"");
    expect(overview).toContain("aria-label=\"Today's story\" style=\"order: {order.today};\"");
    expect(overview).toContain("aria-label=\"Recent activity\" style=\"order: {order.activity};\"");
    expect(overview).toContain("aria-label=\"Beyond money\" style=\"order: {order.beyond};\"");
    expect(overview).toContain("style=\"order: {order.live};\"");
  });
});

describe("economy narrative order (V0.2 semantic pass)", () => {
  it("the advanced opener leads with the wealth result, never wallet turnover", () => {
    expect(money).toContain("your net worth");
    // The user-visible complaint: the editorial opened with "…entered your
    // wallet and … left it". That framing must not exist anywhere on the page.
    expect(money).not.toContain("entered your wallet");
    // Turnover is the CLOSING note of the editorial, framed as staging.
    const turnover = money.indexOf("Wallet turnover ran");
    const lead = money.indexOf("const editorial");
    expect(turnover).toBeGreaterThan(-1);
    expect(turnover).toBeGreaterThan(lead);
    expect(money.slice(turnover)).toContain("normal staging in Torn");
  });

  it("advanced lens order is net worth → economic effect → conversions → cash", () => {
    const nw = money.indexOf('id="lens-panel-networth"');
    const ef = money.indexOf('id="lens-panel-effect"');
    const cv = money.indexOf('id="lens-panel-conversions"');
    const ch = money.indexOf('id="lens-panel-cash"');
    expect(nw).toBeGreaterThan(-1);
    expect(nw).toBeLessThan(ef);
    expect(ef).toBeLessThan(cv);
    expect(cv).toBeLessThan(ch);
  });

  it("the lens switcher defaults to net worth", () => {
    expect(money).toContain('activeLens = $state("networth")');
  });

  it("simple surfaces the biggest costs beside the economic effect", () => {
    const effect = simple.indexOf("Real gains &amp; costs");
    const costs = simple.indexOf("Biggest costs");
    expect(costs).toBeGreaterThan(effect);
  });
});

describe('release-candidate QA regressions', () => {
  it('what-changed omits zero-change rows instead of printing $0 noise', () => {
    expect(simple).toContain('.filter((c) => c.change !== 0)');
    expect(simple).toContain('Nothing moved this period');
  });

  it('the Overview strip carries a Happy bar — energy/nerve/happy at a glance', () => {
    expect(liveNow).toContain('barChip("happy")');
    expect(liveNow).toContain('today?.bars.happy');
  });

  it('the Today updated label is suppressed while the payload is stale (no contradictory "updated just now")', () => {
    expect(read('../../web/src/routes/today/+page.svelte')).toContain('{#if data && !data.stale}');
  });
});

describe("bank color semantics", () => {
  it("a healthy bank countdown is neutral; only a matured investment warns", () => {
    // Real-user finding: "Bank" rendered warning-yellow for a normal active
    // investment. Warning is reserved for the actionable "Matured — collect"
    // state; the countdown is a neutral timer.
    expect(liveNow).toMatch(/value: `matures in \$\{formatCountdownCompact\(left\)\}`, tone: "neutral"/);
    expect(liveNow).toMatch(/value: "Matured — collect", tone: "warning"/);
  });
});
