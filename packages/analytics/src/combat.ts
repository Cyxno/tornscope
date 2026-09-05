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
  mugsMade: number;
  mugsReceived: number;
  hospitalizationsCaused: number;
  hospitalizationsReceived: number;
  respectGained: number | null;
  respectLost: number | null;
  byOpponent: OpponentRow[];
  dailySeries: Array<{ t: number; made: number; received: number; wins: number; losses: number }>;
  provenance: "exact";
}

const WIN_RESULTS = new Set(["Attacked", "Mugged", "Hospitalized", "Arrested", "Special"]);
const LOSS_RESULTS = new Set(["Lost", "Defended"]);
const MUG_RESULT = "Mugged";
const HOSPITAL_RESULT = "Hospitalized";

export function aggregateCombatStats(events: readonly CombatEventLike[], from: number, to: number, selfName: string | null = null): CombatStats {
  const inRange = events.filter((e) => e.occurredAt >= from && e.occurredAt <= to);

  let attacksMade = 0;
  let attacksReceived = 0;
  let wins = 0;
  let losses = 0;
  let mugsMade = 0;
  let mugsReceived = 0;
  let hospitalizationsCaused = 0;
  let hospitalizationsReceived = 0;
  let respectGained = 0;
  let respectLost = 0;
  let respectKnown = 0;

  interface OpponentAgg { attacks: number; wins: number; losses: number; last: number; name: string | null }
  const opponents = new Map<string, OpponentAgg>();
  const byDay = new Map<number, { made: number; received: number; wins: number; losses: number }>();

  for (const e of inRange) {
    const outgoing = e.direction === "outgoing";
    if (outgoing) attacksMade += 1;
    else attacksReceived += 1;

    const isWin = outgoing && WIN_RESULTS.has(e.result);
    const isLoss = (!outgoing && WIN_RESULTS.has(e.result)) || LOSS_RESULTS.has(e.result);
    if (isWin) wins += 1;
    if (isLoss) losses += 1;
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
    if (isWin) row.wins += 1;
    if (isLoss) row.losses += 1;
    row.last = Math.max(row.last, e.occurredAt);
    if (e.opponentName !== null) row.name = e.opponentName;

    const day = Math.floor(e.occurredAt / 86_400) * 86_400;
    const d = byDay.get(day) ?? byDay.set(day, { made: 0, received: 0, wins: 0, losses: 0 }).get(day)!;
    if (outgoing) d.made += 1;
    else d.received += 1;
    if (isWin) d.wins += 1;
    if (isLoss) d.losses += 1;
  }

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
