/**
 * Combat analytics over normalized CombatEvents (/v2/user/attacks).
 *
 * Win/loss/mug classification uses Torn's own result strings ("Attacked",
 * "Mugged", "Hospitalized", "Lost", "Stalemate", "Assist", ...). Respect is
 * Torn-provided (exact); mug cash lives in MoneyEvent (category mugging) and
 * is not duplicated here.
 */

export interface CombatEventLike {
  occurredAt: number;
  direction: "outgoing" | "incoming";
  opponentId: number | null;
  opponentName: string | null;
  result: string;
  respectDelta: number | null;
}

export interface OpponentRow {
  opponentId: number | null;
  opponent: string;
  attacks: number;
  wins: number;
  losses: number;
  winRate: number | null;
  lastEncounter: number;
}

export interface CombatStats {
  attacksMade: number;
  attacksReceived: number;
  wins: number;
  losses: number;
  winRate: number | null;
  /** Outgoing encounters I won (Attacked / Mugged / Hospitalized / ...). */
  outgoingWins: number;
  /** Outgoing encounters I lost (result "Lost"). */
  outgoingLosses: number;
  /** Incoming attacks I successfully defended (result "Defended"). */
  incomingDefended: number;
  /** Incoming attacks where the attacker won (I was attacked/mugged/hospitalized). */
  incomingLost: number;
  mugsMade: number;
  mugsReceived: number;
  hospitalizationsCaused: number;
  hospitalizationsReceived: number;
  respectGained: number | null;
  respectLost: number | null;
  byOpponent: OpponentRow[];
  dailySeries: Array<{ t: number; made: number; received: number; wins: number; losses: number; outgoingWins: number; outgoingLosses: number; incomingDefended: number; incomingLost: number }>;
  provenance: "exact";
}

const WIN_RESULTS = new Set(["Attacked", "Mugged", "Hospitalized", "Arrested", "Special"]);
/** Results where the ATTACKER lost — only meaningful on outgoing attacks. */
const ATTACKER_LOSS_RESULTS = new Set(["Lost"]);
const MUG_RESULT = "Mugged";
const HOSPITAL_RESULT = "Hospitalized";

export function aggregateCombatStats(events: readonly CombatEventLike[], from: number, to: number, selfName: string | null = null): CombatStats {
  const inRange = events.filter((e) => e.occurredAt >= from && e.occurredAt <= to);

  let attacksMade = 0;
  let attacksReceived = 0;
  let outgoingWins = 0;
  let outgoingLosses = 0;
  let incomingDefended = 0;
  let incomingLost = 0;
  let mugsMade = 0;
  let mugsReceived = 0;
  let hospitalizationsCaused = 0;
  let hospitalizationsReceived = 0;
  let respectGained = 0;
  let respectLost = 0;
  let respectKnown = 0;

  interface OpponentAgg { attacks: number; wins: number; losses: number; last: number; name: string | null }
  const opponents = new Map<string, OpponentAgg>();
  const byDay = new Map<number, { made: number; received: number; wins: number; losses: number; outgoingWins: number; outgoingLosses: number; incomingDefended: number; incomingLost: number }>();

  for (const e of inRange) {
    const outgoing = e.direction === "outgoing";
    if (outgoing) attacksMade += 1;
    else attacksReceived += 1;

    // Direction-aware result semantics. Torn's result string is written from
    // the ATTACKER's perspective:
    //   outgoing + Attacked/Mugged/Hospitalized/Arrested/Special -> I won.
    //   outgoing + Lost/Defended -> my attack failed (my loss).
    //   incoming + Mugged/... -> the attacker succeeded (my loss).
    //   incoming + Defended/Lost -> the attack on me failed (defensive win).
    let myWin = false;
    let myLoss = false;
    if (outgoing) {
      myWin = WIN_RESULTS.has(e.result);
      myLoss = !myWin && (ATTACKER_LOSS_RESULTS.has(e.result) || e.result === "Defended");
    } else {
      myLoss = WIN_RESULTS.has(e.result);
      myWin = !myLoss && (ATTACKER_LOSS_RESULTS.has(e.result) || e.result === "Defended");
    }
    if (myWin) outgoingWins += outgoing ? 1 : 0;
    if (myWin && !outgoing) incomingDefended += 1;
    if (myLoss && outgoing) outgoingLosses += 1;
    if (myLoss && !outgoing) incomingLost += 1;
    const wins = myWin ? 1 : 0;
    const losses = myLoss ? 1 : 0;
    if (e.result === MUG_RESULT) {
      if (outgoing) mugsMade += 1;
      else mugsReceived += 1;
    }
    if (e.result === HOSPITAL_RESULT) {
      if (outgoing) hospitalizationsCaused += 1;
      else hospitalizationsReceived += 1;
    }
    if (e.respectDelta !== null) {
      if (e.respectDelta > 0) respectGained += e.respectDelta;
      else respectLost += -e.respectDelta;
      respectKnown += 1;
    }

    const opponentKey = e.opponentId !== null ? `id:${e.opponentId}` : `name:${e.opponentName ?? "unknown"}`;
    const opponentName = e.opponentName ?? "Unknown opponent";
    const row = opponents.get(opponentKey) ?? opponents.set(opponentKey, { attacks: 0, wins: 0, losses: 0, last: e.occurredAt, name: null }).get(opponentKey)!;
    row.attacks += 1;
    if (myWin) row.wins += 1;
    if (myLoss) row.losses += 1;
    row.last = Math.max(row.last, e.occurredAt);
    if (e.opponentName !== null) row.name = e.opponentName;

    const day = Math.floor(e.occurredAt / 86_400) * 86_400;
    const d = byDay.get(day) ?? byDay.set(day, { made: 0, received: 0, wins: 0, losses: 0, outgoingWins: 0, outgoingLosses: 0, incomingDefended: 0, incomingLost: 0 }).get(day)!;
    if (outgoing) d.made += 1;
    else d.received += 1;
    if (myWin) {
      d.wins += 1;
      if (outgoing) d.outgoingWins += 1;
      else d.incomingDefended += 1;
    }
    if (myLoss) {
      d.losses += 1;
      if (outgoing) d.outgoingLosses += 1;
      else d.incomingLost += 1;
    }
  }

  const wins = outgoingWins + incomingDefended;
  const losses = outgoingLosses + incomingLost;
  const decided = wins + losses;
  const byOpponent: OpponentRow[] = [...opponents.entries()]
    .map(([key, r]) => {
      const idPart = key.startsWith("id:") ? Number(key.slice(3)) : null;
      const namePart = key.startsWith("name:") ? key.slice(5) : null;
      return {
        opponentId: idPart,
        opponent: namePart ?? (idPart !== null ? (opponents.get(key)!.name ?? "Unknown opponent") : "Unknown opponent"),
        attacks: r.attacks,
        wins: r.wins,
        losses: r.losses,
        winRate: r.attacks > 0 ? r.wins / r.attacks : null,
        lastEncounter: r.last,
      };
    })
    .sort((a, b) => b.attacks - a.attacks || b.lastEncounter - a.lastEncounter);
  void selfName;

  return {
    attacksMade,
    attacksReceived,
    wins,
    losses,
    winRate: decided > 0 ? wins / decided : null,
    outgoingWins,
    outgoingLosses,
    incomingDefended,
    incomingLost,
    mugsMade,
    mugsReceived,
    hospitalizationsCaused,
    hospitalizationsReceived,
    respectGained: respectKnown > 0 ? respectGained : null,
    respectLost: respectKnown > 0 ? respectLost : null,
    byOpponent,
    dailySeries: [...byDay.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, v]) => ({ t, ...v })),
    provenance: "exact",
  };
}
