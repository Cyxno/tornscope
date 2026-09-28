import { describe, expect, it } from "vitest";
import {
  categoryChips,
  categoryLabel,
  clickPathLabel,
  comparisonParts,
  formatComparisonDelta,
  formatComparisonValue,
  formatDeltaPct,
  evidenceLine,
  kindLabel,
  sortInsights,
} from "../src/lib/insights-view";
import { confidenceChip } from "../src/lib/goals-view";
import type { Insight } from "@tornscope/shared";

/**
 * Insights page presentation logic. Pinned regressions: comparisons are
 * unit-aware and honest about signs, evidence carries human dates and the
 * sample size, null deltaPct renders no percentage, and the feed sorts by
 * priority then recency.
 */

const KINDS = [
  { kind: "income_shift" as const, label: "Income level", category: "economy" as const, typicalWindowDays: 37 },
  { kind: "travel_profit_shift" as const, label: "Travel profit", category: "travel" as const, typicalWindowDays: 37 },
  { kind: "xanax_usage_shift" as const, label: "Xanax usage", category: "substances" as const, typicalWindowDays: 37 },
];

const DAY = 86_400;
const FROM = 1_789_000_000; // arbitrary unix seconds

function insight(over: Partial<Insight> = {}): Insight {
  return {
    id: "income_shift:1",
    kind: "income_shift",
    category: "economy",
    priority: "normal",
    title: "Income is up",
    detail: "Daily cash received is above the baseline period.",
    sensitiveDetail: null,
    comparison: {
      metric: "daily cash received",
      baselineLabel: "30-day average",
      baselineValue: 1_000_000,
      currentValue: 1_500_000,
      delta: 500_000,
      deltaPct: 50,
      unit: "money",
    },
    evidence: { from: FROM, to: FROM + 7 * DAY, sampleSize: 7, baselineDays: 30 },
    confidence: "high",
    provenance: "derived",
    dedupeKey: "income_shift:1",
    occurredAt: FROM + 7 * DAY,
    clickPath: "/money",
    ...over,
  };
}

const fakeDate = (ts: number | null | undefined) => `D${ts}`;

describe("labels (codes never render raw)", () => {
  it("categories read as words, including the plural record group", () => {
    expect(categoryLabel("economy")).toBe("Economy");
    expect(categoryLabel("training")).toBe("Training");
    expect(categoryLabel("travel")).toBe("Travel");
    expect(categoryLabel("substances")).toBe("Substances");
    expect(categoryLabel("record")).toBe("Records");
    expect(categoryLabel("system")).toBe("System");
  });

  it("an unknown category does not render as a bare slug", () => {
    expect(categoryLabel("some_future_group")).toBe("Some Future Group");
  });

  it("kind labels come from the response registry, then the shared curated registry", () => {
    expect(kindLabel("income_shift", KINDS)).toBe("Income level");
    expect(kindLabel("networth_growth_shift", [])).toBe("Net worth growth");
    expect(kindLabel("some_future_kind", [])).toBe("Some Future Kind");
  });
});

describe("comparison formatting per unit", () => {
  it("money goes through the shared compact money formatter", () => {
    expect(formatComparisonValue(1_234_567, "money")).toBe("$1.23m");
    expect(formatComparisonValue(0, "money")).toBe("$0");
  });

  it("stat/energy are compact numbers without currency symbols", () => {
    expect(formatComparisonValue(2_345_678, "stat")).toBe("2.35m");
    expect(formatComparisonValue(12_340, "energy")).toBe("12.3k");
  });

  it("hours, ratios and counts render in their own honest shapes", () => {
    expect(formatComparisonValue(3.25, "hours")).toBe("3.3h");
    expect(formatComparisonValue(1.456, "ratio")).toBe("1.46×");
    expect(formatComparisonValue(1234.6, "count")).toBe("1,235");
  });

  it("deltas carry an explicit sign", () => {
    expect(formatComparisonDelta(500_000, "money")).toBe("+$500.0k");
    expect(formatComparisonDelta(-8.12, "hours")).toBe("-8.1h");
    expect(formatComparisonDelta(0, "count")).toBe("0");
    expect(formatComparisonDelta(-350, "stat")).toBe("-350");
  });

  it("deltaPct is signed and rounded; null stays null (no fake percentage)", () => {
    expect(formatDeltaPct(23.4)).toBe("+23%");
    expect(formatDeltaPct(-8.6)).toBe("-9%");
    expect(formatDeltaPct(0)).toBe("0%");
    expect(formatDeltaPct(null)).toBeNull();
  });

  it("comparisonParts assembles the baseline → current line", () => {
    const parts = comparisonParts(insight().comparison);
    expect(parts.baseline).toBe("$1.00m");
    expect(parts.current).toBe("$1.50m");
    expect(parts.delta).toBe("+$500.0k");
    expect(parts.pct).toBe("+50%");
  });
});

describe("evidence line", () => {
  it("carries human dates, window vs baseline and the sample size", () => {
    const line = evidenceLine(insight().evidence, fakeDate);
    expect(line).toBe(`D${FROM} – D${FROM + 7 * DAY} · 7-day window vs 30-day baseline · sample: 7`);
  });

  it("a sub-day window never rounds to zero days", () => {
    const line = evidenceLine({ from: FROM, to: FROM + 3600, sampleSize: 1, baselineDays: 30 }, fakeDate);
    expect(line).toContain("1-day window");
  });
});

describe("feed shaping", () => {
  it("sorts by priority first, then newest", () => {
    const high = insight({ id: "high", priority: "high", occurredAt: 100 });
    const normalNew = insight({ id: "normal-new", priority: "normal", occurredAt: 900 });
    const normalOld = insight({ id: "normal-old", priority: "normal", occurredAt: 500 });
    const low = insight({ id: "low", priority: "low", occurredAt: 999 });
    expect(sortInsights([low, normalOld, high, normalNew]).map((i) => i.id)).toEqual(["high", "normal-new", "normal-old", "low"]);
  });

  it("does not mutate the input array", () => {
    const rows = [insight({ priority: "low" }), insight({ priority: "high" })];
    sortInsights(rows);
    expect(rows[0]!.priority).toBe("low");
  });

  it("filter chips lead with All and keep the registry's category order with live counts", () => {
    const chips = categoryChips(
      [insight(), insight({ category: "economy" }), insight({ category: "travel" })],
      KINDS
    );
    expect(chips.map((c) => c.category)).toEqual(["all", "economy", "travel", "substances"]);
    expect(chips[0]).toEqual({ category: "all", label: "All", count: 3 });
    expect(chips[1]!.count).toBe(2);
    expect(chips[2]!.count).toBe(1);
    expect(chips[3]!.count).toBe(0); // the engine looks for it — the chip exists
  });
});

describe("click path", () => {
  const NAV = [
    { href: "/money", label: "Economy" },
    { href: "/travel", label: "Travel" },
  ];

  it("resolves in-app destinations against the nav model", () => {
    expect(clickPathLabel("/money", NAV)).toBe("Open Economy");
    expect(clickPathLabel("/travel/extra", NAV)).toBe("Open Travel");
  });

  it("an unknown destination renders no link at all", () => {
    expect(clickPathLabel("/nowhere", NAV)).toBeNull();
  });
});

describe("confidence chip (shared with goals)", () => {
  it("re-exports the same chip vocabulary as the goals page", () => {
    expect(confidenceChip("high").label).toBe("High confidence");
    expect(confidenceChip("medium").label).toBe("Medium confidence");
    expect(confidenceChip("low").label).toBe("Low confidence");
  });
});
