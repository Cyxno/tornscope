import { describe, expect, it } from "vitest";
import {
  asOfLabel,
  confidenceChip,
  formatGoalValue,
  formatLocaleNumber,
  formatVelocity,
  goalDraftError,
  insufficientReasonLabel,
  INSUFFICIENT_REASON_COPY,
  metricLabel,
  normalizeNote,
  noteError,
  progressPct,
  splitGoals,
  targetDateToUnix,
  targetError,
  unitForMetric,
  unixToTargetDate,
  isStatProjection,
  formatEtaRange,
} from "../src/lib/goals-view";
import type { Goal, GoalView, GoalsResponse } from "@tornscope/shared";

/**
 * Goals page presentation logic. The regressions being pinned here: machine
 * reason codes never render (and unknown future codes get a humanized
 * fallback), null data renders "—"/"No data yet" — never an invented 0 — and
 * money always goes through the shared formatters.
 */

const METRICS: GoalsResponse["metrics"] = [
  { id: "networth", label: "Net worth", unit: "money", description: "Total net worth.", source: "networth_snapshot" },
  { id: "strength", label: "Strength", unit: "stat", description: "Strength.", source: "personalstats_snapshot" },
];

function goal(over: Partial<Goal> = {}): Goal {
  return { id: "g1", metric: "networth", target: 1_500_000, note: null, createdAt: 0, targetDate: null, status: "active", achievedAt: null, ...over };
}

function view(over: Partial<GoalView> = {}): GoalView {
  return {
    goal: goal(),
    currentValue: 500_000,
    currentValueAt: 1_000,
    progress: 1 / 3,
    projection: {
      etaAt: 2_000_000_000,
      velocityPerDay: 120_450,
      slopePerDay: 100_000,
      fitR2: 0.9,
      lookbackDays: 30,
      confidence: "high",
      insufficientReason: null,
      window: { from: 0, to: 1, points: 30 },
      provenance: "derived",
      model: "median_delta_linear",
      etaRangeDays: null,
      observedChangePerDay: 120_450,
    },
    dataAvailable: true,
    ...over,
  };
}

describe("insufficient-reason copy (codes never render raw)", () => {
  it("maps every machine reason to its plain-words line", () => {
    expect(INSUFFICIENT_REASON_COPY.insufficient_history).toBe("Not enough history yet");
    expect(INSUFFICIENT_REASON_COPY.no_positive_trend).toBe("No upward trend right now");
    expect(INSUFFICIENT_REASON_COPY.too_volatile).toBe("Too volatile to project");
    expect(INSUFFICIENT_REASON_COPY.beyond_horizon).toBe("Beyond the 5-year horizon");
    expect(INSUFFICIENT_REASON_COPY.target_reached).toBe("Target reached");
    for (const reason of Object.keys(INSUFFICIENT_REASON_COPY)) {
      expect(insufficientReasonLabel(reason)).toBe(INSUFFICIENT_REASON_COPY[reason as keyof typeof INSUFFICIENT_REASON_COPY]);
    }
  });

  it("humanizes unknown future codes instead of rendering them", () => {
    expect(insufficientReasonLabel("some_future_reason")).toBe("Some Future Reason");
    expect(insufficientReasonLabel("some_future_reason")).not.toBe("some_future_reason");
  });

  it("a missing reason still reads as a sentence, never as null/undefined", () => {
    expect(insufficientReasonLabel(null)).toBe("No projection yet");
    expect(insufficientReasonLabel(undefined)).toBe("No projection yet");
  });
});

describe("value formatting (missing is never 0)", () => {
  it("null/undefined/NaN render as an em dash for every unit", () => {
    for (const value of [null, undefined, Number.NaN]) {
      expect(formatGoalValue(value, "money")).toBe("—");
      expect(formatGoalValue(value, "stat")).toBe("—");
      expect(formatGoalValue(value, "level")).toBe("—");
    }
  });

  it("money goals go through the shared full money formatter", () => {
    expect(formatGoalValue(1_500_000, "money")).toBe("$1,500,000");
    expect(formatGoalValue(0, "money")).toBe("$0"); // a CONFIRMED zero is honest
  });

  it("stat and level goals render as locale whole numbers", () => {
    expect(formatGoalValue(1_234_567, "stat")).toBe("1,234,567");
    expect(formatGoalValue(62.4, "level")).toBe("62");
    expect(formatLocaleNumber(1234.6)).toBe("1,235");
  });

  it("velocity carries a sign and a per-day unit", () => {
    expect(formatVelocity(120_450, "money")).toBe("+$120.5k/day");
    expect(formatVelocity(-532_100, "money")).toBe("-$532.1k/day");
    expect(formatVelocity(350, "stat")).toBe("+350/day");
    expect(formatVelocity(null, "stat")).toBeNull();
  });

  it("progress percentages clamp and never invent a number", () => {
    expect(progressPct(null)).toBeNull();
    expect(progressPct(0)).toBe(0);
    expect(progressPct(1 / 3)).toBe(33);
    expect(progressPct(1)).toBe(100);
    expect(progressPct(1.5)).toBe(100); // over-delivery clamps
    expect(progressPct(-0.2)).toBe(0);
  });
});

describe("projection confidence chip", () => {
  it("labels confidence in words with an explanation tooltip", () => {
    expect(confidenceChip("high").label).toBe("High confidence");
    expect(confidenceChip("high").class).toContain("chip-positive");
    expect(confidenceChip("medium").label).toBe("Medium confidence");
    expect(confidenceChip("low").label).toBe("Low confidence");
    expect(confidenceChip("low").class).toContain("chip-warning");
    for (const c of [confidenceChip("high"), confidenceChip("medium"), confidenceChip("low"), confidenceChip("insufficient")]) {
      expect(c.title.length).toBeGreaterThan(10);
    }
  });

  it("an unknown confidence falls back to the honest 'not enough data' chip", () => {
    expect(confidenceChip("future_level").label).toBe("Not enough data");
  });
});

describe("date helpers (UTC day-end targets)", () => {
  it("a date-input value becomes unix seconds at that UTC day's end", () => {
    expect(targetDateToUnix("2026-10-05")).toBe(Date.parse("2026-10-05T23:59:59Z") / 1000);
  });

  it("blank or malformed dates become null — never NaN epochs", () => {
    expect(targetDateToUnix("")).toBeNull();
    expect(targetDateToUnix("not-a-date")).toBeNull();
  });

  it("stored unix seconds round-trip back to the date-input value", () => {
    const ts = targetDateToUnix("2026-10-05")!;
    expect(unixToTargetDate(ts)).toBe("2026-10-05");
    expect(unixToTargetDate(null)).toBe("");
  });
});

describe("form validation", () => {
  it("targets must be positive numbers", () => {
    expect(targetError("")).toBe("Enter a target above zero.");
    expect(targetError("   ")).toBe("Enter a target above zero.");
    expect(targetError("abc")).toBe("Enter a target above zero.");
    expect(targetError("0")).toBe("Enter a target above zero.");
    expect(targetError("-5")).toBe("Enter a target above zero.");
    expect(targetError("1500000")).toBeNull();
  });

  it("notes are capped and blank notes become null", () => {
    expect(noteError("fine")).toBeNull();
    expect(noteError("x".repeat(281))).toBe("Notes are capped at 280 characters.");
    expect(normalizeNote("  rebuild the chain  ")).toBe("rebuild the chain");
    expect(normalizeNote("   ")).toBeNull();
  });

  it("the create form needs a metric, a valid target and a valid note", () => {
    expect(goalDraftError("", "100", "")).toBe("Pick a metric to track.");
    expect(goalDraftError("networth", "", "")).toBe("Enter a target above zero.");
    expect(goalDraftError("networth", "100", "x".repeat(281))).toBe("Notes are capped at 280 characters.");
    expect(goalDraftError("networth", "100", "note")).toBeNull();
  });
});

describe("metric metadata with registry fallback", () => {
  it("labels and units come from the response registry first", () => {
    expect(metricLabel(METRICS, "networth")).toBe("Net worth");
    expect(unitForMetric(METRICS, "networth")).toBe("money");
    expect(unitForMetric(METRICS, "strength")).toBe("stat");
  });

  it("an id missing from the response falls back to the shared GOAL_METRICS registry", () => {
    expect(metricLabel([], "level")).toBe("Level");
    expect(unitForMetric([], "level")).toBe("level");
    expect(unitForMetric([], "battlestats_total")).toBe("stat");
    expect(unitForMetric([], "networth")).toBe("money");
  });
});

describe("list shaping", () => {
  it("archived goals split off; active and achieved stay together in order", () => {
    const a = view({ goal: goal({ id: "a" }) });
    const b = view({ goal: goal({ id: "b", status: "achieved" }) });
    const c = view({ goal: goal({ id: "c", status: "archived" }) });
    const groups = splitGoals([a, b, c]);
    expect(groups.active.map((v) => v.goal.id)).toEqual(["a", "b"]);
    expect(groups.archived.map((v) => v.goal.id)).toEqual(["c"]);
  });

  it("an empty list splits into two empty groups", () => {
    expect(splitGoals([])).toEqual({ active: [], archived: [] });
  });
});

describe("as-of age line", () => {
  it("uses the injected relative formatter", () => {
    expect(asOfLabel(1_000, (ts) => `rel:${ts}`)).toBe("as of rel:1000");
  });

  it("no snapshot timestamp means no as-of claim", () => {
    expect(asOfLabel(null, () => "never")).toBe("");
  });
});

describe("stat projection presentation (semantic audit)", () => {
  it("recognizes the compounding stat model only", () => {
    expect(isStatProjection("relative_compounding")).toBe(true);
    expect(isStatProjection("median_delta_linear")).toBe(false);
    expect(isStatProjection("none")).toBe(false);
    expect(isStatProjection(null)).toBe(false);
  });

  it("formats ETA ranges in honest human units, never a precise date", () => {
    expect(formatEtaRange({ minDays: 100, maxDays: 140 })).toBe("~3 months–~5 months");
    expect(formatEtaRange({ minDays: 108, maxDays: 150 })).toBe("~4 months–~5 months");
    expect(formatEtaRange({ minDays: 3, maxDays: 9 })).toBe("~3 days–~9 days");
    expect(formatEtaRange({ minDays: 20, maxDays: 45 })).toBe("~3 weeks–~6 weeks");
    expect(formatEtaRange({ minDays: 1200, maxDays: 1600 })).toBe("~3.3 years–~4.4 years");
    expect(formatEtaRange(null)).toBeNull();
    // Degenerate input never formats.
    expect(formatEtaRange({ minDays: 50, maxDays: 40 })).toBeNull();
  });

  it("maps the withheld-model reason to explicit copy", () => {
    expect(insufficientReasonLabel("mechanics_not_modelled")).toContain("can't model");
  });
});
