import { describe, expect, it } from "vitest";
import { GoalCreateInputSchema, GoalSchema, GoalUpdateInputSchema, GoalViewSchema, ProjectionSchema } from "../src/goals.js";

const DAY = 86_400;

const validGoal = {
  id: "g1",
  metric: "networth",
  target: 5_000_000_000,
  note: null,
  createdAt: 1_750_000_000,
  targetDate: null,
  status: "active",
  achievedAt: null,
};

describe("GoalCreateInputSchema", () => {
  it("accepts a valid create payload", () => {
    const parsed = GoalCreateInputSchema.safeParse({ metric: "networth", target: 5_000_000_000, note: "goal", targetDate: 1_800_000_000 });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown metrics and non-positive targets", () => {
    expect(GoalCreateInputSchema.safeParse({ metric: "happiness", target: 10 }).success).toBe(false);
    expect(GoalCreateInputSchema.safeParse({ metric: "networth", target: 0 }).success).toBe(false);
    expect(GoalCreateInputSchema.safeParse({ metric: "networth", target: -5 }).success).toBe(false);
  });

  it("rejects oversized notes and non-integer target dates", () => {
    expect(GoalCreateInputSchema.safeParse({ metric: "level", target: 100, note: "x".repeat(281) }).success).toBe(false);
    expect(GoalCreateInputSchema.safeParse({ metric: "level", target: 100, targetDate: 1.5 }).success).toBe(false);
  });
});

describe("GoalUpdateInputSchema", () => {
  it("accepts partial patches", () => {
    expect(GoalUpdateInputSchema.safeParse({}).success).toBe(true);
    expect(GoalUpdateInputSchema.safeParse({ target: 100 }).success).toBe(true);
    expect(GoalUpdateInputSchema.safeParse({ status: "archived" }).success).toBe(true);
    expect(GoalUpdateInputSchema.safeParse({ note: null }).success).toBe(true);
  });

  it("never lets a client mark a goal achieved directly", () => {
    expect(GoalUpdateInputSchema.safeParse({ status: "achieved" }).success).toBe(false);
  });
});

describe("response schemas", () => {
  it("parses a full goal view", () => {
    const view = {
      goal: validGoal,
      currentValue: 4_000_000_000,
      currentValueAt: 1_750_000_000,
      progress: 0.8,
      projection: {
        etaAt: 1_760_000_000,
        velocityPerDay: 10_000_000,
        slopePerDay: 10_000_000,
        fitR2: 0.9,
        lookbackDays: 30,
        confidence: "high",
        insufficientReason: null,
        window: { from: 1_740_000_000, to: 1_750_000_000, points: 30 },
        provenance: "derived",
      },
      dataAvailable: true,
    };
    expect(GoalViewSchema.safeParse(view).success).toBe(true);
    expect(GoalSchema.safeParse(validGoal).success).toBe(true);
  });

  it("accepts withheld projections (null eta + reason) and rejects unknown reasons", () => {
    const base = { velocityPerDay: null, slopePerDay: null, fitR2: null, lookbackDays: 30, confidence: "insufficient", window: { from: null, to: null, points: 0 }, provenance: "derived" };
    expect(ProjectionSchema.safeParse({ ...base, etaAt: null, insufficientReason: "insufficient_history" }).success).toBe(true);
    expect(ProjectionSchema.safeParse({ ...base, etaAt: null, insufficientReason: "made_up_reason" }).success).toBe(false);
  });

  it("rejects out-of-registry goal status", () => {
    expect(GoalSchema.safeParse({ ...validGoal, status: "pending" }).success).toBe(false);
  });

  it("day boundaries stay stable (targetDate round-trips as unix seconds)", () => {
    const ts = 1_800_000_000;
    const parsed = GoalCreateInputSchema.safeParse({ metric: "strength", target: 10_000_000, targetDate: ts });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.targetDate).toBe(ts);
    void DAY;
  });
});
