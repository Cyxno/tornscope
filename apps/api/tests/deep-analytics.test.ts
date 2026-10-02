import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { getEnergySummary } from "../src/services/energy.js";
import { getLogs, getLogsMeta, exportLogs, EXPORT_MAX_ROWS } from "../src/services/logs.js";
import { getDrugsSummary } from "../src/services/drugs.js";
import { getTravelSummary } from "../src/services/travel.js";

/**
 * Deep Analytics (2.1.0) service tests — energy accounting, log explorer,
 * streaming export and the enriched drugs/travel payloads. DB-backed
 * (TEST_DATABASE_URL) with synthetic profiles cleaned up afterwards;
 * skipped in the hermetic suite.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const FROM = NOW - 30 * DAY;
const TO = NOW + DAY;
const RANGE = { preset: "custom" as const, from: FROM, to: TO };

let userA: { id: string };
let userB: { id: string };
const cleanupIds: string[] = [];

function logRow(userId: string, ref: string, occurredAt: Date, category: string, title: string, data: Record<string, unknown>) {
  return {
    userId,
    occurredAt,
    type: "log",
    category,
    title,
    source: "torn_log",
    sourceRef: ref,
    metadata: { id: 1, timestamp: Math.floor(occurredAt.getTime() / 1000), details: { id: 0, title, category }, data },
  };
}

function fakeReply() {
  const chunks: string[] = [];
  const headers = {} as Record<string, string>;
  return {
    chunks,
    headers,
    header(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    send(chunk: string | Uint8Array) {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return this;
    },
  };
}

beforeAll(async () => {
  userA = await db.user.create({ data: { displayName: `DEEP-A-${randomUUID().slice(0, 8)}`, role: "user" } });
  userB = await db.user.create({ data: { displayName: `DEEP-B-${randomUUID().slice(0, 8)}`, role: "user" } });
  cleanupIds.push(userA.id, userB.id);

  const mid = new Date((FROM + TO) / 2 * 1000);

  // Raw log archive for user A (gym exact energy, refill, xanax OD, hunting).
  await db.timelineEvent.createMany({
    data: [
      logRow(userA.id, "deep:a:gym1", mid, "Gym", "Gym train strength", { energy_used: 200, trains: 20, happy_used: 100 }),
      logRow(userA.id, "deep:a:gym2", mid, "Gym", "Gym train defense", { energy_used: 100, trains: 10 }),
      logRow(userA.id, "deep:a:refill1", mid, "Points building", "Points energy refill use", { points_used: 30, energy_increased: 150 }),
      logRow(userA.id, "deep:a:od1", mid, "Drugs", "Item use xanax overdose", { item: 206, energy_decreased: 150, happy_decreased: 100 }),
      logRow(userA.id, "deep:a:ecstasyOD", mid, "Drugs", "Item use ecstasy overdose", { item: 197, happy_increased: 6250 }),
      logRow(userA.id, "deep:a:hunt", mid, "Hunting", "Hunting", { cost: 500, income: 10400 }),
      logRow(userA.id, "deep:a:bank", mid, "Bank", "Bank withdraw", { money: 25_000 }),
      // User B's own rows must never leak into A's queries.
      logRow(userB.id, "deep:b:gym1", mid, "Gym", "Gym train strength", { energy_used: 9999, trains: 1 }),
    ],
  });

  await db.drugEvent.createMany({
    data: [
      { userId: userA.id, occurredAt: mid, drugItemId: 206, drugName: "Xanax", outcome: "success", source: "torn_log", sourceRef: "deep:a:xan1" },
      { userId: userA.id, occurredAt: new Date((NOW - 2 * DAY) * 1000), drugItemId: 206, drugName: "Xanax", outcome: "success", source: "torn_log", sourceRef: "deep:a:xan2" },
      { userId: userA.id, occurredAt: new Date((NOW - 5 * DAY) * 1000), drugName: "Cannabis", outcome: "overdose", source: "torn_log", sourceRef: "deep:a:cannOD" },
      { userId: userB.id, occurredAt: mid, drugItemId: 206, drugName: "Xanax", outcome: "overdose", source: "torn_log", sourceRef: "deep:b:od" },
    ],
  });

  await db.barsSnapshot.createMany({
    data: [
      { userId: userA.id, capturedAt: new Date(FROM * 1000), energyCurrent: 0, energyMaximum: 150, happyCurrent: 0, happyMaximum: 500 },
      { userId: userA.id, capturedAt: new Date((FROM + 3600) * 1000), energyCurrent: 100, energyMaximum: 150, happyCurrent: 0, happyMaximum: 500 },
      { userId: userA.id, capturedAt: new Date((FROM + 7200) * 1000), energyCurrent: 40, energyMaximum: 150, happyCurrent: 0, happyMaximum: 500 },
    ],
  });

  await db.consumptionEvent.createMany({
    data: [
      { userId: userA.id, occurredAt: mid, category: "energy", quantity: 1, source: "torn_log", sourceRef: "deep:a:drink", metadata: { data: { energy_increased: 75 } } },
    ],
  });

  await db.combatEvent.createMany({
    data: [{ userId: userA.id, occurredAt: new Date((FROM + 3500) * 1000), direction: "outgoing", result: "Attacked", sourceRef: "deep:a:atk1" }],
  });

  await db.rehabEvent.createMany({
    data: [
      { userId: userA.id, occurredAt: new Date((NOW - 10 * DAY) * 1000), cost: 12_000n, rehabPercent: 50, sessions: 2, addictionPointsRemoved: 12, source: "torn_log", sourceRef: "deep:a:reh1" },
      { userId: userA.id, occurredAt: new Date((NOW - 3 * DAY) * 1000), cost: 16_000n, rehabPercent: 60, sessions: 2, addictionPointsRemoved: 14, source: "torn_log", sourceRef: "deep:a:reh2" },
    ],
  });

  await db.travelEvent.createMany({
    data: [
      { userId: userA.id, destination: "UAE", departedAt: new Date((FROM + DAY) * 1000), returnedAt: new Date((FROM + DAY + 14_400) * 1000), durationSeconds: 14_400, status: "returned", source: "trip", sourceRef: "deep:a:trip1" },
      { userId: userA.id, destination: "UAE", departedAt: new Date((FROM + 2 * DAY) * 1000), returnedAt: new Date((FROM + 2 * DAY + 14_400) * 1000), durationSeconds: 14_400, status: "returned", source: "trip", sourceRef: "deep:a:trip2" },
    ],
  });
});

afterAll(async () => {
  for (const id of cleanupIds) {
    await db.timelineEvent.deleteMany({ where: { userId: id } });
    await db.drugEvent.deleteMany({ where: { userId: id } });
    await db.barsSnapshot.deleteMany({ where: { userId: id } });
    await db.consumptionEvent.deleteMany({ where: { userId: id } });
    await db.combatEvent.deleteMany({ where: { userId: id } });
    await db.rehabEvent.deleteMany({ where: { userId: id } });
    await db.travelEvent.deleteMany({ where: { userId: id } });
    await db.moneyEvent.deleteMany({ where: { userId: id } });
    await db.user.delete({ where: { id: id } }).catch(() => undefined);
  }
});

suite("energy accounting service", () => {
  it("aggregates exact gym/refill/OD energy and keeps ecstasy ODs out", async () => {
    const res = await getEnergySummary(userA.id, RANGE);
    const gym = res.uses.find((u) => u.category === "gym");
    expect(gym?.amount).toBe(300);
    expect(gym?.provenance).toBe("exact");

    const refill = res.sources.find((s) => s.category === "refill");
    expect(refill?.amount).toBe(150);
    expect(refill?.pointsUsed).toBe(30);

    const xanax = res.sources.find((s) => s.category === "xanax");
    expect(xanax?.amount).toBe(500); // two successful uses × documented 250
    expect(xanax?.provenance).toBe("estimated");

    // Only the Xanax OD carries energy_decreased; ecstasy never drains energy.
    expect(res.losses.map((l) => l.category)).toEqual(["Xanax"]);
    expect(res.balance.lost.value).toBe(150);
    // No drug-drink source leakage: energy drink is exact 75.
    expect(res.sources.find((s) => s.category === "energy_drink")?.amount).toBe(75);
  });

  it("derives natural regen from bars and withholds the net without coverage", async () => {
    const res = await getEnergySummary(userA.id, RANGE);
    expect(res.balance.generated.value).not.toBeNull();
    expect(res.coverage.quality).toBe("full");
    expect(res.coverage.accountedShare).not.toBeNull();

    const uncovered = await getEnergySummary(userA.id, { preset: "custom", from: NOW - 400 * DAY, to: NOW - 300 * DAY });
    expect(uncovered.balance.generated.value).toBeNull();
    expect(uncovered.balance.net.value).toBeNull();
    expect(uncovered.coverage.quality).toBe("unavailable");
    expect(uncovered.coverage.accountedShare).toBeNull();
  });

  it("never exposes another profile's rows", async () => {
    const res = await getEnergySummary(userA.id, RANGE);
    const gym = res.uses.find((u) => u.category === "gym");
    expect(gym?.amount).toBe(300); // not 9999+300
    const resB = await getEnergySummary(userB.id, RANGE);
    expect(resB.uses.find((u) => u.category === "gym")?.amount).toBe(9999);
    expect(resB.sources.find((s) => s.category === "xanax")?.events ?? 0).toBe(0);
  });

  it("respects date-range boundaries", async () => {
    const tight = await getEnergySummary(userA.id, { preset: "custom", from: NOW - DAY, to: NOW + DAY });
    expect(tight.sources.find((s) => s.category === "refill")).toBeUndefined();
    expect(tight.uses.find((u) => u.category === "gym")).toBeUndefined();
  });
});

suite("log explorer service", () => {
  it("lists archive rows with signed money and exact energy", async () => {
    const res = await getLogs(userA.id, RANGE, { limit: 50 });
    expect(res.items.length).toBeGreaterThanOrEqual(6);
    const bank = res.items.find((l) => l.title === "Bank withdraw");
    expect(bank?.money).toBe(25_000);
    const od = res.items.find((l) => l.title === "Item use xanax overdose");
    expect(od?.energy).toBe(-150);
    const hunt = res.items.find((l) => l.title === "Hunting");
    // Hunting carries cost+income keys with no classifiable direction —
    // unknown money shows NO amount (same rule as the ledger).
    expect(hunt?.money).toBeNull();
    // Raw payloads never ship wholesale — only the bounded digest.
    expect(JSON.stringify(res.items)).not.toContain('"metadata"');
  });

  it("filters by category, type, search, outcome and amount range", async () => {
    const gymOnly = await getLogs(userA.id, RANGE, { category: "Gym", limit: 50 });
    expect(gymOnly.items.every((l) => l.category === "Gym")).toBe(true);
    expect(gymOnly.items.length).toBe(2);

    const byType = await getLogs(userA.id, RANGE, { type: "Points energy refill use", limit: 50 });
    expect(byType.items).toHaveLength(1);

    const search = await getLogs(userA.id, RANGE, { search: "overdose", limit: 50 });
    expect(search.items.length).toBeGreaterThanOrEqual(2);

    const gains = await getLogs(userA.id, RANGE, { outcome: "gain", minAmount: "1000", limit: 50 });
    expect(gains.items.every((l) => (l.money ?? 0) >= 1000)).toBe(true);
    expect(gains.items.some((l) => l.title === "Bank withdraw")).toBe(true);

    const losses = await getLogs(userA.id, RANGE, { outcome: "loss", maxAmount: "600", limit: 50 });
    expect(losses.items.every((l) => (l.money ?? 0) <= -1 && Math.abs(l.money ?? 0) <= 600)).toBe(true);
  });

  it("paginates with a keyset cursor without duplicates", async () => {
    const page1 = await getLogs(userA.id, RANGE, { limit: 3 });
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await getLogs(userA.id, RANGE, { limit: 50, cursor: page1.nextCursor! });
    const ids1 = new Set(page1.items.map((i) => i.id));
    for (const item of page2.items) expect(ids1.has(item.id)).toBe(false);
  });

  it("continues payload-filtered pagination past sparse pages (regression)", async () => {
    // Sparse money-filtered query: a long tail of non-matching rows sits
    // around the matches, so no single fetch page can contain them all.
    const tail = [];
    for (let i = 0; i < 400; i++) {
      tail.push(logRow(userA.id, `deep:a:noise:${i}`, new Date((FROM - (i + 100) * 86400) * 1000), "Hunting", "Hunting", { cost: 500 }));
    }
    // Gain matches deep inside the noise tail: positions beyond the first
    // scan page (limit*4+100 rows), so page 1 cannot contain them all.
    for (const offsetDays of [150, 250, 350]) {
      tail.push(logRow(userA.id, `deep:a:crime:${offsetDays}`, new Date((FROM - offsetDays * 86400) * 1000), "Crimes", "Crime success", { money_gained: 250_000 }));
    }
    await db.timelineEvent.createMany({ data: tail });

    const wide = { preset: "custom", from: FROM - 500 * 86400, to: TO };
    const page1 = await getLogs(userA.id, wide, { outcome: "gain", minAmount: "1000", limit: 3 });
    expect(page1.items).toHaveLength(3);
    // Regression: a short FILTERED page must still report a cursor when more
    // source rows exist beyond the scanned window.
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await getLogs(userA.id, wide, { outcome: "gain", minAmount: "1000", limit: 50, cursor: page1.nextCursor });
    const ids1 = new Set(page1.items.map((i) => i.id));
    for (const item of page2.items) expect(ids1.has(item.id)).toBe(false);
    expect(page2.items.length).toBeGreaterThanOrEqual(1);
    expect(page2.items.some((i) => i.title === "Crime success")).toBe(true);
  });

  it("keeps profiles isolated", async () => {
    const res = await getLogs(userB.id, RANGE, { limit: 50 });
    expect(res.items.some((l) => l.title === "Gym train strength")).toBe(true);
    expect(res.items.some((l) => l.title === "Bank withdraw")).toBe(false);
  });

  it("returns bounded meta", async () => {
    const meta = await getLogsMeta(userA.id, RANGE);
    const gym = meta.categories.find((c) => c.category === "Gym");
    expect(gym?.count).toBe(2);
    expect(meta.totalLogs).toBeGreaterThanOrEqual(6);
    expect(meta.oldestAt).not.toBeNull();
  });
});

suite("log export", () => {
  it("streams CSV with headers and signed values", async () => {
    const reply = fakeReply();
    await exportLogs(reply, userA.id, RANGE, { format: "csv" });
    expect(Object.values(reply.headers).join(" ")).toContain(".csv");
    const body = reply.chunks.join("");
    const lines = body.trim().split("\n");
    expect(lines[0]).toContain("timestamp,category,type,summary,energy,money,details");
    expect(lines.length).toBeGreaterThanOrEqual(7);
    expect(body).toContain("Bank withdraw");
  });

  it("streams valid JSON arrays", async () => {
    const reply = fakeReply();
    await exportLogs(reply, userA.id, RANGE, { format: "json" });
    expect(Object.values(reply.headers).join(" ")).toContain(".json");
    const parsed = JSON.parse(reply.chunks.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(6);
    expect(parsed[0]).toHaveProperty("title");
  });

  it("respects the outcome filter in exports too", async () => {
    const reply = fakeReply();
    await exportLogs(reply, userA.id, RANGE, { format: "json", outcome: "gain", minAmount: "1000" });
    const parsed = JSON.parse(reply.chunks.join(""));
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    for (const row of parsed) expect(row.money).toBeGreaterThanOrEqual(1000);
  });

  it("never contains credentials or another profile's rows", async () => {
    const reply = fakeReply();
    await exportLogs(reply, userA.id, RANGE, { format: "json" });
    const body = reply.chunks.join("");
    expect(body).not.toMatch(/api[_-]?key|encrypted|credential/i);
    expect(body).not.toContain("9999"); // user B's gym energy
    expect(body).not.toContain(userB.id);
  });

  it("exposes a finite export cap", () => {
    expect(EXPORT_MAX_ROWS).toBeGreaterThan(0);
    expect(EXPORT_MAX_ROWS).toBeLessThanOrEqual(200_000);
  });
});

suite("drugs & travel 2.1.0 payloads", () => {
  it("returns streaks over full history and enriched per-drug rows", async () => {
    const res = await getDrugsSummary(userA.id, RANGE, null);
    expect(res.overall.streaks).toBeDefined();
    // Cannabis OD (5d ago) after two Xanax successes (2d/now) — the Xanax
    // uses are one species, Cannabis another: overall current streak counts
    // successes after the LAST OD of any drug.
    expect(res.overall.streaks!.lastOverdoseAt).not.toBeNull();
    const xanax = res.byDrug.find((d) => d.drug === "Xanax");
    expect(xanax?.uses).toBe(2);
    expect(xanax?.currentStreak).toBe(2);
    expect(xanax?.lastOverdoseAt ?? null).toBeNull();
  });

  it("returns rehab AP totals, cost/AP and an estimated next cost", async () => {
    const res = await getDrugsSummary(userA.id, RANGE, null);
    expect(res.rehab.addictionPointsRemoved).toBe(26);
    expect(res.rehab.addictionPointsKnownVisits).toBe(2);
    expect(res.rehab.costPerAddictionPoint?.value).toBe(1077); // 28000/26 rounded
    expect(res.rehab.estimatedNextCost?.value).toBe(14_000); // median(12000, 16000)
    expect(res.rehab.estimatedNextCost?.provenance).toBe("estimated");
  });

  it("returns the travel overview with exact flight time", async () => {
    const res = await getTravelSummary(userA.id, RANGE);
    expect(res.overview).toBeDefined();
    expect(res.overview!.trips).toBe(2);
    expect(res.overview!.flightTimeSeconds).toBe(28_800);
    const uae = res.overview!.byDestination.find((d) => d.destination === "UAE");
    expect(uae?.trips).toBe(2);
    expect(uae?.averageFlightSeconds).toBe(14_400);
    expect(res.overview!.daily.length).toBeGreaterThanOrEqual(1);
  });
});
