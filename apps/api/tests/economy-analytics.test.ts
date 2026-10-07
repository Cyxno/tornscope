import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { getEconomySummary } from "../src/services/economy.js";
import { deleteProfile } from "../src/services/me.js";

/**
 * Economy analytics acceptance matrix (v0.2 roadmap item #6).
 *
 * DB-backed: synthetic profiles are created and deleted per run. Fixtures
 * exercise every semantic lens — cash flow vs economic effect vs conversions
 * vs net worth — plus wallet reconciliation (exact / residual / partial /
 * missing anchors), provenance separation, capability gating and isolation.
 * The core rule everywhere: unavailable never becomes zero, and conversions
 * never become income or expense.
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
const range = { preset: "custom" as const, from: dayStart, to: dayStart + DAY };
const cleanupIds: string[] = [];

function sig(hour: number, minute = 0): Date {
  return new Date((dayStart + hour * 3600 + minute * 60) * 1000);
}

async function makeProfile(name: string, caps: object): Promise<{ id: string; tornId: number }> {
  const tornId = 2_100_000_000 + Math.floor(Math.random() * 40_000_000);
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

/** Fully caught-up sync states: money coverage spans far before the range. */
async function caughtUpStates(userId: string, opts: { moneyGaps?: boolean } = {}): Promise<void> {
  for (const resource of ["money_logs", "drugs", "travel", "rehab", "events"]) {
    const gap = opts.moneyGaps && resource === "money_logs";
    const state = {
      status: "idle" as const,
      recordsCollected: 1000,
      // Coverage starting INSIDE the range = known gap → partial grades.
      stopReason: gap ? ("source_exhausted" as const) : ("history_boundary_reached" as const),
      sourceEarliestAt: gap ? BigInt(dayStart + 3600) : BigInt(dayStart - 60 * DAY),
    };
    await db.syncState.upsert({
      where: { userId_resource: { userId, resource } },
      create: {
        userId, resource,
        lastSuccessAt: new Date((nowSec - 300) * 1000),
        lastAttemptAt: new Date((nowSec - 300) * 1000),
        lastCompletedAt: new Date((nowSec - 300) * 1000),
        lastTimestamp: BigInt(nowSec - 300),
        frequencySeconds: 600,
        nextRunAt: new Date((nowSec + 600) * 1000),
        ...state,
      },
      update: state,
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

/**
 * A coherent economy day. Returns the ledger so tests can derive the exact
 * expected wallet movement (OC payouts excluded — they never touch the wallet).
 */
async function seedEconomyDay(uid: string, ocPayout = true): Promise<Array<{ amount: bigint; oc?: boolean }>> {
  const rows: Array<{ amount: bigint; oc?: boolean }> = [
    { amount: 365_000n }, // salary — earned income
    { amount: 2_400_000n }, // bazaar sale — conversion (items → cash)
    { amount: -1_500_000n }, // stock buy — conversion (cash → stocks)
    { amount: -500_000n }, // bank investment — transfer (cash → bank)
    { amount: 521_000n }, // bank withdrawal with yield — transfer + derived interest
    { amount: -75_000n }, // gym — true expense
    { amount: -250_000n }, // rehab — true expense
  ];
  await db.moneyEvent.createMany({
    data: [
      { userId: uid, occurredAt: sig(2, 15), category: "salary", direction: "income", amount: 365_000n, source: "test", sourceRef: `eco:salary:${uid}` },
      { userId: uid, occurredAt: sig(9, 40), category: "bazaar", direction: "income", amount: 2_400_000n, source: "test", sourceRef: `eco:bazaar:${uid}` },
      { userId: uid, occurredAt: sig(11, 5), category: "stock", direction: "expense", amount: -1_500_000n, source: "test", sourceRef: `eco:stock:${uid}` },
      { userId: uid, occurredAt: sig(11, 20), category: "city_bank", direction: "neutral", amount: -500_000n, source: "test", sourceRef: `eco:bdep:${uid}` },
      { userId: uid, occurredAt: sig(21, 45), category: "city_bank", direction: "neutral", amount: 521_000n, source: "test", sourceRef: `eco:bwd:${uid}` },
      { userId: uid, occurredAt: sig(18, 30), category: "gym", direction: "expense", amount: -75_000n, source: "test", sourceRef: `eco:gym:${uid}` },
      { userId: uid, occurredAt: sig(14, 10), category: "rehab", direction: "expense", amount: -250_000n, source: "test", sourceRef: `eco:rehab:${uid}` },
    ],
    skipDuplicates: true,
  });
  if (ocPayout) {
    // Earned income credited to the FACTION BALANCE — never wallet cash.
    rows.push({ amount: 1_200_000n, oc: true });
    await db.moneyEvent.create({
      data: {
        userId: uid, occurredAt: sig(15, 0), category: "faction", direction: "income", amount: 1_200_000n,
        source: "test", sourceRef: `eco:oc:${uid}`, description: "Faction payout money balance receive",
        metadata: { data: { scenario: "Break the Bank" } },
      },
    });
  }
  return rows;
}

/** Snapshots: opening at/before range start; closing inside the range. */
async function seedWalletAnchors(uid: string, opening: bigint, closing: bigint): Promise<void> {
  await db.networthSnapshot.createMany({
    data: [
      { userId: uid, capturedAt: new Date((dayStart - 3600) * 1000), total: 100_000_000n, wallet: opening },
      { userId: uid, capturedAt: sig(23), total: 105_000_000n, wallet: closing },
    ],
    skipDuplicates: true,
  });
}

async function wealthSnapshots(uid: string): Promise<void> {
  await db.networthSnapshot.createMany({
    data: [
      { userId: uid, capturedAt: new Date((dayStart - 3600) * 1000), total: 100_000_000n, wallet: 20_000_000n, inventory: 40_000_000n, stockMarket: 10_000_000n },
      { userId: uid, capturedAt: sig(23), total: 105_000_000n, wallet: 22_000_000n, inventory: 42_000_000n, stockMarket: 11_500_000n },
    ],
    skipDuplicates: true,
  });
}

function netRecordedMovement(rows: Array<{ amount: bigint; oc?: boolean }>): number {
  return rows.filter((r) => !r.oc).reduce((s, r) => s + Number(r.amount), 0);
}

suite("economy analytics — semantic lenses", () => {
  it("full profile: conversions stay out of economic effect; bank interest is derived income; principal stays out", async () => {
    const p = await makeProfile("ECO-LENSES", FULL_CAPS);
    await caughtUpStates(p.id);
    await seedEconomyDay(p.id);
    const s = await getEconomySummary(p.id, range);

    // Cash flow P&L: every income row INCLUDING the OC payout (it is earned);
    // bank transfers stay out (neutral), and the OC payout leaves the wallet
    // reconciliation alone — that exclusion is asserted in its own test.
    expect(s.cashFlow.income.value).toBe(365_000 + 2_400_000 + 1_200_000);
    expect(s.cashFlow.expenses.value).toBe(1_500_000 + 75_000 + 250_000);
    // Earned vs converted split.
    expect(s.cashFlow.trueIncome).toBe(365_000 + 1_200_000);
    expect(s.cashFlow.trueExpense).toBe(75_000 + 250_000);
    expect(s.cashFlow.assetInflow).toBe(2_400_000);
    expect(s.cashFlow.assetOutflow).toBe(1_500_000);

    // Economic effect: earned income (salary + OC payout) + derived interest
    // (521k back on 500k in). Principal returns never appear here.
    expect(s.economicEffect.income.value).toBe(365_000 + 1_200_000 + 21_000);
    expect(s.economicEffect.interestIncome).toBe(21_000);
    expect(s.economicEffect.interestComplete).toBe(true);
    expect(s.economicEffect.expenses.value).toBe(325_000);
    // Income categories carry the derived interest row explicitly.
    expect(s.economicEffect.incomeCategories.some((c) => c.key === "bank_interest" && c.provenance === "derived")).toBe(true);

    // Conversions: both directions, bank subset tracked.
    const pairs = Object.fromEntries(s.conversions.byPair.map((x) => [x.pair, x.amount]));
    expect(pairs["items->cash"]).toBe(2_400_000);
    expect(pairs["cash->stocks"]).toBe(1_500_000);
    expect(pairs["cash->bank"]).toBe(500_000);
    expect(pairs["bank->cash"]).toBe(521_000);
    expect(s.conversions.bankTransfers).toBe(1_021_000);
  });

  it("bazaar sale never becomes profit: cash inflow ≠ economic income", () => {
    return (async () => {
      const p = await makeProfile("ECO-BAZAAR", FULL_CAPS);
      await caughtUpStates(p.id);
      await seedEconomyDay(p.id, false);
      const s = await getEconomySummary(p.id, range);
      expect(s.cashFlow.income.value! >= 2_400_000).toBe(true);
      expect(s.economicEffect.income.value! < s.cashFlow.income.value!).toBe(true);
      expect(s.cashFlow.assetInflow).toBeGreaterThan(0);
    })();
  });

  it("OC payouts: earned income, but excluded from wallet reconciliation", async () => {
    const p = await makeProfile("ECO-OC", FULL_CAPS);
    await caughtUpStates(p.id);
    const rows = await seedEconomyDay(p.id, true);
    const net = netRecordedMovement(rows); // excludes the 1.2m OC payout
    await seedWalletAnchors(p.id, 10_000_000n, BigInt(10_000_000 + net)); // exact
    const s = await getEconomySummary(p.id, range);
    expect(s.wallet.factionBalanceCredits).toBe(1_200_000);
    expect(s.wallet.recordedInflows + s.wallet.recordedOutflows > 0).toBe(true);
    expect(s.wallet.recordedNet).toBe(net);
    // Exact reconciliation — the OC payout would have broken it.
    expect(s.wallet.residual).toBe(0);
    expect(s.wallet.quality).toBe("exact");
    expect(s.wallet.explainedRatio).toBe(1);
    // And it still counts as earned income in the received breakdown.
    expect(s.cashFlow.trueIncome).toBe(365_000 + 1_200_000);
  });

  it("wallet reconciliation residual: surfaced with quality grade, never hidden", async () => {
    const p = await makeProfile("ECO-RESIDUAL", FULL_CAPS);
    await caughtUpStates(p.id);
    const rows = await seedEconomyDay(p.id, false);
    const net = netRecordedMovement(rows);
    await seedWalletAnchors(p.id, 10_000_000n, BigInt(10_000_000 + net - 500_000)); // 500k missing
    const s = await getEconomySummary(p.id, range);
    expect(s.wallet.expectedClosingWallet).toBe(10_000_000 + net);
    expect(s.wallet.closingWallet).toBe(10_000_000 + net - 500_000);
    expect(s.wallet.residual).toBe(-500_000);
    expect(s.wallet.quality).toBe("unreconciled");
    expect(s.explanation.walletUnexplained).toBe(-500_000);
    expect(s.wallet.explainedRatio).toBeLessThan(1);
  });

  it("missing wallet anchors: quality unavailable, residual null — never zero", async () => {
    const p = await makeProfile("ECO-NOANCHOR", FULL_CAPS);
    await caughtUpStates(p.id);
    await seedEconomyDay(p.id, false);
    const s = await getEconomySummary(p.id, range);
    expect(s.wallet.openingWallet).toBeNull();
    expect(s.wallet.closingWallet).toBeNull();
    expect(s.wallet.residual).toBeNull();
    expect(s.wallet.quality).toBe("unavailable");
    expect(s.wallet.explainedRatio).toBeNull();
  });

  it("known money-log coverage gaps cap reconciliation quality at partial", async () => {
    const p = await makeProfile("ECO-GAPS", FULL_CAPS);
    await caughtUpStates(p.id, { moneyGaps: true });
    const rows = await seedEconomyDay(p.id, false);
    const net = netRecordedMovement(rows);
    await seedWalletAnchors(p.id, 10_000_000n, BigInt(10_000_000 + net)); // exact residual anyway
    const s = await getEconomySummary(p.id, range);
    expect(s.wallet.residual).toBe(0);
    expect(s.wallet.quality).toBe("partial"); // luck, not proof
    expect(s.explanation.quality).toBe("partial");
  });

  it("net worth delta stays separate from economic net; official category drivers lead the explanation", async () => {
    const p = await makeProfile("ECO-NW", FULL_CAPS);
    await caughtUpStates(p.id);
    await seedEconomyDay(p.id, false);
    await wealthSnapshots(p.id);
    const s = await getEconomySummary(p.id, range);

    expect(s.networth.change.value).toBe(5_000_000); // official snapshot delta
    expect(s.economicEffect.net.value).not.toBe(5_000_000); // not the same concept
    const recorded = s.explanation.contributors.filter((c) => c.certainty === "recorded");
    expect(recorded.length).toBeGreaterThanOrEqual(3);
    expect(recorded.every((c) => c.source === "Official Torn net worth snapshots")).toBe(true);
    expect(recorded.every((c) => c.provenance === "derived")).toBe(true);
    // Deterministic ordering: |value| desc within the recorded group.
    const mags = recorded.map((c) => Math.abs(c.value ?? 0));
    expect([...mags].sort((a, b) => b - a)).toEqual(mags);
    // Residual is present and labeled unexplained.
    const residual = s.explanation.contributors.find((c) => c.certainty === "unexplained");
    expect(residual).toBeDefined();
    expect(s.explanation.netWorthUnexplained).toBe(residual!.value);
  });

  it("travel and drug consumption stay estimated and never merge into economic effect", async () => {
    const p = await makeProfile("ECO-EST", FULL_CAPS);
    await caughtUpStates(p.id);
    await seedEconomyDay(p.id, false);
    // The travel revenue side values from the CURRENT catalog (estimated);
    // seed a price for the trip item so the estimate is computable, then
    // remove it again — TornItemCatalog is a global table. Only remove it
    // when THIS test created it: parallel suites (daily-summary, golden-data)
    // may have seeded the same row, and only its creator cleans up (2.5.4).
    const ecoCreatedTeddyRow = (await db.tornItemCatalog.findUnique({ where: { itemId: 438 } })) === null;
    await db.tornItemCatalog.upsert({
      where: { itemId: 438 },
      create: { itemId: 438, name: "Teddy", type: "Plushie", marketPrice: 10_000n },
      update: { marketPrice: 10_000n },
    });
    try {
      const trip = await db.travelEvent.create({
        data: { userId: p.id, destination: "Mexico", departedAt: sig(3), arrivedAt: sig(8), returnedAt: sig(12), durationSeconds: 9 * 3600, status: "returned", source: "test", sourceRef: `eco:trip:${p.id}` },
      });
      await db.travelItemEvent.create({
        data: { userId: p.id, travelEventId: trip.id, occurredAt: sig(6), destination: "Mexico", category: "plushie", itemId: 438, itemName: "Teddy", quantity: 10, unitCost: 6_500n, totalCost: 65_000n, estimatedUnitValue: 10_000n, estimatedTotalValue: 100_000n, source: "test", sourceRef: `eco:titem:${p.id}` },
      });
      await db.consumptionEvent.create({
        data: { userId: p.id, occurredAt: sig(10), itemId: 206, itemName: "Xanax", category: "drug", quantity: 1, unitValue: 45_000n, totalValue: 45_000n, valuationMethod: "catalog_market_price", source: "test", sourceRef: `eco:cons:${p.id}` },
      });
      const s = await getEconomySummary(p.id, range);
      expect(s.travel.estimatedProfit.provenance).toBe("estimated");
      expect(s.consumption.totalValue.provenance).toBe("estimated");
      const est = s.explanation.contributors.filter((c) => c.certainty === "estimated");
      const labels = est.map((c) => c.key).sort();
      expect(labels).toEqual(["consumption", "travel"]);
      // Economic effect contains neither figure.
      expect(s.economicEffect.income.value).toBe(365_000 + 21_000);
    } finally {
      if (ecoCreatedTeddyRow) await db.tornItemCatalog.deleteMany({ where: { itemId: 438 } });
    }
  });

  it("major movements: deterministic, cross-role ordering from the endpoint", async () => {
    const p = await makeProfile("ECO-MAJOR", FULL_CAPS);
    await caughtUpStates(p.id);
    await seedEconomyDay(p.id, true);
    const s = await getEconomySummary(p.id, range);
    const mags = s.majorMovements.map((m) => m.amount);
    expect([...mags].sort((a, b) => b - a)).toEqual(mags);
    expect(s.majorMovements.some((m) => m.role === "transfer" && m.category === "city_bank")).toBe(true);
    expect(s.majorMovements.some((m) => m.role === "income" && m.category === "faction")).toBe(true);
    // Unknown rows never surface.
    expect(s.majorMovements.every((m) => m.amount >= 1_000)).toBe(true);
  });

  it("no double counting: received categories reconcile exactly to cash inflow", async () => {
    const p = await makeProfile("ECO-RECON", FULL_CAPS);
    await caughtUpStates(p.id);
    await seedEconomyDay(p.id, true);
    const s = await getEconomySummary(p.id, range);
    const incomeTotal = (s.cashFlow.incomeByCategory ?? []).reduce((sum, c) => sum + c.total, 0);
    expect(incomeTotal).toBe(s.cashFlow.income.value);
    const expenseTotal = (s.cashFlow.expensesByCategory ?? []).reduce((sum, c) => sum + c.total, 0);
    expect(expenseTotal).toBe(s.cashFlow.expenses.value);
  });

  it("lenses are related, not additive: wallet net ≠ cash net when bank transfers move", async () => {
    const p = await makeProfile("ECO-LENS", FULL_CAPS);
    await caughtUpStates(p.id);
    await seedEconomyDay(p.id, false);
    const s = await getEconomySummary(p.id, range);
    const cashNet = s.cashFlow.netCashFlow.value!;
    // recordedNet includes neutral bank transfers (−500k + 521k = +21k) — the
    // wallet lens is cash-basis, the cash-flow lens is ledger-P&L-basis.
    expect(s.wallet.recordedNet).toBe(cashNet + 21_000);
  });

  it("range isolation: rows outside the range never leak into any lens", async () => {
    const p = await makeProfile("ECO-RANGE", FULL_CAPS);
    await caughtUpStates(p.id);
    await seedEconomyDay(p.id, false);
    await db.moneyEvent.createMany({
      data: [
        { userId: p.id, occurredAt: new Date((dayStart - 30 * DAY) * 1000), category: "crime", direction: "income", amount: 999_999n, source: "test", sourceRef: `eco:old1:${p.id}` },
        { userId: p.id, occurredAt: new Date((dayStart + 2 * DAY) * 1000), category: "crime", direction: "income", amount: 888_888n, source: "test", sourceRef: `eco:future:${p.id}` },
      ],
    });
    const s = await getEconomySummary(p.id, range);
    expect(s.cashFlow.income.value).toBe(365_000 + 2_400_000);
    expect(s.range.from).toBe(range.from);
    expect(s.range.to).toBe(range.to);
  });
});

suite("economy analytics — capability and dataset gating", () => {
  it("limited capability: retained money history renders; networth-anchored sections degrade without fabrication", async () => {
    const p = await makeProfile("ECO-LIMITED", LIMITED_CAPS);
    await caughtUpStates(p.id);
    await seedEconomyDay(p.id, false);
    const s = await getEconomySummary(p.id, range);
    // Retained ledger history still computes (stale, not permission-hidden).
    expect(s.cashFlow.income.value).toBe(365_000 + 2_400_000);
    expect(s.availability?.cashFlow.state).toBe("stale_permission");
    // No networth permission → no snapshots → unavailable wallet, null NW.
    expect(s.wallet.quality).toBe("unavailable");
    expect(s.wallet.residual).toBeNull();
    expect(s.networth.current.value).toBeNull();
    // The key cannot refresh networth anymore, but the feature stays visible
    // with its retained (here: empty) history — stale, not permission-hidden.
    expect(s.availability?.networth.state).toBe("stale_permission");
  });

  it("confirmed zero stays zero under proven coverage", async () => {
    const p = await makeProfile("ECO-ZERO", FULL_CAPS);
    await caughtUpStates(p.id);
    await wealthSnapshots(p.id);
    const s = await getEconomySummary(p.id, range);
    expect(s.cashFlow.income.value).toBe(0);
    expect(s.cashFlow.income.availability).toBe("ok");
    expect(s.cashFlow.expenses.value).toBe(0);
  });

  it("never-synced dataset: unavailable, never zero", async () => {
    const p = await makeProfile("ECO-NEVER", FULL_CAPS);
    const s = await getEconomySummary(p.id, range);
    expect(s.cashFlow.income.value).toBeNull();
    expect(s.cashFlow.income.availability).toBe("unavailable");
    expect(s.cashFlow.unclassifiedCount).toBe(0);
    expect(s.confidence.cashFlow.confidence).toBe("unavailable");
  });

  it("multi-user isolation: another profile's economy never leaks", async () => {
    const a = await makeProfile("ECO-ISO-A", FULL_CAPS);
    const b = await makeProfile("ECO-ISO-B", FULL_CAPS);
    await caughtUpStates(a.id);
    await caughtUpStates(b.id);
    await seedEconomyDay(a.id, false);
    await wealthSnapshots(a.id);
    const sa = await getEconomySummary(a.id, range);
    const sb = await getEconomySummary(b.id, range);
    expect(sa.cashFlow.income.value).toBe(365_000 + 2_400_000);
    expect(sb.cashFlow.income.value).toBe(0);
    expect(sa.networth.change.value).toBe(5_000_000);
    expect(sb.networth.change.value).toBeNull();
  });

  it("demo profile: new lenses are populated with bank conversions and derived interest", async () => {
    const demoUser = await db.user.findUnique({ where: { email: "demo@tornscope.local" } });
    if (!demoUser) return; // demo seed not present in this environment
    // Wide window (inside the 180d demo history): bank interest attribution
    // needs the invest side of each pair in-range; pairs near the window edge
    // are conservatively unattributable (tested at the analytics level).
    const s = await getEconomySummary(demoUser.id, { preset: "custom", from: nowSec - 100 * DAY, to: nowSec });
    expect(s.generatedAt).toBeGreaterThan(0);
    // Signature day + history both bank-invest and withdraw with yield.
    expect(s.conversions.byPair.some((x) => x.pair === "cash->bank" && x.amount > 0)).toBe(true);
    expect(s.conversions.byPair.some((x) => x.pair === "bank->cash" && x.amount > 0)).toBe(true);
    expect(s.economicEffect.interestIncome).toBeGreaterThan(0);
    expect(s.economicEffect.interestComplete).toBe(true);
    // The OC payout must not have been counted as wallet inflow.
    expect(s.wallet.factionBalanceCredits).toBeGreaterThan(0);
    // Wallet reconciliation ran against the tracked snapshots (small drift).
    expect(["exact", "small_residual", "partial", "unreconciled"]).toContain(s.wallet.quality);
    expect(s.wallet.quality).not.toBe("unavailable");
    // Series ship in the same payload.
    expect(s.series.flow.length).toBeGreaterThan(0);
    expect(s.series.cumulativeNet.length).toBe(s.series.flow.length);
  });
});

afterAll(async () => {
  for (const id of cleanupIds) {
    try {
      await deleteProfile(id);
    } catch {
      /* already gone */
    }
  }
});
