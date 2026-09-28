import { describe, expect, it } from "vitest";
import type { ActionCategory, ActionItem, ActionPriority } from "@tornscope/shared";
import { deadlineLabel, deriveCommandCenter, PRIORITY_TONES } from "../src/lib/command-center-view";

/**
 * Command Center view derivation (2.0). Logic-level tests: the feed is
 * ordered by priority (critical → low), ties break by soonest deadline with
 * no-deadline items last, every category maps to an icon, deadlines render
 * only while FUTURE, and priority carries an accessible text label — never
 * color alone.
 */

const NOW = 1_000_000;
const HOUR = 3600;

let seq = 0;
function actionItem(over: Partial<ActionItem> = {}): ActionItem {
  seq += 1;
  return {
    id: `item-${seq}`,
    type: "insight",
    category: "insight",
    priority: "normal",
    title: "An item",
    state: "info",
    explanation: "One-sentence evidence-based explanation.",
    deadlineAt: null,
    actionUrl: null,
    analyticsUrl: "/today",
    confidence: "exact",
    occurredAt: NOW,
    ...over,
  };
}

describe("priority ordering", () => {
  it("sorts critical → high → normal → low regardless of input order", () => {
    const feed = deriveCommandCenter(
      [
        actionItem({ id: "a", priority: "low" }),
        actionItem({ id: "b", priority: "normal" }),
        actionItem({ id: "c", priority: "critical" }),
        actionItem({ id: "d", priority: "high" }),
      ],
      NOW
    );
    expect(feed.map((i) => i.key)).toEqual(["c", "d", "b", "a"]);
  });

  it("same priority: sooner deadline first, no deadline last", () => {
    const feed = deriveCommandCenter(
      [
        actionItem({ id: "none", deadlineAt: null }),
        actionItem({ id: "far", deadlineAt: NOW + 5 * HOUR }),
        actionItem({ id: "soon", deadlineAt: NOW + HOUR }),
      ],
      NOW
    );
    expect(feed.map((i) => i.key)).toEqual(["soon", "far", "none"]);
  });

  it("same priority and deadline: newest occurredAt first", () => {
    const feed = deriveCommandCenter(
      [
        actionItem({ id: "old", occurredAt: NOW - 500 }),
        actionItem({ id: "new", occurredAt: NOW }),
      ],
      NOW
    );
    expect(feed.map((i) => i.key)).toEqual(["new", "old"]);
  });

  it("does not mutate the input array", () => {
    const items = [actionItem({ id: "a", priority: "low" }), actionItem({ id: "b", priority: "critical" })];
    deriveCommandCenter(items, NOW);
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("category → icon mapping", () => {
  const EXPECTED: Record<ActionCategory, string> = {
    bars: "today",
    cooldown: "clock",
    finance: "wallet",
    faction: "faction",
    travel: "travel",
    progression: "progression",
    goal: "goal",
    insight: "insight",
    health: "alert",
  };

  it("maps every category to its icon", () => {
    for (const [category, icon] of Object.entries(EXPECTED) as Array<[ActionCategory, string]>) {
      const feed = deriveCommandCenter([actionItem({ id: `x-${category}`, category })], NOW);
      expect(feed[0]!.icon, `icon for category ${category}`).toBe(icon);
    }
  });
});

describe("deadline labels", () => {
  it("a future deadline renders as a compact countdown", () => {
    expect(deadlineLabel(NOW + HOUR + 2 * 60, NOW)).toBe("in 1h 02m");
    expect(deadlineLabel(NOW + 3 * 86_400, NOW)).toBe("in 3d 0h");
  });

  it("no deadline and passed deadlines render no countdown", () => {
    expect(deadlineLabel(null, NOW)).toBeNull();
    expect(deadlineLabel(NOW - 1, NOW)).toBeNull();
    expect(deadlineLabel(NOW, NOW)).toBeNull();
  });

  it("view items carry the remaining seconds only while the deadline is future", () => {
    const feed = deriveCommandCenter(
      [
        actionItem({ id: "future", deadlineAt: NOW + 120 }),
        actionItem({ id: "past", deadlineAt: NOW - 120 }),
        actionItem({ id: "none", deadlineAt: null }),
      ],
      NOW
    );
    const byId = Object.fromEntries(feed.map((i) => [i.key, i]));
    expect(byId["future"]!.deadlineSeconds).toBe(120);
    expect(byId["future"]!.deadline).toBe("in 2m");
    expect(byId["past"]!.deadlineSeconds).toBeNull();
    expect(byId["past"]!.deadline).toBeNull();
    expect(byId["none"]!.deadlineSeconds).toBeNull();
  });
});

describe("priority tones (accessible, not color alone)", () => {
  it("every priority has a text label and accent classes", () => {
    const priorities: ActionPriority[] = ["critical", "high", "normal", "low"];
    for (const priority of priorities) {
      const tone = PRIORITY_TONES[priority];
      expect(tone.label.toLowerCase()).toContain("priority");
      expect(tone.dot).toMatch(/^bg-/);
      expect(tone.text).toMatch(/^text-/);
    }
  });

  it("critical uses the negative semantic, high the warning, normal the accent, low stays quiet", () => {
    expect(PRIORITY_TONES.critical.dot).toBe("bg-negative");
    expect(PRIORITY_TONES.high.dot).toBe("bg-warning");
    expect(PRIORITY_TONES.normal.dot).toBe("bg-accent");
    expect(PRIORITY_TONES.low.dot).toBe("bg-fg-faint");
  });

  it("view items carry their priority tone", () => {
    const feed = deriveCommandCenter([actionItem({ id: "hi", priority: "high" })], NOW);
    expect(feed[0]!.tone).toEqual(PRIORITY_TONES.high);
  });
});

describe("shape", () => {
  it("an empty feed stays empty", () => {
    expect(deriveCommandCenter([], NOW)).toEqual([]);
  });

  it("passes title, explanation and the analytics destination through", () => {
    const feed = deriveCommandCenter(
      [actionItem({ id: "x", title: "Energy is capped", explanation: "Full for 2h.", analyticsUrl: "/today" })],
      NOW
    );
    expect(feed[0]).toMatchObject({
      key: "x",
      title: "Energy is capped",
      explanation: "Full for 2h.",
      analyticsUrl: "/today",
    });
  });

  it("an item without an analytics destination is not a link", () => {
    const feed = deriveCommandCenter([actionItem({ id: "x", analyticsUrl: null })], NOW);
    expect(feed[0]!.analyticsUrl).toBeNull();
  });
});
