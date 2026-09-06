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
  type FactionOcParticipant,
  type FactionWarMemberRow,
  KpiValue,
} from "@tornscope/shared";
import { deriveMemberStats, matchPayout, matchOcPayout, warCombatEvents, summarizeWars, warResult, type WarLike, type PayoutCandidateInput, type WarCombatEventLike, type PayoutMatch } from "@tornscope/analytics";
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
/** Load ALL faction income payouts with their raw metadata (scenario etc.). */
async function loadFactionPayouts(userId: number | string, from: number, to: number): Promise<Array<PayoutCandidateInput & { scenario: string | null; description: string | null }>> {
  const db = getPrismaClient();
  const rows = await db.moneyEvent.findMany({
    where: { userId: String(userId), category: "faction", direction: "income", occurredAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
    select: { occurredAt: true, amount: true, sourceRef: true, metadata: true, description: true },
    orderBy: { occurredAt: "asc" },
  });
  return rows.map((r) => {
    const meta = (r.metadata ?? {}) as { data?: { scenario?: string } };
    return {
      occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
      amount: bigintToNumber(r.amount) ?? 0,
      sourceRef: r.sourceRef,
      scenario: meta.data?.scenario ?? null,
      description: r.description,
    };
  });
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

  // Payouts matched conservatively per payout (settlement window from env).
  const settlementDays = Number(process.env.RANKED_WAR_PAYOUT_SETTLEMENT_DAYS ?? 7);
  const completedWars = wars.filter((w) => w.endedAt !== null);
  const matches = payouts.map((p) => ({ payout: p, match: matchPayout(p, completedWars, { settlementDays }) }));
  const warPayoutTotals = new Map<number, number>();
  for (const { match, payout } of matches) {
    if (match.matchedWarId !== null && ["exact", "strong", "time_window"].includes(match.matchType)) {
      warPayoutTotals.set(match.matchedWarId, (warPayoutTotals.get(match.matchedWarId) ?? 0) + payout.amount);
    }
  }
  const warRows = summarizeWars(wars, warPayoutTotals, new Map(), range.from, range.to);

  const wins = warRows.filter((w) => w.result === "win").length;
  const losses = warRows.filter((w) => w.result === "loss").length;
  const ongoing = warRows.filter((w) => w.result === "ongoing").length;

  const knownPayoutTotal = warRows.reduce((s, w) => s + w.knownPayoutTotal, 0);
  const personalMatched = matches.reduce((sum, { match, payout }) => {
    if (!["exact", "strong", "time_window"].includes(match.matchType) || match.matchedWarId === null) return sum;
    const war = wars.find((w) => w.tornWarId === match.matchedWarId);
    return war !== undefined && war.startedAt >= range.from && war.startedAt <= range.to ? sum + payout.amount : sum;
  }, 0);

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
  const settlementDays = Number(process.env.RANKED_WAR_PAYOUT_SETTLEMENT_DAYS ?? 7);
  const completedWars = wars.filter((w) => w.endedAt !== null);
  const rows: RankedWarRow[] = wars
    .filter((w) => w.startedAt >= range.from && w.startedAt <= range.to)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((w) => {
      const myEvents = warCombatEvents(combatEvents, w);
      const stats = deriveMemberStats(myEvents);
      // Match payouts for THIS war: candidate = faction income (no OC scenario)
      // within this war's settlement window. Known payout total = sum matched.
      let knownPayoutTotal = 0;
      let personal = 0;
      let linkage: RankedWarRow["linkage"] = "unmatched";
      for (const p of payouts) {
        if (p.scenario) continue;
        const m = matchPayout(p, completedWars, { settlementDays });
        if (m.matchedWarId !== w.tornWarId || !["exact", "strong", "time_window"].includes(m.matchType)) continue;
        knownPayoutTotal += p.amount;
        if (personal === 0) personal = p.amount;
        if (m.matchType !== "unmatched") linkage = m.matchType as RankedWarRow["linkage"];
      }
      return {
        tornWarId: w.tornWarId,
        opponentName: w.opponentName,
        startedAt: w.startedAt,
        endedAt: w.endedAt,
        result: warResult(w),
        ourScore: w.ourScore,
        opponentScore: w.opponentScore,
        durationSeconds: w.endedAt !== null ? w.endedAt - w.startedAt : null,
        knownPayoutTotal,
        personalPayout: personal,
        myAttacks: stats.attacks,
        myWins: stats.wins,
        myRespect: stats.respect,
        linkage,
        matchConfidence: null,
        matchReason: null,
        reconciliationStatus: knownPayoutTotal > 0 ? "partial" : "unavailable",
        statProvenance: myEvents.length > 0 ? "derived_from_attacks" : "unavailable",
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
  const account = await db.tornAccount.findUnique({ where: { userId }, select: { tornId: true } });
  const resolved = myTornId ?? account?.tornId ?? null;
  const ownerName = (await db.tornAccount.findUnique({ where: { userId }, select: { name: true } }))?.name ?? null;
  // Known member names from the faction member table (id -> member id key).
  const memberNames = new Map<number, string>();
  const factionId = (await db.tornAccount.findUnique({ where: { userId }, select: { factionId: true } }))?.factionId ?? null;
  if (factionId !== null) {
    const memberships = await db.factionMembership.findMany({ where: { userId, factionId, isActive: true }, select: { id: true, sourceRef: true } });
    const factionRow = await db.faction.findUnique({ where: { id: factionId }, select: { id: true } });
    void factionRow;
    // member ids are faction-internal ids; the roster name resolution comes
    // from the OC payload itself when available — names for unknown members
    // stay null and the UI shows "Unknown member".
    void memberships;
  }
  const ocs = await db.organizedCrime.findMany({
    where: { userId, OR: [{ executedAt: { gte: new Date(range.from * 1000) } }, { executedAt: null }] },
    orderBy: { executedAt: "desc" },
  });

  const rows: FactionOcRow[] = ocs.map((oc) => {
    const slots = (oc.slots ?? []) as Array<{ position?: string; user?: { id?: number; outcome?: string; progress?: number } | null; checkpoint_pass_rate?: number }>;
    const myParticipation = resolved !== null && slots.some((s) => s.user?.id === resolved);
    const rewards = (oc.rewards ?? {}) as { money?: number; respect?: number; items?: Array<{ id?: number; quantity?: number }>; payout?: { type?: string; percentage?: number; paid_by?: number; paid_at?: number } | null };
    const participants: FactionOcParticipant[] = slots.map((slot) => {
      const user = slot.user ?? null;
      const userId = typeof user?.id === "number" ? user.id : null;
      // memberName stays null: the OC payload has ids only; names come from
      // /faction/members (current roster) — historical members without a
      // current membership show as id-only rows, never fabricated names.
      return {
        memberId: userId,
        memberName: null,
        position: slot.position ?? null,
        outcome: typeof user?.outcome === "string" ? user.outcome : null,
        progress: typeof user?.progress === "number" ? Math.round(user.progress) : null,
        checkpointPassRate: typeof slot.checkpoint_pass_rate === "number" ? Math.round(slot.checkpoint_pass_rate) : null,
        isOwner: userId !== null && resolved !== null && userId === resolved,
      };
    });
    const items = Array.isArray(rewards.items) ? rewards.items.map((it) => ({ id: Number(it.id ?? 0), quantity: Number(it.quantity ?? 1) })) : null;
    return {
      ocId: oc.ocId,
      name: oc.name,
      status: oc.status,
      difficulty: oc.difficulty,
      executedAt: oc.executedAt ? Math.floor(oc.executedAt.getTime() / 1000) : null,
      myParticipation,
      rewardMoney: typeof rewards.money === "number" ? rewards.money : null,
      rewardRespect: typeof rewards.respect === "number" ? rewards.respect : null,
      rewardItems: items,
      payoutPercentage: typeof rewards.payout?.percentage === "number" ? rewards.payout.percentage : null,
      paidBy: typeof rewards.payout?.paid_by === "number" ? rewards.payout.paid_by : null,
      paidAt: typeof rewards.payout?.paid_at === "number" ? Math.floor(rewards.payout.paid_at / 1000) : null,
      payoutType: typeof rewards.payout?.type === "string" ? rewards.payout.type : null,
      participants,
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
