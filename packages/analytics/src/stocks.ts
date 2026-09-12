/* -------------------------------------------------------------------------- */
/* Stock benefit intelligence — pure calculations                             */
/* -------------------------------------------------------------------------- */

/**
 * SOURCES (verified live against Torn API v2, spec 6.13.5):
 *
 * - `/v2/user/stocks` → `{ stocks: [{ id, shares, transactions,
 *   bonus: { available, increment, progress, frequency } }] }`.
 *   `shares` and the bonus block are exact. The bonus object exists for
 *   every owned stock, even below the benefit threshold.
 * - `/v2/torn/stocks` (public) → `{ stocks: [{ id, name, acronym,
 *   market: { price, … }, bonus: { passive, frequency, requirement,
 *   description } }] }`. The market price is the exact current price at
 *   capture time; `bonus` is the single benefit definition per stock —
 *   the payload is an OBJECT, not an array, so Torn proves one benefit
 *   block per stock (no multi-block semantics exist).
 *
 * `bonus.progress` semantics are not documented by Torn. Observed evidence
 * (shares == requirement, progress = 3, frequency = 7, available = false)
 * supports: once the threshold is met, `progress` counts elapsed days in the
 * current payout cycle and `available` flips true when the reward is ready.
 * Timing derived from it is therefore labeled DERIVED, and only produced
 * when the evidence is complete (threshold met, 0 < progress ≤ frequency).
 */

/** How a stock benefit's reward converts into value — or why it does not. */
export type RewardKind =
  | "fixed_cash"
  | "item"
  | "points"
  | "bar_refill"
  | "non_monetary"
  | "unvalued";

export interface RewardValuation {
  kind: RewardKind;
  /** Exact cash amount for fixed_cash. */
  cash: number | null;
  /** Item quantity for item rewards. */
  quantity: number | null;
  /** Item name for item rewards (as Torn phrases it, minus the "Nx"). */
  itemName: string | null;
  /** Points amount for point rewards (never auto-converted to money). */
  points: number | null;
  /** Human reward text (always shown — the value is secondary). */
  description: string;
  /**
   * Estimated money value of ONE payout. Null unless the kind supports a
   * defensible valuation: fixed_cash (exact) or item with a catalog price.
   * NEVER 0 for unvalued rewards — null means "no money figure".
   */
  valuePerPayout: number | null;
  /** True when valuePerPayout is exact (fixed cash), not a price estimate. */
  valueIsExact: boolean;
}

/** Raw benefit definition from `/v2/torn/stocks`. */
export interface StockBenefitDefinition {
  passive: boolean;
  /** Payout interval in days. */
  frequency: number | null;
  /** Shares required to reach the benefit. */
  requirement: number | null;
  description: string;
}

/**
 * Classify + value a benefit description.
 *
 * `itemPriceByName` resolves rewards against the SAME TornItemCatalog the
 * Drugs/Travel valuation uses — never a second price source. Rewards that
 * cannot be valued (random property, unknown items, passive perks, stat
 * refills, points) carry `valuePerPayout: null` — never a fabricated $0.
 */
export function classifyReward(
  benefit: StockBenefitDefinition,
  itemPriceByName: Map<string, number>
): RewardValuation {
  const description = benefit.description.trim();
  const base: RewardValuation = {
    kind: "unvalued",
    cash: null,
    quantity: null,
    itemName: null,
    points: null,
    description,
    valuePerPayout: null,
    valueIsExact: false,
  };

  // Exact cash: "$50,000,000"
  const cash = description.match(/^\$([\d,]+)$/);
  if (cash) {
    const amount = Number((cash[1] ?? "0").replaceAll(",", ""));
    return { ...base, kind: "fixed_cash", cash: amount, valuePerPayout: amount, valueIsExact: true };
  }

  // Points: "100 points" — a real reward, but TornScope has no defensible
  // point-price model, so it renders as points, never as money.
  const points = description.match(/^([\d,]+) points?$/i);
  if (points) {
    return { ...base, kind: "points", points: Number((points[1] ?? "0").replaceAll(",", "")) };
  }

  // Bar refills: "100 energy" / "50 nerve" / "1000 happiness" — no canonical
  // per-unit market value; render as-is.
  const refill = description.match(/^([\d,]+) (energy|nerve|happiness)$/i);
  if (refill) {
    return { ...base, kind: "bar_refill" };
  }

  // Item rewards: "1x Drug Pack" — valued at the current catalog price when
  // the item resolves there.
  const item = description.match(/^(\d+)x (.+)$/i);
  if (item) {
    const quantity = Number(item[1] ?? 0);
    const itemName = (item[2] ?? "").trim();
    // "1x Random Property" — inherently unpredictable, never valued.
    if (/^random property$/i.test(itemName)) {
      return { ...base, kind: "non_monetary", quantity, itemName };
    }
    const price = itemPriceByName.get(itemName.toLowerCase());
    if (price !== undefined && Number.isFinite(price)) {
      return { ...base, kind: "item", quantity, itemName, valuePerPayout: quantity * price, valueIsExact: false };
    }
    // Recognized as an item, but no catalog coverage — honest "unvalued".
    return { ...base, kind: "unvalued", quantity, itemName };
  }

  // Passive perks and anything else: "a 10% bank interest bonus",
  // "Private jet access", …
  if (benefit.passive) {
    return { ...base, kind: "non_monetary" };
  }
  return base;
}

/* -------------------------------------------------------------------------- */
/* Payout timing                                                              */
/* -------------------------------------------------------------------------- */

export type PayoutTimingKind = "ready" | "derived" | "unavailable";

export interface PayoutTiming {
  kind: PayoutTimingKind;
  /** Days until the reward can be collected (0 when ready). */
  daysRemaining: number | null;
  /** Source evidence behind the figure — shown as provenance. */
  basis: string;
}

/** Raw per-user bonus state from `/v2/user/stocks`. */
export interface UserBonusState {
  available: boolean | null;
  increment: number | null;
  progress: number | null;
  frequency: number | null;
}

export interface BenefitReachedInput {
  shares: number;
  requirement: number | null;
  bonus: UserBonusState;
}

/**
 * Payout timing for an ACTIVE benefit (threshold met).
 *
 * - available === true → "ready" (exact source boolean).
 * - threshold met, 0 < progress ≤ frequency → derived days remaining.
 * - anything else → unavailable. Never a negative countdown.
 *
 * When the threshold is NOT met the benefit is not running at all — callers
 * should not ask for timing (see `benefitReached`).
 */
export function payoutTiming(input: BenefitReachedInput): PayoutTiming {
  const { shares, requirement, bonus } = input;
  const reached = requirement !== null && shares >= requirement;
  if (!reached || bonus.available === null) {
    return { kind: "unavailable", daysRemaining: null, basis: "benefit not active" };
  }
  if (bonus.available) {
    return { kind: "ready", daysRemaining: 0, basis: "ready to collect" };
  }
  const { progress, frequency } = bonus;
  if (
    frequency !== null &&
    frequency > 0 &&
    progress !== null &&
    progress > 0 &&
    progress <= frequency
  ) {
    const daysRemaining = Math.max(0, frequency - progress);
    return {
      kind: "derived",
      daysRemaining,
      basis: `day ${progress} of a ${frequency}-day cycle`,
    };
  }
  return { kind: "unavailable", daysRemaining: null, basis: "insufficient cycle evidence" };
}

/** Whether the share threshold for the (single) benefit block is met. */
export function benefitReached(shares: number, requirement: number | null): boolean {
  return requirement !== null && requirement > 0 && shares >= requirement;
}

/* -------------------------------------------------------------------------- */
/* Per-stock intelligence row                                                 */
/* -------------------------------------------------------------------------- */

export interface StockCatalogEntry {
  id: number;
  name: string;
  acronym: string;
  /** Exact market price at capture; null when the catalog omits it. */
  price: number | null;
  benefit: StockBenefitDefinition | null;
}

export interface StockRowInput {
  catalog: StockCatalogEntry;
  /** Exact owned shares; null = unowned stock (catalog-only row). */
  shares: number | null;
  bonus: UserBonusState | null;
  /** Catalog price capture time (unix seconds) for freshness labeling. */
  priceCapturedAt: number | null;
  /** Current catalog item prices (lowercase name → unit price). */
  itemPriceByName?: Map<string, number>;
}

export interface StockIntelligenceRow {
  id: number;
  name: string;
  acronym: string;
  owned: boolean;
  /** Exact shares; null when unowned. */
  shares: number | null;
  /** Shares × current price; null without a price. Estimated at current price. */
  positionValue: number | null;

  benefitDescription: string | null;
  benefitRequirement: number | null;
  benefitFrequencyDays: number | null;
  benefitPassive: boolean | null;
  reward: RewardValuation | null;

  /** Threshold met — the benefit is running (or ready). */
  benefitReached: boolean;
  /** "All benefit blocks reached" is meaningless with one block; this is
   *  simply the single block's state. Kept for summary counting. */
  timing: PayoutTiming | null;

  /** Exact missing shares to the benefit threshold. */
  missingShares: number | null;
  /** Missing shares × current price. null without a price or when reached. */
  estimatedCostToBenefit: number | null;

  /** Reward value × payouts/year. null when the reward is unvalued. */
  estimatedAnnualValue: number | null;
  /** Annual value ÷ capital value of the benefit's required shares (%). */
  estimatedYieldPct: number | null;
  /** Capital ÷ annual value, in days — how long the benefit repays the
   *  shares required for it. null when inputs are unavailable. */
  estimatedPaybackDays: number | null;
  /** The capital denominator used for yield/payback (requirement × price). */
  yieldCapitalBasis: number | null;

  priceCapturedAt: number | null;
}

const DAYS_PER_YEAR = 365;

/** Assemble one stock's intelligence row. Pure — golden-test target. */
export function assembleStockRow(input: StockRowInput): StockIntelligenceRow {
  const { catalog, shares, bonus } = input;
  const price = catalog.price;
  const benefit = catalog.benefit ?? null;
  const owned = shares !== null;

  const positionValue = owned && shares !== null && price !== null ? shares * price : null;

  const reward = benefit ? classifyReward(benefit, input.itemPriceByName ?? new Map()) : null;

  const reached = owned && shares !== null && benefit ? benefitReached(shares, benefit.requirement) : false;
  const timing =
    owned && reached && benefit && bonus
      ? payoutTiming({ shares, requirement: benefit.requirement, bonus })
      : null;

  const missingShares =
    owned && shares !== null && benefit?.requirement != null && !reached
      ? Math.max(0, benefit.requirement - shares)
      : null;
  const estimatedCostToBenefit =
    missingShares !== null && price !== null ? missingShares * price : null;

  // Annual value exists only for valued rewards.
  const valuePerPayout = reward?.valuePerPayout ?? null;
  const frequency = benefit?.frequency ?? null;
  const estimatedAnnualValue =
    valuePerPayout !== null && frequency !== null && frequency > 0
      ? valuePerPayout * (DAYS_PER_YEAR / frequency)
      : null;

  // Capital basis: the current market value of the shares REQUIRED for the
  // benefit (not the user's whole position) — benefit-only economics, and
  // the UI says so.
  const yieldCapitalBasis =
    benefit?.requirement != null && price !== null ? benefit.requirement * price : null;
  const estimatedYieldPct =
    estimatedAnnualValue !== null && yieldCapitalBasis !== null && yieldCapitalBasis > 0
      ? (estimatedAnnualValue / yieldCapitalBasis) * 100
      : null;
  const estimatedPaybackDays =
    estimatedAnnualValue !== null && estimatedAnnualValue > 0 && yieldCapitalBasis !== null && yieldCapitalBasis > 0
      ? yieldCapitalBasis / (estimatedAnnualValue / DAYS_PER_YEAR)
      : null;

  return {
    id: catalog.id,
    name: catalog.name,
    acronym: catalog.acronym,
    owned,
    shares,
    positionValue,
    benefitDescription: benefit?.description ?? null,
    benefitRequirement: benefit?.requirement ?? null,
    benefitFrequencyDays: benefit?.frequency ?? null,
    benefitPassive: benefit?.passive ?? null,
    reward,
    benefitReached: reached,
    timing,
    missingShares,
    estimatedCostToBenefit,
    estimatedAnnualValue,
    estimatedYieldPct,
    estimatedPaybackDays,
    yieldCapitalBasis,
    priceCapturedAt: input.priceCapturedAt ?? null,
  };
}
