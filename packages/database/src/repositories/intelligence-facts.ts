import {
  buildBattlestatSeries,
  buildEnergyCappedHours,
  buildEnergyLedger,
  detectTrainingSessions,
  shapeEnergyInputs,
  extractStatCounters,
  type BattlestatPoint,
  type EnergyObservation,
  type GoalFacts,
  type InsightInputs,
  type MoneyEventLike,
  type NetworthSnapshotFields,
  type RehabEventLike,
  type TravelTripLike,
} from "@tornscope/analytics";
import { bigintToNumber } from "../client.js";
import { loadMarketPrices } from "./catalog.js";
import type { PrismaClientType } from "../client.js";

/**
 * Stored-data fact gathering for TornScope 2.0 intelligence (goals,
 * projections, insights). ONE implementation, shared by the API services and
 * the worker's notification producers — the analytics itself is pure and
 * lives in @tornscope/analytics; this module only fetches the exact stored
 * windows those functions need. No Torn API calls, ever.
 */

const DAY = 86_400;

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
  points: true,
} as const;

export type NetworthSnapshotRow = {
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
  points: bigint;
};

export function networthRowToFields(r: NetworthSnapshotRow): NetworthSnapshotFields {
  return {
    capturedAt: Math.floor(r.capturedAt.getTime() / 1000),
    total: Number(r.total),
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

/** Goal fact windows: 95 days covers the 90d projection lookback + margin. */
const GOAL_WINDOW_DAYS = 95;

/** Stored series a goal metric can be measured against (goals + projections). */
export async function getGoalFacts(db: PrismaClientType, userId: string, nowSec: number): Promise<GoalFacts> {
  const windowStart = new Date((nowSec - GOAL_WINDOW_DAYS * DAY) * 1000);
  const [networthRows, statRows, levelRows] = await Promise.all([
    db.networthSnapshot.findMany({
      where: { userId, capturedAt: { gte: windowStart } },
      orderBy: { capturedAt: "asc" },
      select: SNAPSHOT_SELECT,
    }),
    db.personalStatSnapshot.findMany({
      where: { userId, capturedAt: { gte: windowStart } },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, stats: true },
    }),
    db.userSnapshot.findMany({
      where: { userId, capturedAt: { gte: windowStart } },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, level: true },
    }),
  ]);
  return {
    networthSnapshots: networthRows.map(networthRowToFields),
    battlestatSeries: buildBattlestatSeries(statRows.map((r) => ({ capturedAt: Math.floor(r.capturedAt.getTime() / 1000), stats: r.stats }))),
    levelSeries: levelRows.map((r) => ({ t: Math.floor(r.capturedAt.getTime() / 1000), level: r.level })),
  };
}

/* -------------------------------------------------------------------------- */
/* Insight inputs                                                              */
/* -------------------------------------------------------------------------- */

/** Fetch assembled trips (departed in window) with catalog-valued items. */
export async function loadTripsWindow(db: PrismaClientType, userId: string, from: number, to: number): Promise<TravelTripLike[]> {
  const [tripRows, itemRows, marketPrices] = await Promise.all([
    db.travelEvent.findMany({
      where: { userId, departedAt: { gte: new Date((from - 7 * DAY) * 1000), lte: new Date(to * 1000) } },
      orderBy: { departedAt: "asc" },
      select: { id: true, destination: true, departedAt: true, returnedAt: true, durationSeconds: true },
    }),
    db.travelItemEvent.findMany({
      where: { userId, occurredAt: { gte: new Date((from - 7 * DAY) * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      select: { id: true, travelEventId: true, itemId: true, itemName: true, category: true, quantity: true, unitCost: true, totalCost: true },
    }),
    loadMarketPrices(db),
  ]);
  const itemsByTrip = new Map<string, TravelTripLike["items"]>();
  for (const r of itemRows) {
    if (!r.travelEventId) continue;
    const list = itemsByTrip.get(r.travelEventId) ?? [];
    list.push({
      id: r.id,
      itemId: r.itemId,
      itemName: r.itemName,
      category: r.category,
      quantity: r.quantity,
      unitCost: bigintToNumber(r.unitCost) ?? 0,
      totalCost: bigintToNumber(r.totalCost) ?? 0,
      estimatedUnitValue: marketPrices.get(r.itemId) !== undefined ? Number(marketPrices.get(r.itemId)) : null,
    });
    itemsByTrip.set(r.travelEventId, list);
  }
  return tripRows.map((t) => ({
    id: t.id,
    destination: t.destination,
    departedAt: Math.floor(t.departedAt.getTime() / 1000),
    returnedAt: t.returnedAt ? Math.floor(t.returnedAt.getTime() / 1000) : null,
    durationSeconds: t.durationSeconds,
    items: itemsByTrip.get(t.id) ?? [],
  }));
}

/**
 * Gather every input the insights engine needs, from stored rows only.
 * Training sessions reuse the SAME inference pipeline inputs as the
 * progression service (energy ledger + battlestat brackets + counters) so
 * both surfaces see identical sessions.
 */
export async function gatherInsightFacts(db: PrismaClientType, userId: string, nowSec: number): Promise<InsightInputs> {
  const eventsFrom = nowSec - 130 * DAY; // best_income_day: 120d + margin
  const barsFrom = nowSec - 37 * DAY;

  const [networthRows, moneyRows, rehabRows, statRows, barsRows, refillRows, drugRows, consumptionRows, combatRows, trips] = await Promise.all([
    db.networthSnapshot.findMany({ where: { userId, capturedAt: { gte: new Date(eventsFrom * 1000) } }, orderBy: { capturedAt: "asc" }, select: SNAPSHOT_SELECT }),
    db.moneyEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(eventsFrom * 1000) } },
      orderBy: { occurredAt: "asc" },
      select: { id: true, occurredAt: true, category: true, direction: true, amount: true },
    }),
    db.rehabEvent.findMany({ where: { userId, occurredAt: { gte: new Date((nowSec - 95 * DAY) * 1000) } }, select: { occurredAt: true, cost: true } }),
    db.personalStatSnapshot.findMany({ where: { userId, capturedAt: { gte: new Date((nowSec - 70 * DAY) * 1000) } }, orderBy: { capturedAt: "asc" }, select: { capturedAt: true, stats: true } }),
    db.barsSnapshot.findMany({ where: { userId, capturedAt: { gte: new Date(barsFrom * 1000) } }, orderBy: { capturedAt: "asc" }, select: { capturedAt: true, energyCurrent: true, energyMaximum: true, happyCurrent: true } }),
    db.timelineEvent.findMany({ where: { userId, title: "Points energy refill use", occurredAt: { gte: new Date(barsFrom * 1000) } }, orderBy: { occurredAt: "asc" }, take: 5000, select: { occurredAt: true, metadata: true } }),
    db.drugEvent.findMany({ where: { userId, drugName: { in: ["Xanax", "Ecstasy"] }, occurredAt: { gte: new Date(barsFrom * 1000) } }, orderBy: { occurredAt: "asc" }, take: 5000, select: { occurredAt: true, drugName: true, outcome: true } }),
    db.consumptionEvent.findMany({ where: { userId, category: { in: ["energy", "candy", "happy_jump"] }, occurredAt: { gte: new Date(barsFrom * 1000) } }, orderBy: { occurredAt: "asc" }, take: 5000, select: { occurredAt: true, category: true, metadata: true } }),
    db.combatEvent.findMany({ where: { userId, direction: "outgoing", occurredAt: { gte: new Date(barsFrom * 1000) } }, orderBy: { occurredAt: "asc" }, take: 5000, select: { occurredAt: true } }),
    loadTripsWindow(db, userId, nowSec - 40 * DAY, nowSec),
  ]);

  // Energy ledger + sessions over the 37d window — the same construction the
  // progression service uses (gains/competing evidence from the same tables).
  const bars: EnergyObservation[] = barsRows.map((r) => ({
    t: Math.floor(r.capturedAt.getTime() / 1000),
    energyCurrent: r.energyCurrent,
    energyMaximum: r.energyMaximum,
    happyCurrent: r.happyCurrent,
  }));
  const statSeries: BattlestatPoint[] = buildBattlestatSeries(statRows.map((r) => ({ capturedAt: Math.floor(r.capturedAt.getTime() / 1000), stats: r.stats })));
  const counterSeries = statRows.map((r) => ({ t: Math.floor(r.capturedAt.getTime() / 1000), ...extractStatCounters(r.stats) }));
  const shaped = shapeEnergyInputs(refillRows, drugRows, consumptionRows, combatRows);
  const ledger = buildEnergyLedger(bars, shaped.gains, shaped.competing);
  const sessions = detectTrainingSessions(ledger, statSeries, counterSeries);

  const moneyEvents: MoneyEventLike[] = moneyRows.map((r) => ({
    id: r.id,
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    category: r.category,
    direction: r.direction,
    amount: bigintToNumber(r.amount) ?? 0,
  }));
  const rehabEvents: RehabEventLike[] = rehabRows.map((r) => ({
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    cost: r.cost !== null ? bigintToNumber(r.cost) : null,
    rehabPercent: null,
  }));

  return {
    now: nowSec,
    networthSnapshots: networthRows.map(networthRowToFields),
    moneyEvents,
    travelTrips: trips,
    rehabEvents,
    xanaxCounter: counterSeries.map((c) => ({ t: c.t, xanax: c.xanax })),
    trainingSessions: sessions,
    energyCappedHours: buildEnergyCappedHours(
      barsRows.map((r) => ({ capturedAt: Math.floor(r.capturedAt.getTime() / 1000), energyCurrent: r.energyCurrent, energyMaximum: r.energyMaximum })),
      barsFrom,
      nowSec
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Decision Intelligence facts (2.3.0)                                         */
/* -------------------------------------------------------------------------- */

export interface DecisionFactsInput {
  now: number;
  money: {
    events: Array<{ t: number; category: string; direction: "income" | "expense" | "neutral" | "unknown"; amount: number }>;
    trackingSince: number | null;
  };
  drugs: {
    events: Array<{ t: number; drugName: string | null; outcome: "success" | "overdose" }>;
    rehab: Array<{ t: number; cost: number | null; sessions: number | null }>;
    trackingSince: number | null;
  };
  travel: {
    trips: Array<{
      destination: string;
      departedAt: number;
      durationSeconds: number | null;
      items: Array<{ totalCost: number; estimatedUnitValue: number | null; quantity: number }>;
    }>;
    trackingSince: number | null;
  };
  energy: {
    gym: Array<{ t: number; energyUsed: number }>;
    refills: Array<{ t: number }>;
    xanaxUses: Array<{ t: number }>;
    trackingSince: number | null;
  };
  goals: {
    paced: Array<{ id: string; label: string; metric: string; target: number; targetDate: number }>;
    networthPerDay: number | null;
  };
}

/**
 * Bounded fact gathering for Decision Intelligence: ONE window (trailing
 * 37 days = recent 7d + baseline 30d) of indexed, capped reads — all
 * aggregates computed downstream in the pure engine. No Torn API calls.
 */
export async function gatherDecisionFacts(db: PrismaClientType, userId: string, nowSec: number): Promise<DecisionFactsInput> {
  const from = nowSec - 37 * DAY;
  const fromDate = new Date(from * 1000);
  const toDate = new Date(nowSec * 1000);

  const [
    moneyRows,
    drugRows,
    rehabRows,
    gymRows,
    refillCountRows,
    trips,
    moneySince,
    drugsSince,
    rehabSince,
    travelSince,
    goals,
  ] = await Promise.all([
    db.moneyEvent.findMany({
      where: { userId, occurredAt: { gte: fromDate, lte: toDate } },
      orderBy: { occurredAt: "asc" },
      take: 20_000,
      select: { occurredAt: true, category: true, direction: true, amount: true },
    }),
    db.drugEvent.findMany({
      where: { userId, occurredAt: { gte: fromDate, lte: toDate } },
      orderBy: { occurredAt: "asc" },
      take: 10_000,
      select: { occurredAt: true, drugName: true, outcome: true },
    }),
    db.rehabEvent.findMany({
      where: { userId, occurredAt: { gte: fromDate, lte: toDate } },
      orderBy: { occurredAt: "asc" },
      take: 2_000,
      select: { occurredAt: true, cost: true, sessions: true },
    }),
    db.timelineEvent.findMany({
      where: { userId, title: { startsWith: "Gym train", mode: "insensitive" }, occurredAt: { gte: fromDate, lte: toDate } },
      orderBy: { occurredAt: "asc" },
      take: 8_000,
      select: { occurredAt: true, metadata: true },
    }),
    db.timelineEvent.findMany({
      where: { userId, title: "Points energy refill use", occurredAt: { gte: fromDate, lte: toDate } },
      orderBy: { occurredAt: "asc" },
      take: 2_000,
      select: { occurredAt: true },
    }),
    loadTripsWindow(db, userId, from, nowSec),
    db.moneyEvent.findFirst({ where: { userId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    db.drugEvent.findFirst({ where: { userId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    db.rehabEvent.findFirst({ where: { userId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    db.travelTransition.findFirst({ where: { userId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    db.goal.findMany({ where: { userId, status: "active", targetDate: { not: null } }, select: { id: true, metric: true, target: true, targetDate: true, note: true } }),
  ]);

  const gym: DecisionFactsInput["energy"]["gym"] = [];
  for (const row of gymRows) {
    const data = (row.metadata as { data?: Record<string, unknown> } | null)?.data ?? {};
    const used = typeof data.energy_used === "number" && Number.isFinite(data.energy_used) && data.energy_used > 0 ? data.energy_used : null;
    if (used !== null) gym.push({ t: Math.floor(row.occurredAt.getTime() / 1000), energyUsed: used });
  }

  const sec = (d: Date): number => Math.floor(d.getTime() / 1000);
  const secOrNull = (d: Date | null): number | null => (d ? sec(d) : null);

  return {
    now: nowSec,
    money: {
      events: moneyRows.map((r) => ({
        t: sec(r.occurredAt),
        category: r.category,
        direction: r.direction as "income" | "expense" | "neutral" | "unknown",
        amount: bigintToNumber(r.amount) ?? 0,
      })),
      trackingSince: secOrNull(moneySince?.occurredAt ?? null),
    },
    drugs: {
      events: drugRows.map((r) => ({ t: sec(r.occurredAt), drugName: r.drugName, outcome: r.outcome as "success" | "overdose" })),
      rehab: rehabRows.map((r) => ({ t: sec(r.occurredAt), cost: bigintToNumber(r.cost), sessions: r.sessions })),
      trackingSince: secOrNull(drugsSince?.occurredAt ?? null),
    },
    travel: {
      trips: trips.map((t) => ({
        destination: t.destination,
        departedAt: t.departedAt,
        durationSeconds: t.durationSeconds,
        items: t.items.map((i) => ({
          totalCost: i.totalCost,
          estimatedUnitValue: i.estimatedUnitValue ?? null,
          quantity: i.quantity,
        })),
      })),
      trackingSince: secOrNull(travelSince?.occurredAt ?? null),
    },
    energy: {
      gym,
      refills: refillCountRows.map((r) => ({ t: sec(r.occurredAt) })),
      xanaxUses: drugRows.filter((r) => r.drugName === "Xanax" && r.outcome === "success").map((r) => ({ t: sec(r.occurredAt) })),
      trackingSince: secOrNull(drugsSince?.occurredAt ?? null),
    },
    goals: {
      paced: goals
        .filter((g) => g.targetDate !== null)
        .map((g) => ({
          id: g.id,
          label: g.note?.trim() ? g.note.trim().slice(0, 60) : g.metric,
          metric: g.metric,
          target: bigintToNumber(g.target) ?? 0,
          targetDate: Math.floor((g.targetDate as Date).getTime() / 1000),
        })),
      networthPerDay: null, // filled by the service from recent money income pace
    },
  };
}
