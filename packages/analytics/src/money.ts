import type { MoneyCategory, MoneyDirection, Provenance } from "@tornscope/shared";
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
