import {
  resolveDateRange,
  type DateRangeInput,
  type HuntingSummaryResponse,
} from "@tornscope/shared";
import { bigintToNumber, getPrismaClient } from "@tornscope/database";
import { loadAvailabilityContext, sectionAvailability } from "./availability.js";

/**
 * Hunting Analytics (2.5.0) — retrospective sessions, cash and skill over
 * normalized ActivityEvents (domain = hunting). Bounded SQL aggregation,
 * no Torn calls, no MoneyEvent double counting (hunting cash never flows
 * through money logs — this is the only place it is reported; provenance
 * "exact" because every component comes from Torn's own log payload).
 */
export async function getHuntingSummary(userId: string, rangeInput: DateRangeInput): Promise<HuntingSummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const availCtx = await loadAvailabilityContext(userId);
  const fromDate = new Date(range.from * 1000);
  const toDate = new Date(range.to * 1000);

  const sessionWhere = {
    userId,
    domain: "hunting",
    outcome: "completed",
    occurredAt: { gte: fromDate, lte: toDate },
  };

  const [totals, bySessionType, levelUps, firstSkill, latestSkill, skillGainSum, recent, best, hunts, oldest, activeDaysRows] = await Promise.all([
    db.activityEvent.aggregate({
      where: sessionWhere,
      _sum: { cashInput: true, cashReward: true, netValue: true },
    }),
    db.activityEvent.groupBy({
      by: ["subtype"],
      where: sessionWhere,
      _count: { _all: true },
      _sum: { cashInput: true, cashReward: true, netValue: true },
    }),
    db.activityEvent.count({ where: { userId, domain: "hunting", outcome: "progressed" } }),
    // Skill trajectory: first and latest parsed skillLevel, exact total gain.
    db.$queryRawUnsafe<Array<{ skill: number | null }>>(
      `SELECT (metadata->>'skillLevel')::float8 AS skill FROM "ActivityEvent"
       WHERE "userId" = $1 AND domain = 'hunting' AND metadata->>'skillLevel' IS NOT NULL
       ORDER BY "occurredAt" ASC LIMIT 1`,
      userId,
    ),
    db.$queryRawUnsafe<Array<{ skill: number | null }>>(
      `SELECT (metadata->>'skillLevel')::float8 AS skill FROM "ActivityEvent"
       WHERE "userId" = $1 AND domain = 'hunting' AND metadata->>'skillLevel' IS NOT NULL
       ORDER BY "occurredAt" DESC LIMIT 1`,
      userId,
    ),
    db.$queryRawUnsafe<Array<{ gain: number | null }>>(
      `SELECT sum((metadata->>'skillGain')::float8)::float8 AS gain FROM "ActivityEvent"
       WHERE "userId" = $1 AND domain = 'hunting' AND metadata->>'skillGain' IS NOT NULL`,
      userId,
    ),
    db.activityEvent.findMany({
      where: sessionWhere,
      orderBy: { occurredAt: "desc" },
      take: 20,
      select: { occurredAt: true, subtype: true, cashInput: true, cashReward: true, netValue: true, metadata: true },
    }),
    db.activityEvent.findFirst({
      where: sessionWhere,
      orderBy: { netValue: "desc" },
      select: { netValue: true, occurredAt: true },
    }),
    db.activityEvent.count({ where: sessionWhere }),
    db.activityEvent.findFirst({ where: { userId, domain: "hunting" }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    db.$queryRawUnsafe<Array<{ day: string }>>(
      `SELECT DISTINCT date_trunc('day', "occurredAt")::text AS day FROM "ActivityEvent"
       WHERE "userId" = $1 AND domain = 'hunting' AND "occurredAt" BETWEEN $2 AND $3`,
      userId, fromDate, toDate,
    ),
  ]);

  const toNum = (v: bigint | null | undefined): number | null => (v === null || v === undefined ? null : bigintToNumber(v));

  const cashSpent = toNum(totals._sum.cashInput);
  const cashEarned = toNum(totals._sum.cashReward);
  const net = toNum(totals._sum.netValue);
  const first = firstSkill[0]?.skill ?? null;
  const current = latestSkill[0]?.skill ?? null;
  const totalGain = skillGainSum[0]?.gain ?? null;

  return {
    range: { from: range.from, to: range.to },
    hunts,
    levelUps,
    cashEarned,
    cashSpent,
    netCash: { value: net, provenance: net !== null ? "exact" : "unavailable" },
    valuePerHunt: hunts > 0 && net !== null ? net / hunts : null,
    activeDays: activeDaysRows.length,
    bestHunt: best && best.netValue !== null
      ? { net: toNum(best.netValue) ?? 0, occurredAt: Math.floor(best.occurredAt.getTime() / 1000) }
      : null,
    sessionTypes: bySessionType
      .map((s) => ({
        type: s.subtype ?? "unknown",
        hunts: s._count._all,
        cashEarned: toNum(s._sum.cashReward),
        cashSpent: toNum(s._sum.cashInput),
        net: toNum(s._sum.netValue),
      }))
      .sort((a, b) => b.hunts - a.hunts),
    skill: {
      current,
      firstSeen: first,
      totalGain: totalGain !== null ? Math.round(totalGain * 10000) / 10000 : null,
      levelUps,
    },
    recent: recent.map((r) => {
      const meta = (r.metadata ?? {}) as { skillLevel?: number; skillGain?: number };
      return {
        occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
        subtype: r.subtype,
        cashSpent: toNum(r.cashInput),
        cashEarned: toNum(r.cashReward),
        net: toNum(r.netValue),
        skillLevel: typeof meta.skillLevel === "number" ? meta.skillLevel : null,
        skillGain: typeof meta.skillGain === "number" ? meta.skillGain : null,
      };
    }),
    coverage: {
      hunts,
      trackingSince: oldest ? Math.floor(oldest.occurredAt.getTime() / 1000) : null,
    },
    availability: {
      history: sectionAvailability(availCtx, "timeline_history", "events"),
    },
  };
}
