/**
 * Faction + ranked war analytics (pure, testable).
 *
 * Provenance model:
 * - RankedWar rows come from /v2/faction/rankedwars (exact scores, winner).
 *   Torn does NOT expose war rewards there — payout/reward metrics come from
 *   MoneyEvents and are marked partial/unavailable when incomplete.
 * - Member war stats are DERIVED from CombatEvents with the ranked-war flag
 *   inside a war's exact interval (derived_from_attacks provenance).
 * - Payout matching is conservative + deterministic (see matchPayout).
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

export type PayoutMatchType = "exact" | "strong" | "time_window" | "ambiguous" | "oc_payout" | "unmatched";
export type PayoutLinkage = PayoutMatchType;

export interface PayoutCandidateInput {
  occurredAt: number;
  amount: number;
  sourceRef: string;
  category?: string;
  /** OC scenario name from the raw payout metadata (exact OC linkage). */
  scenario?: string | null;
  /** Explicit war id if a source ever provides one. */
  warId?: number | null;
}

export interface PayoutMatch {
  matchType: PayoutMatchType;
  matchConfidence: number;
  matchedWarId: number | null;
  matchedOcName: string | null;
  matchReason: string;
  candidateCount: number;
  candidateWarIds: number[];
}

/** Settlement tail: how long after a war ends a payout is plausibly linked. */
export const DEFAULT_PAYOUT_SETTLEMENT_DAYS = 7;
/** Historical alias (configurable via RANKED_WAR_PAYOUT_SETTLEMENT_DAYS). */
export const PAYOUT_TAIL_DAYS = DEFAULT_PAYOUT_SETTLEMENT_DAYS;

const CONFIDENCE = { exact: 1.0, strong: 0.8, time_window: 0.5, ambiguous: 0.0, oc_payout: 1.0, unmatched: 0.0 } as const;

/**
 * Match one payout to a completed ranked war — conservative + deterministic.
 *
 * Precedence:
 * 1. exact      — explicit war id on the payout (not observed in practice)
 * 2. oc_payout  — payout metadata carries an OC scenario: exact OC linkage,
 *                 never a war payout
 * 3. candidates = completed wars whose [start, end + settlementDays] window
 *    contains the payout
 *    - 0  -> unmatched
 *    - 1  -> strong if strictly after war end, else time_window
 *    - >1 -> ambiguous (no auto-selection)
 */
export function matchPayout(
  payout: PayoutCandidateInput,
  completedWars: readonly WarLike[],
  opts: { settlementDays?: number } = {}
): PayoutMatch {
  const settlementDays = opts.settlementDays ?? DEFAULT_PAYOUT_SETTLEMENT_DAYS;
  const tail = settlementDays * 86_400;

  if (payout.warId !== null && payout.warId !== undefined) {
    return {
      matchType: "exact",
      matchConfidence: CONFIDENCE.exact,
      matchedWarId: payout.warId,
      matchedOcName: null,
      matchReason: "explicit war id on the payout record",
      candidateCount: 1,
      candidateWarIds: [payout.warId],
    };
  }

  if (payout.scenario) {
    return {
      matchType: "oc_payout",
      matchConfidence: CONFIDENCE.oc_payout,
      matchedWarId: null,
      matchedOcName: payout.scenario,
      matchReason: "payout metadata carries an organized-crime scenario (exact OC linkage, not a war payout)",
      candidateCount: 0,
      candidateWarIds: [],
    };
  }

  const candidates = completedWars.filter((w) => {
    const tailEnd = (w.endedAt ?? w.startedAt) + tail;
    return payout.occurredAt >= w.startedAt && payout.occurredAt <= tailEnd;
  });

  if (candidates.length === 0) {
    return { matchType: "unmatched", matchConfidence: CONFIDENCE.unmatched, matchedWarId: null, matchedOcName: null, matchReason: "no completed war within the settlement window", candidateCount: 0, candidateWarIds: [] };
  }

  if (candidates.length > 1) {
    return {
      matchType: "ambiguous",
      matchConfidence: CONFIDENCE.ambiguous,
      matchedWarId: null,
      matchedOcName: null,
      matchReason: `multiple completed wars (${candidates.map((w) => w.tornWarId).join(", ")}) qualify within the settlement window — not auto-selected`,
      candidateCount: candidates.length,
      candidateWarIds: candidates.map((w) => w.tornWarId),
    };
  }

  const war = candidates[0]!;
  const afterEnd = war.endedAt !== null && war.endedAt !== undefined && payout.occurredAt > war.endedAt;
  return afterEnd
    ? { matchType: "strong", matchConfidence: CONFIDENCE.strong, matchedWarId: war.tornWarId, matchedOcName: null, matchReason: "single completed war; payout occurred after war end within the settlement window", candidateCount: 1, candidateWarIds: [war.tornWarId] }
    : { matchType: "time_window", matchConfidence: CONFIDENCE.time_window, matchedWarId: war.tornWarId, matchedOcName: null, matchReason: "single completed war candidate; payout falls inside the war window", candidateCount: 1, candidateWarIds: [war.tornWarId] };
}

/** Match every payout (deterministic order: wars sorted by id). */
export function matchPayouts(payouts: readonly PayoutCandidateInput[], completedWars: readonly WarLike[], opts: { settlementDays?: number } = {}): PayoutMatch[] {
  const sorted = [...completedWars].sort((a, b) => a.tornWarId - b.tornWarId);
  return payouts.map((p) => matchPayout(p, sorted, opts));
}

/**
 * Match a faction payout to an organized crime by exact scenario name,
 * confirmed by execution-time proximity (OC names repeat across runs).
 */
export function matchOcPayout(
  payout: PayoutCandidateInput,
  ocs: ReadonlyArray<{ ocId: number; name: string; status: string; executedAt: number | null }>
): { ocId: number | null; matchedOcName: string | null; confidence: number } {
  if (!payout.scenario) return { ocId: null, matchedOcName: null, confidence: 0 };
  const named = ocs.filter((o) => o.name === payout.scenario);
  if (named.length === 0) return { ocId: null, matchedOcName: payout.scenario, confidence: 0.5 };
  const DAY = 86_400;
  const within = named
    .filter((o) => o.executedAt !== null && Math.abs(o.executedAt - payout.occurredAt) <= 3 * DAY)
    .sort((a, b) => Math.abs((a.executedAt ?? 0) - payout.occurredAt) - Math.abs((b.executedAt ?? 0) - payout.occurredAt));
  if (within.length > 0) return { ocId: within[0]!.ocId, matchedOcName: payout.scenario, confidence: 1.0 };
  const newest = [...named].sort((a, b) => (b.executedAt ?? 0) - (a.executedAt ?? 0))[0]!;
  return { ocId: newest.ocId, matchedOcName: payout.scenario, confidence: 0.5 };
}

/** Result of a war from Torn's canonical winner field. */
export function warResult(war: WarLike): "win" | "loss" | "ongoing" | "draw" {
  if (war.endedAt === null) return "ongoing";
  if (war.winnerFactionId === null) return "draw";
  return war.winnerFactionId === war.factionId ? "win" : "loss";
}

/** Ranked-war outgoing attacks inside a war's exact time interval. */
export function warCombatEvents(events: readonly WarCombatEventLike[], war: WarLike): WarCombatEventLike[] {
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

/** Derive member war stats from ranked-war combat events (derived_from_attacks provenance). */
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

export interface WarPayoutSummary {
  matched: Array<PayoutMatch & { amount: number; occurredAt: number; sourceRef: string }>;
  knownPayoutTotal: number;
  personalPayoutTotal: number | null;
}

export interface WarReconciliation {
  tornWarId: number;
  opponentName: string | null;
  startedAt: number;
  endedAt: number | null;
  result: "win" | "loss" | "ongoing" | "draw";
  factionCashReward: null;
  factionPointsReward: null;
  exactItemRewardQuantities: null;
  estimatedItemRewardValue: null;
  knownMatchedPayouts: number;
  matchedPayoutCount: number;
  ambiguousPayoutCount: number;
  unmatchedLikelyPayoutAmount: number;
  personalPayout: number | null;
  retainedFactionCash: null;
  reconciliationCoverage: null;
  reconciliationStatus: "complete" | "partial" | "unavailable";
}

/**
 * Per-war reconciliation. Torn's rankedwars endpoint exposes no reward
 * fields, so gross/points/item rewards and retained cash stay null
 * (unavailable). Coverage percentage needs a valid denominator — never
 * fabricated.
 */
export function reconcileWar(
  war: WarLike,
  payouts: ReadonlyArray<{ match: PayoutMatch; amount: number; occurredAt: number; sourceRef: string }>,
  personalPayout: number | null = null
): WarReconciliation {
  const matchedPayouts = payouts.filter((p) => ["exact", "strong", "time_window"].includes(p.match.matchType) && p.match.matchedWarId === war.tornWarId);
  const ambiguous = payouts.filter((p) => p.match.matchType === "ambiguous" && p.match.candidateWarIds.includes(war.tornWarId));
  const knownMatchedPayouts = matchedPayouts.reduce((sum, p) => sum + p.amount, 0);
  return {
    tornWarId: war.tornWarId,
    opponentName: war.opponentName,
    startedAt: war.startedAt,
    endedAt: war.endedAt,
    result: warResult(war),
    factionCashReward: null,
    factionPointsReward: null,
    exactItemRewardQuantities: null,
    estimatedItemRewardValue: null,
    knownMatchedPayouts,
    matchedPayoutCount: matchedPayouts.length,
    ambiguousPayoutCount: ambiguous.length,
    unmatchedLikelyPayoutAmount: 0,
    personalPayout,
    retainedFactionCash: null,
    reconciliationCoverage: null,
    reconciliationStatus: matchedPayouts.length > 0 ? "partial" : "unavailable",
  };
}

export interface WarProfitability {
  grossCashReward: number | null;
  knownPayoutTotal: number;
  retainedCash: number | null;
  reconciliation: "partial" | "unavailable";
  personalPayout: number | null;
  payoutRatio: number | null;
}

export function warProfitability(war: WarLike, payoutSummary: WarPayoutSummary, personalPayout: number | null = null): WarProfitability {
  return {
    grossCashReward: null,
    knownPayoutTotal: payoutSummary.knownPayoutTotal,
    retainedCash: null,
    reconciliation: payoutSummary.knownPayoutTotal > 0 ? "partial" : "unavailable",
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
  knownPayoutByWar: Map<number, number>,
  personalPayoutByWar: Map<number, number>,
  from: number,
  to: number
): WarSummaryRow[] {
  return wars
    .filter((w) => w.startedAt >= from && w.startedAt <= to)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((w) => ({
      ...w,
      result: warResult(w),
      durationSeconds: w.endedAt !== null ? w.endedAt - w.startedAt : null,
      knownPayoutTotal: knownPayoutByWar.get(w.tornWarId) ?? 0,
      personalPayout: personalPayoutByWar.get(w.tornWarId) ?? null,
    }));
}

export function personalShare(personal: number, factionTotal: number): number | null {
  if (factionTotal <= 0) return null;
  return personal / factionTotal;
}
