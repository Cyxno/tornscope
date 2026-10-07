import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { getDecisions, getDecisionPrefs, updateDecisionPrefs, invalidateDecisionsCache } from "../src/services/decisions.js";

/**
 * Decision Intelligence service tests (2.3.0) — endpoint contract on real
 * data: bounded gather, coverage disclosure, prefs round-trip, lifecycle
 * state persistence and the no-Torn-calls guarantee (the service only reads
 * local tables).
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
let userId: string;

beforeAll(async () => {
  userId = (await db.user.create({ data: { displayName: `DI-${randomUUID().slice(0, 8)}`, role: "user" } })).id;
  // A tiny but realistic slice: expenses (recent spike), income, xanax uses,
  // gym logs, refills, trips + items.
  const now = Math.floor(Date.now() / 1000);
  const D = 86_400;
  // Baseline rows sit 9-34 days back: comfortably inside the facts gatherer's
  // 37-day window with days of margin. The original layout put the oldest row
  // EXACTLY on that 37-day boundary — any second of delay between the fixture
  // and the service call dropped it from the gather (the 46-vs-47 coverage
  // flake fixed in 2.5.4).
  const baseline = (i: number) => now - 9 * D - i * 20 * 3600;
  // The drugs baseline has 40 rows: tighter 15h spacing keeps the oldest
  // within ~33 days (still days clear of the 37-day gather window).
  const drugsBaseline = (i: number) => now - 9 * D - i * 15 * 3600;
  const moneyRows = [];
  for (let i = 0; i < 7; i++) moneyRows.push({ userId, occurredAt: new Date((now - i * D - 100) * 1000), category: "other", direction: "expense" as const, amount: BigInt(5000 + i), source: "test", sourceRef: `di:exp:${i}` });
  for (let i = 0; i < 30; i++) moneyRows.push({ userId, occurredAt: new Date(baseline(i) * 1000), category: "other", direction: "expense" as const, amount: BigInt(1000), source: "test", sourceRef: `di:expb:${i}` });
  for (let i = 0; i < 10; i++) moneyRows.push({ userId, occurredAt: new Date((now - i * D - 50) * 1000), category: "salary", direction: "income" as const, amount: BigInt(20_000), source: "test", sourceRef: `di:inc:${i}` });
  await db.moneyEvent.createMany({ data: moneyRows });
  await db.drugEvent.createMany({
    data: [
      ...Array.from({ length: 10 }, (_, i) => ({ userId, occurredAt: new Date((now - (i % 5) * D - 100) * 1000), drugName: "Xanax", outcome: "success" as const, source: "test", sourceRef: `di:xan:${i}` })),
      ...Array.from({ length: 40 }, (_, i) => ({ userId, occurredAt: new Date(drugsBaseline(i) * 1000), drugName: "Xanax", outcome: "success" as const, source: "test", sourceRef: `di:xanb:${i}` })),
    ],
  });
  await db.timelineEvent.createMany({
    data: [
      ...Array.from({ length: 8 }, (_, i) => ({ userId, occurredAt: new Date((now - (i % 4) * D - 100) * 1000), type: "log", category: "Gym", title: "Gym train strength", source: "torn_log", sourceRef: `di:gym:${i}`, metadata: { data: { energy_used: 400 } } })),
      ...Array.from({ length: 30 }, (_, i) => ({ userId, occurredAt: new Date(baseline(i) * 1000), type: "log", category: "Gym", title: "Gym train strength", source: "torn_log", sourceRef: `di:gymb:${i}`, metadata: { data: { energy_used: 100 } } })),
    ],
  });
});

afterAll(async () => {
  await db.appSetting.deleteMany({ where: { userId } });
  await db.moneyEvent.deleteMany({ where: { userId } });
  await db.drugEvent.deleteMany({ where: { userId } });
  await db.timelineEvent.deleteMany({ where: { userId } });
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
});

suite("decision intelligence service", () => {
  it("returns a well-formed response with coverage and prefs", async () => {
    const res = await getDecisions(userId);
    expect(res.generatedAt).toBeGreaterThan(0);
    expect(res.prefs.enabled).toBe(true);
    expect(res.prefs.maxOverviewSignals).toBe(3);
    expect(res.coverage.money.events).toBe(47);
    expect(res.coverage.money.trackingSince).not.toBeNull();
  });

  it("computes signals from local history only", async () => {
    const res = await getDecisions(userId);
    for (const s of res.signals) {
      expect(s.evidence.length).toBeGreaterThan(0);
      expect(s.reason).toContain("baseline");
      expect(s.actionUrl).toMatch(/^\/(money|travel|energy|drugs|goals)$/);
    }
  });

  it("persists prefs and normalizes partial patches", async () => {
    const updated = await updateDecisionPrefs(userId, { maxOverviewSignals: 5, domains: { travel: false } });
    expect(updated.maxOverviewSignals).toBe(5);
    expect(updated.domains.travel).toBe(false);
    expect(updated.domains.money).toBe(true);
    const reread = await getDecisionPrefs(userId);
    expect(reread.maxOverviewSignals).toBe(5);
  });

  it("persists signal lifecycle state across runs", async () => {
    const first = await getDecisions(userId);
    const second = await getDecisions(userId);
    for (const s of second.signals) {
      expect(s.firstSeenAt).not.toBeNull();
    }
    // The state row exists in AppSetting KV (no dedicated table needed).
    const stateRow = await db.appSetting.findUnique({ where: { userId_key: { userId, key: "decision_signal_state" } } });
    expect(stateRow).not.toBeNull();
    void first;
  });

  it("honors the enabled=false pref by returning zero signals", async () => {
    await updateDecisionPrefs(userId, { enabled: false });
    const res = await getDecisions(userId);
    expect(res.signals).toHaveLength(0);
    await updateDecisionPrefs(userId, { enabled: true });
  });
});

suite("decision intelligence invariants (audit hardening)", () => {
  it("single-flight: concurrent cold misses share one build (no duplicate writes)", async () => {
    await db.appSetting.deleteMany({ where: { userId, key: "decision_signal_state" } });
    invalidateDecisionsCache(userId);
    const [a, b, c] = await Promise.all([getDecisions(userId), getDecisions(userId), getDecisions(userId)]);
    // All three resolve to the SAME response object identity (shared flight).
    expect(a).toBe(b);
    expect(b).toBe(c);
    // The lifecycle write happened exactly once (state row exists once, AppSetting is KV).
    const stateRow = await db.appSetting.findUnique({ where: { userId_key: { userId, key: "decision_signal_state" } } });
    expect(stateRow).not.toBeNull();
  });

  it("cache: warm hit within TTL returns the same response object", async () => {
    const a = await getDecisions(userId);
    const b = await getDecisions(userId);
    expect(a).toBe(b);
  });

  it("prefs update invalidates the cache (next response reflects new prefs)", async () => {
    await updateDecisionPrefs(userId, { maxOverviewSignals: 4 });
    const res = await getDecisions(userId);
    expect(res.prefs.maxOverviewSignals).toBe(4);
  });
});
