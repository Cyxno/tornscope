import {
  resolveDateRange,
  type CasinoSummaryResponse,
  type DateRangeInput,
} from "@tornscope/shared";
import { bigintToNumber, getPrismaClient } from "@tornscope/database";
import { loadAvailabilityContext, sectionAvailability } from "./availability.js";

/**
 * Casino Analytics (2.4.0) — retrospective P/L over normalized
 * ActivityEvents (domain = casino). Bounded SQL aggregation server-side;
 * event lists cursor-paginated. No Torn calls, no double counting with
 * MoneyEvent (that ledger stays the accounting view; this is the semantic
 * view — differences disclosed via the reconciliation endpoint).
 */

export async function getCasinoSummary(userId: string, rangeInput: DateRangeInput): Promise<CasinoSummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const availCtx = await loadAvailabilityContext(userId);
  const fromDate = new Date(range.from * 1000);
  const toDate = new Date(range.to * 1000);

  const where = {
    userId,
    domain: "casino",
    occurredAt: { gte: fromDate, lte: toDate },
  };

  const [byGame, byOutcome, totals, topResults, activityCount, oldest, lastPlayedRows, activeDaysRows] = await Promise.all([
    db.activityEvent.groupBy({
      by: ["activityType", "activityLabel"],
      where,
      _count: { _all: true },
      _sum: { cashInput: true, cashReward: true, netValue: true },
    }),
    db.activityEvent.groupBy({
      by: ["outcome"],
      where,
      _count: { _all: true },
    }),
    db.activityEvent.aggregate({
      where,
      _sum: { cashInput: true, cashReward: true, netValue: true },
      _max: { netValue: true, occurredAt: true },
      _min: { netValue: true, occurredAt: true },
    }),
    db.activityEvent.findMany({
      where: { ...where, netValue: { not: null } },
      orderBy: { netValue: "desc" },
      take: 1,
      select: { netValue: true, activityLabel: true, occurredAt: true },
    }),
    db.activityEvent.count({ where }),
    db.activityEvent.findFirst({ where: { userId, domain: "casino" }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    // Last played per game: one bounded groupBy (never per-game queries).
    db.activityEvent.groupBy({ by: ["activityType"], where, _max: { occurredAt: true } }),
    // Active days: distinct UTC days with casino activity (bounded by window).
    db.$queryRawUnsafe<Array<{ day: string }>>(
      `SELECT DISTINCT date_trunc('day', "occurredAt")::text AS day FROM "ActivityEvent"
       WHERE "userId" = $1 AND domain = 'casino' AND "occurredAt" BETWEEN $2 AND $3`,
      userId, fromDate, toDate
    ),
  ]);

  const toNum = (v: bigint | null | undefined): number | null => (v === null || v === undefined ? null : bigintToNumber(v));

  const lastPlayedByType = new Map(lastPlayedRows.map((r) => [r.activityType, r._max.occurredAt]));
  const games = byGame
    .map((g) => {
      const last = lastPlayedByType.get(g.activityType);
      return {
        game: g.activityType,
        label: g.activityLabel,
        plays: g._count._all,
        wagered: toNum(g._sum.cashInput),
        cashWon: toNum(g._sum.cashReward),
        net: toNum(g._sum.netValue),
        lastPlayedAt: last ? Math.floor(last.getTime() / 1000) : null,
      };
    })
    .sort((a, b) => (b.net ?? 0) - (a.net ?? 0));

  const outcomes: Record<string, number> = {};
  for (const o of byOutcome) outcomes[o.outcome ?? "unknown"] = o._count._all;

  const wagered = toNum(totals._sum.cashInput);
  const returned = toNum(totals._sum.cashReward);
  const net = toNum(totals._sum.netValue);
  const best = topResults[0] ?? null;

  return {
    range: { from: range.from, to: range.to },
    activities: activityCount,
    totalWagered: { value: wagered, provenance: wagered !== null ? "exact" : "unavailable" },
    cashReturned: { value: returned, provenance: returned !== null ? "exact" : "unavailable" },
    netCash: { value: net, provenance: net !== null ? "exact" : "unavailable" },
    outcomeCounts: outcomes,
    games,
    activeDays: activeDaysRows.length,
    bestResult: best
      ? { label: best.activityLabel, net: toNum(best.netValue) ?? 0, occurredAt: Math.floor(best.occurredAt.getTime() / 1000) }
      : null,
    worstResult: null,
    coverage: {
      activities: activityCount,
      trackingSince: oldest ? Math.floor(oldest.occurredAt.getTime() / 1000) : null,
    },
    availability: {
      history: sectionAvailability(availCtx, "timeline_history", "events"),
    },
  };
}
