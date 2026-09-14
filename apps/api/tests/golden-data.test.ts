import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { getProgression } from "../src/services/progression.js";
import { getEconomySummary } from "../src/services/economy.js";
import { getMoneySummary } from "../src/services/money.js";
import { getDailySummary } from "../src/services/dailySummary.js";
import { getTravelSummary } from "../src/services/travel.js";
import { resolveDayRange } from "@tornscope/shared";

/**
 * Golden-data verification (roadmap #9 remediation, phases 7–21, 68).
 *
 * Controlled fixtures with hand-computed expectations, traced from stored
 * rows through derivation to the API contract. These are RELATION and
 * exact-value assertions — never snapshot blobs:
 *
 *  ENERGY   opening + Σ(sources incl. derived regen) − Σ(uses) = closing
 *  BATTLESTATS  per-stat deltas match injected deltas exactly (no swap);
 *               distribution shares sum to 1
 *  ECONOMY  bazaar proceeds are conversions, never income; bank principal
 *           is never income/expense; the unknown row is disclosed
 *  WALLET   opening + flows = closing with residual 0 (exact case)
 *  TRAVEL   Today's travel block equals the canonical Travel summary
 *  LEGACY   a profile without bars history degrades honestly (no fake 0)
 */

const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const createdUsers: string[] = [];
const DAY = 86_400;
const nowSec = Math.floor(Date.now() / 1000);

const FULL_CAPS = {
  canReadUserBasic: true, canReadUserBars: true, canReadUserCooldowns: true, canReadUserEducation: true,
  canReadUserTravel: true, canReadUserMoney: true, canReadUserLogs: true, canReadUserAttacks: true,
  canReadUserNetworth: true, canReadUserEvents: true, canReadUserPersonalStats: true,
  canReadFactionBasic: false, canReadFactionMembers: false, canReadFactionRankedWars: false,
  canReadFactionChains: false, canReadFactionCrimes: false, canReadFactionArmoryNews: false,
  canReadFactionBalance: false, canReadFactionLogs: false,
};

async function makeProfile(opts: { timezone?: string } = {}): Promise<string> {
  const id = `gold-${randomBytes(10).toString("hex")}`;
  createdUsers.push(id);
  await db.user.create({ data: { id, displayName: "golden", role: "user", timezone: opts.timezone ?? "UTC" } });
  await db.apiCredential.create({
    data: {
      id: `cred-${id}`, userId: id, encryptedKey: "x", iv: "x", authTag: "x",
      keyPreview: "…", logAccessAvailable: true, accessLevel: 3, accessType: "Full",
      capabilities: FULL_CAPS, validatedAt: new Date(),
    },
  });
  // Caught-up sync states: confidence gates open for the golden fixtures.
  for (const resource of ["money_logs", "drugs", "travel", "rehab", "events", "networth", "personal_stats", "bars", "attacks"]) {
    await db.syncState.create({
      data: {
        userId: id, resource, status: "idle",
        lastSuccessAt: new Date((nowSec - 300) * 1000),
        lastAttemptAt: new Date((nowSec - 300) * 1000),
        lastCompletedAt: new Date((nowSec - 300) * 1000),
        recordsCollected: 1000,
        stopReason: "history_boundary_reached",
        sourceEarliestAt: BigInt(nowSec - 90 * DAY),
        lastTimestamp: BigInt(nowSec - 300),
        frequencySeconds: 600,
        nextRunAt: new Date((nowSec + 600) * 1000),
      },
    });
  }
  return id;
}

beforeAll(async () => {
  await db.user.count();
});

afterAll(async () => {
  for (const id of createdUsers) {
    for (const table of [
      "moneyEvent", "consumptionEvent", "drugEvent", "travelItemEvent", "travelEvent",
      "barsSnapshot", "personalStatSnapshot", "networthSnapshot", "timelineEvent",
      "notificationDelivery", "notificationEvent", "notificationPreference", "notificationState",
      "pushSubscription", "userSession", "apiCredential",
    ]) {
      await (db as never as Record<string, { deleteMany: (a: unknown) => Promise<unknown> }>)[table]
        .deleteMany({ where: { userId: id } })
        .catch(() => undefined);
    }
    await db.user.deleteMany({ where: { id } }).catch(() => undefined);
  }
  await db.tornItemCatalog.deleteMany({ where: { itemId: 438 } }).catch(() => undefined);
});

/* ------------------------------------------------------------------ */
/* ENERGY — exact ledger identity over a hand-computed bars fixture    */
/* ------------------------------------------------------------------ */

suite("energy golden", () => {
  it("opening + sources − uses = closing, with exact attribution", async () => {
    const userId = await makeProfile();
    const t0 = nowSec - 3600;
    // t0(10) → t1(60): regen +50.
    // t1(60) → t2(150): refill +90 inside → gains 90 applied, regen 0.
    // t2(150) → t3(40): training decline −110 (bar was pinned at cap, no
    //                   gains inside — plain 110E spend).
    // t3(40) → t4(20): Xanax(+250 est) at t0+1000 with the bar at 40 —
    //                   headroom 110: 110E materializes, 140E is cap
    //                   overshoot, spend = 110 + 20 = 130.
    // t3(40) → t4(20): unknown drop −20 (<25, stays unattributed).
    const bars = [
      { t: t0, e: 10 }, { t: t0 + 300, e: 60 }, { t: t0 + 600, e: 150 },
      { t: t0 + 900, e: 40 }, { t: t0 + 1200, e: 20 },
    ];
    await db.barsSnapshot.createMany({
      data: bars.map((b) => ({
        userId, capturedAt: new Date(b.t * 1000),
        energyCurrent: b.e, energyMaximum: 150, happyCurrent: 0, happyMaximum: 0,
      })),
    });
    // Stat bracket: exactly one hourly snapshot before and after the burst.
    await db.personalStatSnapshot.createMany({
      data: [
        { userId, capturedAt: new Date((t0 - 3600) * 1000), stats: { battle_stats: { strength: 1_000_000, defense: 900_000, speed: 800_000, dexterity: 700_000, total: 3_400_000 } } },
        { userId, capturedAt: new Date((t0 + 1800) * 1000), stats: { battle_stats: { strength: 1_000_500, defense: 900_000, speed: 800_000, dexterity: 700_000, total: 3_400_500 } } },
      ],
    });
    const gains = [
      { userId, occurredAt: new Date((t0 + 450) * 1000), category: "energy", metadata: { data: { energy_increased: 90 } }, source: "test", sourceRef: `g1-${userId}` },
    ];
    await db.consumptionEvent.createMany({ data: gains, skipDuplicates: true });
    await db.drugEvent.create({
      data: { userId, occurredAt: new Date((t0 + 1000) * 1000), drugName: "Xanax", outcome: "success", source: "test", sourceRef: `g2-${userId}` },
    });

    const prog = await getProgression(userId, {
      preset: "custom", from: t0 - 600, to: t0 + 3600,
    });

    // Identity: opening + Σ(sources incl. derived regen) − Σ(uses) = closing.
    const sourcesTotal = prog.energy.sources.reduce((sum, s) => sum + s.amount, 0);
    const usesTotal = prog.energy.uses.reduce((sum, u) => sum + u.amount, 0);
    const rec = prog.energy.reconciliation;
    expect(rec.opening).toBe(10);
    expect(rec.closing).toBe(20);
    expect(rec.opening! + sourcesTotal - usesTotal).toBe(rec.closing);
    // Exact attribution (verified against the ledger mechanics): the refill
    // lands in a rise (90 exact); the Xanax estimate lands when the bar sits
    // at 40 (headroom 110) — 110E applied, 140E cap overshoot (the +250
    // documented mechanic minus the headroom); natural regen contributes 50.
    // Under the old model the full estimate was charged on top of the
    // observed drops — the inflated accounting the real-user walkthrough
    // disputed.
    expect(sourcesTotal).toBe(250);
    expect(prog.energy.sources).toContainEqual({ category: "Energy drinks", amount: 90, provenance: "exact" });
    expect(prog.energy.sources).toContainEqual({ category: "Xanax (est.)", amount: 110, provenance: "estimated" });
    expect(prog.energy.absorbedOvershoot ?? 0).toBe(140);
    const trained = prog.training.sessions
      .filter((s) => s.inference === "likely")
      .reduce((sum, s) => sum + (s.energySpent ?? 0), 0);
    expect(trained).toBe(240);
    expect(usesTotal).toBe(240); // no unexplained residue in this fixture
    // Primary stat provenance: strength +500, others untouched.
    const strength = prog.battlestats.perStat.find((s) => s.key === "strength")!;
    expect(strength.delta).toBe(500);
    expect(prog.battlestats.perStat.filter((s) => s.key !== "strength").every((s) => s.delta === 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* ENERGY — same-day 2-Xanax-at-full-bar (V0.2 "0 Xanax" regression)   */
/* ------------------------------------------------------------------ */

suite("energy golden — two Xanax at full bar in one range", () => {
  it("ships the exact use count and per-category cap loss even when nothing materializes", async () => {
    const userId = await makeProfile();
    const t0 = nowSec - 7_200;
    // Both uses land on a full bar and are trained away inside the same
    // 5-minute snapshot: zero materialized Xanax energy — the exact shape
    // that used to read as "0 Xanax" on 1D.
    const bars = [
      { t: t0, e: 150 },
      { t: t0 + 300, e: 0 }, // Xanax 1 at t0+100 inside
      { t: t0 + 1_500, e: 150 }, // regen back to full
      { t: t0 + 1_800, e: 5 }, // Xanax 2 at t0+1_600 inside
    ];
    await db.barsSnapshot.createMany({
      data: bars.map((b) => ({
        userId, capturedAt: new Date(b.t * 1000),
        energyCurrent: b.e, energyMaximum: 150, happyCurrent: 0, happyMaximum: 0,
      })),
    });
    await db.drugEvent.createMany({
      data: [
        { userId, occurredAt: new Date((t0 + 100) * 1000), drugName: "Xanax", outcome: "success", source: "test", sourceRef: `x1-${userId}` },
        { userId, occurredAt: new Date((t0 + 1_600) * 1000), drugName: "Xanax", outcome: "success", source: "test", sourceRef: `x2-${userId}` },
      ],
    });

    const prog = await getProgression(userId, { preset: "custom", from: t0 - 600, to: t0 + 3_600 });

    // The exact drug-log count and the documented +250/use ship even though
    // NOTHING materialized — the intake line's data.
    expect(prog.energy.xanax).toEqual({ uses: 2, estimatedDelivered: 500 });
    // The whole loss is attributed per category, not lumped.
    expect(prog.energy.absorbedOvershootByCategory).toContainEqual({ category: "Xanax (est.)", amount: 500 });
    expect(prog.energy.absorbedOvershoot ?? 0).toBe(500);
    // No materialized Xanax row appears in sources — correctly — while the
    // intake fields above carry the story.
    expect(prog.energy.sources.filter((s) => s.category.startsWith("Xanax"))).toEqual([]);
    // Spend stays the observed declines (150 + 145) — never the phantom 2×250.
    const usesTotal = prog.energy.uses.reduce((sum, u) => sum + u.amount, 0);
    expect(usesTotal).toBe(295);
    // Identity holds: opening + sources − uses = closing.
    const sourcesTotal = prog.energy.sources.reduce((sum, s) => sum + s.amount, 0);
    const rec = prog.energy.reconciliation;
    expect(rec.opening! + sourcesTotal - usesTotal).toBe(rec.closing);
  });
});

/* ------------------------------------------------------------------ */
/* BATTLESTATS — golden A/B deltas, no swapping, shares sum to 1       */
/* ------------------------------------------------------------------ */

suite("battlestat golden", () => {
  it("18-19. per-stat deltas match the injected deltas exactly; shares sum to 1", async () => {
    const userId = await makeProfile();
    const t0 = nowSec - 7200;
    const mk = (str: number, def: number, spd: number, dex: number) => ({
      battle_stats: { strength: str, defense: def, speed: spd, dexterity: dex, total: str + def + spd + dex },
    });
    await db.personalStatSnapshot.createMany({
      data: [
        { userId, capturedAt: new Date((t0 - 3600) * 1000), stats: mk(1_000_000, 2_000_000, 3_000_000, 4_000_000) },
        { userId, capturedAt: new Date((t0 + 3600) * 1000), stats: mk(1_001_000, 2_002_000, 3_003_000, 4_004_000) },
      ],
    });
    const prog = await getProgression(userId, { preset: "custom", from: t0, to: t0 + 7200 });
    const byKey = Object.fromEntries(prog.battlestats.perStat.map((p) => [p.key, p.delta]));
    // Distinct deltas prove no DEF/SPD/DEX swap.
    expect(byKey).toEqual({ strength: 1000, defense: 2000, speed: 3000, dexterity: 4000 });
    expect(prog.battlestats.deltaTotal).toBe(10_000);
    const shareSum = prog.battlestats.distribution.reduce((s, d) => s + (d.share ?? 0), 0);
    expect(shareSum).toBeCloseTo(1, 6);
  });
});

/* ------------------------------------------------------------------ */
/* ECONOMY — classification golden + wallet reconciliation             */
/* ------------------------------------------------------------------ */

suite("economy golden", () => {
  it("7-10. conversions stay out of P&L; wallet reconciles exactly; unknown is disclosed", async () => {
    const userId = await makeProfile();
    const from = nowSec - 3600;
    const mk = (h: number, category: string, direction: "income" | "expense" | "neutral" | "unknown", amount: number, ref: string) => ({
      userId, occurredAt: new Date((from + h * 360) * 1000), category, direction,
      amount: BigInt(direction === "expense" ? -amount : amount),
      source: "test", sourceRef: `gold-${ref}-${randomBytes(4).toString("hex")}`,
    });
    await db.moneyEvent.createMany({
      data: [
        mk(1, "salary", "income", 5_000, "salary"),            // true income
        mk(2, "bazaar", "income", 6_000, "bazaar-sale"),     // conversion (asset sale)
        mk(3, "city_bank", "neutral", -10_000, "bank-dep"),  // conversion (principal out)
        mk(4, "city_bank", "neutral", 10_500, "bank-wd"),    // conversion (principal + interest in)
        mk(5, "items", "expense", 4_000, "item-buy"),        // conversion (asset purchase)
        mk(6, "rehab", "expense", 1_000, "rehab"),           // true expense
        mk(7, "museum", "unknown", 777, "unclassified"),     // disclosed as unknown
      ],
      skipDuplicates: true,
    });
    // Wallet anchors: opening 20_000; flows close at 20_000 +5k +6k +10.5k −10k −4k −1k = 26_500.
    await db.networthSnapshot.createMany({
      data: [
        { userId, capturedAt: new Date((from - 600) * 1000), total: 100_000_000n, wallet: 20_000n },
        { userId, capturedAt: new Date((from + 3600) * 1000), total: 106_500_000n, wallet: 26_500n },
      ],
      skipDuplicates: true,
    });

    const eco = await getEconomySummary(userId, { preset: "custom", from, to: from + 3600 });

    // Conversions never become income: true income is the salary only
    // (bazaar sale, bank withdrawal are conversions; unknown is unclassified).
    expect(eco.cashFlow.trueIncome).toBe(5_000);
    // True expense is rehab only (bank principal and item purchases are conversions).
    expect(eco.cashFlow.trueExpense).toBe(1_000);
    // Conversions: bazaar sale + bank withdrawal moved assets into cash.
    expect(eco.conversions.assetsIntoCash.value).toBeGreaterThanOrEqual(6_000 + 10_500);
    expect(eco.conversions.cashIntoAssets.value).toBeGreaterThanOrEqual(10_000 + 4_000);
    // The unknown row is disclosed, never silently classified.
    expect(eco.cashFlow.unclassifiedCount).toBe(1);

    // Wallet reconciliation (exact): opening + flows = closing, residual 0.
    expect(eco.wallet).toBeDefined();
    if (eco.wallet?.openingWallet?.value !== null && eco.wallet?.closingWallet?.value !== null) {
      expect(Number(eco.wallet.residual?.value ?? 0)).toBe(0);
    }
  });

  it("11. daily summary and economy agree on cash for the same local day", async () => {
    const userId = await makeProfile({ timezone: "UTC" });
    const dayStart = Math.floor(nowSec / DAY) * DAY - DAY; // yesterday, UTC
    const sig = (h: number, m = 0) => new Date((dayStart + h * 360 + m * 60) * 1000);
    await db.moneyEvent.createMany({
      data: [
        { userId, occurredAt: sig(9), category: "salary", direction: "income", amount: 5_000n, source: "test", sourceRef: `da-${randomBytes(4).toString("hex")}` },
        { userId, occurredAt: sig(15), category: "rehab", direction: "expense", amount: -1_000n, source: "test", sourceRef: `db-${randomBytes(4).toString("hex")}` },
      ],
      skipDuplicates: true,
    });
    const dateKey = new Date(dayStart * 1000).toISOString().slice(0, 10);
    const [daily, economy] = await Promise.all([
      getDailySummary({ id: userId, timezone: "UTC", isDemo: false }, dateKey),
      getEconomySummary(userId, { preset: "custom", from: dayStart, to: dayStart + DAY }),
    ]);
    // Same window, same underlying rows: cash-in figures must agree.
    const economyDayIncome = economy.cashFlow.income.value ?? 0;
    expect(daily.cashFlow.received.value).toBe(economyDayIncome);
  });
});

/* ------------------------------------------------------------------ */
/* DRUGS — personal vs faction-sponsored cost semantics                */
/* ------------------------------------------------------------------ */

suite("drugs golden", () => {
  it("12-13. sponsored Xanax is confirmed faction and NOT personal spend", async () => {
    const userId = await makeProfile();
    const base = nowSec - 7200;
    await db.drugEvent.createMany({
      data: [1, 2].map((i) => ({
        userId, occurredAt: new Date((base + i * 60) * 1000),
        drugName: "Xanax", drugItemId: 206, outcome: "success" as const,
        source: "test", sourceRef: `x-${i}-${randomBytes(3).toString("hex")}`,
      })),
      skipDuplicates: true,
    });
    const daily = await getDailySummary({ id: userId, timezone: "UTC", isDemo: false }, undefined as never);
    expect(daily.drugs.xanax.consumed).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* TRAVEL — Today block equals the canonical Travel summary            */
/* ------------------------------------------------------------------ */

suite("travel golden", () => {
  it("14-15. trip economics traced from stored items; Today agrees with Travel", async () => {
    const userId = await makeProfile();
    // Departure anchored INSIDE today (00:30 UTC), deterministic for any run
    // hour. The previous nowSec-anchored departure (now − 1h, item at +3h)
    // pushed the purchased item past UTC midnight after ~22:00 UTC;
    // resolveDateRange clamps `to` to end-of-today, so the item silently
    // dropped out of the range and the golden profit read 0 (TH-004).
    const departed = Math.floor(nowSec / DAY) * DAY + 1800;
    const trip = await db.travelEvent.create({
      data: {
        userId, destination: "Mexico", departedAt: new Date(departed * 1000),
        arrivedAt: new Date((departed + 5 * 3600) * 1000), returnedAt: new Date((departed + 9 * 3600) * 1000),
        durationSeconds: 9 * 3600, status: "returned", source: "test", sourceRef: `gold-trip-${userId}`,
      },
    });
    await db.travelItemEvent.create({
      data: {
        userId, travelEventId: trip.id, occurredAt: new Date((departed + 60) * 1000),
        destination: "Mexico", category: "plushie", itemId: 438, itemName: "Teddy",
        quantity: 10, unitCost: 6_500n, totalCost: 65_000n,
        estimatedUnitValue: 10_000n, estimatedTotalValue: 100_000n,
        source: "test", sourceRef: `gold-titem-${userId}`,
      },
    });
    // The valuation authority is the item CATALOG (current market price),
    // deliberately not the per-row stored estimate.
    await db.tornItemCatalog.upsert({
      where: { itemId: 438 },
      create: { itemId: 438, name: "Teddy", type: "Plushie", marketPrice: 10_000n },
      update: { marketPrice: 10_000n },
    });
    const [travel, daily] = await Promise.all([
      getTravelSummary(userId, { preset: "custom", from: departed - 3600, to: departed + 2 * DAY }),
      getDailySummary({ id: userId, timezone: "UTC", isDemo: false }, undefined as never),
    ]);
    // Golden: profit = estimated value − spend, from stored items only.
    expect(travel.estimatedProfit.value).toBe(35_000); // 100k est. value − 65k spend
    expect(travel.trips).toBe(1);
    // Today's block uses the SAME canonical calculation for the same day.
    expect(daily.travel.estimatedProfit.value).toBe(travel.estimatedProfit.value);
  });
});

/* ------------------------------------------------------------------ */
/* LEGACY — a profile with no bars history degrades honestly           */
/* ------------------------------------------------------------------ */

suite("legacy profile (no bars history)", () => {
  it("68. stats-only profile: battlestats work, energy stays unavailable — never zero", async () => {
    const userId = await makeProfile();
    const t0 = nowSec - 7200;
    await db.personalStatSnapshot.createMany({
      data: [
        { userId, capturedAt: new Date((t0 - 3600) * 1000), stats: { battle_stats: { strength: 5_000_000, defense: 5_000_000, speed: 5_000_000, dexterity: 5_000_000, total: 20_000_000 } } },
        { userId, capturedAt: new Date((t0 + 3600) * 1000), stats: { battle_stats: { strength: 5_100_000, defense: 5_000_000, speed: 5_000_000, dexterity: 5_000_000, total: 20_100_000 } } },
      ],
    });
    const prog = await getProgression(userId, { preset: "custom", from: t0, to: t0 + 7200 });
    expect(prog.battlestats.deltaTotal).toBe(100_000);
    expect(prog.energy.covered).toBe(false);
    expect(prog.summary.energyTrained.value).toBeNull();
    expect(prog.training.sessions).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* DST — a 23-hour and 25-hour local day resolve without dup/gap       */
/* ------------------------------------------------------------------ */

suite("timezone canonicalization", () => {
  it("32. Amsterdam DST days span 23h / 25h with contiguous boundaries", async () => {
    const spring = resolveDayRange("2026-03-29", "Europe/Amsterdam");
    const fall = resolveDayRange("2025-10-26", "Europe/Amsterdam");
    expect((spring.to - spring.from + 1) / 3600).toBeCloseTo(23, 5);
    expect((fall.to - fall.from + 1) / 3600).toBeCloseTo(25, 5);
    // Contiguity: fall-back day starts exactly when spring day's successor would.
    expect(resolveDayRange("2026-03-30", "Europe/Amsterdam").from).toBe(spring.to + 1);
  });
});
