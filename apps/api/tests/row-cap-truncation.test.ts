import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { resolveDateRange } from "@tornscope/shared";

/**
 * Row-cap truncation honesty (roadmap #9 remediation, phases 60–63).
 *
 * The hardening row caps are runaway guards — but an aggregate computed
 * over a clipped window must NEVER present itself as complete. With an
 * injected low cap this test proves:
 *  - deterministic clipping (oldest-first ordering, in-range rows only),
 *  - the analysis_truncated confidence disclosure on economy,
 *  - the analysisTruncated flag on the money summary,
 *  - no false "Complete" while truncated, and NO disclosure under the cap.
 *
 * Runs against a real PostgreSQL when TEST_DATABASE_URL is set. Caps are
 * env-injectable (clamp floor 100) so no fixture needs 250k rows.
 */

process.env.ECONOMY_MAX_MONEY_ROWS = "100";
process.env.MONEY_SUMMARY_MAX_ROWS = "100";

const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const createdUsers: string[] = [];
const nowSec = Math.floor(Date.now() / 1000);

async function makeProfile(): Promise<string> {
  const id = `cap-${randomBytes(10).toString("hex")}`;
  createdUsers.push(id);
  await db.user.create({ data: { id, displayName: "cap-test", role: "user" } });
  return id;
}

/** 110 deterministic events, oldest-first, spanning ~29.5d inside a 30d range.
 *  Even i = income +(1000+i); odd i = expense -(1000+i). */
async function seedMoneyEvents(userId: string): Promise<void> {
  const rows = [];
  for (let i = 0; i < 110; i++) {
    rows.push({
      userId,
      occurredAt: new Date((nowSec - 30 * 86_400 + i * 23_400) * 1000),
      category: i % 2 === 0 ? "jobs" : "faction",
      direction: i % 2 === 0 ? ("income" as const) : ("expense" as const),
      amount: BigInt(i % 2 === 0 ? 1_000 + i : -(1_000 + i)),
      source: "money_logs",
      sourceRef: `cap-${i}-${randomBytes(6).toString("hex")}`,
    });
  }
  await db.moneyEvent.createMany({ data: rows });
}

/** The exact in-range window the service queries, oldest-first. */
function inRangeRows(userId: string) {
  const range = resolveDateRange({ preset: "30d" }, nowSec);
  return db.moneyEvent.findMany({
    where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
    orderBy: { occurredAt: "asc" },
    select: { amount: true, direction: true },
  });
}

beforeAll(async () => {
  await db.user.count();
});

afterAll(async () => {
  for (const id of createdUsers) {
    await db.moneyEvent.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.apiCredential.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id } }).catch(() => undefined);
  }
});

suite("row-cap truncation honesty", () => {
  it("110 events, cap 100: economy clips deterministically and discloses partial", async () => {
    const userId = await makeProfile();
    await db.apiCredential.create({
      data: { id: `cred-${userId}`, userId, encryptedKey: "x", iv: "x", authTag: "x", keyPreview: "…", logAccessAvailable: true },
    });
    await seedMoneyEvents(userId);
    const { getEconomySummary } = await import("../src/services/economy.js");
    const summary = await getEconomySummary(userId, { preset: "30d" });

    // Disclosure: money confidence is partial with the truncation reason.
    expect(summary.confidence.cashFlow.confidence).toBe("partial");
    expect(summary.confidence.cashFlow.reason).toBe("analysis_truncated");

    // Deterministic clipping: the EARLIEST 100 in-range events are analyzed.
    const inRange = await inRangeRows(userId);
    expect(inRange.length).toBeGreaterThan(100); // fixture sanity
    const clipped = inRange.slice(0, 100);
    const expectedIncome = clipped.filter((r) => r.direction === "income").reduce((s, r) => s + Number(r.amount), 0);
    expect(summary.cashFlow.income.value).toBe(expectedIncome);
    // Prove clipping actually changed the aggregate vs the full window.
    const fullIncome = inRange.filter((r) => r.direction === "income").reduce((s, r) => s + Number(r.amount), 0);
    expect(expectedIncome).not.toBe(fullIncome);
  });

  it("money summary carries analysisTruncated and clips the same way", async () => {
    const userId = await makeProfile();
    await seedMoneyEvents(userId);
    const { getMoneySummary } = await import("../src/services/money.js");
    const summary = await getMoneySummary(userId, { preset: "30d" });
    expect(summary.analysisTruncated).toBe(true);
    const inRange = await inRangeRows(userId);
    const clipped = inRange.slice(0, 100);
    const expectedIncome = clipped.filter((r) => r.direction === "income").reduce((s, r) => s + Number(r.amount), 0);
    expect(summary.totalIncome.value).toBe(expectedIncome);
  });

  it("under the cap: no disclosure, full-window totals", async () => {
    const userId = await makeProfile();
    await seedMoneyEvents(userId);
    // Remove the newest 15 events → 95 in range < 100 cap.
    const newest = await db.moneyEvent.findMany({
      where: { userId }, orderBy: { occurredAt: "desc" }, take: 15, select: { id: true },
    });
    for (const row of newest) await db.moneyEvent.delete({ where: { id: row.id } });
    const { getMoneySummary } = await import("../src/services/money.js");
    const summary = await getMoneySummary(userId, { preset: "30d" });
    expect(summary.analysisTruncated).toBeUndefined();
    const inRange = await inRangeRows(userId);
    const expectedIncome = inRange.filter((r) => r.direction === "income").reduce((s, r) => s + Number(r.amount), 0);
    expect(summary.totalIncome.value).toBe(expectedIncome);
  });
});
