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
    expect(simple.indexOf("Net worth change")).toBeLessThan(simple.indexOf("Known income &amp; costs"));
  });

  it("names the main drivers — largest first, price moves included", () => {
    expect(simple).toContain("Main drivers");
    expect(simple).toContain("Official category movements, largest first");
    expect(simple).toContain("incl. price moves");
  });

  it("explains known income & costs — conversions excluded", () => {
    expect(simple).toContain("Known income &amp; costs");
    expect(simple).toContain("Known income minus true costs — moving money between assets does not count.");
  });

  it("keeps Simple curated: no duplicate lenses (asset shifts / notable movements / biggest costs)", () => {
    expect(simple).not.toContain("Asset shifts");
    expect(simple).not.toContain("What mattered most");
    expect(simple).not.toContain("Biggest costs");
    // The removed lenses remain in Advanced.
    expect(money).toContain("Asset conversions");
    expect(money).toContain("Major movements");
  });

  it("surfaces the residual neutrally when material — never as an error banner", () => {
    expect(simple).toContain("could not be attributed");
    expect(simple).toContain("Shown, not forced into a category");
    // No warning-styled residual tile in Simple.
    expect(simple).not.toContain("border-warning/30");
  });

  it("demotes wallet turnover to a cash-details disclosure with the Torn explanation", () => {
    expect(simple).toContain('data-testid="cash-details"');
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
  it("Simple strip is a dashboard: training outcome + liquidity, no accounting heroes", () => {
    // V1.0 hierarchy pass: accounting perspectives live in Economy; the
    // financial-semantics pass demoted cash-on-hand to liquidity context.
    const stripStart = overview.indexOf('<dl class="mt-6 grid');
    const stripEnd = overview.indexOf("</dl>", stripStart);
    const strip = overview.slice(stripStart, stripEnd);
    const simpleSlice = strip.slice(strip.indexOf('prefs.mode === "simple"'), strip.indexOf('{:else}'));
    expect(simpleSlice).toContain("Battlestats today");
    expect(simpleSlice).toContain("Training today");
    expect(simpleSlice).toContain("Cash on hand");
    expect(simpleSlice).toContain("liquidity"); // low cash framed as normal
    expect(simpleSlice).not.toContain("economic effect");
    expect(simpleSlice).not.toContain("true income");
    expect(simpleSlice).not.toContain("wallet inflow");
  });

  it("Advanced strip is wealth-first: economic result colored, conversion neutral, wallet demoted", () => {
    const stripStart = overview.indexOf('<dl class="mt-6 grid');
    const stripEnd = overview.indexOf("</dl>", stripStart);
    const strip = overview.slice(stripStart, stripEnd);
    const advancedSlice = strip.slice(strip.indexOf("{:else}"), stripEnd);
    // ECONOMIC: true income/costs keep red/green.
    expect(advancedSlice).toContain("true income");
    expect(advancedSlice).toContain("text-positive");
    expect(advancedSlice).toContain("true costs");
    expect(advancedSlice).toContain("text-negative");
    // CONVERSION: asset movement is one neutral cell.
    expect(advancedSlice).toContain("asset movement");
    expect(advancedSlice).toContain("neutral, not P&amp;L");
    // LIQUIDITY: cash on hand last, framed as liquidity; the old colored
    // wallet trio is gone entirely.
    const cashIdx = advancedSlice.indexOf("Cash on hand");
    expect(cashIdx).toBeGreaterThan(advancedSlice.indexOf("asset movement"));
    expect(advancedSlice).not.toContain("net wallet movement");
    expect(advancedSlice).not.toContain("{period} cash received");
    expect(advancedSlice).not.toContain("{period} cash spent");
    // No sign-derived sentiment on any liquidity/transport figure.
    expect(advancedSlice).not.toMatch(/walletInflow - walletOutflow >= 0 ? 'text-positive'/);
  });

  it("net cash movement survives only as a quiet neutral contextual line", () => {
    const idx = overview.indexOf("Net cash movement");
    expect(idx).toBeGreaterThan(-1);
    const context = overview.slice(idx, idx + 500);
    expect(context).toContain("transport, not profit/loss");
    expect(overview.slice(idx - 100, idx + 500)).toContain("text-fg-faint");
  });

  it("the wealth story headline renders under the hero when defensible", () => {
    expect(overview).toContain("explainWealthStory");
    expect(overview).toContain("wealthStory?.headline");
  });

  it("explains the Torn wallet context (framing kept, wording updated)", () => {
    expect(overview).toContain("wallet cash is exposed to mugging");
    // The known-income-vs-costs explanation lives in EconomySimple now.
    expect(simple).toContain("Known income minus true costs — moving money between assets does not count.");
  });

  it("focus ordering applies to every Overview section without hiding any", () => {
    expect(overview).toContain("overviewSectionOrder(prefs.focus)");
    expect(overview).toContain('aria-label="Net worth" style="order: {order.networth};"');
    expect(overview).toContain("aria-label=\"Today's story\" style=\"order: {order.today};\"");
    expect(overview).toContain('aria-label="Recent activity" style="order: {order.activity};"');
    expect(overview).toContain('aria-label="Beyond money" style="order: {order.beyond};"');
    expect(overview).toContain('style="order: {order.live};"');
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

describe("Received vs spent mix legend containment (1.0.1 regression)", () => {
  const start = money.indexOf('title="Received vs spent mix"');
  const end = money.indexOf("</Panel>", start);
  const mixPanel = money.slice(start, end);

  it("donut columns are container-driven, not viewport-driven", () => {
    // At ≥1500px this panel can be a narrow grid column while the viewport
    // is huge — a viewport breakpoint (sm:grid-cols-2) kept two donut
    // columns alive in a ~300px panel and the legends collided across the
    // column midpoint. Container queries stack them based on the space the
    // panel actually has.
    expect(mixPanel).toContain('<div class="@container">');
    expect(mixPanel).toContain("@min-[560px]:grid-cols-2");
    expect(mixPanel).not.toContain('class="grid grid-cols-1 gap-6 sm:grid-cols-2"');
  });

  it("legend rows are isolated per column — names truncate, values never shrink or wrap", () => {
    // Every row keeps min-w-0 so the truncating name absorbs pressure; the
    // amount and percentage are shrink-0 and never wrap, so they stay at the
    // row edge inside their own column.
    const rows = mixPanel.split("<li ").slice(1);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row).toContain("min-w-0");
      expect(row).toContain("truncate");
      expect(row).toMatch(/tnum shrink-0 whitespace-nowrap/);
      expect(row).toMatch(/w-9 shrink-0 text-right/);
    }
  });
});
