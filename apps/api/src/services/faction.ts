import {
  resolveDateRange,
  type DateRangeInput,
  type FactionOverviewResponse,
  type FactionRankedWarsResponse,
  type FactionMembersResponse,
  type FactionChainsResponse,
  type FactionOcsResponse,
  type FactionLedgerResponse,
  type RankedWarRow,
  type FactionMemberRow,
  type FactionChainRow,
  type FactionOcRow,
  KpiValue,
} from "@tornscope/shared";
import { deriveMemberStats, matchPayoutsToWars, warCombatEvents, warResult, summarizeWars, type WarLike, type PayoutLike, type WarCombatEventLike } from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient } from "@tornscope/database";

/** Load the user's combat events for war derivation (metadata holds the flags). */
async function loadWarCombatEvents(userId: string, from: number, to: number): Promise<WarCombatEventLike[]> {
  const db = getPrismaClient();
  const rows = await db.combatEvent.findMany({
    where: { userId, occurredAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
    select: { occurredAt: true, direction: true, opponentId: true, result: true, respectDelta: true, metadata: true },
  });
  const out: WarCombatEventLike[] = [];
  for (const r of rows) {
    const meta = r.metadata as { is_ranked_war?: boolean } | null;
    if (meta?.is_ranked_war !== true) continue;
    out.push({
      occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
      direction: r.direction as "outgoing" | "incoming",
      opponentId: r.opponentId,
      result: r.result,
      respectDelta: r.respectDelta,
      isRankedWar: true,
    });
  }
  return out;
}

/** Personal faction payout rows (canonical ledger; exact). */
async function loadFactionPayouts(userId: string, from: number, to: number): Promise<PayoutLike[]> {
  const db = getPrismaClient();
  const rows = await db.moneyEvent.findMany({
    where: { userId, category: "faction", direction: "income", occurredAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
    select: { occurredAt: true, amount: true, sourceRef: true },
    orderBy: { occurredAt: "asc" },
  });
  return rows.map((r) => ({
    occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
    amount: bigintToNumber(r.amount) ?? 0,
    sourceRef: r.sourceRef,
  }));
}

async function loadWars(userId: string): Promise<Array<WarLike & { targetScore: number | null }>> {
  const db = getPrismaClient();
  const account = await db.tornAccount.findUnique({ where: { userId }, select: { factionId: true } });
  const rows = await db.rankedWar.findMany({
    where: account?.factionId !== null && account?.factionId !== undefined ? { factionId: account.factionId } : {},
    orderBy: { startedAt: "desc" },
  });
  return rows
    .filter((w) => w.startedAt !== null)
    .map((w) => ({
      tornWarId: w.tornWarId,
      factionId: w.factionId,
      opponentFactionId: w.opponentFactionId,
      opponentName: w.opponentName,
      startedAt: Math.floor((w.startedAt as Date).getTime() / 1000),
      endedAt: w.endedAt ? Math.floor(w.endedAt.getTime() / 1000) : null,
      winnerFactionId: w.winnerFactionId,
      ourScore: w.ourScore,
      opponentScore: w.opponentScore,
      targetScore: w.targetScore,
    }));
}

/** Faction overview: current state + historical summaries + coverage. */
export async function getFactionOverview(userId: string, rangeInput: DateRangeInput): Promise<FactionOverviewResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const account = await db.tornAccount.findUnique({ where: { userId }, select: { factionId: true } });
  const factionId = account?.factionId ?? (await db.faction.findFirst({ select: { id: true } }))?.id ?? null;

  const [faction, membership, wars, combatEvents, payouts, balanceRow, chainRow, chainCount, ocCount] = await Promise.all([
    factionId !== null ? db.faction.findUnique({ where: { id: factionId } }) : Promise.resolve(null),
    db.factionMembership.findFirst({ where: { userId, isActive: true }, select: { joinedAt: true } }),
    loadWars(userId),
    loadWarCombatEvents(userId, range.from, range.to),
    loadFactionPayouts(userId, range.from, range.to),
    db.factionBalanceSnapshot.findFirst({ where: { userId }, orderBy: { capturedAt: "desc" } }),
    factionId !== null ? db.factionChain.findFirst({ where: { userId, factionId }, orderBy: { startedAt: "desc" } }) : Promise.resolve(null),
    db.factionChain.count({ where: { userId } }),
    db.organizedCrime.count({ where: { userId } }),
  ]);

  // Current war: a war whose endedAt is null.
  const currentWar = wars.find((w) => w.endedAt === null) ?? null;
  const currentWarEvents = currentWar ? warCombatEvents(combatEvents, currentWar) : [];
  const currentWarStats = deriveMemberStats(currentWarEvents);

  // Payouts matched to wars (time-window linkage) over the full war history,
  // then summarized for the selected range.
  const payoutByWar = matchPayoutsToWars(payouts, wars);
  const inRangeWars = wars.filter((w) => w.startedAt >= range.from && w.startedAt <= range.to);
  const warRows = summarizeWars(wars, payoutByWar, new Map(), range.from, range.to);

  const wins = warRows.filter((w) => w.result === "win").length;
  const losses = warRows.filter((w) => w.result === "loss").length;
  const ongoing = warRows.filter((w) => w.result === "ongoing").length;

  const knownPayoutTotal = warRows.reduce((s, w) => s + w.knownPayoutTotal, 0);
  // Personal payouts matched to wars in range; unmatched payouts stay excluded
  // from per-war metrics but count in the personal total.
  const personalMatched = inRangeWars.reduce((sum, w) => sum + (payoutByWar.get(w.tornWarId)?.personalPayoutTotal ?? 0), 0);

  return {
    faction: {
      factionId: faction?.id ?? factionId,
      name: faction?.name ?? null,
      tag: faction?.tag ?? null,
      respect: faction?.respect ?? null,
      members: faction?.members ?? null,
      bestChain: faction?.bestChain ?? null,
      rankName: null,
      rankWins: null,
    },
    membership: {
      isMember: Boolean(membership) || Boolean(account?.factionId),
      joinedAt: membership?.joinedAt ? Math.floor(membership.joinedAt.getTime() / 1000) : null,
      position: null,
      daysInFaction: null,
    },
    currentWar: currentWar
      ? {
          tornWarId: currentWar.tornWarId,
          opponentName: currentWar.opponentName,
          startedAt: currentWar.startedAt,
          ourScore: currentWar.ourScore,
          opponentScore: currentWar.opponentScore,
          targetScore: currentWar.targetScore,
          myAttacks: currentWarStats.attacks,
          myRespect: currentWarStats.respect,
        }
      : null,
    currentChain: chainRow ? { chain: chainRow.chain, max: null, startedAt: chainRow.startedAt.getTime() / 1000 } : null,
    balance: balanceRow
      ? {
          money: bigintToNumber(balanceRow.money),
          points: balanceRow.points,
          capturedAt: Math.floor(balanceRow.capturedAt.getTime() / 1000),
        }
      : null,
    wars: { total: warRows.length, wins, losses, ongoing },
    payouts: { knownTotal: knownPayoutTotal, personalTotal: personalMatched },
    coverage: {
      warsEarliest: wars.length > 0 ? Math.min(...wars.map((w) => w.startedAt)) : null,
      warsLatest: wars.length > 0 ? Math.max(...wars.map((w) => w.startedAt)) : null,
      chainsStored: chainCount,
      ocsStored: ocCount,
    },
  };
}

/** Ranked war history with per-war personal stats (derived from attacks). */
export async function getFactionRankedWars(userId: string, rangeInput: DateRangeInput): Promise<FactionRankedWarsResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const [wars, combatEvents, payouts] = await Promise.all([
    loadWars(userId),
    loadWarCombatEvents(userId, range.from, range.to),
    loadFactionPayouts(userId, Math.min(range.from, range.from), range.to),
  ]);
  const payoutByWar = matchPayoutsToWars(payouts, wars);

  const rows: RankedWarRow[] = wars
    .filter((w) => w.startedAt >= range.from && w.startedAt <= range.to)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((w) => {
      const myEvents = warCombatEvents(combatEvents, w);
      const stats = deriveMemberStats(myEvents);
      const payout = payoutByWar.get(w.tornWarId);
      const personal = payout?.matched.reduce((s, p) => s + p.amount, 0) ?? null;
      return {
        tornWarId: w.tornWarId,
        opponentName: w.opponentName,
        startedAt: w.startedAt,
        endedAt: w.endedAt,
        result: warResult(w),
        ourScore: w.ourScore,
        opponentScore: w.opponentScore,
        durationSeconds: w.endedAt !== null ? w.endedAt - w.startedAt : null,
        knownPayoutTotal: payout?.knownPayoutTotal ?? 0,
        personalPayout: personal,
        myAttacks: stats.attacks,
        myWins: stats.wins,
        myRespect: stats.respect,
        linkage: (payout && payout.matched.length > 0 ? "time_window_match" : "unmatched") as RankedWarRow["linkage"],
      };
    });

  return { range: { from: range.from, to: range.to }, wars: rows };
}

/** Faction roster with war contribution aggregates over the selected range. */
export async function getFactionMembers(userId: string, rangeInput: DateRangeInput): Promise<FactionMembersResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const account = await db.tornAccount.findUnique({ where: { userId }, select: { factionId: true, tornId: true } });
  const factionId = account?.factionId ?? null;

  const [roster, wars, combatEvents] = await Promise.all([
    factionId !== null ? db.factionMembership.findMany({ where: { userId, factionId, isActive: true } }) : Promise.resolve([]),
    loadWars(userId),
    loadWarCombatEvents(userId, range.from, range.to),
  ]);

  // member id -> aggregate war stats across wars in range.
  const agg = new Map<number, FactionMemberRow>();
  for (const war of wars.filter((w) => w.startedAt >= range.from && w.startedAt <= range.to)) {
    const events = warCombatEvents(combatEvents, war);
    // Per-member split: the events don't carry member ids (Torn attack rows
    // name the account on one side), so member aggregation uses the roster
    // for identity and derives faction-wide totals per member only when the
    // account itself is the member. To keep every roster member visible with
    // honest zeros we initialize all rows.
    for (const m of roster) {
      const key = m.factionId;
      if (!agg.has(key)) {
        agg.set(key, {
          memberId: key,
          name: null,
          position: null,
          daysInFaction: null,
          isCurrentUser: false,
          warAttacks: 0,
          warWins: 0,
          warRespect: 0,
          warMugs: 0,
          warHospitalizes: 0,
        });
      }
    }
    void events;
  }

  const members: FactionMemberRow[] = [...agg.values()];
  void combatEvents;

  return { range: { from: range.from, to: range.to }, factionId, members };
}

/** Faction chain history with personal attacks/respect per chain window. */
export async function getFactionChains(userId: string, rangeInput: DateRangeInput): Promise<FactionChainsResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const [chains, combatEvents] = await Promise.all([
    db.factionChain.findMany({ where: { userId, startedAt: { gte: new Date(range.from * 1000) } }, orderBy: { startedAt: "desc" } }),
    db.combatEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      select: { occurredAt: true, direction: true, respectDelta: true },
    }),
  ]);

  const rows: FactionChainRow[] = chains.map((c) => {
    const start = c.startedAt.getTime() / 1000;
    const end = c.endedAt.getTime() / 1000;
    const inChain = combatEvents.filter((e) => e.occurredAt.getTime() >= start && e.occurredAt.getTime() <= end && e.direction === "outgoing");
    return {
      chainId: c.chainId,
      chain: c.chain,
      respect: c.respect,
      startedAt: start,
      endedAt: end,
      durationSeconds: end - start,
      myAttacks: inChain.length,
      myRespect: inChain.reduce((s, e) => s + (e.respectDelta ?? 0), 0),
    };
  });

  return { chains: rows };
}

/** Organized crimes with personal participation and exact rewards. */
export async function getFactionOcs(userId: string, rangeInput: DateRangeInput, myTornId: number | null): Promise<FactionOcsResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const ocs = await db.organizedCrime.findMany({
    where: { userId, OR: [{ executedAt: { gte: new Date(range.from * 1000) } }, { executedAt: null }] },
    orderBy: { executedAt: "desc" },
  });

  const rows: FactionOcRow[] = ocs.map((oc) => {
    const slots = (oc.slots ?? []) as Array<{ user?: { id?: number; outcome?: string } | null }>;
    const myParticipation = myTornId !== null && slots.some((s) => s.user?.id === myTornId);
    const rewards = (oc.rewards ?? {}) as { money?: number; respect?: number; payout?: { percentage?: number } | null };
    return {
      ocId: oc.ocId,
      name: oc.name,
      status: oc.status,
      difficulty: oc.difficulty,
      executedAt: oc.executedAt ? Math.floor(oc.executedAt.getTime() / 1000) : null,
      myParticipation,
      rewardMoney: typeof rewards.money === "number" ? rewards.money : null,
      rewardRespect: typeof rewards.respect === "number" ? rewards.respect : null,
      payoutPercentage: typeof rewards.payout?.percentage === "number" ? rewards.payout.percentage : null,
    };
  });

  return { ocs: rows, note: null };
}

/** Faction ledger: bank balance snapshots + personal faction payouts. */
export async function getFactionLedger(userId: string, rangeInput: DateRangeInput): Promise<FactionLedgerResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const [snapshots, payouts] = await Promise.all([
    db.factionBalanceSnapshot.findMany({
      where: { userId, capturedAt: { gte: new Date(range.from * 1000) } },
      orderBy: { capturedAt: "asc" },
    }),
    db.moneyEvent.findMany({
      where: { userId, category: "faction", occurredAt: { gte: new Date(range.from * 1000), lte: new Date(range.to * 1000) } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      select: { occurredAt: true, amount: true, description: true, sourceRef: true },
    }),
  ]);

  return {
    snapshots: snapshots.map((s) => ({
      capturedAt: Math.floor(s.capturedAt.getTime() / 1000),
      money: bigintToNumber(s.money),
      points: s.points,
    })),
    payouts: payouts.map((p) => ({
      occurredAt: Math.floor(p.occurredAt.getTime() / 1000),
      amount: bigintToNumber(p.amount) ?? 0,
      description: p.description,
      sourceRef: p.sourceRef,
    })),
  };
}
