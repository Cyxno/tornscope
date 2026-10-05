
/**
 * Casino economic ownership (2.5.1) — EVENT rows vs LOGICAL PLAY economics.
 *
 * One logical play can produce several ActivityEvent rows (placement +
 * settlement). Rows are exact per log, but naive SUMs over them distort
 * play economics:
 *
 * - bookie: the placement owns the stake; win/lose/refund settlements REPEAT
 *   the stake in their payload → naive wagered counts settled stakes twice.
 * - blackjack: the start owns the stake; terminal win repeats bet and lose
 *   carries losses → wagered counts completed stakes twice. Terminal nets
 *   are play-complete (win = won − bet, lose = −losses), so net = ΣnetValue.
 * - high-low: the start owns the stake and NOTHING repeats it — the win log
 *   carries only the pot. Net therefore = ΣnetValue − Σ(start stakes that
 *   have no net of their own). Exact when every logged session settles;
 *   an unsettled start would count as a loss (disclosed limitation).
 * - spin-the-wheel: the start carries net −cost itself; ΣnetValue is exact.
 * - lottery: placements only, no settlement log exists → net is PENDING
 *   (null), never −stakes.
 * - slots / roulette / keno: one log = one play; plain sums are exact.
 * - bookie withdrawals: balance movements between the bookie account and
 *   the wallet — activity, but NOT game winnings. Excluded from cash
 *   returned and net; reported separately as `withdrawn`.
 */

export interface CasinoEconomicsRow {
  activityType: string;
  subtype: string | null;
  outcome: string | null;
  cashInput: bigint | null;
  cashReward: bigint | null;
  netValue: bigint | null;
}

export interface CasinoEconomics {
  /** Rows that carry economic weight (withdrawals excluded). */
  plays: number;
  /** Logical stake: only rows that OWN a stake contribute. */
  wagered: bigint;
  /** Cash returned by the game (winnings + refunds; withdrawals excluded). */
  returned: bigint;
  /** Net per the game's ownership semantics; null when pending-only. */
  net: bigint | null;
  /** Bookie withdrawals excluded from returned/net (balance movements). */
  withdrawn: bigint;
  /** Rows counted for activity but carrying no settled economics (pending). */
  pending: number;
  /** Any cash observed at all (distinguishes "no data" from exact zero). */
  hasCash: boolean;
}

/** Stake-owning subtypes per game. Games absent from this table let every
 *  row with a cashInput own its own stake (one-log-per-play games). */
const STAKE_OWNERS: Record<string, ReadonlySet<string>> = {
  bookie: new Set(["placed"]),
  blackjack: new Set(["start"]),
  "high-low": new Set(["start"]),
  "spin-the-wheel": new Set(["start"]),
  lottery: new Set(["bet", "placed"]),
};

/** Games whose settlements do NOT repeat the stake — the stake-owning row's
 *  stake must be subtracted into net explicitly (it has no net itself). */
const STAKE_MISSING_FROM_NET = new Set(["high-low"]);

/** Outcomes that are balance movements, not game economics. */
const EXCLUDED_OUTCOMES: Record<string, ReadonlySet<string>> = {
  bookie: new Set(["withdrawal"]),
};

function ownsStake(game: string, subtype: string | null): boolean {
  const owners = STAKE_OWNERS[game];
  if (!owners) return true; // one-log-per-play games
  return subtype !== null && owners.has(subtype);
}

/** Aggregate one single game's rows (per-game pending netting). */
function aggregateGameEconomics(game: string, rows: CasinoEconomicsRow[]): CasinoEconomics {
  let wagered = 0n;
  let returned = 0n;
  let net = 0n;
  let netSeen = false;
  let withdrawn = 0n;
  let unresolvedStakes = 0;
  let settledNets = 0;
  let hasCash = false;

  for (const row of rows) {
    const excluded = EXCLUDED_OUTCOMES[game]?.has(row.outcome ?? "") ?? false;
    if (excluded) {
      if (row.cashReward !== null) withdrawn += row.cashReward;
      continue;
    }
    if (row.cashInput !== null || row.cashReward !== null) hasCash = true;

    const stakeOwner = ownsStake(game, row.subtype) && row.cashInput !== null;
    if (stakeOwner && row.cashInput !== null) {
      wagered += row.cashInput;
      // Stakes that never reappear in a settlement's net (high-low style):
      // the start's stake IS the play's loss until a pot arrives.
      if (STAKE_MISSING_FROM_NET.has(game) && row.netValue === null) {
        net -= row.cashInput;
        netSeen = true;
      } else if (row.netValue === null) {
        unresolvedStakes += 1;
      }
    }
    if (row.cashReward !== null) returned += row.cashReward;
    if (row.netValue !== null) {
      net += row.netValue;
      netSeen = true;
      settledNets += 1;
    }
  }
  // Settlements resolve placements 1:1 for the games that complete net in
  // the terminal log; whatever remains is genuinely pending (scoped to the
  // game — settlements of other games never net out these stakes).
  const pending = Math.max(0, unresolvedStakes - settledNets);
  return { plays: rows.length, wagered, returned, net: netSeen ? net : null, withdrawn, pending, hasCash };
}

/** Aggregate raw per-row casino economics into logical-play economics. */
export function aggregateCasinoEconomics(rows: CasinoEconomicsRow[]): CasinoEconomics {
  const byGame = new Map<string, CasinoEconomicsRow[]>();
  for (const row of rows) {
    const list = byGame.get(row.activityType) ?? [];
    list.push(row);
    byGame.set(row.activityType, list);
  }
  const totals: CasinoEconomics = { plays: 0, wagered: 0n, returned: 0n, net: null, withdrawn: 0n, pending: 0, hasCash: false };
  let netSeen = false;
  for (const [game, list] of byGame) {
    const eco = aggregateGameEconomics(game, list);
    totals.plays += eco.plays;
    totals.wagered += eco.wagered;
    totals.returned += eco.returned;
    totals.withdrawn += eco.withdrawn;
    totals.pending += eco.pending;
    totals.hasCash = totals.hasCash || eco.hasCash;
    if (eco.net !== null) {
      totals.net = (totals.net ?? 0n) + eco.net;
      netSeen = true;
    }
  }
  totals.net = netSeen ? totals.net : null;
  return totals;
}

/** Group rows per game and aggregate each. */
export function aggregateCasinoPerGame(rows: CasinoEconomicsRow[]): Map<string, CasinoEconomics> {
  const byGame = new Map<string, CasinoEconomicsRow[]>();
  for (const row of rows) {
    const list = byGame.get(row.activityType) ?? [];
    list.push(row);
    byGame.set(row.activityType, list);
  }
  const out = new Map<string, CasinoEconomics>();
  for (const [game, list] of byGame) out.set(game, aggregateCasinoEconomics(list));
  return out;
}

