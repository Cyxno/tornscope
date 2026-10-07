import { humanLabel, INCOME_LABELS, EXPENSE_LABELS, type MoneyCategory, type MoneyDirection, type Provenance } from "@tornscope/shared";
import { bucketAxis, bucketStart, cumulative, type Interval } from "./series.js";

/**
 * Money ledger aggregation. All functions are pure; amounts are signed
 * numbers (positive = income, negative = expense) and unix seconds.
 */

export interface MoneyEventLike {
  id: string;
  occurredAt: number;
  category: MoneyCategory | string;
  subcategory?: string | null;
  direction: MoneyDirection;
  amount: number; // signed
  description?: string | null;
  source?: string;
  provenance?: Provenance;
}

export interface CategoryTotal {
  category: string;
  total: number;
}

export interface FlowPoint {
  t: number;
  income: number;
  expenses: number;
}

export interface MoneyAggregate {
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
  incomeByCategory: CategoryTotal[];
  expensesByCategory: CategoryTotal[];
  largestIncomeCategory: CategoryTotal | null;
  largestExpenseCategory: CategoryTotal | null;
  flowSeries: FlowPoint[];
  cumulativeNetSeries: Array<{ t: number; net: number }>;
  provenance: Provenance;
}

/** Filter events to a [from, to] window (unix seconds, inclusive). */
export function filterByRange<T extends { occurredAt: number }>(events: readonly T[], from: number, to: number): T[] {
  return events.filter((e) => e.occurredAt >= from && e.occurredAt <= to);
}

/**
 * Aggregate money events over a range.
 * Avoids double counting by design: the caller passes the deduplicated
 * ledger rows; each row is counted exactly once.
 */
export function aggregateMoneyEvents(
  events: readonly MoneyEventLike[],
  from: number,
  to: number,
  interval: Interval = "day"
): MoneyAggregate {
  const inRange = filterByRange(events, from, to);

  let totalIncome = 0;
  let totalExpenses = 0;
  const incomeByCat = new Map<string, number>();
  const expenseByCat = new Map<string, number>();

  for (const event of inRange) {
    if (event.amount === 0) continue;
    // Transfers (bank deposits/withdrawals, faction pool movements) keep a
    // ledger row but never count as income or spending; unknown-direction
    // rows are unclassified and stay out of P&L until classified.
    if (event.direction !== "income" && event.direction !== "expense") continue;
    const cat = String(event.category);
    if (event.amount > 0) {
      totalIncome += event.amount;
      incomeByCat.set(cat, (incomeByCat.get(cat) ?? 0) + event.amount);
    } else {
      totalExpenses += -event.amount;
      expenseByCat.set(cat, (expenseByCat.get(cat) ?? 0) + -event.amount);
    }
  }

  const toSorted = (m: Map<string, number>): CategoryTotal[] =>
    [...m.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);

  // Bucketed flow series on a contiguous axis.
  const axis = bucketAxis(from, to, interval);
  const incomeByBucket = new Map<number, number>();
  const expenseByBucket = new Map<number, number>();
  for (const event of inRange) {
    if (event.amount === 0) continue;
    if (event.direction !== "income" && event.direction !== "expense") continue; // transfers/unknown are not flows
    const b = bucketStart(event.occurredAt, interval);
    if (event.amount > 0) incomeByBucket.set(b, (incomeByBucket.get(b) ?? 0) + event.amount);
    else expenseByBucket.set(b, (expenseByBucket.get(b) ?? 0) + -event.amount);
  }
  const flowSeries = axis.map((t) => ({
    t,
    income: incomeByBucket.get(t) ?? 0,
    expenses: expenseByBucket.get(t) ?? 0,
  }));

  const netSeries = flowSeries.map((p) => ({ t: p.t, value: p.income - p.expenses }));

  const incomeByCategory = toSorted(incomeByCat);
  const expensesByCategory = toSorted(expenseByCat);

  return {
    totalIncome,
    totalExpenses,
    netProfit: totalIncome - totalExpenses,
    incomeByCategory,
    expensesByCategory,
    largestIncomeCategory: incomeByCategory[0] ?? null,
    largestExpenseCategory: expensesByCategory[0] ?? null,
    flowSeries,
    cumulativeNetSeries: cumulative(netSeries).map((p) => ({ t: p.t, net: p.value })),
    provenance: "exact",
  };
}

/** Daily/weekly/monthly totals for one direction. */
export function totalsByBucket(events: readonly MoneyEventLike[], interval: Interval, from: number, to: number): Array<{ t: number; total: number }> {
  const axis = bucketAxis(from, to, interval);
  const byBucket = new Map<number, number>();
  for (const event of filterByRange(events, from, to)) {
    if (event.amount === 0) continue;
    if (event.direction !== "income" && event.direction !== "expense") continue;
    const b = bucketStart(event.occurredAt, interval);
    byBucket.set(b, (byBucket.get(b) ?? 0) + Math.abs(event.amount));
  }
  return axis.map((t) => ({ t, total: byBucket.get(t) ?? 0 }));
}

/* -------------------------------------------------------------------------- */
/* Wallet cash bridge                                                          */
/* -------------------------------------------------------------------------- */

export interface WalletFlowRow {
  amount: number; // signed
  direction: MoneyDirection;
  category: string;
}

export interface WalletBridge {
  /** Wallet cash at the first snapshot at/before the range start. */
  startingCash: number | null;
  /** Wallet cash from the latest snapshot (actual, Torn-provided). */
  actualEndingCash: number | null;
  /** starting + all signed wallet movements. */
  expectedEndingCash: number | null;
  /** All money that entered the wallet (income rows + neutral positives). */
  walletInflow: number;
  /** All money that left the wallet (expense rows + neutral negatives). */
  walletOutflow: number;
  /** Wallet → bank movements (city/cayman invest/deposit, neutral). */
  bankDeposits: number;
  /** Bank → wallet movements (withdrawals/maturities, neutral). */
  bankWithdrawals: number;
  /**
   * Value received into the FACTION MEMBER BALANCE, not the wallet (Torn
   * credits OC payouts there). Excluded from wallet flows because the wallet
   * never sees it; the money is still owned — it is part of Extended Wealth
   * via the faction balance, never counted as spending or loss.
   */
  factionBalanceCredits: number;
  /** actual − expected; null when coverage is incomplete. */
  unreconciled: number | null;
  coverage: "full" | "partial" | "unavailable";
  provenance: Provenance;
}

const BANK_TRANSFER_CATEGORIES = new Set(["city_bank", "cayman_bank", "piggy_bank"]);

/**
 * Reconcile wallet cash for a range. Wallet semantics differ from economic
 * semantics: a bank investment IS a wallet outflow (cash left the wallet)
 * even though it is only an asset conversion economically. Coverage is
 * "full" only when both endpoint snapshots exist — the bridge never forces
 * equality when source coverage is incomplete.
 */
export function buildWalletBridge(
  flows: readonly WalletFlowRow[],
  startingCash: number | null,
  actualEndingCash: number | null,
  factionBalanceCredits = 0
): WalletBridge {
  let walletInflow = 0;
  let walletOutflow = 0;
  let bankDeposits = 0;
  let bankWithdrawals = 0;
  let net = 0;
  for (const row of flows) {
    if (row.amount === 0) continue;
    if (row.direction === "unknown") continue;
    if (row.direction === "neutral") {
      if (row.amount > 0) {
        walletInflow += row.amount;
        net += row.amount;
        if (BANK_TRANSFER_CATEGORIES.has(row.category)) bankWithdrawals += row.amount;
      } else {
        walletOutflow += -row.amount;
        net += row.amount;
        if (BANK_TRANSFER_CATEGORIES.has(row.category)) bankDeposits += -row.amount;
      }
      continue;
    }
    if (row.amount > 0) {
      walletInflow += row.amount;
      net += row.amount;
    } else {
      walletOutflow += -row.amount;
      net += row.amount;
    }
  }
  const coverage: WalletBridge["coverage"] =
    startingCash !== null && actualEndingCash !== null ? "full" : startingCash === null && actualEndingCash === null ? "unavailable" : "partial";
  const expectedEndingCash = startingCash !== null ? startingCash + net : null;
  const unreconciled = expectedEndingCash !== null && actualEndingCash !== null ? actualEndingCash - expectedEndingCash : null;
  return {
    startingCash,
    actualEndingCash,
    expectedEndingCash,
    walletInflow,
    walletOutflow,
    bankDeposits,
    bankWithdrawals,
    factionBalanceCredits,
    unreconciled,
    coverage,
    provenance: "exact",
  };
}

/* -------------------------------------------------------------------------- */
/* Economic semantics                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What a cash movement MEANS economically. In Torn, wealth constantly moves
 * between forms (cash, items, points, bank, faction balance), so:
 * - cash inflow is not automatically income (bazaar sales convert assets),
 * - cash outflow is not automatically an economic loss (buying points keeps
 *   the value owned),
 * - true income/expense changes total economic value directly.
 */
export type MoneySemantics =
  | "true_income" // earned / received: raises total value (salary, payouts, crime cash)
  | "true_expense" // consumed / lost / paid away: lowers total value (rehab, muggings, upkeep)
  | "asset_in" // asset -> cash (selling items/points/stocks)
  | "asset_out" // cash -> asset (buying items/points/stocks; still owned value)
  | "unknown"; // no defensible classification

/**
 * Classify one ledger row. Category is authoritative; the description only
 * refines ambiguous catch-alls (e.g. "Money receive" vs "Item use stash box").
 */
export function classifyMoneySemantics(event: {
  category: string;
  direction: MoneyDirection;
  description?: string | null;
}): MoneySemantics {
  if (event.direction !== "income" && event.direction !== "expense") return "unknown";
  const cat = event.category;
  const desc = event.description ?? "";
  const income = event.direction === "income";

  // Yield on owned value is true income, not a conversion: stock dividends pay
  // cash for shares you already hold, and bank interest (wherever a ledger row
  // carries it as income) is earned on deposited money. Paying interest
  // (loans) is symmetric true expense.
  if (/dividend|interest/i.test(desc)) return income ? "true_income" : "true_expense";

  switch (cat) {
    // Asset <-> cash conversions (value stays owned, in another form).
    case "bazaar":
    case "items":
    case "trading":
    case "auction":
    case "points":
    case "stock":
      return income ? "asset_in" : "asset_out";
    // Abroad purchases and consumable stock: cash -> inventory.
    case "travel":
    case "plushie":
    case "flower":
    case "drugs":
      return income ? "asset_in" : "asset_out";
    // Genuine earnings.
    case "crime":
    case "mugging":
    case "ranked_war":
    case "faction":
    case "salary":
    case "missions":
    case "casino":
      return income ? "true_income" : "true_expense";
    // Genuine costs of doing things.
    case "rehab":
    case "education":
    case "hospital":
    case "jail":
    case "housing":
    case "gym":
      return income ? "true_income" : "true_expense";
    // Banks are transfers (neutral direction already keeps them out of P&L);
    // if they ever arrive as income/expense rows they are conversions.
    case "city_bank":
    case "cayman_bank":
    case "piggy_bank":
      return "asset_in";
    case "other":
      // Player transfers are real cash flow; item-derived cash is a sale.
      if (/item use/i.test(desc)) return income ? "asset_in" : "asset_out";
      return income ? "true_income" : "true_expense";
    default:
      return "unknown";
  }
}

export interface MoneySemanticsAggregate {
  /** All cash that entered the wallet (true_income + asset_in). */
  cashInflow: number;
  /** All cash that left the wallet (true_expense + asset_out). */
  cashOutflow: number;
  /** Earned/received money (raises total value directly). */
  trueIncome: number;
  /** Spent/lost money (lowers total value directly). */
  trueExpense: number;
  /** Cash received from selling assets. */
  assetInflow: number;
  /** Cash spent acquiring assets (still owned in another form). */
  assetOutflow: number;
  /** Rows that could not be classified (summed magnitude). */
  unknownValue: number;
  unknownCount: number;
  /** Internal movements between owned accounts (bank invest/withdraw etc.). */
  bankTransfers: number;
  /** Per-category totals within each semantic class. */
  inflowByCategory: CategoryTotal[];
  outflowByCategory: CategoryTotal[];
  provenance: Provenance;
}

/** Aggregate ledger rows into cash-flow vs economic semantics. */
export function aggregateMoneySemantics(events: readonly MoneyEventLike[], from: number, to: number): MoneySemanticsAggregate {
  let cashInflow = 0;
  let cashOutflow = 0;
  let trueIncome = 0;
  let trueExpense = 0;
  let assetInflow = 0;
  let assetOutflow = 0;
  let unknownValue = 0;
  let unknownCount = 0;
  let bankTransfers = 0;
  const inflowByCat = new Map<string, number>();
  const outflowByCat = new Map<string, number>();

  for (const event of filterByRange(events, from, to)) {
    if (event.amount === 0) continue;
    // Neutral rows are internal movements between owned accounts (bank
    // invest/withdraw, faction pool) — known conversions, not "unclassified"
    // and not wallet inflow/outflow. They are reported separately.
    if (event.direction === "neutral") {
      bankTransfers += Math.abs(event.amount);
      continue;
    }
    const kind = classifyMoneySemantics(event);
    const magnitude = Math.abs(event.amount);
    if (kind === "unknown") {
      unknownValue += magnitude;
      unknownCount += 1;
      continue;
    }
    const inflow = event.amount > 0;
    if (inflow) {
      cashInflow += event.amount;
      inflowByCat.set(event.category, (inflowByCat.get(event.category) ?? 0) + event.amount);
    } else {
      cashOutflow += magnitude;
      outflowByCat.set(event.category, (outflowByCat.get(event.category) ?? 0) + magnitude);
    }
    if (kind === "true_income") trueIncome += event.amount;
    else if (kind === "true_expense") trueExpense += magnitude;
    else if (kind === "asset_in") assetInflow += event.amount;
    else if (kind === "asset_out") assetOutflow += magnitude;
  }

  const toSorted = (m: Map<string, number>): CategoryTotal[] =>
    [...m.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);

  return {
    cashInflow,
    cashOutflow,
    trueIncome,
    trueExpense,
    assetInflow,
    assetOutflow,
    unknownValue,
    unknownCount,
    bankTransfers,
    inflowByCategory: toSorted(inflowByCat),
    outflowByCategory: toSorted(outflowByCat),
    provenance: "exact",
  };
}

/* -------------------------------------------------------------------------- */
/* Cash received / spent breakdown (reconciling)                               */
/* -------------------------------------------------------------------------- */

/**
 * Canonical finance label maps — defined ONCE in @tornscope/shared and
 * re-exported here so every chart, table and card uses the same strings.
 */
export const CASH_INCOME_LABELS: Record<string, string> = INCOME_LABELS;
export const CASH_EXPENSE_LABELS: Record<string, string> = EXPENSE_LABELS;
const financeIncomeLabel = (category: string): string => INCOME_LABELS[category] ?? humanLabel(category);
const financeExpenseLabel = (category: string): string => EXPENSE_LABELS[category] ?? humanLabel(category);

/** Income categories that are earnings (raise total value directly). */
const EARNED_INCOME_CATEGORIES = new Set(["crime", "mugging", "ranked_war", "salary", "missions", "casino", "faction"]);
/** Income categories that are asset -> cash conversions. */
const ASSET_SALE_CATEGORIES = new Set(["bazaar", "items", "trading", "auction", "points", "stock", "travel", "plushie", "flower", "drugs"]);

export interface CashFlowEventLike {
  category: string;
  direction: MoneyDirection;
  /** Signed; positive = received. */
  amount: number;
  /** Faction income carrying OC scenario metadata (an OC payout credited to
   * the faction member balance — earned, but not wallet cash). */
  ocPayout?: boolean;
}

export interface CashFlowRow {
  /** Stable bucket id ( OC payouts split faction income). */
  key: string;
  /** Explicit user-facing label. */
  label: string;
  amount: number;
}

export interface CashReceivedBreakdown {
  /** Exactly the income that aggregateMoneySemantics counts as cashInflow. */
  total: number;
  earned: { total: number; ocPayouts: number; rows: CashFlowRow[] };
  assetSales: { total: number; rows: CashFlowRow[] };
  /** Income that could not be classified as earned or asset sale. */
  other: { total: number; rows: CashFlowRow[] };
  /** Unclassifiable income rows — reported, never silently folded in. */
  unclassified: { total: number; count: number };
}

/**
 * Partition received cash into earned income vs asset sales vs other, with
 * per-row labels. Construction guarantees `earned.total + assetSales.total +
 * other.total === total` and no event is counted twice. OC payouts stay in
 * earned income with their own row (the wallet section explains they credit
 * the faction balance, not the wallet).
 */
export function buildCashReceivedBreakdown(events: readonly CashFlowEventLike[]): CashReceivedBreakdown {
  const earnedRows = new Map<string, CashFlowRow>();
  const assetRows = new Map<string, CashFlowRow>();
  const otherRows = new Map<string, CashFlowRow>();
  let earnedTotal = 0;
  let ocPayouts = 0;
  let assetTotal = 0;
  let otherTotal = 0;
  let total = 0;
  let unclassifiedTotal = 0;
  let unclassifiedCount = 0;

  const addRow = (map: Map<string, CashFlowRow>, key: string, label: string, amount: number): void => {
    const existing = map.get(key);
    if (existing) existing.amount += amount;
    else map.set(key, { key, label, amount });
  };

  for (const event of events) {
    if (event.amount === 0) continue;
    if (event.direction !== "income") continue;
    // Mirror aggregateMoneySemantics: neutral rows are internal movements and
    // unknown-direction rows are never counted as received.
    if (classifyMoneySemantics(event) === "unknown") {
      unclassifiedTotal += Math.abs(event.amount);
      unclassifiedCount += 1;
      continue;
    }
    total += event.amount;
    const isOcPayout = event.ocPayout === true;
    if (event.category === "faction" && isOcPayout) {
      earnedTotal += event.amount;
      ocPayouts += event.amount;
      addRow(earnedRows, "oc_payout", "OC payouts (credited to faction balance)", event.amount);
      continue;
    }
    if (EARNED_INCOME_CATEGORIES.has(event.category)) {
      earnedTotal += event.amount;
      const label = event.category === "faction" ? "Faction income" : financeIncomeLabel(event.category);
      addRow(earnedRows, event.category, label, event.amount);
      continue;
    }
    if (ASSET_SALE_CATEGORIES.has(event.category)) {
      assetTotal += event.amount;
      addRow(assetRows, event.category, financeIncomeLabel(event.category), event.amount);
      continue;
    }
    otherTotal += event.amount;
    addRow(otherRows, event.category, financeIncomeLabel(event.category), event.amount);
  }

  const sortRows = (map: Map<string, CashFlowRow>): CashFlowRow[] =>
    [...map.values()].sort((a, b) => b.amount - a.amount);

  return {
    total,
    earned: { total: earnedTotal, ocPayouts, rows: sortRows(earnedRows) },
    assetSales: { total: assetTotal, rows: sortRows(assetRows) },
    other: { total: otherTotal, rows: sortRows(otherRows) },
    unclassified: { total: unclassifiedTotal, count: unclassifiedCount },
  };
}

export interface CashSpentBreakdown {
  total: number;
  /** True expenses (value consumed/lost). */
  expenses: { total: number; rows: CashFlowRow[] };
  /** Asset purchases (cash -> owned asset). */
  assetPurchases: { total: number; rows: CashFlowRow[] };
  other: { total: number; rows: CashFlowRow[] };
  unclassified: { total: number; count: number };
}

/** Mirror of buildCashReceivedBreakdown for the spending side. */
export function buildCashSpentBreakdown(events: readonly CashFlowEventLike[]): CashSpentBreakdown {
  const expenseRows = new Map<string, CashFlowRow>();
  const assetRows = new Map<string, CashFlowRow>();
  const otherRows = new Map<string, CashFlowRow>();
  let expenseTotal = 0;
  let assetTotal = 0;
  let otherTotal = 0;
  let total = 0;
  let unclassifiedTotal = 0;
  let unclassifiedCount = 0;

  const addRow = (map: Map<string, CashFlowRow>, key: string, label: string, amount: number): void => {
    const existing = map.get(key);
    if (existing) existing.amount += amount;
    else map.set(key, { key, label, amount });
  };

  for (const event of events) {
    const magnitude = Math.abs(event.amount);
    if (event.amount === 0 || event.direction !== "expense") continue;
    if (classifyMoneySemantics(event) === "unknown") {
      unclassifiedTotal += magnitude;
      unclassifiedCount += 1;
      continue;
    }
    total += magnitude;
    if (EARNED_INCOME_CATEGORIES.has(event.category) || ["rehab", "education", "hospital", "jail", "housing", "gym"].includes(event.category)) {
      expenseTotal += magnitude;
      addRow(expenseRows, event.category, financeExpenseLabel(event.category), magnitude);
      continue;
    }
    if (ASSET_SALE_CATEGORIES.has(event.category)) {
      assetTotal += magnitude;
      addRow(assetRows, event.category, financeExpenseLabel(event.category), magnitude);
      continue;
    }
    otherTotal += magnitude;
    addRow(otherRows, event.category, financeExpenseLabel(event.category), magnitude);
  }

  const sortRows = (map: Map<string, CashFlowRow>): CashFlowRow[] =>
    [...map.values()].sort((a, b) => b.amount - a.amount);

  return {
    total,
    expenses: { total: expenseTotal, rows: sortRows(expenseRows) },
    assetPurchases: { total: assetTotal, rows: sortRows(assetRows) },
    other: { total: otherTotal, rows: sortRows(otherRows) },
    unclassified: { total: unclassifiedTotal, count: unclassifiedCount },
  };
}

/* -------------------------------------------------------------------------- */
/* Bank interest (derived — principal return is never income)                   */
/* -------------------------------------------------------------------------- */

/**
 * Bank maturity pays back the principal AND the interest in one withdrawal —
 * the historical log carries only the total. The interest (the only true
 * income here) must therefore be DERIVED, never booked from the raw amount.
 *
 * Model, per bank pool (city / cayman / piggy) over the range:
 *   surplus = Σ withdrawals − Σ investments
 * When every invest/withdraw pair lies inside the range the surplus IS the
 * interest — exact, whatever the interleaving. When withdrawals exceed the
 * recorded investments beyond any plausible yield (Torn's top rates are
 * ≈11% per term, so anything over MAX_PLAUSIBLE_INTEREST_RATIO of the
 * recorded principal is principal from investments that predate the range),
 * the split is unattributable: no income is claimed and `complete` goes
 * false. A negative surplus is principal still returning — never negative
 * income.
 */
export const MAX_PLAUSIBLE_INTEREST_RATIO = 0.5;

export interface BankInterestDerivation {
  /** Derived interest earned on matured investments (true income). */
  interestIncome: number;
  /** Principal returned to the wallet on attributed withdrawals. */
  principalReturned: number;
  /** Yield-bearing withdrawals whose principal/interest split is not attributable. */
  unattributableWithdrawals: number;
  /** Recorded principal still invested (or awaiting withdrawal) at range end. */
  principalStillInvested: number;
  /** true when every bank pool's surplus was attributable. */
  complete: boolean;
  provenance: "derived";
}

export function deriveBankInterest(events: readonly MoneyEventLike[], from: number, to: number): BankInterestDerivation {
  let interestIncome = 0;
  let principalReturned = 0;
  let unattributableWithdrawals = 0;
  let principalStillInvested = 0;
  let complete = true;

  for (const bank of BANK_TRANSFER_CATEGORIES) {
    let deposits = 0;
    let withdrawals = 0;
    for (const e of filterByRange(events, from, to)) {
      if (e.direction !== "neutral" || e.category !== bank || e.amount === 0) continue;
      if (e.amount < 0) deposits += -e.amount;
      else withdrawals += e.amount;
    }
    const surplus = withdrawals - deposits;
    if (surplus <= 0) {
      // All principal (or investments still held): no income to claim.
      principalReturned += withdrawals;
      principalStillInvested += -surplus;
      continue;
    }
    if (deposits > 0 && surplus <= deposits * MAX_PLAUSIBLE_INTEREST_RATIO) {
      interestIncome += surplus;
      principalReturned += deposits;
    } else {
      // Principal predates recorded history: the split is unknowable.
      unattributableWithdrawals += surplus;
      principalReturned += withdrawals - surplus; // matched principal, if any
      complete = false;
    }
  }

  return {
    interestIncome,
    principalReturned,
    unattributableWithdrawals,
    principalStillInvested,
    complete,
    provenance: "derived",
  };
}

/** The bank transfer categories (wallet ↔ bank), shared by all economy math. */
export function isBankTransferCategory(category: string): boolean {
  return BANK_TRANSFER_CATEGORIES.has(category);
}

/* -------------------------------------------------------------------------- */
/* Asset conversions                                                            */
/* -------------------------------------------------------------------------- */

export interface ConversionRow {
  /** Stable pair id, e.g. "cash->bank" or "items->cash". */
  pair: string;
  label: string;
  /** Total moved (magnitude). */
  amount: number;
  count: number;
}

export interface ConversionsAggregate {
  /** Wallet cash spent acquiring assets (bank deposits, stock/item/point buys, vault deposits). */
  cashIntoAssets: number;
  /** Assets sold/redeemed into wallet cash. */
  assetsIntoCash: number;
  /** assetsIntoCash − cashIntoAssets. */
  netCashEffect: number;
  /** Subset of the above that moved through bank accounts (both directions, magnitude). */
  bankTransfers: number;
  byPair: ConversionRow[];
  provenance: "exact";
}

/**
 * Conversion pair table. Neutral rows are own-pool movements (bank, faction
 * vault); non-neutral rows qualify only when their economic semantics say
 * asset_in/asset_out — earned income and true expenses never appear here.
 */
const CONVERSION_PAIR_BY_CATEGORY: Record<string, { into: [string, string]; outOf: [string, string] }> = {
  city_bank: { into: ["cash->bank", "Cash → Bank"], outOf: ["bank->cash", "Bank → Cash"] },
  cayman_bank: { into: ["cash->bank", "Cash → Cayman"], outOf: ["bank->cash", "Cayman → Cash"] },
  piggy_bank: { into: ["cash->bank", "Cash → Piggy Bank"], outOf: ["bank->cash", "Piggy Bank → Cash"] },
  faction: { into: ["cash->faction", "Cash → Faction vault"], outOf: ["faction->cash", "Faction vault → Cash"] },
  stock: { into: ["cash->stocks", "Cash → Stocks"], outOf: ["stocks->cash", "Stocks → Cash"] },
  points: { into: ["cash->points", "Cash → Points"], outOf: ["points->cash", "Points → Cash"] },
  bazaar: { into: ["cash->items", "Cash → Items"], outOf: ["items->cash", "Items → Cash"] },
  items: { into: ["cash->items", "Cash → Items"], outOf: ["items->cash", "Items → Cash"] },
  trading: { into: ["cash->items", "Cash → Items"], outOf: ["items->cash", "Items → Cash"] },
  auction: { into: ["cash->items", "Cash → Items"], outOf: ["items->cash", "Items → Cash"] },
  travel: { into: ["cash->items", "Cash → Items"], outOf: ["items->cash", "Items → Cash"] },
  plushie: { into: ["cash->items", "Cash → Items"], outOf: ["items->cash", "Items → Cash"] },
  flower: { into: ["cash->items", "Cash → Items"], outOf: ["items->cash", "Items → Cash"] },
  drugs: { into: ["cash->items", "Cash → Items"], outOf: ["items->cash", "Items → Cash"] },
};

/** Aggregate cash ↔ asset conversions for a range (bank + vault + item/stock/point trades). */
export function aggregateConversions(events: readonly MoneyEventLike[], from: number, to: number): ConversionsAggregate {
  let cashIntoAssets = 0;
  let assetsIntoCash = 0;
  let bankTransfers = 0;
  const byPair = new Map<string, ConversionRow>();

  const add = (pair: [string, string], amount: number): void => {
    if (pair[0].startsWith("cash->")) cashIntoAssets += amount;
    else assetsIntoCash += amount;
    const existing = byPair.get(pair[0]);
    if (existing) {
      existing.amount += amount;
      existing.count += 1;
    } else {
      byPair.set(pair[0], { pair: pair[0], label: pair[1], amount, count: 1 });
    }
  };

  for (const event of filterByRange(events, from, to)) {
    if (event.amount === 0) continue;
    const magnitude = Math.abs(event.amount);
    const pairTable = CONVERSION_PAIR_BY_CATEGORY[event.category];
    if (!pairTable) continue;
    if (event.direction === "neutral") {
      const pair = event.amount > 0 ? pairTable.outOf : pairTable.into;
      add(pair, magnitude);
      if (isBankTransferCategory(event.category)) bankTransfers += magnitude;
      continue;
    }
    // Non-neutral rows must be conversions semantically — yields (dividends,
    // interest) and earned income are excluded here.
    const kind = classifyMoneySemantics(event);
    if (kind === "asset_out") add(pairTable.into, magnitude);
    else if (kind === "asset_in") add(pairTable.outOf, magnitude);
  }

  const rows = [...byPair.values()].sort((a, b) => b.amount - a.amount || a.pair.localeCompare(b.pair));
  return {
    cashIntoAssets,
    assetsIntoCash,
    netCashEffect: assetsIntoCash - cashIntoAssets,
    bankTransfers,
    byPair: rows,
    provenance: "exact",
  };
}

/* -------------------------------------------------------------------------- */
/* Wallet reconciliation quality                                                */
/* -------------------------------------------------------------------------- */

export type ReconciliationQuality = "exact" | "small_residual" | "partial" | "unreconciled" | "unavailable";

/**
 * Grade a wallet reconciliation. Anchors missing → unavailable (never a
 * fabricated grade). Known money-log coverage gaps cap the grade at partial
 * — a perfect-looking residual over a partial history is luck, not proof.
 * `exact` is reserved for sub-dollar residuals; `small_residual` allows a
 * tiny fraction of the recorded flow; anything larger is unreconciled.
 */
export function classifyReconciliation(input: {
  openingWallet: number | null;
  closingWallet: number | null;
  residual: number | null;
  inflows: number;
  outflows: number;
  coverageGap: boolean;
}): ReconciliationQuality {
  if (input.openingWallet === null || input.closingWallet === null || input.residual === null) return "unavailable";
  if (input.coverageGap) return "partial";
  const abs = Math.abs(input.residual);
  if (abs < 1) return "exact"; // sub-dollar: rounding only
  const flow = input.inflows + input.outflows;
  if (abs <= Math.max(1_000, flow * 0.002)) return "small_residual";
  return "unreconciled";
}

/**
 * Share of the actual wallet change that recorded movements explain
 * (0..1). null when the ratio is meaningless: missing anchors, or a zero
 * wallet change with a non-zero residual (division by zero).
 */
export function explainedRatio(residual: number | null, openingWallet: number | null, closingWallet: number | null): number | null {
  if (residual === null || openingWallet === null || closingWallet === null) return null;
  const change = closingWallet - openingWallet;
  if (Math.abs(change) < 1) return Math.abs(residual) < 1 ? 1 : null;
  return Math.max(0, Math.min(1, 1 - Math.abs(residual) / Math.abs(change)));
}

/* -------------------------------------------------------------------------- */
/* Major movements                                                              */
/* -------------------------------------------------------------------------- */

export type MovementRole = "income" | "expense" | "conversion_in" | "conversion_out" | "transfer";

export interface MajorMovement {
  id: string;
  occurredAt: number;
  category: string;
  label: string;
  description: string | null;
  role: MovementRole;
  /** Magnitude (always positive). */
  amount: number;
}

/**
 * Largest meaningful movements in a range, across ALL semantic roles so a
 * huge bank investment is never crowded out by sale proceeds. The floor is
 * adaptive: 0.1% of total recorded magnitude (min $1k) keeps $5k events out
 * of a multi-billion account. Deterministic: magnitude desc, then time asc,
 * then id.
 */
export function majorMoneyMovements(events: readonly MoneyEventLike[], from: number, to: number, opts?: { limit?: number }): MajorMovement[] {
  const limit = opts?.limit ?? 8;
  const inRange = filterByRange(events, from, to).filter((e) => e.amount !== 0 && e.direction !== "unknown");
  const totalMagnitude = inRange.reduce((s, e) => s + Math.abs(e.amount), 0);
  const floor = Math.max(1_000, totalMagnitude * 0.001);

  const rows: MajorMovement[] = [];
  for (const e of inRange) {
    const magnitude = Math.abs(e.amount);
    if (magnitude < floor) continue;
    let role: MovementRole;
    let label: string;
    if (e.direction === "neutral") {
      role = "transfer";
      label = humanLabel(e.category);
    } else {
      const kind = classifyMoneySemantics(e);
      if (kind === "true_income") {
        role = "income";
        label = financeIncomeLabel(e.category);
      } else if (kind === "true_expense") {
        role = "expense";
        label = financeExpenseLabel(e.category);
      } else if (kind === "asset_in") {
        role = "conversion_in";
        label = financeIncomeLabel(e.category);
      } else if (kind === "asset_out") {
        role = "conversion_out";
        label = financeExpenseLabel(e.category);
      } else {
        continue; // unknown semantics never surface as a major movement
      }
    }
    rows.push({
      id: e.id,
      occurredAt: e.occurredAt,
      category: String(e.category),
      label,
      description: e.description ?? null,
      role,
      amount: magnitude,
    });
  }

  return rows.sort((a, b) => b.amount - a.amount || a.occurredAt - b.occurredAt || a.id.localeCompare(b.id)).slice(0, limit);
}


/* -------------------------------------------------------------------------- */
/* Internal transfers (2.6.0): vault + bank movements, never P/L               */
/* -------------------------------------------------------------------------- */

export interface InternalTransferRowLike {
  category: string;
  direction: string;
  amount: bigint;
}

export interface InternalTransferAccount {
  category: string;
  label: string;
  deposited: number;
  withdrawn: number;
  moved: number;
  rows: number;
}

export interface InternalTransfersSummary {
  deposited: number;
  withdrawn: number;
  moved: number;
  byAccount: InternalTransferAccount[];
  provenance: "exact";
}

const INTERNAL_TRANSFER_LABELS: Record<string, string> = {
  vault: "Vault",
  city_bank: "City bank",
  cayman_bank: "Cayman bank",
};

/**
 * Aggregate NEUTRAL own-pool movements (vault deposits/withdrawals, bank
 * deposits/withdrawals) into a per-account transfer view. Direction-neutral
 * by definition: these rows NEVER enter income, expenses, net or alerts —
 * this function only makes their volume visible.
 */
export function buildInternalTransfers(rows: readonly InternalTransferRowLike[]): InternalTransfersSummary {
  const accounts = new Map<string, InternalTransferAccount>();
  let deposited = 0;
  let withdrawn = 0;
  for (const row of rows) {
    const label = INTERNAL_TRANSFER_LABELS[row.category];
    if (label === undefined) continue; // only known internal accounts
    if (row.direction !== "neutral") continue; // defensive: transfers are neutral
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    let account = accounts.get(row.category);
    if (!account) {
      account = { category: row.category, label, deposited: 0, withdrawn: 0, moved: 0, rows: 0 };
      accounts.set(row.category, account);
    }
    if (amount > 0) {
      account.withdrawn += amount;
      withdrawn += amount;
    } else {
      account.deposited += -amount;
      deposited += -amount;
    }
    account.rows += 1;
    account.moved = account.deposited + account.withdrawn;
  }
  const byAccount = [...accounts.values()].sort((a, b) => b.moved - a.moved);
  return { deposited, withdrawn, moved: deposited + withdrawn, byAccount, provenance: "exact" };
}
