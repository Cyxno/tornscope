import { buildCrimeSkillProgression, mergeCrimeSkillSnapshot } from "@tornscope/analytics";
import { resolveDateRange, type CrimesSummaryResponse, type CrimesTimelineResponse, type CombatSummaryResponse, type CombatTimelineResponse, type KpiValue, type DateRangeInput, type Paginated, type CrimeEventDto, type CombatEventDto } from "@tornscope/shared";
import { aggregateCrimeStats, aggregateCombatStats } from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, loadItemNameMap, loadMarketPrices, parseRewardComponents, priceRewardComponent } from "@tornscope/database";
import { cursorWhere, encodeCursor } from "../cursor.js";
import { loadAvailabilityContext, sectionAvailability } from "./availability.js";

/** Crimes analytics over normalized CrimeEvents (rebuilt from raw logs). */
export async function getCrimesSummary(userId: string, rangeInput: DateRangeInput): Promise<CrimesSummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  // Crime skill progression (2.6.0): the "Crime skill level up/down" logs are
  // progression bookkeeping (timeline-only by design). Their payloads carry
  // the exact per-crime skill level — enough for level/delta/trend without a
  // new table. Bounded read.
  const skillRows = await db.$queryRawUnsafe<Array<{ occurredAt: Date; title: string; crime: string; skill_level: number }>>(
    'SELECT te."occurredAt", te."title", (te."metadata"->\'data\'->>\'crime\') AS crime, (te."metadata"->\'data\'->>\'skill_level\')::int AS skill_level FROM "TimelineEvent" te WHERE te."userId" = $1 AND te."type" = \'log\' AND te."category" = \'Crimes\' AND te."title" IN (\'Crime skill level up\', \'Crime skill level down\') AND te."occurredAt" >= $2 AND te."occurredAt" <= $3 ORDER BY te."occurredAt" ASC LIMIT 20000',
    userId, new Date(range.from * 1000), new Date(range.to * 1000)
  );
  // Crime-skill authority from the personalstats snapshot (2.8.0): the latest
  // snapshot's crimes.skills map carries Torn's own exact per-crime level —
  // including crimes whose skill never produced a level-change log here.
  // One bounded query; raw snapshot untouched, log-derived levels never
  // overwritten (the snapshot rides in snapshotLevel).
  const latestSkillSnapshot = await db.personalStatSnapshot.findFirst({
    where: { userId },
    orderBy: { capturedAt: "desc" },
    select: { stats: true },
  });
  const snapshotSkillMap = (latestSkillSnapshot?.stats as { crimes?: { skills?: Record<string, unknown> } } | null)?.crimes?.skills ?? null;
  const skillProgression = mergeCrimeSkillSnapshot(
    buildCrimeSkillProgression(
      skillRows.map((r) => ({
        t: Math.floor(r.occurredAt.getTime() / 1000),
        crime: String(r.crime ?? "unknown"),
        level: r.skill_level,
        direction: (/down/i.test(r.title) ? "down" : "up") as "down" | "up",
      }))
    ),
    snapshotSkillMap
  );
  const rows = await db.crimeEvent.findMany({
    where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
    orderBy: { occurredAt: "asc" },
    select: { occurredAt: true, crimeName: true, success: true, nerveUsed: true, moneyDelta: true, itemsValue: true, jailSeconds: true },
  });
  const stats = aggregateCrimeStats(
    rows.map((r) => ({
      occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
      crimeName: r.crimeName,
      success: r.success,
      nerveUsed: r.nerveUsed,
      moneyDelta: bigintToNumber(r.moneyDelta),
      itemsValue: bigintToNumber(r.itemsValue),
      jailSeconds: r.jailSeconds,
    })),
    range.from,
    range.to
  );

  const [earliest, latest] = await Promise.all([
    db.crimeEvent.findFirst({ where: { userId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    db.crimeEvent.findFirst({ where: { userId }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true } }),
  ]);
  const availCtx = await loadAvailabilityContext(userId);

  return {
    range: { from: range.from, to: range.to },
    availability: { history: sectionAvailability(availCtx, "crimes_history", "money_logs") },
    attempts: stats.attempts,
    successful: stats.successful,
    failed: stats.failed,
    successRate: stats.successRate,
    moneyGained: stats.moneyGained,
    moneyLost: stats.moneyLost,
    netCrimeCash: stats.netCrimeCash,
    estimatedItemsValue: stats.estimatedItemsValue,
    totalEstimatedValue: stats.totalEstimatedValue,
    nerveUsed: stats.nerveUsed,
    valuePerNerve: stats.valuePerNerve,
    jailedCount: stats.jailedCount,
    totalJailSeconds: stats.totalJailSeconds,
    crimesPerDay: stats.crimesPerDay,
    byCrime: stats.byCrime,
    dailySeries: stats.dailySeries,
    skillProgression,
    coverage: {
      trackingSince: earliest ? Math.floor(earliest.occurredAt.getTime() / 1000) : null,
      earliestStored: earliest ? Math.floor(earliest.occurredAt.getTime() / 1000) : null,
      latestStored: latest ? Math.floor(latest.occurredAt.getTime() / 1000) : null,
    },
  };
}

export async function getCrimesTimeline(userId: string, rangeInput: DateRangeInput, limit: number, cursor?: string): Promise<CrimesTimelineResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const rows = await db.crimeEvent.findMany({
    where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) }, ...cursorWhere(cursor) },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit,
    select: { id: true, occurredAt: true, crimeName: true, crimeCategory: true, success: true, nerveUsed: true, moneyDelta: true, itemsValue: true, jailSeconds: true, metadata: true },
  });

  // Non-cash reward components (2.7.0): parsed from the raw payload the
  // CrimeEvent already archives (metadata.data), priced from the CURRENT
  // catalog — never mixed into the exact cash columns, never zeroed when
  // unpriced.
  const [itemNameById, marketPriceById] = await Promise.all([loadItemNameMap(db), loadMarketPrices(db)]);

  const items: CrimeEventDto[] = rows.map((r) => {
    const data = (r.metadata as { data?: Record<string, unknown> } | null)?.data ?? null;
    const parsed = data ? parseRewardComponents(data) : { components: [], malformed: 0 };
    return {
      id: r.id,
      occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
      crimeName: r.crimeName,
      crimeCategory: r.crimeCategory,
      success: r.success,
      nerveUsed: r.nerveUsed,
      moneyDelta: bigintToNumber(r.moneyDelta),
      itemsValue: bigintToNumber(r.itemsValue),
      jailSeconds: r.jailSeconds,
      otherRewards: parsed.components.map((c) => priceRewardComponent(c, itemNameById, marketPriceById)),
    };
  });
  const last = rows[rows.length - 1];
  return {
    range: { from: range.from, to: range.to },
    items,
    nextCursor: rows.length < limit || !last ? null : encodeCursor({ occurredAt: Math.floor(last.occurredAt.getTime() / 1000), id: last.id }),
  } satisfies Paginated<CrimeEventDto> & CrimesTimelineResponse;
}

/** Combat analytics over normalized CombatEvents (/v2/user/attacks). */
export async function getCombatSummary(userId: string, rangeInput: DateRangeInput): Promise<CombatSummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const rows = await db.combatEvent.findMany({
    where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
    orderBy: { occurredAt: "asc" },
    select: { occurredAt: true, direction: true, opponentId: true, opponentName: true, result: true, respectDelta: true },
  });
  const stats = aggregateCombatStats(
    rows.map((r) => ({
      occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
      direction: r.direction as "outgoing" | "incoming",
      opponentId: r.opponentId,
      opponentName: r.opponentName,
      result: r.result,
      respectDelta: r.respectDelta,
    })),
    range.from,
    range.to
  );

  // Mug cash is canonical in MoneyEvent (category mugging) from mug logs.
  const [mugRows, earliest, latest] = await Promise.all([
    db.moneyEvent.groupBy({
      by: ["direction"],
      where: { userId, category: "mugging", occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      _sum: { amount: true },
    }),
    db.combatEvent.findFirst({ where: { userId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    db.combatEvent.findFirst({ where: { userId }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true } }),
  ]);
  const muggedGain = Number(mugRows.find((r) => r.direction === "income")?._sum.amount ?? 0n);
  const muggedLoss = -Number(mugRows.find((r) => r.direction === "expense")?._sum.amount ?? 0n);
  const mug: (v: number) => KpiValue = (v) => ({ value: v, provenance: "exact", availability: mugRows.length > 0 ? "ok" : "unavailable" });
  const availCtx = await loadAvailabilityContext(userId);

  return {
    range: { from: range.from, to: range.to },
    availability: { history: sectionAvailability(availCtx, "combat_history", "attacks") },
    attacksMade: stats.attacksMade,
    attacksReceived: stats.attacksReceived,
    wins: stats.wins,
    losses: stats.losses,
    winRate: stats.winRate,
    outgoingWins: stats.outgoingWins,
    outgoingLosses: stats.outgoingLosses,
    incomingDefended: stats.incomingDefended,
    incomingLost: stats.incomingLost,
    mugsMade: stats.mugsMade,
    mugsReceived: stats.mugsReceived,
    moneyMugged: mug(muggedGain),
    moneyLostToMugs: mug(muggedLoss),
    hospitalizationsCaused: stats.hospitalizationsCaused,
    hospitalizationsReceived: stats.hospitalizationsReceived,
    respectGained: stats.respectGained,
    respectLost: stats.respectLost,
    byOpponent: stats.byOpponent,
    dailySeries: stats.dailySeries,
    coverage: {
      trackingSince: earliest ? Math.floor(earliest.occurredAt.getTime() / 1000) : null,
      earliestStored: earliest ? Math.floor(earliest.occurredAt.getTime() / 1000) : null,
      latestStored: latest ? Math.floor(latest.occurredAt.getTime() / 1000) : null,
    },
  };
}

export async function getCombatTimeline(userId: string, rangeInput: DateRangeInput, limit: number, cursor?: string): Promise<CombatTimelineResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const rows = await db.combatEvent.findMany({
    where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) }, ...cursorWhere(cursor) },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit,
    select: { id: true, occurredAt: true, direction: true, opponentName: true, result: true, respectDelta: true },
  });
  const items: CombatEventDto[] = rows.map((r) => ({
    id: r.id,
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    direction: r.direction as CombatEventDto["direction"],
    opponentName: r.opponentName,
    result: r.result,
    respectDelta: r.respectDelta,
  }));
  const last = rows[rows.length - 1];
  return {
    range: { from: range.from, to: range.to },
    items,
    nextCursor: rows.length < limit || !last ? null : encodeCursor({ occurredAt: Math.floor(last.occurredAt.getTime() / 1000), id: last.id }),
  } satisfies Paginated<CombatEventDto> & CombatTimelineResponse;
}
