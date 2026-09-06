import { autoInterval, resolveDateRange, type DateRangeInput, type NetworthCoverage, type NetworthResponse } from "@tornscope/shared";
import { buildNetworthSeries, calculateNetworthChanges, calculateNetworthPeriodChange, type NetworthSnapshotFields } from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient } from "@tornscope/database";

const SNAPSHOT_SELECT = {
  capturedAt: true,
  total: true,
  pending: true,
  wallet: true,
  vault: true,
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

interface SnapshotRow {
  capturedAt: Date;
  total: bigint;
  pending: bigint;
  wallet: bigint;
  vault: bigint;
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
}

function toFields(row: SnapshotRow): NetworthSnapshotFields {
  return {
    capturedAt: Math.floor(row.capturedAt.getTime() / 1000),
    total: bigintToNumber(row.total) ?? 0,
    pending: bigintToNumber(row.pending) ?? 0,
    wallet: bigintToNumber(row.wallet) ?? 0,
    vault: bigintToNumber(row.vault) ?? 0,
    bookie: bigintToNumber(row.bookie) ?? 0,
    cityBank: bigintToNumber(row.cityBank) ?? 0,
    caymanBank: bigintToNumber(row.caymanBank) ?? 0,
    piggyBank: bigintToNumber(row.piggyBank) ?? 0,
    inventory: bigintToNumber(row.inventory) ?? 0,
    displayCase: bigintToNumber(row.displayCase) ?? 0,
    bazaar: bigintToNumber(row.bazaar) ?? 0,
    trades: bigintToNumber(row.trades) ?? 0,
    itemMarket: bigintToNumber(row.itemMarket) ?? 0,
    auctionHouse: bigintToNumber(row.auctionHouse) ?? 0,
    enlistedCars: bigintToNumber(row.enlistedCars) ?? 0,
    property: bigintToNumber(row.property) ?? 0,
    stockMarket: bigintToNumber(row.stockMarket) ?? 0,
    company: bigintToNumber(row.company) ?? 0,
    points: bigintToNumber(row.points) ?? 0,
  };
}

/**
 * Net worth history + change over the SELECTED period.
 *
 * The period baseline is the closest valid snapshot at or before the range
 * start; when tracking began after the range started, coverage is "partial"
 * (Tracked period change) and with no usable history "none" (Insufficient
 * history) — never a misleading 0.
 *
 * The change metrics only ever compare ANCHOR snapshots (latest at/before a
 * timestamp, earliest ever), so the queries fetch those anchors directly —
 * loading the entire snapshot history (20 bigint columns per row) per request
 * is unnecessary.
 */
export async function getNetworth(userId: string, rangeInput: DateRangeInput): Promise<NetworthResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const now = Math.floor(Date.now() / 1000);
  const referenceNow = Math.max(now, range.to);
  const yearStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000);
  const DAY = 86_400;

  const snapAtOrBefore = (ts: number) =>
    db.networthSnapshot.findFirst({
      where: { userId, capturedAt: { lte: new Date(ts * 1000) } },
      orderBy: { capturedAt: "desc" },
      select: SNAPSHOT_SELECT,
    });

  const [rows, firstEver, latest, at7d, at30d, atYtd, atFrom, atTo] = await Promise.all([
    db.networthSnapshot.findMany({
      where: { userId, capturedAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      orderBy: { capturedAt: "asc" },
      select: SNAPSHOT_SELECT,
    }),
    db.networthSnapshot.findFirst({ where: { userId }, orderBy: { capturedAt: "asc" }, select: SNAPSHOT_SELECT }),
    snapAtOrBefore(referenceNow),
    snapAtOrBefore(referenceNow - 7 * DAY),
    snapAtOrBefore(referenceNow - 30 * DAY),
    snapAtOrBefore(yearStart),
    snapAtOrBefore(range.from),
    snapAtOrBefore(range.to),
  ]);

  // Anchors for the change metrics — exactly the snapshots the analytics can
  // select (latest at/before each anchor, plus the first ever).
  const changeAnchors = [firstEver, atYtd, at30d, at7d, latest]
    .filter((r): r is SnapshotRow => r !== null)
    .map(toFields)
    .sort((a, b) => a.capturedAt - b.capturedAt);
  const changes = calculateNetworthChanges(changeAnchors, referenceNow, yearStart);

  // Anchors for the period change: baseline (≤ from), current (≤ to), the
  // first snapshot inside the range (partial-coverage case) and the first
  // ever (trackedFrom).
  const periodAnchors = [firstEver, atFrom, atTo, rows[0] ?? null]
    .filter((r): r is SnapshotRow => r !== null)
    .map(toFields)
    .sort((a, b) => a.capturedAt - b.capturedAt);
  const period = calculateNetworthPeriodChange(periodAnchors, range.from, range.to);

  // Chart series: every real snapshot in the range exactly as stored,
  // chronologically sorted (buildNetworthSeries never repeats the latest
  // value or collapses points into buckets).
  const fieldsByTs = new Map<number, NetworthSnapshotFields>(rows.map((r) => [Math.floor(r.capturedAt.getTime() / 1000), toFields(r)]));
  const series = buildNetworthSeries(
    rows.map((r) => ({ capturedAt: Math.floor(r.capturedAt.getTime() / 1000), total: bigintToNumber(r.total) ?? 0 })),
    range.from,
    range.to
  ).map((point) => {
    const f = fieldsByTs.get(point.t);
    return {
      ...point,
      breakdown: {
        cash: f ? f.wallet + f.vault : 0,
        banks: f ? f.cityBank + f.caymanBank : 0,
        points: f?.points ?? 0,
        property: f?.property ?? 0,
        stocks: f?.stockMarket ?? 0,
        company: f?.company ?? 0,
      },
    };
  });

  return {
    range: { from: range.from, to: range.to, interval: autoInterval(range) },
    series,
    changes: {
      current: changes.current,
      change7d: changes.change7d,
      change30d: changes.change30d,
      changeYtd: changes.changeYtd,
      changeAllTime: changes.changeAllTime,
      firstTrackedAt: changes.firstTrackedAt,
    },
    period: {
      currentAt: period.current?.capturedAt ?? null,
      current: period.current?.total ?? null,
      baselineAt: period.baseline?.capturedAt ?? null,
      baseline: period.baseline?.total ?? null,
      change: period.change,
      changePct: period.changePct,
      coverage: period.coverage as NetworthCoverage,
      trackedFrom: period.trackedFrom,
      byCategory: period.byCategory,
    },
    trackingSince: changes.firstTrackedAt,
  };
}

/** Latest net worth snapshot (KPI source). */
export async function getLatestNetworth(userId: string) {
  const db = getPrismaClient();
  const row = await db.networthSnapshot.findFirst({
    where: { userId },
    orderBy: { capturedAt: "desc" },
    select: { capturedAt: true, total: true, wallet: true, vault: true },
  });
  if (!row) return null;
  return {
    capturedAt: Math.floor(row.capturedAt.getTime() / 1000),
    total: bigintToNumber(row.total),
    cash: (bigintToNumber(row.wallet) ?? 0) + (bigintToNumber(row.vault) ?? 0),
  };
}

/**
 * Networth period change over an arbitrary [from, to] window — shared by the
 * networth and dashboard/economy read paths so they always agree. Only the
 * anchor snapshots the calculation can select are fetched.
 */
export async function getNetworthPeriodForRange(userId: string, from: number, to: number) {
  const db = getPrismaClient();
  const [firstEver, atFrom, atTo, firstIn] = await Promise.all([
    db.networthSnapshot.findFirst({ where: { userId }, orderBy: { capturedAt: "asc" }, select: SNAPSHOT_SELECT }),
    db.networthSnapshot.findFirst({
      where: { userId, capturedAt: { lte: new Date(from * 1000) } },
      orderBy: { capturedAt: "desc" },
      select: SNAPSHOT_SELECT,
    }),
    db.networthSnapshot.findFirst({
      where: { userId, capturedAt: { lte: new Date(to * 1000) } },
      orderBy: { capturedAt: "desc" },
      select: SNAPSHOT_SELECT,
    }),
    db.networthSnapshot.findFirst({
      where: { userId, capturedAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
      orderBy: { capturedAt: "asc" },
      select: SNAPSHOT_SELECT,
    }),
  ]);
  const anchors = [firstEver, atFrom, atTo, firstIn]
    .filter((r): r is SnapshotRow => r !== null)
    .map(toFields)
    .sort((a, b) => a.capturedAt - b.capturedAt);
  return calculateNetworthPeriodChange(anchors, from, to);
}
