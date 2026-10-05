import type { LogRecord } from "./extract.js";

/**
 * Casino domain registry (2.4.0) — one explicit adapter per Torn casino
 * game, built from ACTUAL raw log shapes (category "Casino" / "Money
 * casino") observed in the stored archive. No giant regex soup, no
 * semantics invented from wiki assumptions: a game is only normalized when
 * its real log titles and payload keys are known here.
 *
 * SEMANTICS PER GAME (from the stored archive):
 * - slots:      "Casino slots lose" {bet_amount} /
 *               "Casino slots win" {bet_amount, won_amount}
 *               One log = one spin. net = won_amount − bet_amount.
 * - roulette:   "Casino roulette win" {bet_amount, won_amount} /
 *               "Casino roulette lose" (expected {bet_amount}).
 *               won_amount includes the stake → net = won − bet.
 * - keno:       "Casino keno lose/win" {bet_amount, won_amount, matches}.
 *               net = won − bet.
 * - lottery:    "Casino lottery bet" {cost, lottery} — placement only;
 *               draw settlement is not observed in logs. outcome=placed.
 * - spin-the-wheel: "Casino spin the wheel start" {cost, wheel} + a
 *               separate outcome log (win money / win points / win item /
 *               win casino tokens / free spin / lose / hospital /
 *               win property) with the same wheel. Start = paid entry;
 *               outcome = prize. Correlation: same wheel, next unmatched
 *               outcome after the start (see spin-correlator).
 * - blackjack:  start {bet} → hit(s) → lose {losses} / win. P/L comes from
 *               the terminal log only; start is a placement.
 * - high-low:   start {bet_amount} → round logs {pot, pot_increase} →
 *               win {pot} / lose. net(win) = pot − bet; net(lose) = −bet.
 * - bookie:     bet (placement) / win (winnings incl. stake) / lose /
 *               refund / withdraw. P/L from SETTLEMENTS (win: winnings −
 *               bet; lose: −bet; refund: 0); placements are pending, never
 *               counted as a loss.
 * - poker:      NO local log evidence and player-vs-player session
 *               semantics — deliberately NOT normalized (documented gap).
 */

export type CasinoGame =
  | "slots"
  | "roulette"
  | "keno"
  | "lottery"
  | "spin-the-wheel"
  | "blackjack"
  | "high-low"
  | "bookie";

export interface CasinoActivity {
  game: CasinoGame;
  activityType: string;
  activityLabel: string;
  subtype: string | null;
  outcome: string | null;
  wheel: string | null;
  /** Exact cash staked/paid (from the payload). */
  cashInput: bigint | null;
  /** Exact cash returned (from the payload). */
  cashReward: bigint | null;
  pointsReward: number | null;
  tokensReward: number | null;
  /** Non-priceable prize descriptor (property, free spin, hospital time). */
  nonPriceable: string | null;
  itemReward: { itemId: number; quantity?: number } | null;
  hospitalSeconds: number | null;
  provenance: "exact";
}

function num(data: LogRecord, key: string): bigint | null {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? BigInt(Math.round(v)) : null;
}

function int(data: LogRecord, key: string): number | null {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * Normalize one raw casino-domain log into a CasinoActivity.
 * Returns null when the (category, title) is not a recognized casino log —
 * the caller leaves it on the timeline (never fabricates semantics).
 */
export function normalizeCasinoLog(category: string, title: string, data: LogRecord): CasinoActivity | null {
  const t = title.toLowerCase();
  if (category !== "Casino" && !t.startsWith("casino ") && !t.startsWith("bookie ")) return null;

  // --- spin the wheel (start + outcome logs) ---
  if (t.startsWith("casino spin the wheel")) {
    // The wheel variant lives in the DATA payload ("the Wheel of ..."),
    // not the title.
    const wheel = typeof data.wheel === "string" && data.wheel.trim() !== "" ? data.wheel.trim() : null;
    const base = { game: "spin-the-wheel" as const, activityType: "spin-the-wheel", activityLabel: "Spin the Wheel", wheel };
    if (/\bstart\b/.test(t)) {
      const cost = num(data, "cost");
      return { ...base, subtype: "start", outcome: "started", cashInput: cost, cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\bwin money\b/.test(t)) {
      return { ...base, subtype: "win-money", outcome: "win", cashInput: null, cashReward: num(data, "money"), pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\bwin points\b/.test(t)) {
      return { ...base, subtype: "win-points", outcome: "win", cashInput: null, cashReward: null, pointsReward: int(data, "points"), tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\bwin item\b/.test(t)) {
      const itemId = int(data, "item");
      return { ...base, subtype: "win-item", outcome: "win", cashInput: null, cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: itemId !== null ? { itemId } : null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\bwin casino tokens\b/.test(t)) {
      return { ...base, subtype: "win-tokens", outcome: "win", cashInput: null, cashReward: null, pointsReward: null, tokensReward: int(data, "casino_tokens_increased"), nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\bfree spin\b/.test(t)) {
      return { ...base, subtype: "free-spin", outcome: "win", cashInput: null, cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: "free spin", itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\bwin property\b/.test(t)) {
      const property = int(data, "property");
      return { ...base, subtype: "win-property", outcome: "win", cashInput: null, cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: property !== null ? `property #${property}` : "property", itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\bhospital\b/.test(t)) {
      return { ...base, subtype: "hospital", outcome: "loss", cashInput: null, cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: "hospitalization", itemReward: null, hospitalSeconds: int(data, "hospital_time_increased"), provenance: "exact" };
    }
    if (/\blose\b/.test(t)) {
      return { ...base, subtype: "lose", outcome: "loss", cashInput: null, cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    return null;
  }

  // --- slots ---
  if (/^casino slots (win|lose)$/.test(t)) {
    const win = t.endsWith("win");
    const bet = num(data, "bet_amount");
    const won = win ? num(data, "won_amount") : null;
    return {
      game: "slots", activityType: "slots", activityLabel: "Slots",
      subtype: win ? "win" : "lose", outcome: win ? "win" : "loss",
      wheel: null, cashInput: bet, cashReward: won, pointsReward: null, tokensReward: null,
      nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact",
    };
  }

  // --- roulette ---
  if (/^casino roulette (win|lose)$/.test(t)) {
    const win = t.endsWith("win");
    const bet = num(data, "bet_amount");
    const won = win ? num(data, "won_amount") : null;
    return {
      game: "roulette", activityType: "roulette", activityLabel: "Roulette",
      subtype: win ? "win" : "lose", outcome: win ? "win" : "loss",
      wheel: null, cashInput: bet, cashReward: won, pointsReward: null, tokensReward: null,
      nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact",
    };
  }

  // --- keno ---
  if (/^casino keno (win|lose)$/.test(t)) {
    const win = t.endsWith("win");
    const bet = num(data, "bet_amount");
    const won = win ? num(data, "won_amount") : null;
    return {
      game: "keno", activityType: "keno", activityLabel: "Keno",
      subtype: win ? "win" : "lose", outcome: win ? "win" : "loss",
      wheel: null, cashInput: bet, cashReward: won, pointsReward: null, tokensReward: null,
      nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact",
    };
  }

  // --- blackjack (start/hit/lose/win/push/double/split/surrender/insurance) ---
  if (/^casino blackjack /.test(t)) {
    const base = { game: "blackjack" as const, activityType: "blackjack", activityLabel: "Blackjack", wheel: null };
    if (/\bstart\b/.test(t)) {
      return { ...base, subtype: "start", outcome: "placed", cashInput: num(data, "bet"), cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\blose\b/.test(t)) {
      return { ...base, subtype: "lose", outcome: "loss", cashInput: num(data, "losses"), cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\bwin\b/.test(t)) {
      return { ...base, subtype: "win", outcome: "win", cashInput: num(data, "bet_amount"), cashReward: num(data, "won_amount"), pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\bpush\b/.test(t)) {
      return { ...base, subtype: "push", outcome: "push", cashInput: null, cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    // hit/double/split/surrender/insurance: session actions without own
    // money payload — keep as activity subtype, P/L stays on the terminal log.
    return { ...base, subtype: t.replace(/^casino blackjack /, ""), outcome: null, cashInput: null, cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
  }

  // --- high-low ---
  if (/^casino high-low /.test(t)) {
    const base = { game: "high-low" as const, activityType: "high-low", activityLabel: "High-Low", wheel: null };
    if (/\bstart\b/.test(t)) {
      return { ...base, subtype: "start", outcome: "placed", cashInput: num(data, "bet_amount"), cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\bwin\b/.test(t)) {
      const bet = int(data, "pot_increase");
      const pot = num(data, "pot");
      // net(win) = pot − accumulated bet is only exact when the fixture
      // carries bet_amount; pot_increase is the last round increment, so the
      // net stays on the pot with bet stored via the start log (paired in
      // the correlator). Here: cashReward = pot, cashInput = null.
      void bet;
      return { ...base, subtype: "win", outcome: "win", cashInput: null, cashReward: pot, pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\blose\b/.test(t)) {
      // The initial bet is the loss; the start log (paired in the
      // correlator) owns it — the lose log itself carries pot state only.
      return { ...base, subtype: "lose", outcome: "loss", cashInput: null, cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    return { ...base, subtype: t.replace(/^casino high-low /, ""), outcome: null, cashInput: null, cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
  }

  // --- lottery ---
  if (/^casino lottery bet$/.test(t)) {
    const lottery = typeof data.lottery === "string" ? data.lottery : null;
    return {
      game: "lottery", activityType: "lottery", activityLabel: lottery ? `Lottery — ${lottery}` : "Lottery",
      subtype: "bet", outcome: "placed",
      wheel: null, cashInput: num(data, "cost"), cashReward: null, pointsReward: null, tokensReward: null,
      nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact",
    };
  }

  // --- bookie (placement vs settlement are distinct logs) ---
  if (/^bookie /.test(t)) {
    const base = { game: "bookie" as const, activityType: "bookie", activityLabel: "Bookie", wheel: null };
    if (/\bbet \(new\)$/.test(t)) {
      return { ...base, subtype: "placed", outcome: "placed", cashInput: num(data, "bet"), cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\bwin \(new\)$/.test(t)) {
      // winnings include the stake → net = winnings − bet (computed by engine).
      return { ...base, subtype: "won", outcome: "win", cashInput: num(data, "bet"), cashReward: num(data, "winnings"), pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\blose \(new\)$/.test(t)) {
      return { ...base, subtype: "lost", outcome: "loss", cashInput: num(data, "bet"), cashReward: null, pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\brefund \(new\)$/.test(t)) {
      return { ...base, subtype: "refunded", outcome: "refund", cashInput: num(data, "bet"), cashReward: num(data, "bet"), pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    if (/\bwithdraw \(new\)$/.test(t)) {
      return { ...base, subtype: "withdrawal", outcome: "withdrawal", cashInput: null, cashReward: num(data, "withdrawn"), pointsReward: null, tokensReward: null, nonPriceable: null, itemReward: null, hospitalSeconds: null, provenance: "exact" };
    }
    return null;
  }

  // --- poker: documented unsupported (no local evidence; session-based) ---
  return null;
}

/** True when the (category, title) is a casino-domain log we recognize. */
export function isCasinoLog(category: string, title: string): boolean {
  return normalizeCasinoLog(category, title, {}) !== null;
}
