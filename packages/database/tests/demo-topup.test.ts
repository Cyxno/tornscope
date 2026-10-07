import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "../src/index.js";
import { generateDemoHistory, type DemoContinuationState } from "../src/demo/generator.js";
import { maybeTopUpDemoData, DEMO_TOPUP_WATERMARK_KEY, DEMO_TOPUP_MAX_CATCHUP_SEC } from "../src/demo/topup.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DAY, HOUR } from "../src/demo/constants.js";

/**
 * Demo freshness (V1.0): deterministic, idempotent incremental top-up.
 *
 * DB-backed against TEST_DATABASE_URL; the demo user is created and deleted
 * per run. `nowSec` is injected everywhere — no real clock dependence.
 */

const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const suffix = randomBytes(6).toString("hex");
let demoUserId = "";

const DAY_SEC = DAY;
const NOW = Math.floor(Date.UTC(2026, 8, 15, 12, 0, 0) / 1000); // fixed 2026-09-15 12:00 UTC

async function createDemoUser(): Promise<string> {
  // ISOLATION: the seeded demo profile (demo@tornscope.local) is a SHARED
  // fixture other suites assert against — never touched here. Tests use
  // their own isDemo user and call the top-up with an explicit userId.
  const user = await db.user.create({ data: { email: `demo-topup-${suffix}@tornscope.local`, displayName: "Demo TopUp Test", role: "user", isDemo: true } });
  return user.id;
}

function initialState(userId: string, fromSec: number): DemoContinuationState {
  return {
    userId,
    nwBase: 180_000_000,
    nwCapturedSec: fromSec - HOUR,
    wallet: 25_000_000,
    stats: { str: 12_400_000, def: 9_850_000, spd: 10_320_000, dex: 8_640_000 },
    cum: { xanax: 347, ecstasy: 41, refills: 137, candy: 2673, awards: 172, overdoses: 11 },
    energy: 40,
    happy: 1200,
    travelCursor: fromSec,
    fromSec,
  };
}

async function counts(userId: string): Promise<Record<string, number>> {
  const [money, drug, consumption, rehab, travel, combat, crime, timeline, nw, stats, bars] = await Promise.all([
    db.moneyEvent.count({ where: { userId } }),
    db.drugEvent.count({ where: { userId } }),
    db.consumptionEvent.count({ where: { userId } }),
    db.rehabEvent.count({ where: { userId } }),
    db.travelEvent.count({ where: { userId } }),
    db.combatEvent.count({ where: { userId } }),
    db.crimeEvent.count({ where: { userId } }),
    db.timelineEvent.count({ where: { userId } }),
    db.networthSnapshot.count({ where: { userId } }),
    db.personalStatSnapshot.count({ where: { userId } }),
    db.barsSnapshot.count({ where: { userId } }),
  ]);
  return { money, drug, consumption, rehab, travel, combat, crime, timeline, nw, stats, bars };
}

suite("demo top-up", () => {
  beforeAll(async () => {
    // Cleanup from any earlier crashed run, then create the fresh demo user.
    await db.user.deleteMany({ where: { email: { contains: `demo-topup-${suffix}` } } });
    demoUserId = await createDemoUser();
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { email: { contains: `demo-topup-${suffix}` } } }).catch(() => undefined);
    await db.$disconnect();
  });

  it("reports needs-seed when no demo history exists", async () => {
    const result = await maybeTopUpDemoData(NOW, demoUserId);
    expect(result.status).toBe("needs-seed");
  });

  it("tops up history, keeps the profile stable, and is idempotent across reruns", async () => {
    // Initial history: generated up to 30 days ago, then never extended —
    // the stale-demo situation (also exercises a 30-day catch-up).
    await generateDemoHistory(db, {
      userId: demoUserId, fromSec: NOW - 30 * DAY_SEC, toSec: NOW - 30 * DAY_SEC + 6 * HOUR,
      state: initialState(demoUserId, NOW - 30 * DAY_SEC), gridOffset: NOW % 3600, xanaxUnitPrice: 45_000n,
    });
    await db.appSetting.create({ data: { userId: demoUserId, key: DEMO_TOPUP_WATERMARK_KEY, value: NOW - 30 * DAY_SEC } });

    const before = await counts(demoUserId);
    expect(before.money).toBeGreaterThan(0);

    // +3 days: exactly the stale-demo reproduction.
    const first = await maybeTopUpDemoData(NOW + 3 * DAY_SEC, demoUserId);
    expect(first.status).toBe("done");
    const afterFirst = await counts(demoUserId);
    expect(afterFirst.money).toBeGreaterThan(before.money);
    expect(afterFirst.nw).toBeGreaterThan(before.nw);

    const newestMoney = await db.moneyEvent.aggregate({ where: { userId: demoUserId }, _max: { occurredAt: true } });
    const newestNw = await db.networthSnapshot.aggregate({ where: { userId: demoUserId }, _max: { capturedAt: true } });
    expect(newestMoney._max.occurredAt!.getTime()).toBeGreaterThan((NOW + 2 * DAY_SEC) * 1000);
    expect(newestNw._max.capturedAt!.getTime()).toBeGreaterThan((NOW + 3 * DAY_SEC - 2 * HOUR) * 1000);

    // True rerun idempotency (a crashed run's retry): rewind the watermark
    // 7h so the same clock reruns the SAME window. The top-up reloads the
    // REAL continuation state (travel cursor, wallet, stats) from the DB and
    // must insert nothing new — every row dedupes by unique sourceRef.
    await db.appSetting.update({
      where: { userId_key: { userId: demoUserId, key: DEMO_TOPUP_WATERMARK_KEY } },
      data: { value: NOW + 3 * DAY_SEC - 7 * HOUR },
    });
    const second = await maybeTopUpDemoData(NOW + 3 * DAY_SEC, demoUserId);
    expect(second.status).toBe("done");
    const afterSecond = await counts(demoUserId);
    expect(afterSecond).toEqual(afterFirst);

    // The demo profile itself was never recreated.
    const user = await db.user.findUnique({ where: { id: demoUserId }, select: { id: true, email: true } });
    expect(user?.id).toBe(demoUserId);
  });

  it("throttles: a top-up within 6h of the watermark is a cheap no-op", async () => {
    const before = await counts(demoUserId);
    const result = await maybeTopUpDemoData(NOW + 3 * DAY_SEC + 2 * HOUR, demoUserId);
    expect(result.status).toBe("current");
    expect(await counts(demoUserId)).toEqual(before);
  });

  it("never mutates old historical rows on future top-ups", async () => {
    // Take a fingerprint of one past day's money rows.
    const dayStart = NOW - 2 * DAY_SEC;
    const rows = await db.moneyEvent.findMany({
      where: { userId: demoUserId, occurredAt: { gte: new Date(dayStart * 1000), lt: new Date((dayStart + DAY_SEC) * 1000) } },
      orderBy: { sourceRef: "asc" },
      select: { sourceRef: true, amount: true, occurredAt: true },
    });
    expect(rows.length).toBeGreaterThan(0);

    const result = await maybeTopUpDemoData(NOW + 4 * DAY_SEC, demoUserId);
    expect(result.status).toBe("done");

    const after = await db.moneyEvent.findMany({
      where: { userId: demoUserId, occurredAt: { gte: new Date(dayStart * 1000), lt: new Date((dayStart + DAY_SEC) * 1000) } },
      orderBy: { sourceRef: "asc" },
      select: { sourceRef: true, amount: true, occurredAt: true },
    });
    expect(after).toEqual(rows);
  });

  it("recovers from partial interruption: rerun converges to the same dataset", async () => {
    // Simulate an interrupted run by rewinding the watermark while the data
    // from the "interrupted" attempt stays: the next top-up regenerates the
    // overlap window and must add NOTHING new inside it.
    // Overlap = the region BOTH runs generate: the later run starts at the
    // rewound watermark's window; rows beyond the earlier run's horizon are
    // legitimately new, so the fixed comparison window is [NOW+2d, NOW+3d].
    const overlapFrom = NOW + 2 * DAY_SEC;
    const overlapTo = NOW + 3 * DAY_SEC;
    const beforeRows = await db.moneyEvent.findMany({
      where: { userId: demoUserId, occurredAt: { gte: new Date(overlapFrom * 1000), lt: new Date(overlapTo * 1000) } },
      orderBy: { sourceRef: "asc" }, select: { sourceRef: true, amount: true },
    });
    await db.appSetting.update({ where: { userId_key: { userId: demoUserId, key: DEMO_TOPUP_WATERMARK_KEY } }, data: { value: overlapFrom } });
    const result = await maybeTopUpDemoData(NOW + 5 * DAY_SEC + 14 * HOUR, demoUserId);
    expect(result.status).toBe("done");
    const afterRows = await db.moneyEvent.findMany({
      where: { userId: demoUserId, occurredAt: { gte: new Date(overlapFrom * 1000), lt: new Date(overlapTo * 1000) } },
      orderBy: { sourceRef: "asc" }, select: { sourceRef: true, amount: true },
    });
    expect(afterRows).toEqual(beforeRows); // interrupted overlap regenerated identically, no dupes
  });

  it("keeps real users and the global item catalog completely untouched", async () => {
    const realUser = await db.user.create({ data: { email: `real-${suffix}@tornscope.local`, displayName: "Real Player", role: "user", isDemo: false } });
    await db.moneyEvent.create({ data: { userId: realUser.id, occurredAt: new Date(NOW * 1000), category: "salary", direction: "income", amount: 1n, source: "torn_log", sourceRef: "real-money-1" } });
    await db.syncState.create({ data: { userId: realUser.id, resource: "money_logs", status: "idle", frequencySeconds: 600 } });
    // The invariant is proven on a RESERVED item (same range as catalog-integrity's
    // 9_999_001), NOT on the real Xanax row: several suites value Xanax through the
    // shared catalog row 206, and parallel vitest workers must never race each
    // other on that row (2.5.3's gate flaked exactly that way).
    const invariantItem = 9_999_206;
    await db.tornItemCatalog.upsert({
      where: { itemId: invariantItem },
      create: { itemId: invariantItem, name: "Topup invariant item", type: "Other", marketPrice: 77_777n },
      update: { marketPrice: 77_777n },
    });

    const realMoneyBefore = await db.moneyEvent.findMany({ where: { userId: realUser.id } });
    const catalogBefore = await db.tornItemCatalog.findUnique({ where: { itemId: invariantItem } });

    await maybeTopUpDemoData(NOW + 6 * DAY_SEC + 2 * HOUR, demoUserId);

    const realMoneyAfter = await db.moneyEvent.findMany({ where: { userId: realUser.id } });
    expect(realMoneyAfter).toEqual(realMoneyBefore);
    expect((await db.moneyEvent.count({ where: { userId: realUser.id } }))).toBe(1);
    const catalogAfter = await db.tornItemCatalog.findUnique({ where: { itemId: invariantItem } });
    expect(catalogAfter?.marketPrice).toBe(catalogBefore?.marketPrice);
    expect(catalogAfter?.marketPrice).toBe(77_777n);

    const realSync = await db.syncState.findFirst({ where: { userId: realUser.id } });
    expect(realSync?.lastSuccessAt).toBeNull(); // demo top-up must not touch it

    await db.user.delete({ where: { id: realUser.id } }).catch(() => undefined);
    await db.tornItemCatalog.delete({ where: { itemId: invariantItem } }).catch(() => undefined);
  });

  it("keeps the financial semantics coherent in the topped-up window", async () => {
    // The top-up window must contain: earned income, true costs, asset
    // purchases AND sales (conversion pairs), bank movements — and net worth
    // snapshots whose wallet tracks the ledger within the demo drift.
    const windowFrom = NOW - 30 * DAY_SEC;
    const [income, expense, bankNeutral, assetBuyRows] = await Promise.all([
      db.moneyEvent.count({ where: { userId: demoUserId, direction: "income", occurredAt: { gte: new Date(windowFrom * 1000) } } }),
      db.moneyEvent.count({ where: { userId: demoUserId, direction: "expense", occurredAt: { gte: new Date(windowFrom * 1000) } } }),
      db.moneyEvent.count({ where: { userId: demoUserId, direction: "neutral", occurredAt: { gte: new Date(windowFrom * 1000) } } }),
      db.moneyEvent.count({ where: { userId: demoUserId, category: "items", direction: "expense", occurredAt: { gte: new Date(windowFrom * 1000) } } }),
    ]);
    const totalForUser = await db.moneyEvent.count({ where: { userId: demoUserId } });
    const dirBreakdown = await db.moneyEvent.groupBy({ by: ["direction"], where: { userId: demoUserId }, _count: true });
    expect(income, `income=0; totalForUser=${totalForUser} breakdown=${JSON.stringify(dirBreakdown)} windowFrom=${new Date(windowFrom * 1000).toISOString()}`).toBeGreaterThan(0);
    expect(expense).toBeGreaterThan(0);
    expect(bankNeutral).toBeGreaterThan(0); // bank conversion pairs
    expect(assetBuyRows).toBeGreaterThan(0); // conversion-day asset purchases

    // Wallet coherence: closing tracked wallet ≈ opening + net movement
    // (within the demo's documented small drift, not an exact fake match).
    const days = await db.networthSnapshot.findMany({
      where: { userId: demoUserId, capturedAt: { gte: new Date(windowFrom * 1000) } },
      orderBy: { capturedAt: "asc" },
      select: { wallet: true, capturedAt: true },
    });
    expect(days.length).toBeGreaterThan(24);
    // Wallet coherence: closing tracked wallet − opening tracked wallet must
    // equal the ledger movement INSIDE the snapshot span (the first hourly
    // snapshot already includes its own hour's movement — count strictly
    // after it, through the last snapshot's hour), plus only the demo's
    // small documented drift — never a structural gap.
    const firstAt = days[0]!.capturedAt;
    const lastAt = days[days.length - 1]!.capturedAt;
    const netMoney = await db.moneyEvent.aggregate({
      where: { userId: demoUserId, occurredAt: { gte: new Date(firstAt.getTime() + HOUR * 1000), lt: new Date(lastAt.getTime() + HOUR * 1000) } },
      _sum: { amount: true },
    });
    const walletDelta = Number(days[days.length - 1]!.wallet) - Number(days[0]!.wallet);
    const movement = Number(netMoney._sum.amount ?? 0n);
    expect(Math.abs(walletDelta - movement)).toBeLessThan(2_000_000); // drift, not a gap
  });

  it("covers recent ranges: no systematic newest-days blank tail", async () => {
    // After a fresh top-up, 1D/7D/14D/30D all contain recent activity.
    const latest = await db.moneyEvent.aggregate({ where: { userId: demoUserId }, _max: { occurredAt: true } });
    const top = latest._max.occurredAt!.getTime() / 1000;
    for (const [label, days] of [["1D", 1], ["7D", 7], ["14D", 14], ["30D", 30]] as const) {
      const c = await db.moneyEvent.count({
        where: { userId: demoUserId, occurredAt: { gte: new Date((top - days * DAY_SEC) * 1000), lt: new Date(top * 1000) } },
      });
      expect(c, `${label} range should have money activity`).toBeGreaterThan(days * 5);
    }
  });

  it("bounds the catch-up window instead of silently rebuilding forever", async () => {
    expect(DEMO_TOPUP_MAX_CATCHUP_SEC).toBeLessThanOrEqual(60 * DAY_SEC);
  });
});

describe("demo module isolation (no Torn API, no push)", () => {
  const base = join(dirname(fileURLToPath(import.meta.url)), "../src/demo");
  const files = ["constants.ts", "random.ts", "generator.ts", "topup.ts", "topup-cli.ts"];

  it("never imports the Torn API client — pure DB synthetic generation", () => {
    for (const f of files) {
      const src = readFileSync(join(base, f), "utf8");
      expect(src, `${f} must not import @tornscope/torn-api`).not.toContain("torn-api");
      expect(src, `${f} must not use fetch`).not.toMatch(/\bfetch\(/);
    }
  });

  it("never writes notifications or push subscriptions", () => {
    for (const f of files) {
      const src = readFileSync(join(base, f), "utf8");
      expect(src, `${f} must not write notifications`).not.toMatch(/notification(Event|Delivery|Preference)\.create/);
      expect(src, `${f} must not write push subscriptions`).not.toContain("pushSubscription.create");
    }
  });
});
