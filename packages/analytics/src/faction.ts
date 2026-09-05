/**
 * Faction + ranked war analytics (pure, testable).
 *
 * Data sources and provenance:
 * - RankedWar rows come from /v2/faction/rankedwars (exact scores, winner).
 *   Torn does NOT expose war rewards in this endpoint — reward metrics are
 *   only produced from MoneyEvents (payouts, exact) and are marked
 *   partial/unavailable when reconciliation is incomplete.
 * - Member war stats are DERIVED from CombatEvents with the ranked-war flag
 *   inside a war's exact time interval (derived-from-attacks provenance).
 * - Personal payouts come from the user's own MoneyEvent (category faction,
 *   income) matched to a war by time window (time_window_match linkage).
 */

export interface WarLike {
  tornWarId: number;
  factionId: number;
  opponentFactionId: number | null;
  opponentName: string | null;
  startedAt: number;
  endedAt: number | null;
  winnerFactionId: number | null;
  ourScore: number | null;
  opponentScore: number | null;
}

export interface WarCombatEventLike {
  occurredAt: number;
  direction: "outgoing" | "incoming";
  opponentId: number | null;
  result: string;
  respectDelta: number | null;
  isRankedWar: boolean;
}

export interface PayoutLike {
  occurredAt: number;
  amount: number;
  sourceRef: string;
}

export type PayoutLinkage = "time_window_match" | "unmatched";

export interface WarPayoutSummary {
  /** Payouts inside the war window or its settlement tail. */
  matched: Array<PayoutLike & { linkage: PayoutLinkage }>;
  knownPayoutTotal: number;
  personalPayoutTotal: number | null;
}

/** Result of a war from Torn's canonical winner field. */
export function warResult(war: WarLike): "win" | "loss" | "ongoing" | "draw" {
  if (war.endedAt === null) return "ongoing";
  if (war.winnerFactionId === null) return "draw";
  return war.winnerFactionId === war.factionId ? "win" : "loss";
}

/** Ranked-war attacks (derived) inside a war's exact time interval. */
export function warCombatEvents(events: readonly WarCombatEventLike[], war: WarLike): WarCombatEventLike[] {
  if (war.startedAt === null) return [];
  const end = war.endedAt ?? Number.MAX_SAFE_INTEGER;
  return events.filter(
    (e) => e.isRankedWar && e.direction === "outgoing" && e.occurredAt >= war.startedAt && e.occurredAt <= end
  );
}

export interface WarMemberStats {
  attacks: number;
  wins: number;
  losses: number;
  mugs: number;
  hospitalizes: number;
  respect: number;
}

const WIN_RESULTS = new Set(["Attacked", "Mugged", "Hospitalized", "Arrested", "Special"]);

/** Derive member war stats from ranked-war combat events (documented derived provenance). */
export function deriveMemberStats(events: readonly WarCombatEventLike[]): WarMemberStats {
  let attacks = 0;
  let wins = 0;
  let losses = 0;
  let mugs = 0;
  let hospitalizes = 0;
  let respect = 0;
  for (const e of events) {
    attacks += 1;
    if (WIN_RESULTS.has(e.result)) wins += 1;
    if (e.result === "Lost" || e.result === "Defended") losses += 1;
    if (e.result === "Mugged") mugs += 1;
    if (e.result === "Hospitalized") hospitalizes += 1;
    respect += e.respectDelta ?? 0;
  }
  return { attacks, wins, losses, mugs, hospitalizes, respect };
}

/**
 * Payout matching: faction payouts arrive in the personal ledger typically
 * right after the war ends. A payout links to a war by falling inside
 * [war.start, war.end + PAYOUT_TAIL_DAYS] — explicitly time-window linkage,
 * never exact. Payouts outside every war window stay unmatched.
 */
export const PAYOUT_TAIL_DAYS = 7;

export function matchPayoutsToWars(payouts: readonly PayoutLike[], wars: readonly WarLike[]): Map<number, WarPayoutSummary> {
  const result = new Map<number, WarPayoutSummary>();
  for (const war of wars) {
    result.set(war.tornWarId, { matched: [], knownPayoutTotal: 0, personalPayoutTotal: null });
  }
  for (const p of payouts) {
    let matchedWar: WarLike | null = null;
    for (const war of wars) {
      if (war.endedAt === null) continue;
      const tailEnd = war.endedAt + PAYOUT_TAIL_DAYS * 86_400;
      if (p.occurredAt >= war.startedAt && p.occurredAt <= tailEnd) {
        // Link to the most recently ended war within the tail (payouts follow
        // the war's end).
        if (matchedWar === null || (matchedWar.endedAt ?? 0) < (war.endedAt ?? 0)) matchedWar = war;
      }
    }
    if (matchedWar) {
      const summary = result.get(matchedWar.tornWarId)!;
      summary.matched.push({ ...p, linkage: "time_window_match" });
      summary.knownPayoutTotal += p.amount;
    }
  }
  return result;
}

export interface WarProfitability {
  grossCashReward: number | null;
  knownPayoutTotal: number;
  retainedCash: number | null;
  reconciliation: "partial" | "unavailable";
  personalPayout: number | null;
  payoutRatio: number | null;
}

/**
 * War profitability from payout reconciliation. Torn's ranked-war endpoint
 * does not expose the faction reward, so gross reward and retained cash are
 * marked partial/unavailable rather than invented.
 */
export function warProfitability(war: WarLike, payoutSummary: WarPayoutSummary, personalPayout: number | null = null): WarProfitability {
  const knownPayoutTotal = payoutSummary.knownPayoutTotal;
  return {
    grossCashReward: null, // not exposed by Torn's rankedwars endpoint
    knownPayoutTotal,
    retainedCash: null, // faction reward unavailable → retained cannot be exact
    reconciliation: knownPayoutTotal > 0 ? "partial" : "unavailable",
    personalPayout,
    payoutRatio: null,
  };
}

export interface WarSummaryRow extends WarLike {
  result: "win" | "loss" | "ongoing" | "draw";
  durationSeconds: number | null;
  knownPayoutTotal: number;
  personalPayout: number | null;
}

/** Summarize wars for a table over a selected range. */
export function summarizeWars(
  wars: readonly WarLike[],
  payoutByWar: Map<number, WarPayoutSummary>,
  personalPayoutByWar: Map<number, number>,
  from: number,
  to: number
): WarSummaryRow[] {
  return wars
    .filter((w) => w.startedAt >= from && w.startedAt <= to)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((w) => {
      const payout = payoutByWar.get(w.tornWarId);
      return {
        ...w,
        result: warResult(w),
        durationSeconds: w.endedAt !== null ? w.endedAt - w.startedAt : null,
        knownPayoutTotal: payout?.knownPayoutTotal ?? 0,
        personalPayout: personalPayoutByWar.get(w.tornWarId) ?? null,
      };
    });
}

/** Personal share metrics vs the faction for one war. */
export function personalShare(personal: number, factionTotal: number): number | null {
  if (factionTotal <= 0) return null;
  return personal / factionTotal;
}
