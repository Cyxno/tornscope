import {
  resolveDateRange,
  type CasinoSummaryResponse,
  type DateRangeInput,
} from "@tornscope/shared";
import { bigintToNumber, getPrismaClient } from "@tornscope/database";
import { loadAvailabilityContext, sectionAvailability } from "./availability.js";
import { aggregateCasinoEconomics, aggregateCasinoPerGame } from "@tornscope/database";
import { loadCasinoRows } from "./casino-economics.js";

/**
 * Casino Analytics (2.5.1) — retrospective P/L over normalized
 * ActivityEvents (domain = casino) using LOGICAL-PLAY economics: stakes are
 * owned by placement/start rows (never double-counted by settlements that
 * repeat the stake), withdrawals are balance movements (never winnings),
 * pending placements are never losses. See casino-economics.ts.
 *
 * Bounded SQL aggregation; event lists cursor-paginated; no Torn calls; no
 * double counting with MoneyEvent (differences disclosed via the
 * reconciliation).
 */

const toNum = (v: bigint | null | undefined): number | null => (v === null || v === undefined ? null : bigintToNumber(v));

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

  const [rows, gameMeta, byOutcome, best, worst, oldest, activeDaysRows] = await Promise.all([
    loadCasinoRows(db, userId, fromDate, toDate),
    db.activityEvent.groupBy({
      by: ["activityType", "activityLabel"],
      where,
      _count: { _all: true },
      _max: { occurredAt: true },
    }),
    db.activityEvent.groupBy({
      by: ["outcome"],
      where,
      _count: { _all: true },
    }),
    db.activityEvent.findFirst({
      where: { ...where, netValue: { not: null } },
      orderBy: { netValue: "desc" },
      select: { netValue: true, activityLabel: true, occurredAt: true },
    }),
    // Deterministic worst result — the actual row with the lowest net, not a
    // detached aggregate minimum.
    db.activityEvent.findFirst({
      where: { ...where, netValue: { not: null } },
      orderBy: { netValue: "asc" },
      select: { netValue: true, activityLabel: true, occurredAt: true },
    }),
    db.activityEvent.findFirst({ where: { userId, domain: "casino" }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    db.$queryRawUnsafe<Array<{ day: string }>>(
      `SELECT DISTINCT date_trunc('day', "occurredAt")::text AS day FROM "ActivityEvent"
       WHERE "userId" = $1 AND domain = 'casino' AND "occurredAt" BETWEEN $2 AND $3`,
      userId, fromDate, toDate,
    ),
  ]);

  const totals = aggregateCasinoEconomics(rows);
  const perGame = aggregateCasinoPerGame(rows);
  const metaByType = new Map(gameMeta.map((g) => [g.activityType, g]));

  const games = gameMeta
    .map((g) => {
      const eco = perGame.get(g.activityType)!;
      const stakeOwned = eco.wagered > 0n || eco.returned > 0n;
      return {
        game: g.activityType,
        label: g.activityLabel,
        // Event rows, not logical plays — multi-event games (placement +
        // settlement) have more rows than plays (labelled accordingly in UI).
        plays: g._count._all,
        wagered: toNum(eco.wagered) ?? (stakeOwned ? 0 : null),
        cashWon: toNum(eco.returned) ?? (stakeOwned ? 0 : null),
        net: toNum(eco.net),
        lastPlayedAt: g._max.occurredAt ? Math.floor(g._max.occurredAt.getTime() / 1000) : null,
      };
    })
    .sort((a, b) => (b.net ?? 0) - (a.net ?? 0));

  const outcomes: Record<string, number> = {};
  for (const o of byOutcome) outcomes[o.outcome ?? "unknown"] = o._count._all;

  const result = (row: { netValue: bigint | null; activityLabel: string; occurredAt: Date } | null) =>
    row && row.netValue !== null
      ? { label: row.activityLabel, net: toNum(row.netValue) ?? 0, occurredAt: Math.floor(row.occurredAt.getTime() / 1000) }
      : null;

  return {
    range: { from: range.from, to: range.to },
    activities: rows.length,
    totalWagered: { value: totals.wagered === 0n && !totals.hasCash ? null : toNum(totals.wagered), provenance: totals.hasCash ? "exact" : "unavailable" },
    cashReturned: { value: totals.returned === 0n && !totals.hasCash ? null : toNum(totals.returned), provenance: totals.hasCash ? "exact" : "unavailable" },
    netCash: { value: toNum(totals.net), provenance: totals.net !== null ? "exact" : totals.hasCash ? "exact" : "unavailable" },
    outcomeCounts: outcomes,
    games,
    activeDays: activeDaysRows.length,
    bestResult: result(best),
    worstResult: result(worst),
    // Balance movements excluded from game economics (bookie withdrawals).
    withdrawn: toNum(totals.withdrawn),
    // Stakes placed with no settlement semantics yet — activity, never a loss.
    pendingActivities: totals.pending,
    coverage: {
      activities: rows.length,
      trackingSince: oldest ? Math.floor(oldest.occurredAt.getTime() / 1000) : null,
    },
    availability: {
      history: sectionAvailability(availCtx, "timeline_history", "events"),
    },
  };
}
