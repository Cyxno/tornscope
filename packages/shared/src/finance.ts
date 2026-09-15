/**
 * Financial semantic model (V1.0 financial-semantics rework).
 *
 * THE PRODUCT RULE: red/green are reserved for ECONOMIC meaning.
 * In Torn, players deliberately hold little cash (wallet cash is exposed to
 * mugging) and routinely move money into banks, stocks, items and faction
 * balances. Therefore:
 *
 *   cash outflow  ≠  loss        cash inflow  ≠  profit
 *   asset purchase ≠  expense    asset sale proceeds ≠ income
 *
 * The hierarchy every financial surface follows:
 *   1. WEALTH       — what happened to net worth (official Torn figure)
 *   2. ECONOMIC     — what was actually earned or consumed/lost for good
 *   3. VALUATION    — did owned assets gain/lose value (price moves)
 *   4. CONVERSION   — value merely moved between forms (cash↔assets, bank)
 *   5. LIQUIDITY    — what happened to cash on hand (transport layer)
 *   6. UNRESOLVED   — what the ledger cannot yet classify
 *
 * SIGN IS NOT SENTIMENT: a signed number carries magnitude and direction in
 * TEXT only. Whether it renders green/red is decided by its MEANING, never
 * by its sign alone. sentimentFor() is the single authority — UI code must
 * not derive color from the sign of a conversion/liquidity value.
 */

export type FinancialMeaning =
  | "wealth" // net worth change (official Torn snapshot delta)
  | "economic" // true income / true costs / realized result
  | "valuation" // owned-asset price movement (incl. in snapshot deltas)
  | "conversion" // value moved between forms: cash↔assets, bank, faction
  | "liquidity" // wallet transport: inflow, outflow, net cash movement
  | "unresolved"; // unclassified / residual (visible, never disguised)

export type FinancialSentiment = "positive" | "negative" | "neutral";

/** Meanings whose sign carries economic sentiment. */
const SIGNED_MEANINGS: ReadonlySet<FinancialMeaning> = new Set(["wealth", "economic", "valuation"]);

/**
 * The one tone authority. Wealth/economic/valuation figures keep gain/loss
 * coloring; conversion, liquidity and unresolved figures are NEUTRAL however
 * large or negative — the transport total must never read as profit/loss.
 */
export function sentimentFor(meaning: FinancialMeaning, value: number | null | undefined): FinancialSentiment {
  if (!SIGNED_MEANINGS.has(meaning)) return "neutral";
  if (value === null || value === undefined) return "neutral";
  return value >= 0 ? "positive" : "negative";
}

/* -------------------------------------------------------------------------- */
/* Wealth story: the plain-language narrative (Phase: real-profile acceptance) */
/* -------------------------------------------------------------------------- */

export interface WealthStoryInput {
  /** Official net worth snapshot delta over the range (may be null). */
  netWorthChange: number | null;
  /** Earned money — raises economic value directly. */
  trueIncome: number | null;
  /** Spent/lost money — lowers economic value directly. */
  trueCosts: number | null;
  /** Cash spent acquiring assets (cash → assets; still owned, not a cost). */
  movedIntoAssets: number | null;
  /** Cash received selling assets (assets → cash; proceeds, not profit). */
  movedBackToCash: number | null;
  /** Gross cash that left the wallet (true costs + asset purchases + transfers). */
  walletOutflow: number | null;
  /** Net wallet movement (transport total; sign never implies loss/gain). */
  walletMovement: number | null;
}

export interface WealthStory {
  /**
   * One hedged plain-language driver sentence, or null when the data cannot
   * defensibly support one. Never claims precision the ledger lacks (Phase:
   * conversion inference — "most of", never "you exactly moved $X").
   */
  headline: string | null;
  /** Whether classified asset purchases dominate the wallet outflow — the
   *  only basis on which a "moved, not lost" narrative may be told. */
  walletDeclineWasConversion: boolean;
  /** True when wealth rose while cash fell — the exact case wallet colors
   *  used to contradict. */
  wealthRoseWhileCashFell: boolean;
}

/**
 * Build the wealth-first narrative for the acceptance case:
 *
 *   Cash −$8.00m, Items +$7.90m, Net worth −$0.10m
 *   → "most of the wallet decline was money moved into assets; the actual
 *      wealth change is the remaining ~$0.1m" — NOT "you lost $8m".
 *
 * Defensibility rules (Phase: conversion inference):
 *   - "moved into assets" requires the CLASSIFIED asset-purchase figure
 *     (ledger event roles — never coincidence pairing of two numbers);
 *   - dominance means purchases explain at least half the gross outflow —
 *     a small purchase next to a large real loss must NOT read as movement;
 *   - wording stays approximate and the leftover difference belongs to the
 *     reconciliation, never to an invented "bad purchase".
 */
export function explainWealthStory(input: WealthStoryInput): WealthStory {
  const { netWorthChange, movedIntoAssets, movedBackToCash, walletOutflow, walletMovement } = input;

  const wealthRoseWhileCashFell =
    netWorthChange !== null && walletMovement !== null && netWorthChange > 0 && walletMovement < 0;

  // Conversion dominance: classified asset purchases explain at least half
  // of the gross outflow. Fixture B (cash −8m, no asset increase) and the
  // small-purchase/large-loss case both fail this and get no story.
  const walletDeclineWasConversion =
    movedIntoAssets !== null &&
    walletOutflow !== null &&
    walletOutflow > 0 &&
    movedIntoAssets >= walletOutflow / 2;

  let headline: string | null = null;
  if (walletDeclineWasConversion && netWorthChange !== null && walletMovement !== null && walletMovement < 0) {
    if (netWorthChange > 0) {
      headline = `Wealth rose even though cash fell — most of the wallet decline was money moved into assets, not lost.`;
    } else if (netWorthChange === 0) {
      headline = `The wallet decline was mostly money moved into assets — value changed form, it did not disappear.`;
    } else {
      headline = `Most of the wallet decline was money moved into assets; the remaining ${formatRough(
        Math.abs(netWorthChange)
      )} is the actual wealth change.`;
    }
  } else if (wealthRoseWhileCashFell) {
    headline = `Wealth rose while cash fell — the cash movement is transport, not loss.`;
  }
  void movedBackToCash;

  return { headline, walletDeclineWasConversion, wealthRoseWhileCashFell };
}

/** "~$7.9m" style rough magnitude for hedged narrative text. */
function formatRough(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `~$${(abs / 1e6).toFixed(1)}m`;
  if (abs >= 1e3) return `~$${Math.round(abs / 1e3)}k`;
  return `~$${Math.round(abs)}`;
}
