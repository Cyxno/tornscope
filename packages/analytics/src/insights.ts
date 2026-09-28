import {
  INSIGHT_KIND_META,
  type Insight,
  type InsightCategory,
  type InsightConfidence,
  type InsightKind,
  type InsightPriority,
} from "@tornscope/shared";
import type { MoneyEventLike } from "./money.js";
import { classifyMoneySemantics } from "./money.js";
import type { TrainingSession } from "./progression.js";
import type { RehabEventLike } from "./rehab.js";
import type { TravelTripLike } from "./travel.js";
import { calculateItemProfit } from "./travel.js";
import type { NetworthSnapshotFields } from "./networth.js";
import { startOfDay, startOfWeek } from "./series.js";

/**
 * Personal insights engine (2.0) — deterministic, curated rules over stored
 * history. Every rule COMPARES a current period against an explicit baseline
 * period, gates on minimum sample size and significance, and stays silent
 * when the data does not support a statement. Absence is a feature: a user
 * with two weeks of history gets no "growth slowed" insight, period.
 *
 * Semantics notes:
 * - Income/spending are TRUE semantics (classifyMoneySemantics): asset sales
 *   and purchases never read as income/expense, internal transfers never
 *   appear at all — the wealth-first philosophy is inherited, not re-derived.
 * - Travel profit reuses the estimated-resale convention (provenance
 *   "estimated" on those figures).
 * - No rule claims causality; wording is strictly observational.
 */

const DAY = 86_400;

/** Shared significance gates. Tests pin these numbers. */
export const INSIGHT_POLICY = {
  /** Relative change required for a "shift" insight. */
  SHIFT_RELATIVE_PCT: 25,
  /** Smaller relative change required for slow-moving wealth trends. */
  WEALTH_SHIFT_RELATIVE_PCT: 30,
  /** Absolute money floor per day beneath which shifts are noise. */
  MONEY_DAILY_FLOOR: 100_000,
  /** Absolute money floor for single-day records. */
  MONEY_DAY_RECORD_FLOOR: 1_000_000,
  /** Training efficiency shift threshold (relative %). */
  TRAINING_EFFICIENCY_PCT: 12,
  /** Min sessions in the current window for training rules. */
  TRAINING_MIN_SESSIONS: 3,
  /** Min baseline sessions for training rules. */
  TRAINING_MIN_BASELINE_SESSIONS: 6,
  /** Min trips for travel rules. */
  TRAVEL_MIN_TRIPS_CURRENT: 2,
  TRAVEL_MIN_TRIPS_BASELINE: 3,
  /** Energy-at-cap elevation threshold (relative %). */
  ENERGY_CAPPED_PCT: 50,
  /** Max insights returned (feed hygiene). */
  MAX_INSIGHTS: 8,
} as const;

/** Raw facts the rules consume. The API fills this from stored rows ONCE. */
export interface InsightInputs {
  now: number;
  /** Net worth snapshots (full columns — the contributor rule needs them). */
  networthSnapshots: ReadonlyArray<NetworthSnapshotFields>;
  /** Money ledger rows covering the longest window a rule uses (≥ 90d + baseline). */
  moneyEvents: ReadonlyArray<MoneyEventLike>;
  /** Assembled trips. */
  travelTrips: ReadonlyArray<TravelTripLike>;
  /** Rehab log rows. */
  rehabEvents: ReadonlyArray<RehabEventLike>;
  /** Cumulative xanax counter from personalstats snapshots (nulls allowed). */
  xanaxCounter: ReadonlyArray<{ t: number; xanax: number | null }>;
  /** Inferred training sessions. */
  trainingSessions: ReadonlyArray<TrainingSession>;
  /** Hours per UTC day the energy bar sat at cap (from BarsSnapshot). */
  energyCappedHours: ReadonlyArray<{ t: number; hours: number }>;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid]! + sorted[mid - 1]!) / 2;
}

function pctDelta(baseline: number, current: number): number | null {
  if (baseline === 0) return null;
  return ((current - baseline) / Math.abs(baseline)) * 100;
}

function round3(value: number): number {
  if (value === 0) return 0;
  const abs = Math.abs(value);
  const digits = Math.max(0, 3 - Math.floor(Math.log10(abs)) - 1);
  return Number(value.toFixed(digits));
}

/**
 * Per-day TRUE income/expense from the ledger (semantics-classified; asset
 * flows excluded, neutral transfers excluded). Days with no rows are absent
 * from the map — callers treat missing days as zero explicitly.
 */
function dailyTrueFlow(events: ReadonlyArray<MoneyEventLike>, from: number, to: number): { income: Map<number, number>; expense: Map<number, number> } {
  const income = new Map<number, number>();
  const expense = new Map<number, number>();
  for (const event of events) {
    if (event.occurredAt < from || event.occurredAt > to || event.amount === 0) continue;
    const kind = classifyMoneySemantics(event);
    if (kind === "true_income") {
      const day = startOfDay(event.occurredAt);
      income.set(day, (income.get(day) ?? 0) + Math.abs(event.amount));
    } else if (kind === "true_expense") {
      const day = startOfDay(event.occurredAt);
      expense.set(day, (expense.get(day) ?? 0) + Math.abs(event.amount));
    }
  }
  return { income, expense };
}

/** Mean daily value across every day in [from, to] (missing days count 0). */
function meanDaily(map: Map<number, number>, from: number, to: number): { mean: number | null; days: number } {
  const days = Math.max(1, Math.floor((to - from) / DAY));
  let total = 0;
  for (const [day, value] of map) {
    if (day >= startOfDay(from) && day <= startOfDay(to)) total += value;
  }
  return { mean: total / days, days };
}

/** Travel profit per trip (estimated resale − cost; unpriced items count as cost). */
function tripProfit(trip: TravelTripLike): { profit: number; priced: boolean } {
  let profit = 0;
  let priced = true;
  for (const item of trip.items) {
    const itemProfit = calculateItemProfit(item);
    if (itemProfit === null) priced = false;
    profit += itemProfit ?? -item.totalCost;
  }
  return { profit, priced };
}

function insight(
  kind: InsightKind,
  identity: string,
  priority: InsightPriority,
  confidence: InsightConfidence,
  provenance: Insight["provenance"],  now: number,
  evidence: { from: number; to: number; sampleSize: number; baselineDays: number },
  comparison: Insight["comparison"],
  title: string,
  detail: string,
  sensitiveDetail: string | null,
  clickPath: string
): Insight {
  const meta = INSIGHT_KIND_META[kind];
  const dedupeKey = `${kind}:${identity}`;
  return {
    id: dedupeKey,
    kind,
    category: meta.category as InsightCategory,
    priority,
    title,
    detail,
    sensitiveDetail,
    comparison: { ...comparison, delta: round3(comparison.delta), baselineValue: round3(comparison.baselineValue), currentValue: round3(comparison.currentValue) },
    evidence,
    confidence,
    provenance,
    dedupeKey,
    occurredAt: evidence.to,
    clickPath,
  };
}

/** Sensitive-detail money formatting: explicit currency, whole units. */
function moneyStr(value: number): string {
  return "$" + Math.round(value).toLocaleString("en-US");
}

/** Period identity for dedupe keys: the UTC week bucket of `now`. */
function weeklyIdentity(now: number): string {
  return String(startOfWeek(now));
}

/** Period identity for dedupe keys: the UTC month bucket of `now`. */
function monthlyIdentity(now: number): string {
  const d = new Date(now * 1000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

type Rule = (inputs: InsightInputs) => Insight | null;

/** Net worth 30-day velocity vs the prior 30 days. */
const networthGrowthShift: Rule = (inputs) => {
  const { now, networthSnapshots } = inputs;
  if (networthSnapshots.length < 8) return null;
  const sorted = [...networthSnapshots].sort((a, b) => a.capturedAt - b.capturedAt);
  const currentFrom = now - 30 * DAY;
  const priorFrom = now - 60 * DAY;

  const velocityFor = (from: number, to: number): { perDay: number | null; points: number } => {
    const inRange = sorted.filter((s) => s.capturedAt >= from && s.capturedAt <= to);
    if (inRange.length < 4) return { perDay: null, points: inRange.length };
    const first = inRange[0]!;
    const last = inRange[inRange.length - 1]!;
    const spanDays = (last.capturedAt - first.capturedAt) / DAY;
    if (spanDays < 3) return { perDay: null, points: inRange.length };
    return { perDay: (last.total - first.total) / spanDays, points: inRange.length };
  };

  const current = velocityFor(currentFrom, now);
  const prior = velocityFor(priorFrom, currentFrom);
  if (current.perDay === null || prior.perDay === null) return null;
  if (Math.abs(prior.perDay) < 1000) return null; // prior velocity ~0 — no meaningful baseline
  const changePct = pctDelta(prior.perDay, current.perDay);
  if (changePct === null || Math.abs(changePct) < INSIGHT_POLICY.WEALTH_SHIFT_RELATIVE_PCT) return null;
  // Both velocities must move real money.
  if (Math.abs(current.perDay) < INSIGHT_POLICY.MONEY_DAILY_FLOOR) return null;

  const slowed = current.perDay < prior.perDay;
  const currentWn = sorted.filter((s) => s.capturedAt >= currentFrom).length;
  return insight(
    "networth_growth_shift",
    monthlyIdentity(now),
    slowed ? "normal" : "low",
    currentWn >= 20 ? "high" : "medium",
    "exact",
    now,
    { from: currentFrom, to: now, sampleSize: current.points, baselineDays: 30 },
    { metric: "Net worth velocity", baselineLabel: "previous 30 days", baselineValue: prior.perDay, currentValue: current.perDay, delta: current.perDay - prior.perDay, deltaPct: changePct, unit: "money" },
    slowed ? "Net worth growth slowed" : "Net worth growth accelerated",
    slowed
      ? "Your wealth is still growing, but noticeably slower than in the previous 30 days."
      : "Your wealth is growing faster than in the previous 30 days.",
    `Net worth velocity: ${moneyStr(current.perDay)}/day vs ${moneyStr(prior.perDay)}/day previously.`,
    "/money"
  );
};

/** True income 7d vs the prior 30-day baseline. */
const incomeShift: Rule = (inputs) => {
  const { now, moneyEvents } = inputs;
  const currentFrom = now - 7 * DAY;
  const priorFrom = currentFrom - 30 * DAY;
  const flow = dailyTrueFlow(moneyEvents, priorFrom, now);
  const current = meanDaily(flow.income, currentFrom, now);
  const prior = meanDaily(flow.income, priorFrom, currentFrom);
  if (current.mean === null || prior.mean === null) return null;
  if (prior.mean < INSIGHT_POLICY.MONEY_DAILY_FLOOR) return null;
  const changePct = pctDelta(prior.mean, current.mean);
  if (changePct === null || Math.abs(changePct) < INSIGHT_POLICY.SHIFT_RELATIVE_PCT) return null;
  const up = current.mean > prior.mean;
  return insight(
    "income_shift",
    weeklyIdentity(now),
    up ? "normal" : "normal",
    "medium",
    "exact",
    now,
    { from: currentFrom, to: now, sampleSize: 7, baselineDays: 30 },
    { metric: "Daily income", baselineLabel: "30-day average", baselineValue: prior.mean, currentValue: current.mean, delta: current.mean - prior.mean, deltaPct: changePct, unit: "money" },
    up ? "Income above your average" : "Income below your average",
    up
      ? "The past week's daily income ran well above your 30-day average."
      : "The past week's daily income ran well below your 30-day average.",
    `Daily true income averaged ${moneyStr(current.mean)} vs a 30-day average of ${moneyStr(prior.mean)}.`,
    "/money"
  );
};

/** True spending 7d vs the prior 30-day baseline — spikes only. */
const spendingSpike: Rule = (inputs) => {
  const { now, moneyEvents } = inputs;
  const currentFrom = now - 7 * DAY;
  const priorFrom = currentFrom - 30 * DAY;
  const flow = dailyTrueFlow(moneyEvents, priorFrom, now);
  const current = meanDaily(flow.expense, currentFrom, now);
  const prior = meanDaily(flow.expense, priorFrom, currentFrom);
  if (current.mean === null || prior.mean === null) return null;
  if (prior.mean < INSIGHT_POLICY.MONEY_DAILY_FLOOR) return null;
  const changePct = pctDelta(prior.mean, current.mean);
  if (changePct === null || current.mean < prior.mean * 1.5 || changePct < INSIGHT_POLICY.SHIFT_RELATIVE_PCT) return null;
  return insight(
    "spending_spike",
    weeklyIdentity(now),
    "normal",
    "medium",
    "exact",
    now,
    { from: currentFrom, to: now, sampleSize: 7, baselineDays: 30 },
    { metric: "Daily spending", baselineLabel: "30-day average", baselineValue: prior.mean, currentValue: current.mean, delta: current.mean - prior.mean, deltaPct: changePct, unit: "money" },
    "Spending spiked",
    "Your true spending over the past week ran well above your 30-day average. Asset purchases are not counted — this is consumed or lost money.",
    `Daily true spending averaged ${moneyStr(current.mean)} vs a 30-day average of ${moneyStr(prior.mean)}.`,
    "/money"
  );
};

/** Travel profit per trip above the 30-day baseline. */
const travelProfitShift: Rule = (inputs) => {
  const { now, travelTrips } = inputs;
  const currentFrom = now - 7 * DAY;
  const priorFrom = currentFrom - 30 * DAY;
  const current = travelTrips.filter((t) => t.departedAt >= currentFrom && t.departedAt <= now && t.returnedAt !== null);
  const prior = travelTrips.filter((t) => t.departedAt >= priorFrom && t.departedAt < currentFrom && t.returnedAt !== null);
  if (current.length < INSIGHT_POLICY.TRAVEL_MIN_TRIPS_CURRENT || prior.length < INSIGHT_POLICY.TRAVEL_MIN_TRIPS_BASELINE) return null;
  const profitOf = (trips: ReadonlyArray<TravelTripLike>): number[] =>
    trips.map((t) => tripProfit(t)).filter((p) => p.priced).map((p) => p.profit);
  const currentProfits = profitOf(current);
  const priorProfits = profitOf(prior);
  if (currentProfits.length < INSIGHT_POLICY.TRAVEL_MIN_TRIPS_CURRENT || priorProfits.length < INSIGHT_POLICY.TRAVEL_MIN_TRIPS_BASELINE) return null;
  const currentMean = mean(currentProfits)!;
  const priorMean = mean(priorProfits)!;
  if (priorMean <= 0) return null;
  const changePct = pctDelta(priorMean, currentMean);
  if (changePct === null || changePct < INSIGHT_POLICY.SHIFT_RELATIVE_PCT) return null;
  return insight(
    "travel_profit_shift",
    weeklyIdentity(now),
    "low",
    "medium",
    "estimated",
    now,
    { from: currentFrom, to: now, sampleSize: currentProfits.length, baselineDays: 30 },
    { metric: "Profit per trip", baselineLabel: "30-day average", baselineValue: priorMean, currentValue: currentMean, delta: currentMean - priorMean, deltaPct: changePct, unit: "money" },
    "Travel profit above average",
    "Recent trips brought in clearly more per trip than your 30-day travel average.",
    `Recent trips averaged ${moneyStr(currentMean)} profit vs a 30-day average of ${moneyStr(priorMean)}.`,
    "/travel"
  );
};

/** Rehab spend at a 90-day high. */
const rehabSpendHigh: Rule = (inputs) => {
  const { now, rehabEvents } = inputs;
  const currentFrom = now - 7 * DAY;
  const baselineFrom = now - 90 * DAY;
  const current = rehabEvents.filter((e) => e.occurredAt >= currentFrom && e.cost !== null);
  const baseline = rehabEvents.filter((e) => e.occurredAt >= baselineFrom && e.occurredAt < currentFrom && e.cost !== null);
  if (current.length === 0 || baseline.length < 5) return null;
  const currentSpend = current.reduce((s, e) => s + (e.cost ?? 0), 0);
  const baselineMean = mean(baseline.map((e) => e.cost ?? 0))!;
  if (baselineMean <= 0) return null;
  // Compare weekly spend against the weekly-equivalent baseline.
  const baselineWeekly = baselineMean * 7;
  if (currentSpend < baselineWeekly * 1.5 || currentSpend < INSIGHT_POLICY.MONEY_DAY_RECORD_FLOOR) return null;
  const pct = pctDelta(baselineWeekly, currentSpend);
  return insight(
    "rehab_spend_high",
    weeklyIdentity(now),
    "normal",
    "medium",
    "exact",
    now,
    { from: currentFrom, to: now, sampleSize: current.length, baselineDays: 90 },
    { metric: "Weekly rehab spend", baselineLabel: "90-day average week", baselineValue: baselineWeekly, currentValue: currentSpend, delta: currentSpend - baselineWeekly, deltaPct: pct, unit: "money" },
    "Rehab spend at a high",
    "Rehab cost you clearly more this week than in a typical week over the past 90 days.",
    `Rehab spend this week: ${moneyStr(currentSpend)} vs a 90-day weekly average of ${moneyStr(baselineWeekly)}.`,
    "/drugs"
  );
};

/** Xanax usage rate (per day) shift vs the prior 30 days. */
const xanaxUsageShift: Rule = (inputs) => {
  const { now, xanaxCounter } = inputs;
  const currentFrom = now - 30 * DAY;
  const priorFrom = currentFrom - 30 * DAY;
  const rateFor = (from: number, to: number): number | null => {
    const inRange = xanaxCounter.filter((p) => p.t >= from && p.t <= to && p.xanax !== null);
    if (inRange.length < 4) return null;
    const first = inRange[0]!;
    const last = inRange[inRange.length - 1]!;
    const days = (last.t - first.t) / DAY;
    if (days < 3) return null;
    return (last.xanax! - first.xanax!) / days;
  };
  const current = rateFor(currentFrom, now);
  const prior = rateFor(priorFrom, currentFrom);
  if (current === null || prior === null || prior < 0.1) return null;
  const changePct = pctDelta(prior, current);
  if (changePct === null || Math.abs(changePct) < INSIGHT_POLICY.SHIFT_RELATIVE_PCT) return null;
  const up = current > prior;
  return insight(
    "xanax_usage_shift",
    monthlyIdentity(now),
    "low",
    "medium",
    "exact",
    now,
    { from: currentFrom, to: now, sampleSize: xanaxCounter.filter((p) => p.t >= currentFrom && p.xanax !== null).length, baselineDays: 30 },
    { metric: "Xanax per day", baselineLabel: "previous 30 days", baselineValue: prior, currentValue: current, delta: current - prior, deltaPct: changePct, unit: "count" },
    up ? "Xanax usage up" : "Xanax usage down",
    `Your observed xanax rate over the last 30 days ran ${up ? "above" : "below"} the previous 30 days.`,
    `Xanax rate: ${current.toFixed(2)}/day vs ${prior.toFixed(2)}/day in the previous 30 days.`,
    "/drugs"
  );
};

/** Training gain-per-energy vs the 30-day baseline (efficiency shift). */
const trainingEfficiencyShift: Rule = (inputs) => {
  const { now, trainingSessions } = inputs;
  const currentFrom = now - 7 * DAY;
  const baselineFrom = currentFrom - 30 * DAY;
  const eligible = trainingSessions.filter((s) => s.gainPerEnergy !== null && !s.bracketShared);
  const current = eligible.filter((s) => s.startedAt >= currentFrom);
  const baseline = eligible.filter((s) => s.startedAt >= baselineFrom && s.startedAt < currentFrom);
  if (current.length < INSIGHT_POLICY.TRAINING_MIN_SESSIONS || baseline.length < INSIGHT_POLICY.TRAINING_MIN_BASELINE_SESSIONS) return null;
  const currentMedian = median(current.map((s) => s.gainPerEnergy!))!;
  const baselineMedian = median(baseline.map((s) => s.gainPerEnergy!))!;
  if (baselineMedian <= 0) return null;
  const changePct = pctDelta(baselineMedian, currentMedian);
  if (changePct === null || Math.abs(changePct) < INSIGHT_POLICY.TRAINING_EFFICIENCY_PCT) return null;
  const up = currentMedian > baselineMedian;
  return insight(
    "training_efficiency_shift",
    weeklyIdentity(now),
    "normal",
    "medium",
    "inferred",
    now,
    { from: currentFrom, to: now, sampleSize: current.length, baselineDays: 30 },
    { metric: "Gain per energy", baselineLabel: "30-day session median", baselineValue: baselineMedian, currentValue: currentMedian, delta: currentMedian - baselineMedian, deltaPct: changePct, unit: "ratio" },
    up ? "Training efficiency at a high" : "Training efficiency dropped",
    `Sessions in the past 7 days observed ${up ? "higher" : "lower"} gain per energy than your 30-day session median.`,
    `Median gain/E ${currentMedian.toFixed(1)} vs a 30-day median of ${baselineMedian.toFixed(1)} (${changePct >= 0 ? "+" : ""}${changePct!.toFixed(1)}%).`,
    "/progression"
  );
};

/** Best training week on record (in the tracked window). */
const trainingRecord: Rule = (inputs) => {
  const { now, trainingSessions } = inputs;
  const window = trainingSessions.filter((s) => s.totalGain !== null && s.totalGain > 0);
  if (window.length < 8) return null;
  const byWeek = new Map<number, number>();
  for (const s of window) {
    const week = startOfWeek(s.startedAt);
    byWeek.set(week, (byWeek.get(week) ?? 0) + (s.totalGain ?? 0));
  }
  const weeks = [...byWeek.entries()].sort((a, b) => a[0] - b[0]);
  if (weeks.length < 4) return null;
  const [currentWeek, currentTotal] = weeks[weeks.length - 1]!;
  if (now - currentWeek > 7 * DAY) return null; // only celebrate the live week
  const priorBest = weeks.slice(0, -1).reduce((max, [, total]) => Math.max(max, total), 0);
  if (priorBest <= 0 || currentTotal <= priorBest) return null;
  return insight(
    "personal_record",
    `${currentWeek}`,
    "normal",
    "medium",
    "inferred",
    now,
    { from: currentWeek, to: now, sampleSize: window.filter((s) => startOfWeek(s.startedAt) === currentWeek).length, baselineDays: 90 },
    { metric: "Weekly stat gain", baselineLabel: "best prior week", baselineValue: priorBest, currentValue: currentTotal, delta: currentTotal - priorBest, deltaPct: pctDelta(priorBest, currentTotal), unit: "stat" },
    "Best training week on record",
    "This week's observed stat gain tops every prior week in your tracked history.",
    `Observed stat gain this week: ${Math.round(currentTotal).toLocaleString("en-US")} (prior best ${Math.round(priorBest).toLocaleString("en-US")}).`,
    "/progression"
  );
};

/** The largest net worth contributor category changed vs the prior period. */
const wealthContributorShift: Rule = (inputs) => {
  const { now, networthSnapshots } = inputs;
  if (networthSnapshots.length < 12) return null;
  const topFor = (from: number, to: number): { key: keyof NetworthSnapshotFields; delta: number } | null => {
    const inRange = networthSnapshots.filter((s) => s.capturedAt >= from && s.capturedAt <= to).sort((a, b) => a.capturedAt - b.capturedAt);
    if (inRange.length < 4) return null;
    const first = inRange[0]!;
    const last = inRange[inRange.length - 1]!;
    const keys: Array<keyof NetworthSnapshotFields> = ["wallet", "vault", "cityBank", "caymanBank", "piggyBank", "stockMarket", "inventory", "bazaar", "property", "points", "company", "itemMarket", "displayCase", "trades", "auctionHouse", "enlistedCars", "bookie", "pending"];
    let best: { key: keyof NetworthSnapshotFields; delta: number } | null = null;
    for (const key of keys) {
      const a = first[key];
      const b = last[key];
      if (typeof a !== "number" || typeof b !== "number") continue;
      const delta = b - a;
      if (best === null || Math.abs(delta) > Math.abs(best.delta)) best = { key, delta };
    }
    return best;
  };
  const currentFrom = now - 30 * DAY;
  const priorFrom = currentFrom - 30 * DAY;
  const current = topFor(currentFrom, now);
  const prior = topFor(priorFrom, currentFrom);
  if (!current || !prior) return null;
  const threshold = (networthSnapshots[networthSnapshots.length - 1]!.total) * 0.02;
  if (Math.abs(current.delta) < threshold || Math.abs(prior.delta) < threshold) return null;
  if (current.key === prior.key) return null;
  const label = (key: keyof NetworthSnapshotFields): string =>
    key === "stockMarket" ? "stocks" : key === "itemMarket" ? "item market value" : key === "cityBank" || key === "caymanBank" ? "bank deposits" : String(key);
  return insight(
    "wealth_contributor_shift",
    monthlyIdentity(now),
    "low",
    "medium",
    "exact",
    now,
    { from: currentFrom, to: now, sampleSize: networthSnapshots.filter((s) => s.capturedAt >= currentFrom).length, baselineDays: 30 },
    { metric: "Largest wealth contributor", baselineLabel: "previous 30 days", baselineValue: prior.delta, currentValue: current.delta, delta: current.delta - prior.delta, deltaPct: null, unit: "money" },
    "Wealth mix shifted",
    `Your largest wealth mover changed from ${label(prior.key)} to ${label(current.key)} versus the previous 30 days.`,
    `${label(current.key)} moved ${moneyStr(current.delta)} in the last 30 days (previously ${label(prior.key)} moved ${moneyStr(prior.delta)}).`,
    "/money"
  );
};

/** Energy sat at cap unusually long this week. */
const energyCappedElevated: Rule = (inputs) => {
  const { now, energyCappedHours } = inputs;
  const currentFrom = now - 7 * DAY;
  const baselineFrom = currentFrom - 30 * DAY;
  const current = energyCappedHours.filter((d) => d.t >= currentFrom);
  const baseline = energyCappedHours.filter((d) => d.t >= baselineFrom && d.t < currentFrom);
  if (current.length < 4 || baseline.length < 14) return null;
  const currentMean = mean(current.map((d) => d.hours))!;
  const baselineMean = mean(baseline.map((d) => d.hours))!;
  const changePct = pctDelta(baselineMean, currentMean);
  if (baselineMean < 0.5) return null; // baseline rarely capped — nothing to compare
  if (changePct === null || currentMean < baselineMean * 1.5 + 1 || changePct < INSIGHT_POLICY.ENERGY_CAPPED_PCT) return null;
  return insight(
    "energy_capped_elevated",
    weeklyIdentity(now),
    "low",
    "medium",
    "derived",
    now,
    { from: currentFrom, to: now, sampleSize: current.length, baselineDays: 30 },
    { metric: "Hours at energy cap per day", baselineLabel: "30-day average", baselineValue: baselineMean, currentValue: currentMean, delta: currentMean - baselineMean, deltaPct: changePct, unit: "hours" },
    "More energy wasted at cap",
    "Your energy bar sat full for longer than usual this week — potential regeneration is being lost.",
    `Energy averaged ${currentMean.toFixed(1)}h/day at cap vs a 30-day average of ${baselineMean.toFixed(1)}h.`,
    "/progression"
  );
};

/** Best income day in the recent window vs all prior tracked days. */
const bestIncomeDay: Rule = (inputs) => {
  const { now, moneyEvents } = inputs;
  const recentFrom = now - 30 * DAY;
  const priorFrom = now - 120 * DAY;
  const flow = dailyTrueFlow(moneyEvents, priorFrom, now);
  const days = [...flow.income.entries()].sort((a, b) => a[0] - b[0]);
  if (days.length < 20) return null;
  const recent = days.filter(([day]) => day >= startOfDay(recentFrom) && day < startOfDay(now));
  const prior = days.filter(([day]) => day < startOfDay(recentFrom));
  if (recent.length === 0 || prior.length < 15) return null;
  const [bestDay, bestValue] = recent.reduce(([bd, bv], [day, value]) => (value > bv ? [day, value] : [bd, bv]), [0, 0]);
  if (bestValue < INSIGHT_POLICY.MONEY_DAY_RECORD_FLOOR) return null;
  const priorBest = prior.reduce((max, [, value]) => Math.max(max, value), 0);
  if (bestValue <= priorBest) return null;
  return insight(
    "best_income_day",
    `${bestDay}`,
    "low",
    "high",
    "exact",
    now,
    { from: bestDay, to: bestDay + DAY, sampleSize: 1, baselineDays: 90 },
    { metric: "Single-day true income", baselineLabel: "best prior day", baselineValue: priorBest, currentValue: bestValue, delta: bestValue - priorBest, deltaPct: pctDelta(priorBest, bestValue), unit: "money" },
    "Best income day on record",
    "A day this month out-earned every prior day in your tracked history.",
    `Best day brought in ${moneyStr(bestValue)} (prior best ${moneyStr(priorBest)}).`,
    "/money"
  );
};

/** Net worth at an all-time tracked high. */
const networthRecord: Rule = (inputs) => {
  const { now, networthSnapshots } = inputs;
  if (networthSnapshots.length < 10) return null;
  const sorted = [...networthSnapshots].sort((a, b) => a.capturedAt - b.capturedAt);
  const latest = sorted[sorted.length - 1]!;
  if (now - latest.capturedAt > 2 * DAY) return null; // stale — do not celebrate old peaks
  const priorMax = sorted.slice(0, -1).reduce((max, s) => Math.max(max, s.total), 0);
  if (latest.total <= priorMax || priorMax <= 0) return null;
  return insight(
    "networth_record",
    `${startOfDay(latest.capturedAt)}`,
    "low",
    "high",
    "exact",
    now,
    { from: latest.capturedAt, to: latest.capturedAt, sampleSize: 1, baselineDays: Math.round((now - sorted[0]!.capturedAt) / DAY) },
    { metric: "Net worth", baselineLabel: "previous best", baselineValue: priorMax, currentValue: latest.total, delta: latest.total - priorMax, deltaPct: pctDelta(priorMax, latest.total), unit: "money" },
    "Net worth record",
    "Your net worth is at the highest level TornScope has ever recorded.",
    `Net worth ${moneyStr(latest.total)} — above the previous best of ${moneyStr(priorMax)}.`,
    "/money"
  );
};

/** The curated rule set — order is irrelevant; output is sorted by priority. */
const RULES: Array<{ kind: InsightKind; run: Rule }> = [
  { kind: "networth_growth_shift", run: networthGrowthShift },
  { kind: "income_shift", run: incomeShift },
  { kind: "spending_spike", run: spendingSpike },
  { kind: "travel_profit_shift", run: travelProfitShift },
  { kind: "rehab_spend_high", run: rehabSpendHigh },
  { kind: "xanax_usage_shift", run: xanaxUsageShift },
  { kind: "training_efficiency_shift", run: trainingEfficiencyShift },
  { kind: "personal_record", run: trainingRecord },
  { kind: "wealth_contributor_shift", run: wealthContributorShift },
  { kind: "energy_capped_elevated", run: energyCappedElevated },
  { kind: "best_income_day", run: bestIncomeDay },
  { kind: "networth_record", run: networthRecord },
];

const PRIORITY_ORDER: Record<InsightPriority, number> = { high: 0, normal: 1, low: 2 };

/** Result of running the engine. */
export interface DerivedInsights {
  insights: Insight[];
  /** True when stored history is too short for most rules to run. */
  insufficientHistory: boolean;
}

/**
 * Run every rule and return the curated feed: highest priority first, one
 * insight per kind, capped at MAX_INSIGHTS.
 */
export function deriveInsights(inputs: InsightInputs): DerivedInsights {
  const emitted: Insight[] = [];
  for (const rule of RULES) {
    try {
      const result = rule.run(inputs);
      if (result) emitted.push(result);
    } catch {
      // A malformed single source must never sink the whole feed — rules are
      // individually guarded, this is the last-resort net.
    }
  }
  const seen = new Set<string>();
  const deduped = emitted.filter((i) => (seen.has(i.dedupeKey) ? false : (seen.add(i.dedupeKey), true)));
  deduped.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.occurredAt - a.occurredAt);
  return {
    insights: deduped.slice(0, INSIGHT_POLICY.MAX_INSIGHTS),
    insufficientHistory: inputs.networthSnapshots.length < 8 && inputs.moneyEvents.length < 20,
  };
}
