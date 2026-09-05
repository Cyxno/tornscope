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
