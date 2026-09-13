import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { getDailySummary } from "../src/services/dailySummary.js";
import { AppError } from "../src/errors.js";
import { deleteProfile } from "../src/services/me.js";
import { resolveDayRange } from "@tornscope/shared";

/**
 * Daily Summary acceptance matrix (v0.2 roadmap item #2).
 *
 * DB-backed: synthetic profiles are created and deleted per run. The fixture
 * builds a deterministic "yesterday" (UTC) with earned income, an asset
 * conversion, an internal bank movement, a true expense, a trip, faction-
 * sponsored Xanax and a rehab visit — then asserts semantics, confidence
 * propagation and zero-vs-unavailable behavior for every state the product
 * promises.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();

const FULL_CAPS = {
  canReadUserBasic: true, canReadUserBars: true, canReadUserCooldowns: true, canReadUserEducation: true,
  canReadUserTravel: true, canReadUserMoney: true, canReadUserLogs: true, canReadUserAttacks: true,
  canReadUserNetworth: true, canReadUserEvents: true, canReadUserPersonalStats: true,
  canReadFactionBasic: false, canReadFactionMembers: false, canReadFactionRankedWars: false,
  canReadFactionChains: false, canReadFactionCrimes: false, canReadFactionArmoryNews: false,
  canReadFactionBalance: false, canReadFactionLogs: false,
};
const LIMITED_CAPS = { ...FULL_CAPS, canReadUserLogs: false, canReadUserNetworth: false };

const DAY = 86_400;
const nowSec = Math.floor(Date.now() / 1000);
const dayStart = Math.floor(nowSec / DAY) * DAY - DAY; // UTC midnight, yesterday
const dayKey = new Date(dayStart * 1000).toISOString().slice(0, 10);
const cleanupIds: string[] = [];

function sig(hour: number, minute = 0): Date {
  return new Date((dayStart + hour * 3600 + minute * 60) * 1000);
}

async function makeProfile(name: string, caps: object): Promise<{ id: string; tornId: number }> {
  const tornId = 2_100_000_000 + Math.floor(Math.random() * 900_000);
  const user = await db.user.create({ data: { displayName: name, role: "user", timezone: "UTC" } });
  cleanupIds.push(user.id);
  await db.apiCredential.create({
    data: {
      userId: user.id,
      encryptedKey: randomBytes(16).toString("hex"),
      iv: randomBytes(8).toString("hex"),
      authTag: randomBytes(8).toString("hex"),
      keyPreview: "TEST",
      accessLevel: 3,
      accessType: "Limited",
      logAccessAvailable: true,
      capabilities: caps,
      validatedAt: new Date(),
    },
  });
  await db.tornAccount.create({ data: { userId: user.id, tornId, name, level: 40, firstSeenAt: new Date(), lastSeenAt: new Date() } });
  return { id: user.id, tornId };
}

/** Fully caught-up sync states with coverage spanning well before `dayStart`. */
async function caughtUpStates(userId: string): Promise<void> {
  const resources = ["money_logs", "drugs", "travel", "rehab", "events"];
  for (const resource of resources) {
    await db.syncState.upsert({
      where: { userId_resource: { userId, resource } },
      create: {
        userId, resource, status: "idle",
        lastSuccessAt: new Date((nowSec - 300) * 1000),
        lastAttemptAt: new Date((nowSec - 300) * 1000),
        lastCompletedAt: new Date((nowSec - 300) * 1000),
        recordsCollected: 1000,
        stopReason: "history_boundary_reached",
        sourceEarliestAt: BigInt(dayStart - 60 * DAY),
        lastTimestamp: BigInt(nowSec - 300),
        frequencySeconds: 600,
        nextRunAt: new Date((nowSec + 600) * 1000),
      },
      update: {
        status: "idle", recordsCollected: 1000,
        stopReason: "history_boundary_reached",
        sourceEarliestAt: BigInt(dayStart - 60 * DAY),
      },
    });
  }
  await db.syncState.upsert({
    where: { userId_resource: { userId, resource: "networth" } },
    create: {
      userId, resource: "networth", status: "idle",
      lastSuccessAt: new Date((nowSec - 300) * 1000),
      recordsCollected: 500,
      frequencySeconds: 3600,
      nextRunAt: new Date((nowSec + 3600) * 1000),
    },
    update: { status: "idle", recordsCollected: 500 },
  });
}

const XANAX_ITEM_ID = 206;

/** A coherent day: flows, conversions, a trip, sponsored Xanax, rehab. */
async function seedSignatureDay(profile: { id: string; tornId: number }, opts: { rehabCostKnown: boolean } = { rehabCostKnown: true }): Promise<void> {
  const uid = profile.id;
  await db.moneyEvent.createMany({
    data: [
      { userId: uid, occurredAt: sig(2, 15), category: "salary", direction: "income", amount: 365_000n, source: "test", sourceRef: `sig:salary:${uid}` },
      { userId: uid, occurredAt: sig(9, 40), category: "bazaar", direction: "income", amount: 2_400_000n, source: "test", sourceRef: `sig:bazaar:${uid}` },
      { userId: uid, occurredAt: sig(11, 5), category: "stock", direction: "expense", amount: -1_500_000n, source: "test", sourceRef: `sig:stock:${uid}` },
      { userId: uid, occurredAt: sig(11, 20), category: "city_bank", direction: "neutral", amount: 500_000n, source: "test", sourceRef: `sig:bank:${uid}` },
      { userId: uid, occurredAt: sig(18, 30), category: "gym", direction: "expense", amount: -75_000n, source: "test", sourceRef: `sig:gym:${uid}` },
      { userId: uid, occurredAt: sig(14, 10), category: "rehab", direction: "expense", amount: -250_000n, source: "test", sourceRef: `sig:rehabmoney:${uid}` },
    ],
    skipDuplicates: true,
  });
  await db.drugEvent.createMany({
    data: [
      { userId: uid, occurredAt: sig(10, 0), drugItemId: XANAX_ITEM_ID, drugName: "Xanax", outcome: "success", source: "test", sourceRef: `sig:x1:${uid}` },
      { userId: uid, occurredAt: sig(22, 30), drugItemId: XANAX_ITEM_ID, drugName: "Xanax", outcome: "success", source: "test", sourceRef: `sig:x2:${uid}` },
    ],
    skipDuplicates: true,
  });
  await db.consumptionEvent.createMany({
    data: [
      { userId: uid, occurredAt: sig(10, 0), itemId: XANAX_ITEM_ID, itemName: "Xanax", category: "drug", quantity: 1, unitValue: 45_000n, totalValue: 45_000n, valuationMethod: "catalog_market_price", source: "test", sourceRef: `sig:c1:${uid}` },
      { userId: uid, occurredAt: sig(22, 30), itemId: XANAX_ITEM_ID, itemName: "Xanax", category: "drug", quantity: 1, unitValue: 45_000n, totalValue: 45_000n, valuationMethod: "catalog_market_price", source: "test", sourceRef: `sig:c2:${uid}` },
    ],
    skipDuplicates: true,
  });
  // Faction armory: one use-time sponsorship match + one prior batch (stock).
  await db.factionArmoryEvent.createMany({
    data: [
      { userId: uid, factionId: 9999, memberId: profile.tornId, itemId: XANAX_ITEM_ID, itemName: "Xanax", action: "used", quantity: 1, occurredAt: sig(10, 0), source: "test", sourceRef: `sig:au:${uid}` },
      { userId: uid, factionId: 9999, memberId: profile.tornId, itemId: XANAX_ITEM_ID, itemName: "Xanax", action: "lent", quantity: 2, occurredAt: new Date((dayStart - 2 * DAY) * 1000), source: "test", sourceRef: `sig:al:${uid}` },
    ],
    skipDuplicates: true,
  });
  await db.rehabEvent.create({
    data: { userId: uid, occurredAt: sig(14, 10), rehabPercent: 60, cost: opts.rehabCostKnown ? 250_000n : null, sessions: 2, source: "test", sourceRef: `sig:rehab:${uid}` },
  });
  const trip = await db.travelEvent.create({
    data: {
      userId: uid, destination: "Mexico", departedAt: sig(3), arrivedAt: sig(8), returnedAt: sig(12),
      durationSeconds: 9 * 3600, status: "returned", source: "test", sourceRef: `sig:trip:${uid}`,
    },
  });
  await db.travelItemEvent.create({
    data: {
      userId: uid, travelEventId: trip.id, occurredAt: sig(6), destination: "Mexico", category: "plushie",
      itemId: 438, itemName: "Teddy", quantity: 10, unitCost: 6_500n, totalCost: 65_000n,
      estimatedUnitValue: 10_000n, estimatedTotalValue: 100_000n, source: "test", sourceRef: `sig:titem:${uid}`,
    },
  });
  await db.networthSnapshot.createMany({
    data: [
      { userId: uid, capturedAt: new Date((dayStart - 3600) * 1000), total: 100_000_000n, wallet: 20_000_000n, inventory: 40_000_000n, stockMarket: 10_000_000n },
      { userId: uid, capturedAt: new Date((dayStart + 3600) * 1000), total: 105_000_000n, wallet: 22_000_000n, inventory: 42_000_000n, stockMarket: 11_500_000n },
    ],
    skipDuplicates: true,
  });
  await db.timelineEvent.createMany({
    data: [
      { userId: uid, occurredAt: sig(9, 41), type: "torn_event", title: "You sold items in your bazaar", source: "test", sourceRef: `sig:ev1:${uid}` },
    ],
    skipDuplicates: true,
  });
}

async function summaryFor(profile: { id: string; timezone?: string }, date?: string) {
  return getDailySummary({ id: profile.id, timezone: profile.timezone ?? "UTC", isDemo: false }, date ?? dayKey);
}

let mainProfile: { id: string; tornId: number };

beforeAll(async () => {
  // The Xanax ledger and travel valuation resolve through the catalog —
  // tests that add catalog rows clean them up again in afterAll.
  await db.tornItemCatalog.createMany({
    data: [
      { itemId: XANAX_ITEM_ID, name: "Xanax", type: "Drug", marketPrice: 45_000n },
      { itemId: 438, name: "Teddy bear", type: "Plushie", marketPrice: 10_000n },
    ],
    skipDuplicates: true,
  });
  mainProfile = await makeProfile("DAILY-A", FULL_CAPS);
  await caughtUpStates(mainProfile.id);
  await seedSignatureDay(mainProfile);
});

afterAll(async () => {
  await db.tornItemCatalog.deleteMany({ where: { itemId: { in: [XANAX_ITEM_ID, 438] }, name: { in: ["Xanax", "Teddy bear"] } } });
  for (const id of cleanupIds.splice(0)) await deleteProfile(id);
});

suite("daily summary — happy paths", () => {
  it("complete day: sections carry values, confidence complete (past day)", async () => {
    const s = await summaryFor(mainProfile);
    expect(s.date).toBe(dayKey);
    expect(s.ongoingDay).toBe(false);
    expect(s.overallConfidence.confidence).toBe("complete");
    expect(s.cashFlow.confidence.confidence).toBe("complete");
    // Cash: salary 365k + bazaar 2.4m in; stock 1.5m + gym 75k + rehab 250k out.
    expect(s.cashFlow.received.value).toBe(2_765_000);
    expect(s.cashFlow.spent.value).toBe(1_825_000);
    expect(s.cashFlow.net.value).toBe(940_000);
    // Economic: earned = salary; expenses = gym + rehab (stock is a conversion).
    expect(s.economicEffect.trueIncome.value).toBe(365_000);
    expect(s.economicEffect.trueExpense.value).toBe(325_000);
    expect(s.economicEffect.net.value).toBe(40_000);
    // Conversions: bazaar sale in, stock buy out, bank transfer separate.
    expect(s.assetConversions.convertedIn.value).toBe(2_400_000);
    expect(s.assetConversions.convertedOut.value).toBe(1_500_000);
    expect(s.assetConversions.bankTransfers).toBe(500_000);
  });

  it("bazaar sale is NOT economic income; stock buy is NOT an expense", async () => {
    const s = await summaryFor(mainProfile);
    const inflowTop = s.cashFlow.topInflow.map((r) => r.category);
    expect(inflowTop).toContain("bazaar");
    expect(s.economicEffect.trueIncome.value).not.toContain(2_400_000 as never);
    // The conversion lens shows the stock purchase; the expense lens does not.
    expect(s.assetConversions.convertedOut.value).toBe(1_500_000);
    expect(s.economicEffect.trueExpense.value).toBe(325_000);
  });

  it("net worth delta comes from official snapshots and is never labeled profit", async () => {
    const s = await summaryFor(mainProfile);
    expect(s.netWorth.coverage).toBe("full");
    expect(s.netWorth.delta).toBe(5_000_000);
    expect(s.netWorth.start).toBe(100_000_000);
    expect(s.netWorth.end).toBe(105_000_000);
    expect(s.netWorth.drivers).not.toBeNull();
    // Drivers are hedged: recorded/estimated, an unexplained residual may exist.
    for (const d of s.netWorth.drivers!) {
      expect(["recorded", "estimated", "unexplained"]).toContain(d.certainty);
    }
  });

  it("travel profit is clearly estimated; trips counted", async () => {
    const s = await summaryFor(mainProfile);
    expect(s.travel.trips).toBe(1);
    expect(s.travel.estimatedProfit.provenance).toBe("estimated");
    expect(s.travel.estimatedProfit.value).not.toBeNull();
  });

  it("xanax funding buckets: faction-sponsored, personal cost zero-claimed only via sponsorship", async () => {
    const s = await summaryFor(mainProfile);
    expect(s.drugs.xanax.consumed).toBe(2);
    expect(s.drugs.xanax.confirmedFaction).toBe(2);
    expect(s.drugs.xanax.confirmedPersonal).toBe(0);
    expect(s.drugs.estimatedConsumptionValue.value).toBe(90_000);
  });

  it("rehab visit counted with known cost", async () => {
    const s = await summaryFor(mainProfile);
    expect(s.rehab.visits).toBe(1);
    expect(s.rehab.cost.value).toBe(250_000);
    expect(s.rehab.cost.availability).toBe("ok");
  });

  it("highlights are deterministic (same data → identical list)", async () => {
    const [a, b] = await Promise.all([summaryFor(mainProfile), summaryFor(mainProfile)]);
    expect(JSON.stringify(a.highlights)).toBe(JSON.stringify(b.highlights));
    const kinds = a.highlights.map((h) => h.kind);
    expect(kinds).toContain("networth_move");
    expect(kinds).toContain("travel_profit");
    expect(kinds).toContain("rehab");
    expect(a.highlights.length).toBeLessThanOrEqual(8);
  });

  it("no unsupported causal statements in the UI layer", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../web/src/lib/components/DailySummary.svelte", import.meta.url), "utf8");
    expect(src).not.toMatch(/\bcaused by\b/i);
    expect(src).toContain("not a profit figure");
    expect(src).toContain("they add up to the change above");
  });
});

suite("daily summary — quiet days, zeros and unavailability", () => {
  it("valid zero: covered quiet day renders $0 with ok availability and a quiet highlight", async () => {
    const quiet = await makeProfile("DAILY-QUIET", FULL_CAPS);
    await caughtUpStates(quiet.id);
    // An earlier day with a real snapshot pair → networth full coverage.
    const olderStart = dayStart - 3 * DAY;
    await db.networthSnapshot.createMany({
      data: [
        { userId: quiet.id, capturedAt: new Date((olderStart - 3600) * 1000), total: 50_000_000n },
        { userId: quiet.id, capturedAt: new Date((olderStart + 3600) * 1000), total: 50_000_000n },
      ],
      skipDuplicates: true,
    });
    const olderKey = new Date(olderStart * 1000).toISOString().slice(0, 10);
    const s = await summaryFor(quiet, olderKey);
    expect(s.cashFlow.received.value).toBe(0);
    expect(s.cashFlow.received.availability).toBe("ok");
    expect(s.cashFlow.spent.value).toBe(0);
    expect(s.rehab.visits).toBe(0);
    expect(s.rehab.cost.value).toBe(0);
    expect(s.travel.trips).toBe(0);
    expect(s.highlights.map((h) => h.kind)).toContain("quiet_day");
  });

  it("missing money permission + no data → unavailable, NEVER zero", async () => {
    const denied = await makeProfile("DAILY-DENIED", LIMITED_CAPS);
    await caughtUpStates(denied.id);
    // Nothing has ever been collected: permission missing + no history.
    await db.syncState.updateMany({
      where: { userId: denied.id },
      data: { recordsCollected: 0, lastSuccessAt: null, stopReason: null, sourceEarliestAt: null, lastTimestamp: null },
    });
    const s = await summaryFor(denied);
    expect(s.cashFlow.confidence.confidence).toBe("unavailable");
    expect(s.cashFlow.received.value).toBeNull();
    expect(s.cashFlow.received.availability).toBe("unavailable");
    expect(s.economicEffect.trueIncome.value).toBeNull();
    expect(s.overallConfidence.confidence).toBe("unavailable");
  });

  it("stale permission: retained history shown as stale_permission", async () => {
    const stale = await makeProfile("DAILY-STALE", FULL_CAPS);
    await caughtUpStates(stale.id);
    await seedSignatureDay(stale);
    await db.apiCredential.update({ where: { userId: stale.id }, data: { capabilities: LIMITED_CAPS } });
    const s = await summaryFor(stale);
    expect(s.cashFlow.confidence.confidence).toBe("stale_permission");
    expect(s.cashFlow.confidence.reason).toBe("historical_permission_lost");
    // History retained: the real numbers still render.
    expect(s.cashFlow.received.value).toBe(2_765_000);
    expect(s.cashFlow.received.availability).toBe("ok");
    expect(s.overallConfidence.confidence).toBe("stale_permission");
  });

  it("partial money history: day before coverage → range_before_coverage", async () => {
    const partial = await makeProfile("DAILY-PARTIAL", FULL_CAPS);
    await caughtUpStates(partial.id);
    // Coverage starts exactly at the requested day (source exhausted there):
    // the day itself is covered, the day before it is not.
    await db.syncState.updateMany({
      where: { userId: partial.id, resource: "money_logs" },
      data: { sourceEarliestAt: BigInt(dayStart), stopReason: "source_exhausted" },
    });
    const s = await summaryFor(partial);
    expect(s.cashFlow.confidence.confidence).toBe("complete");
    const before = await summaryFor(partial, new Date((dayStart - DAY) * 1000).toISOString().slice(0, 10));
    expect(before.cashFlow.confidence.reason).toBe("range_before_coverage");
    expect(before.cashFlow.confidence.confidence).toBe("partial");
  });

  it("missing networth snapshots → delta null, coverage none, unavailable (never 0)", async () => {
    const nonw = await makeProfile("DAILY-NONW", FULL_CAPS);
    await caughtUpStates(nonw.id);
    const s = await summaryFor(nonw);
    expect(s.netWorth.delta).toBeNull();
    expect(s.netWorth.coverage).toBe("none");
    expect(s.netWorth.confidence.confidence).toBe("unavailable");
    expect(s.overallConfidence.confidence).toBe("partial"); // networth is critical
  });

  it("unknown rehab cost → cost unavailable, never 0; visit still counted", async () => {
    const noCost = await makeProfile("DAILY-REHAB", FULL_CAPS);
    await caughtUpStates(noCost.id);
    await db.rehabEvent.create({
      data: { userId: noCost.id, occurredAt: sig(14, 10), rehabPercent: 40, cost: null, sessions: null, source: "test", sourceRef: `sig:rehabnc:${noCost.id}` },
    });
    const s = await summaryFor(noCost);
    expect(s.rehab.visits).toBe(1);
    expect(s.rehab.cost.value).toBeNull();
    expect(s.rehab.cost.availability).toBe("unavailable");
    expect(s.rehab.sessionsUnavailable).toBe(1);
  });
});

suite("daily summary — dates, isolation, capability tiers, demo", () => {
  it("timezone boundaries: 23:00 UTC lands on different days across timezones", async () => {
    const tz = await makeProfile("DAILY-TZ", FULL_CAPS);
    await caughtUpStates(tz.id);
    const edge = new Date((dayStart + 23 * 3600) * 1000);
    await db.moneyEvent.create({
      data: { userId: tz.id, occurredAt: edge, category: "salary", direction: "income", amount: 111_111n, source: "test", sourceRef: `sig:tzedge:${tz.id}` },
    });
    // 23:00 UTC is still the same UTC day in Los Angeles (UTC-7 → 16:00).
    const la = await getDailySummary({ id: tz.id, timezone: "America/Los_Angeles", isDemo: false }, dayKey);
    expect(la.cashFlow.received.value).toBe(111_111);
    // …but already the NEXT calendar day in Amsterdam (UTC+2 → 01:00).
    const ams = await getDailySummary({ id: tz.id, timezone: "Europe/Amsterdam", isDemo: false }, dayKey);
    expect(ams.cashFlow.received.value).toBe(0);
    const amsNext = new Date((dayStart + DAY) * 1000).toISOString().slice(0, 10);
    const amsTomorrow = await getDailySummary({ id: tz.id, timezone: "Europe/Amsterdam", isDemo: false }, amsNext);
    expect(amsTomorrow.cashFlow.received.value).toBe(111_111);
  });

  it("wallet equation is inspectable and reconciles to exactly zero residual", async () => {
    // Real-user finding: the "Cash" why-it-moved row read like unexplained
    // money. The day now carries the SAME wallet equation as Economy:
    // opening + known received − known spent = expected closing vs actual
    // closing, with the graded residual surfaced.
    const w = await makeProfile("DAILY-WALLET", FULL_CAPS);
    await caughtUpStates(w.id);
    await db.networthSnapshot.createMany({
      data: [
        { userId: w.id, capturedAt: new Date((dayStart - 3600) * 1000), total: 5_000_000n, wallet: 1_000_000n },
        { userId: w.id, capturedAt: new Date((dayStart + 3600) * 1000), total: 5_400_000n, wallet: 1_400_000n },
      ],
    });
    await db.moneyEvent.createMany({
      data: [
        { userId: w.id, occurredAt: sig(2, 0), category: "salary", direction: "income", amount: 750_000n, source: "test", sourceRef: `we:salary:${w.id}` },
        { userId: w.id, occurredAt: sig(6, 0), category: "gym", direction: "expense", amount: -350_000n, source: "test", sourceRef: `we:gym:${w.id}` },
      ],
      skipDuplicates: true,
    });
    const s = await summaryFor(w);
    const wallet = s.netWorth.wallet!;
    expect(wallet).toBeDefined();
    expect(wallet.opening).toBe(1_000_000);
    expect(wallet.knownReceived).toBe(750_000);
    expect(wallet.knownSpent).toBe(350_000);
    expect(wallet.expectedClosing).toBe(1_400_000);
    expect(wallet.actualClosing).toBe(1_400_000);
    expect(wallet.residual).toBe(0);
    expect(wallet.quality).toBe("exact");
    expect(wallet.coverage).toBe("full");
  });

  it("an unexplained cash change surfaces as a graded residual — never hidden or zero-filled", async () => {
    const w = await makeProfile("DAILY-WALLET-GAP", FULL_CAPS);
    await caughtUpStates(w.id);
    // The closing snapshot's wallet is 500,000 ABOVE what the recorded flows
    // explain — the equation must show that gap, not absorb it.
    await db.networthSnapshot.createMany({
      data: [
        { userId: w.id, capturedAt: new Date((dayStart - 3600) * 1000), total: 5_000_000n, wallet: 1_000_000n },
        { userId: w.id, capturedAt: new Date((dayStart + 3600) * 1000), total: 5_900_000n, wallet: 1_900_000n },
      ],
    });
    await db.moneyEvent.createMany({
      data: [
        { userId: w.id, occurredAt: sig(2, 0), category: "salary", direction: "income", amount: 750_000n, source: "test", sourceRef: `weg:salary:${w.id}` },
        { userId: w.id, occurredAt: sig(6, 0), category: "gym", direction: "expense", amount: -350_000n, source: "test", sourceRef: `weg:gym:${w.id}` },
      ],
      skipDuplicates: true,
    });
    const s = await summaryFor(w);
    const wallet = s.netWorth.wallet!;
    expect(wallet.expectedClosing).toBe(1_400_000);
    expect(wallet.actualClosing).toBe(1_900_000);
    expect(wallet.residual).toBe(500_000);
    expect(wallet.quality).toBe("unreconciled");
  });

  it("today is capped at partial with day_in_progress", async () => {
    const s = await summaryFor(mainProfile, undefined);
    void s; // main profile used elsewhere; use a dedicated profile for clarity
    const today = await getDailySummary({ id: mainProfile.id, timezone: "UTC", isDemo: false }, resolveDayRange(undefined, "UTC", nowSec).dateKey);
    expect(today.ongoingDay).toBe(true);
    expect(today.overallConfidence.confidence).not.toBe("complete");
    expect(today.overallConfidence.reason).toBe("day_in_progress");
  });

  it("future dates are rejected with a 400-class error", async () => {
    const future = new Date((dayStart + 40 * DAY) * 1000).toISOString().slice(0, 10);
    await expect(summaryFor(mainProfile, future)).rejects.toMatchObject({ code: "invalid_date", statusCode: 400 });
    await expect(summaryFor(mainProfile, "not-a-date")).rejects.toBeInstanceOf(AppError);
  });

  it("multi-user isolation: another profile's day never leaks in", async () => {
    const b = await makeProfile("DAILY-B", FULL_CAPS);
    await caughtUpStates(b.id);
    const a = await summaryFor(mainProfile);
    const bs = await summaryFor(b);
    // B has no rows on the day: zeros with proven coverage, not A's numbers.
    expect(bs.cashFlow.received.value).toBe(0);
    expect(a.cashFlow.received.value).toBe(2_765_000);
  });

  it("large outflows aggregate semantically: one row per category+direction, ×N label, summed amount", async () => {
    // Real-user finding: two big payments in the SAME category on one day
    // used to render as two identical "Large cash outflow" ledger rows.
    // The dedupe must be semantic (merge same category+direction, keep the
    // count and the summed amount), never string-blind (genuinely different
    // categories stay separate rows).
    const dedupe = await makeProfile("DAILY-DEDUPE", FULL_CAPS);
    await caughtUpStates(dedupe.id);
    await db.moneyEvent.createMany({
      data: [
        { userId: dedupe.id, occurredAt: sig(2, 0), category: "salary", direction: "income", amount: 750_000n, source: "test", sourceRef: `dd:salary:${dedupe.id}` },
        // Same category, two separate payments — the duplicate-story case.
        { userId: dedupe.id, occurredAt: sig(5, 0), category: "housing", direction: "expense", amount: -900_000n, source: "test", sourceRef: `dd:rent1:${dedupe.id}` },
        { userId: dedupe.id, occurredAt: sig(6, 30), category: "housing", direction: "expense", amount: -900_000n, source: "test", sourceRef: `dd:rent2:${dedupe.id}` },
        // A genuinely different story — must survive as its own row.
        { userId: dedupe.id, occurredAt: sig(7, 0), category: "gym", direction: "expense", amount: -850_000n, source: "test", sourceRef: `dd:gym:${dedupe.id}` },
        // Below the large-movement threshold — must not appear at all.
        { userId: dedupe.id, occurredAt: sig(8, 0), category: "casino", direction: "expense", amount: -100_000n, source: "test", sourceRef: `dd:casino:${dedupe.id}` },
      ],
      skipDuplicates: true,
    });
    // Outflow 2,750,000 → threshold = max(50k, 20% of 2.75m) = 550k.
    const s = await summaryFor(dedupe);
    const outs = s.highlights.filter((h) => h.kind === "large_cash_out");
    expect(outs).toHaveLength(2); // aggregated rent + gym — not 3 single rows

    const rent = outs.find((h) => h.label.includes("Property Rent & Upkeep"));
    expect(rent).toBeDefined();
    expect(rent!.label).toContain("×2"); // the two payments read as one story
    expect(rent!.amount).toBe(-1_800_000); // summed, not the largest single one

    const gym = outs.find((h) => h.label.includes("Gym Membership"));
    expect(gym).toBeDefined();
    expect(gym!.amount).toBe(-850_000);

    expect(outs.find((h) => h.label.includes("Casino"))).toBeUndefined();

    // No two highlights ever render as the same ledger row.
    const seen = new Set<string>();
    for (const h of s.highlights) {
      const key = `${h.kind}:${h.label}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });


  it("Limited capability profile still returns a summary (retained history, not errors)", async () => {
    const limited = await makeProfile("DAILY-LIMITED", LIMITED_CAPS);
    await caughtUpStates(limited.id);
    const s = await summaryFor(limited);
    // The key no longer refreshes logs/networth, but collected history is
    // retained and still rendered — stale_permission, never unavailable.
    expect(s.cashFlow.confidence.confidence).toBe("stale_permission");
    expect(s.cashFlow.received.value).toBe(0); // no rows recorded that day: valid zero within retained history
    expect(s.travel.estimatedProfit.value).toBe(0);
    // Networth is not granted either — with no retained snapshots the section
    // is unavailable, degrading the overall summary to partial (money history
    // is still retained and shown).
    expect(s.netWorth.delta).toBeNull();
    expect(s.netWorth.confidence.confidence).toBe("unavailable");
    expect(s.overallConfidence.confidence).toBe("partial");
    expect(s.cashFlow.confidence.confidence).toBe("stale_permission");
  });

  it("demo profile: signature day renders complete with faction-sponsored Xanax", async () => {
    const demoUser = await db.user.findUnique({ where: { email: "demo@tornscope.local" } });
    if (!demoUser) return; // demo seed not present in this environment
    const s = await getDailySummary({ id: demoUser.id, timezone: "UTC", isDemo: true }, dayKey);
    expect(s.overallConfidence.confidence).toBe("complete");
    expect(s.overallConfidence.reason).not.toBe("historical_permission_lost");
    if (s.cashFlow.received.value !== null && s.cashFlow.received.value > 0) {
      expect(s.cashFlow.received.availability).toBe("ok");
    }
    // The signature day seeds exactly two sponsored Xanax (random uses may add more).
    expect(s.drugs.xanax.confirmedFaction).toBeGreaterThanOrEqual(2);
    expect(s.drugs.xanax.confirmedPersonal).toBe(0);
  });
});
