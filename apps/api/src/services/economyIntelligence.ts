import { buildFinancialRecords, buildWealthAttribution, buildWealthProjection, buildWealthVelocity, type NetworthSnapshotFields } from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, loadTripsWindow } from "@tornscope/database";
import type { EconomySummaryResponse } from "@tornscope/shared";

/**
 * Economy intelligence (2.0) — the `intelligence` section of /api/economy:
 * wealth velocity (7/30/90d), a 30-day trend projection, wealth attribution
 * for the selected range and all-time personal financial records.
 *
 * Everything is derived from stored snapshots and the money ledger; the
 * attribution inherits the semantics partitioning so conversions are never
 * misread as income/loss and nothing is double counted.
 */

/** Full snapshot columns needed for attribution + liquid records. */
const SNAPSHOT_SELECT = {
  capturedAt: true,
  total: true,
  wallet: true,
  vault: true,
  pending: true,
  bookie: true,
  cityBank: true,
  caymanBank: true,
  piggyBank: true,
  inventory: true,
  displayCase: true,
  bazaar: true,
  trades: true,
  itemMarket: true,
  auctionHouse: true,
  enlistedCars: true,
  property: true,
  stockMarket: true,
  company: true,
  loans: true,
  unpaidFees: true,
  points: true,
} as const;

type SnapshotRow = {
  capturedAt: Date;
  total: bigint;
  wallet: bigint;
  vault: bigint;
  pending: bigint;
  bookie: bigint;
  cityBank: bigint;
  caymanBank: bigint;
  piggyBank: bigint;
  inventory: bigint;
  displayCase: bigint;
  bazaar: bigint;
  trades: bigint;
  itemMarket: bigint;
  auctionHouse: bigint;
  enlistedCars: bigint;
  property: bigint;
  stockMarket: bigint;
  company: bigint;
  loans: bigint;
  unpaidFees: bigint;
  points: bigint;
};

function toFields(r: SnapshotRow): NetworthSnapshotFields {
  return {
    capturedAt: Math.floor(r.capturedAt.getTime() / 1000),
    total: Number(r.total),
    loans: Number(r.loans ?? 0n),
    unpaidFees: Number(r.unpaidFees ?? 0n),
    wallet: Number(r.wallet),
    vault: Number(r.vault),
    pending: Number(r.pending),
    bookie: Number(r.bookie),
    cityBank: Number(r.cityBank),
    caymanBank: Number(r.caymanBank),
    piggyBank: Number(r.piggyBank),
    inventory: Number(r.inventory),
    displayCase: Number(r.displayCase),
    bazaar: Number(r.bazaar),
    trades: Number(r.trades),
    itemMarket: Number(r.itemMarket),
    auctionHouse: Number(r.auctionHouse),
    enlistedCars: Number(r.enlistedCars),
    property: Number(r.property),
    stockMarket: Number(r.stockMarket),
    company: Number(r.company),
    points: Number(r.points),
  };
}

/** Minimal money-row shape for records/attributions (id NOT needed here). */
interface MoneyRowLite {
  occurredAt: Date;
  category: string;
  direction: string;
  amount: bigint;
}

function toEventLike(r: MoneyRowLite): { id: string; occurredAt: number; category: string; direction: "income" | "expense" | "neutral" | "unknown"; amount: number } {
  return {
    id: `${r.occurredAt.getTime()}:${r.category}:${r.direction}:${Number(r.amount)}`,
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    category: r.category,
    direction: r.direction as "income" | "expense" | "neutral" | "unknown",
    amount: bigintToNumber(r.amount) ?? 0,
  };
}

/**
 * Compose the intelligence section. `from`/`to` drive the attribution window
 * (the user's selected economy range); velocity/projection/records use their
 * own windows regardless of the selection.
 */
export async function buildEconomyIntelligence(userId: string, from: number, to: number): Promise<EconomySummaryResponse["intelligence"]> {
  const db = getPrismaClient();
  const now = Math.floor(Date.now() / 1000);
  const velocityFrom = new Date((now - 92 * 86400) * 1000);

  const [snapshotRows, moneyRows, travelAllRows, attributionRows] = await Promise.all([
    db.networthSnapshot.findMany({ where: { userId, capturedAt: { gte: velocityFrom } }, orderBy: { capturedAt: "asc" }, select: SNAPSHOT_SELECT }),
    // All-time (bounded by stored history) for records — 4 slim columns.
    db.moneyEvent.findMany({
      where: { userId },
      select: { occurredAt: true, category: true, direction: true, amount: true },
    }),
    loadTripsWindow(db, userId, 0, now),
    // Attribution needs only the selected range.
    db.moneyEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
      select: { occurredAt: true, category: true, direction: true, amount: true },
    }),
  ]);

  const snapshots = snapshotRows.map(toFields);

  return {
    velocity: buildWealthVelocity(snapshots, now).map((v) => ({
      lookbackDays: v.lookbackDays,
      change: v.change,
      velocityPerDay: v.velocityPerDay,
      coverage: v.coverage,
      trend: {
        velocityPerDay: v.trend.velocityPerDay,
        slopePerDay: v.trend.slopePerDay,
        fitR2: v.trend.fitR2,
        confidence: v.trend.confidence,
        window: v.trend.window,
      },
    })),
    projection: buildWealthProjection(snapshots, now),
    attribution: buildWealthAttribution({ moneyEvents: attributionRows.map(toEventLike), networthSnapshots: snapshots }, from, to),
    records: buildFinancialRecords({
      networthSnapshots: snapshots,
      moneyEvents: moneyRows.map(toEventLike),
      travelTrips: travelAllRows,
    }),
  };
}
