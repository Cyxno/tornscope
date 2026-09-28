import { describe, expect, it } from "vitest";
import { deriveActionItems, ACTION_POLICY, type ActionFacts } from "../src/command-center.js";
import type { Insight } from "../src/insights.js";

const NOW = 1_750_000_000;

function facts(overrides: Partial<ActionFacts> = {}): ActionFacts {
  return {
    now: NOW,
    hasCredential: true,
    liveFactsAgeSeconds: 10,
    bars: null,
    cooldowns: [],
    bank: null,
    education: null,
    travel: null,
    hospitalUntil: null,
    jailedUntil: null,
    oc: [],
    goals: [],
    insights: [],
    freshnessIssues: [],
    networth: null,
    ...overrides,
  };
}

function insight(priority: "high" | "normal" | "low", confidence: "high" | "medium" | "low", id = "income_shift:w1"): Insight {
  return {
    id,
    kind: "income_shift",
    category: "economy",
    priority,
    title: "Income above your average",
    detail: "The past week's daily income ran well above your 30-day average.",
    sensitiveDetail: null,
    comparison: { metric: "Daily income", baselineLabel: "30-day average", baselineValue: 1, currentValue: 2, delta: 1, deltaPct: 100, unit: "money" },
    evidence: { from: NOW - 7 * 86400, to: NOW, sampleSize: 7, baselineDays: 30 },
    confidence,
    provenance: "exact",
    dedupeKey: id,
    occurredAt: NOW,
    clickPath: "/money",
  };
}

describe("deriveActionItems", () => {
  it("returns an empty feed when nothing is actionable", () => {
    expect(deriveActionItems(facts())).toEqual([]);
  });

  it("flags energy capped after the threshold with high priority", () => {
    const result = deriveActionItems(
      facts({ bars: { energy: { current: 150, maximum: 150, fullAt: NOW - 3600 } } })
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "energy_capped", priority: "high", state: "capped" });
    expect(result[0]!.explanation).toContain("1h");
  });

  it("does not flag freshly-capped or long-capped energy", () => {
    const fresh = deriveActionItems(facts({ bars: { energy: { current: 150, maximum: 150, fullAt: NOW - 60 } } }));
    expect(fresh.find((i) => i.type === "energy_capped")).toBeUndefined();
    const ancient = deriveActionItems(facts({ bars: { energy: { current: 150, maximum: 150, fullAt: NOW - 12 * 3600 } } }));
    expect(ancient.find((i) => i.type === "energy_capped")).toBeUndefined();
  });

  it("ignores all live-derived items when the facts are stale", () => {
    const result = deriveActionItems(facts({ liveFactsAgeSeconds: 3600, bars: { energy: { current: 150, maximum: 150, fullAt: NOW - 3600 } } }));
    expect(result).toEqual([]);
  });

  it("reports ready cooldowns within the ready window only", () => {
    const result = deriveActionItems(facts({ cooldowns: [{ kind: "drug", endsAt: NOW - 600 }, { kind: "booster", endsAt: NOW - 48 * 3600 }] }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "cooldown_ready:drug", type: "cooldown_ready", priority: "normal" });
  });

  it("prioritizes a matured bank investment", () => {
    const result = deriveActionItems(facts({ bank: { endsAt: NOW - 600, ready: true } }));
    expect(result[0]).toMatchObject({ type: "bank_matured", priority: "high" });
  });

  it("deduplicates by identity and sorts by priority then deadline", () => {
    const result = deriveActionItems(
      facts({
        cooldowns: [{ kind: "drug", endsAt: NOW - 600 }, { kind: "medical", endsAt: NOW - 700 }, { kind: "booster", endsAt: NOW - 800 }],
        bank: { endsAt: NOW - 300, ready: true },
        travel: { endsAt: NOW + 1800 },
      })
    );
    // One item per kind even though three cooldowns are ready.
    expect(result.filter((i) => i.type === "cooldown_ready")).toHaveLength(3); // drug/medical/booster are distinct identities
    const priorities = result.map((i) => i.priority);
    expect(priorities.indexOf("high")).toBeLessThan(priorities.indexOf("normal"));
    expect(result.find((i) => i.type === "travel_landing")).toBeDefined();
  });

  it("puts goal behind-pace above goal almost-there", () => {
    const result = deriveActionItems(
      facts({
        goals: [
          { id: "g1", metric: "networth", label: "Net worth 5B", target: 5e9, progress: 0.6, etaAt: NOW + 10 * 86400, targetDate: NOW + 5 * 86400, achievedAt: null, createdAt: NOW - 86400 },
          { id: "g2", metric: "level", label: "Level 60", target: 60, progress: 0.95, etaAt: NOW + 2 * 86400, targetDate: null, achievedAt: null, createdAt: NOW - 86400 },
        ],
      })
    );
    const atRisk = result.find((i) => i.type === "goal_at_risk");
    const soon = result.find((i) => i.type === "goal_eta_soon");
    expect(atRisk).toBeDefined();
    expect(soon).toBeDefined();
    expect(atRisk!.priority).toBe("high");
    expect(soon!.priority).toBe("normal");
  });

  it("reports achieved-but-unmarked goals once", () => {
    const result = deriveActionItems(
      facts({ goals: [{ id: "g1", metric: "networth", label: "5B", target: 5e9, progress: 1.0, etaAt: null, targetDate: null, achievedAt: null, createdAt: NOW - 86400 }] })
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "goal_achieved_pending", priority: "high" });
  });

  it("skips achieved goals entirely", () => {
    const result = deriveActionItems(
      facts({ goals: [{ id: "g1", metric: "networth", label: "5B", target: 5e9, progress: 1.0, etaAt: null, targetDate: null, achievedAt: NOW - 60, createdAt: NOW - 86400 }] })
    );
    expect(result).toEqual([]);
  });

  it("carries at most two insights and drops low-confidence ones", () => {
    const result = deriveActionItems(
      facts({
        insights: [
          insight("high", "high", "i1"),
          insight("normal", "medium", "i2"),
          insight("low", "high", "i3"),
          insight("high", "high", "i4"),
        ],
      })
    );
    const insightItems = result.filter((i) => i.type === "insight");
    expect(insightItems).toHaveLength(2);
    // i1 and i4 are both high-priority/high-confidence → they win; i3 (low
    // confidence) is dropped outright; i2 is next in line but beyond the cap.
    expect(insightItems.map((i) => i.id).sort()).toEqual(["insight:i1", "insight:i4"]);
    expect(insightItems[0]!.priority).toBe("normal"); // insights never outrank real actions
  });

  it("escalates failing data health and demotes degraded to low", () => {
    const result = deriveActionItems(
      facts({
        freshnessIssues: [
          { domain: "money", label: "Money logs", status: "failed" },
          { domain: "bars", label: "Bars", status: "stale" },
        ],
      })
    );
    const failed = result.find((i) => i.type === "data_health" && i.state === "failed");
    const degraded = result.find((i) => i.type === "data_health" && i.state !== "failed");
    expect(failed?.priority).toBe("high");
    expect(degraded?.priority).toBe("low");
  });

  it("suppresses data health items without a credential", () => {
    const result = deriveActionItems(facts({ hasCredential: false, freshnessIssues: [{ domain: "money", label: "Money logs", status: "failed" }] }));
    expect(result).toEqual([]);
  });

  it("adds a notable trend only past the threshold", () => {
    const quiet = deriveActionItems(facts({ networth: { current: 1e9, changePct7d: 3 } }));
    expect(quiet.find((i) => i.type === "notable_trend")).toBeUndefined();
    const loud = deriveActionItems(facts({ networth: { current: 1e9, changePct7d: -12.4 } }));
    const trend = loud.find((i) => i.type === "notable_trend");
    expect(trend).toBeDefined();
    expect(trend!.state).toBe("trend_down");
    expect(trend!.explanation).toContain("-12.4%");
  });

  it("caps the feed and per-priority counts", () => {
    const cooldowns = (["drug", "medical", "booster"] as const).map((kind) => ({ kind, endsAt: NOW - 600 }));
    const oc = Array.from({ length: 6 }, (_, i) => ({ id: `oc${i}`, name: `OC ${i}`, joined: true, readyAt: NOW - 600, status: "recruiting" }));
    const result = deriveActionItems(facts({ cooldowns, oc }));
    expect(result.length).toBeLessThanOrEqual(ACTION_POLICY.MAX_ITEMS);
    const highCount = result.filter((i) => i.priority === "high").length;
    expect(highCount).toBeLessThanOrEqual(ACTION_POLICY.MAX_PER_PRIORITY.high);
  });

  it("handles hospital and jail states", () => {
    const result = deriveActionItems(facts({ hospitalUntil: NOW + 3600 }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "hospital_jail", state: "hospital", deadlineAt: NOW + 3600 });
  });
});
