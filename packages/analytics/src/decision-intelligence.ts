import type { Provenance } from "@tornscope/shared";

/**
 * Decision Intelligence (2.3.0) — deterministic, evidence-backed decision
 * support derived from the user's OWN stored history.
 *
 * CONTRACT:
 *  - Descriptive first: signals compare the user with THEMSELVES (rolling
 *    personal baselines). No population benchmarks, no game-bot advice, no
 *    "you must X".
 *  - Historical signal ≠ live recommendation: travel/market signals describe
 *    the past and never claim current market availability.
 *  - provenance ≠ confidence: an exact historical measurement can still back
 *    only a low/medium-confidence forward-looking signal. `provenance` is the
 *    worst provenance of the signal's inputs; `confidence` grades how much
 *    the EVIDENCE supports the comparison.
 *  - Coverage guards: raw absence is never zero. A comparison needs a
 *    minimum number of COVERED days (days with at least one in-domain
 *    event) in each window, or the signal is suppressed and counted.
 *
 * PERIOD SEMANTICS (one method, documented):
 *    recent   = the trailing 7 days          [now-7d, now]
 *    baseline = the previous 30 days          [now-37d, now-7d)
 *    Non-overlapping by construction. All rates are per COVERED day of
 *    their own window.
 *
 * ANOMALY METHOD (deterministic, no ML):
 *    |recentRate − baselineMedian| > max(3 × 1.4826 × MAD, 25% of median)
 *    with baseline sample n ≥ 10 covered days and recent n ≥ 3.
 */

export type DecisionCategory = "OPPORTUNITY" | "RISK" | "INEFFICIENCY" | "TREND" | "MILESTONE" | "ANOMALY";
export type DecisionConfidence = "high" | "medium" | "low";
import type { DecisionDomain } from "@tornscope/shared";
export type { DecisionDomain };

export interface DecisionSignal {
  /** Stable lifecycle key — identical while the same condition holds. */
  id: string;
  domain: DecisionDomain;
  category: DecisionCategory;
  title: string;
  /** One-line explanation (the headline claim). */
  summary: string;
  /** WHY — the evidence lines behind the claim. */
  evidence: string[];
  /** Signed impact phrase, rounded to the input's precision. */
  impact: string;
  confidence: DecisionConfidence;
  provenance: Provenance;
  /** Deterministic ordering score 0..100 (actionability first). */
  urgency: number;
  /** Decision horizon of the underlying comparison. */
  horizon: "now" | "7d" | "30d" | "90d";
  metricBefore: number | null;
  metricAfter: number | null;
  metricUnit: string;
  /** The exact comparison method, stated for the reader. */
  reason: string;
  limitations: string[];
  actionUrl: string;
  generatedAt: number;
}

export interface DecisionCoverageEntry {
  coveredDays: number;
  events: number;
  /** Earliest in-domain evidence ever stored (unix seconds, null = none). */
  trackingSince: number | null;
}

export interface DecisionFacts {
  now: number;
  money: {
    events: Array<{ t: number; category: string; direction: "income" | "expense" | "neutral" | "unknown"; amount: number }>;
    trackingSince: number | null;
  };
  drugs: {
    events: Array<{ t: number; drugName: string | null; outcome: "success" | "overdose" }>;
    rehab: Array<{ t: number; cost: number | null; sessions: number | null }>;
    trackingSince: number | null;
  };
  travel: {
    /** Completed trips with catalog-valued items (TravelTripLike shape). */
    trips: Array<{
      destination: string;
      departedAt: number;
      durationSeconds: number | null;
      items: Array<{ totalCost: number; estimatedUnitValue: number | null; quantity: number }>;
    }>;
    trackingSince: number | null;
  };
  energy: {
    /** Exact gym energy per gym log (payload energy_used). */
    gym: Array<{ t: number; energyUsed: number }>;
    refills: Array<{ t: number }>;
    xanaxUses: Array<{ t: number }>;
    trackingSince: number | null;
  };
  goals: {
    /** Active goals with an explicit target date and a numeric target. */
    paced: Array<{ id: string; label: string; metric: string; target: number; targetDate: number }>;
    /** Current net-worth pace per day over the last 30 days (derived), if measurable. */
    networthPerDay: number | null;
  };
}

export interface DecisionPrefs {
  enabled: boolean;
  domains: Record<DecisionDomain, boolean>;
  includeLowConfidence: boolean;
  maxOverviewSignals: number;
}

export const DEFAULT_DECISION_PREFS: DecisionPrefs = {
  enabled: true,
  domains: { energy: true, drugs: true, travel: true, money: true, goals: true },
  includeLowConfidence: true,
  maxOverviewSignals: 3,
};

export function normalizeDecisionPrefs(raw: unknown): DecisionPrefs {
  const p = (raw ?? {}) as Partial<DecisionPrefs>;
  const domains = { ...DEFAULT_DECISION_PREFS.domains };
  if (p.domains && typeof p.domains === "object") {
    for (const key of Object.keys(domains) as DecisionDomain[]) {
      const v = (p.domains as Record<string, unknown>)[key];
      if (typeof v === "boolean") domains[key] = v;
    }
  }
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : DEFAULT_DECISION_PREFS.enabled,
    domains,
    includeLowConfidence: typeof p.includeLowConfidence === "boolean" ? p.includeLowConfidence : true,
    maxOverviewSignals:
      typeof p.maxOverviewSignals === "number" && Number.isFinite(p.maxOverviewSignals)
        ? Math.min(5, Math.max(1, Math.round(p.maxOverviewSignals)))
        : DEFAULT_DECISION_PREFS.maxOverviewSignals,
  };
}

/* -------------------------------------------------------------------------- */
/* Window & robust-statistics helpers                                          */
/* -------------------------------------------------------------------------- */

export const RECENT_WINDOW_SEC = 7 * 86_400;
export const BASELINE_WINDOW_SEC = 30 * 86_400;

export interface WindowStat {
  /** Sum over the window (signed as the domain defines it). */
  total: number;
  events: number;
  coveredDays: number;
  /** Total / coveredDays (null when the window has no coverage). */
  perCoveredDay: number | null;
}

const DAY = 86_400;

/** Compute the window aggregation over per-day buckets. */
export function windowStat(
  events: ReadonlyArray<{ t: number; value: number }>,
  from: number,
  to: number
): WindowStat {
  const days = new Set<number>();
  let total = 0;
  let events_count = 0;
  for (const e of events) {
    if (e.t < from || e.t > to) continue;
    days.add(Math.floor(e.t / DAY));
    total += e.value;
    events_count += 1;
  }
  const covered = days.size;
  return { total, events: events_count, coveredDays: covered, perCoveredDay: covered > 0 ? total / covered : null };
}

export function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Median absolute deviation, scaled to a consistent-estimate (×1.4826). */
export function scaledMad(values: ReadonlyArray<number>): number | null {
  const med = median(values);
  if (med === null || values.length === 0) return null;
  return median(values.map((v) => Math.abs(v - med)))! * 1.4826;
}

/** Provenance worst-of ladder (re-uses the energy module's semantics). */
import { worstProvenance } from "./energy.js";

/** Confidence grades how much evidence supports the comparison. */
function confidenceFor(recentEvents: number, baselineCoveredDays: number, provenance: Provenance): DecisionConfidence {
  const thin = recentEvents < 5 || baselineCoveredDays < 15;
  const sparse = recentEvents < 3 || baselineCoveredDays < 10;
  if (sparse) return "low";
  if (thin || provenance === "estimated") return "medium";
  return "high";
}

const pct = (v: number): number => Math.round(v * 100);
const fmtMoney = (v: number): string => {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}b`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}m`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${Math.round(v)}`;
};

/* -------------------------------------------------------------------------- */
/* Signal builders                                                             */
/* -------------------------------------------------------------------------- */

const BASELINE_REASON = "Recent = trailing 7 days; baseline = the previous 30 days (non-overlapping); rates are per covered day.";

export interface DomainCoverage {
  money: DecisionCoverageEntry;
  drugs: DecisionCoverageEntry;
  travel: DecisionCoverageEntry;
  energy: DecisionCoverageEntry;
}

interface BuildInput {
  facts: DecisionFacts;
  coverage: DomainCoverage;
}

function coveredDaysOf(events: ReadonlyArray<{ t: number }>, from: number, to: number): number {
  const days = new Set<number>();
  for (const e of events) if (e.t >= from && e.t <= to) days.add(Math.floor(e.t / DAY));
  return days.size;
}

/** Comparisons need meaningful coverage in BOTH windows or they are suppressed. */
export const MIN_RECENT_COVERED_DAYS = 3;
export const MIN_BASELINE_COVERED_DAYS = 10;

/* ---- money ---- */

function buildMoneySignals(facts: DecisionFacts, out: DecisionSignal[]): void {
  const now = facts.now;
  const recentFrom = now - RECENT_WINDOW_SEC;
  const baselineFrom = now - RECENT_WINDOW_SEC - BASELINE_WINDOW_SEC;
  const expenses = facts.money.events
    .filter((e) => e.direction === "expense")
    .map((e) => ({ t: e.t, value: Math.abs(e.amount) }));
  const income = facts.money.events
    .filter((e) => e.direction === "income")
    .map((e) => ({ t: e.t, value: Math.abs(e.amount) }));

  const recentExp = windowStat(expenses, recentFrom, now);
  const baseExp = windowStat(expenses, baselineFrom, recentFrom);
  // Per-covered-day series for the baseline distribution (robust stats).
  const baselineDailyExpense = dailyTotals(expenses, baselineFrom, recentFrom);
  const baselineMedian = median(baselineDailyExpense);
  const baselineMad = scaledMad(baselineDailyExpense);

  // 1. Spending anomaly (RISK/ANOMALY).
  if (
    recentExp.coveredDays >= MIN_RECENT_COVERED_DAYS &&
    baselineDailyExpense.length >= 10 &&
    baselineMedian !== null &&
    baselineMad !== null
  ) {
    const threshold = Math.max(baselineMedian + 3 * baselineMad, baselineMedian * 1.25);
    if (recentExp.perCoveredDay !== null && recentExp.perCoveredDay > threshold) {
      const uplift = (recentExp.perCoveredDay - baselineMedian) / baselineMedian;
      const topCategory = topExpenseCategory(facts.money.events, recentFrom, now);
      out.push({
        id: "money.spending-anomaly",
        domain: "money",
        category: "ANOMALY",
        title: "Spending is running above your usual daily level",
        summary: `Recent spending averages ${fmtMoney(recentExp.perCoveredDay)}/covered day versus a ${fmtMoney(baselineMedian)} daily median over the previous 30 days.`,
        evidence: [
          `Recent 7-day spending: ${fmtMoney(recentExp.total)} across ${recentExp.events} expenses (${recentExp.coveredDays} covered days)`,
          `Previous 30-day daily median: ${fmtMoney(baselineMedian)} (MAD ${fmtMoney(baselineMad)})`,
          `Anomaly threshold: ${fmtMoney(threshold)} (median + 3×MAD, floor 25%)`,
          ...(topCategory ? [`Largest recent expense category: ${topCategory.category} (${fmtMoney(topCategory.total)})`] : []),
        ],
        impact: `+${pct(uplift)}% daily spend vs baseline`,
        confidence: confidenceFor(recentExp.events, baseExp.coveredDays, "exact"),
        provenance: "exact",
        urgency: 78,
        horizon: "7d",
        metricBefore: Math.round(baselineMedian),
        metricAfter: Math.round(recentExp.perCoveredDay),
        metricUnit: "$/covered day",
        reason: BASELINE_REASON,
        limitations: [
          "Neutral transfers (bank/vault movements) are excluded from spending.",
          "A single large purchase can drive the whole window — check the category breakdown.",
        ],
        actionUrl: "/money",
        generatedAt: now,
      });
    }
  }

  // 2. Income drop (TREND).
  const recentInc = windowStat(income, recentFrom, now);
  const baselineDailyIncome = dailyTotals(income, baselineFrom, recentFrom);
  const incomeMedian = median(baselineDailyIncome);
  if (
    recentInc.coveredDays >= MIN_RECENT_COVERED_DAYS &&
    baselineDailyIncome.length >= 10 &&
    incomeMedian !== null &&
    incomeMedian > 0 &&
    recentInc.perCoveredDay !== null &&
    recentInc.perCoveredDay < incomeMedian * 0.6
  ) {
    const drop = (incomeMedian - recentInc.perCoveredDay) / incomeMedian;
    out.push({
      id: "money.income-drop",
      domain: "money",
      category: "TREND",
      title: "Income is running well below your recent norm",
      summary: `Recent income averages ${fmtMoney(recentInc.perCoveredDay)}/covered day versus a ${fmtMoney(incomeMedian)} daily median over the previous 30 days.`,
      evidence: [
        `Recent 7-day income: ${fmtMoney(recentInc.total)} across ${recentInc.events} receipts (${recentInc.coveredDays} covered days)`,
        `Previous 30-day daily median: ${fmtMoney(incomeMedian)}`,
        `Comparison floor: 60% of the baseline median`,
      ],
      impact: `−${pct(drop)}% daily income vs baseline`,
      confidence: confidenceFor(recentInc.events, baseExp.coveredDays, "exact"),
      provenance: "exact",
      urgency: 62,
      horizon: "7d",
      metricBefore: Math.round(incomeMedian),
      metricAfter: Math.round(recentInc.perCoveredDay),
      metricUnit: "$/covered day",
      reason: BASELINE_REASON,
      limitations: ["Irregular income (a big sale every few weeks) legitimately produces quiet weeks."],
      actionUrl: "/money",
      generatedAt: now,
    });
  }

  // 3. Casino loss anomaly (INEFFICIENCY).
  const casinoExpenses = facts.money.events
    .filter((e) => e.direction === "expense" && e.category === "casino")
    .map((e) => ({ t: e.t, value: Math.abs(e.amount) }));
  const recentCasino = windowStat(casinoExpenses, recentFrom, now);
  const baselineCasinoDaily = dailyTotals(casinoExpenses, baselineFrom, recentFrom);
  const casinoMedian = median(baselineCasinoDaily);
  if (
    recentCasino.coveredDays >= MIN_RECENT_COVERED_DAYS &&
    recentCasino.total > 0 &&
    baselineCasinoDaily.length >= 10 &&
    casinoMedian !== null
  ) {
    const threshold = Math.max(casinoMedian + 3 * (scaledMad(baselineCasinoDaily) ?? 0), casinoMedian * 2, 1);
    if (recentCasino.perCoveredDay !== null && recentCasino.perCoveredDay > threshold) {
      out.push({
        id: "money.casino-loss",
        domain: "money",
        category: "INEFFICIENCY",
        title: "Casino losses are above your usual level",
        summary: `Recent casino losses average ${fmtMoney(recentCasino.perCoveredDay)}/covered day versus a ${fmtMoney(casinoMedian)} daily median over the previous 30 days.`,
        evidence: [
          `Recent 7-day casino losses: ${fmtMoney(recentCasino.total)}`,
          `Previous 30-day daily median: ${fmtMoney(casinoMedian)}`,
        ],
        impact: `${fmtMoney(recentCasino.total)} casino losses this week`,
        confidence: confidenceFor(recentCasino.events, baseExp.coveredDays, "exact"),
        provenance: "exact",
        urgency: 55,
        horizon: "7d",
        metricBefore: Math.round(casinoMedian),
        metricAfter: Math.round(recentCasino.perCoveredDay),
        metricUnit: "$/covered day",
        reason: BASELINE_REASON,
        limitations: ["Descriptive only — no judgment about gambling, just the delta against your own baseline."],
        actionUrl: "/money",
        generatedAt: now,
      });
    }
  }
}

function dailyTotals(events: ReadonlyArray<{ t: number; value: number }>, from: number, to: number): number[] {
  const byDay = new Map<number, number>();
  for (const e of events) {
    if (e.t < from || e.t >= to) continue;
    const day = Math.floor(e.t / DAY);
    byDay.set(day, (byDay.get(day) ?? 0) + e.value);
  }
  return [...byDay.values()];
}

function topExpenseCategory(
  events: ReadonlyArray<{ t: number; category: string; direction: string; amount: number }>,
  from: number,
  to: number
): { category: string; total: number } | null {
  const byCat = new Map<string, number>();
  for (const e of events) {
    if (e.direction !== "expense" || e.t < from || e.t > to) continue;
    byCat.set(e.category, (byCat.get(e.category) ?? 0) + Math.abs(e.amount));
  }
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? { category: top[0], total: top[1] } : null;
}

/* ---- travel ---- */

interface TripCompute {
  destination: string;
  departedAt: number;
  hours: number | null;
  profit: number | null; // estimated resale − spend; null when any item value unknown
}

function computeTrips(facts: DecisionFacts): TripCompute[] {
  return facts.travel.trips.map((trip) => {
    const duration = trip.durationSeconds !== null && trip.durationSeconds > 0 ? trip.durationSeconds : null;
    let revenue = 0;
    let spend = 0;
    let known = trip.items.length > 0;
    for (const item of trip.items) {
      spend += item.totalCost;
      if (item.estimatedUnitValue !== null) revenue += item.estimatedUnitValue * item.quantity;
      else known = false;
    }
    return {
      destination: trip.destination,
      departedAt: trip.departedAt,
      hours: duration !== null ? duration / 3600 : null,
      profit: known && duration !== null ? revenue - spend : known ? revenue - spend : null,
    };
  });
}

function buildTravelSignals(facts: DecisionFacts, out: DecisionSignal[]): void {
  const now = facts.now;
  const recentFrom = now - RECENT_WINDOW_SEC;
  const baselineFrom = now - RECENT_WINDOW_SEC - BASELINE_WINDOW_SEC;
  const trips = computeTrips(facts)
    .filter((t) => t.hours !== null && t.hours > 0 && t.profit !== null)
    .map((t) => ({ ...t, perHour: t.profit! / t.hours! }));

  const recentTrips = trips.filter((t) => t.departedAt >= recentFrom && t.departedAt <= now);
  const baselineTrips = trips.filter((t) => t.departedAt >= baselineFrom && t.departedAt < recentFrom);

  // 1. Profit/hour deterioration (TREND).
  const recentMedian = median(recentTrips.map((t) => t.perHour));
  const baselineMedian = median(baselineTrips.map((t) => t.perHour));
  if (recentTrips.length >= 3 && baselineTrips.length >= 5 && recentMedian !== null && baselineMedian !== null && baselineMedian > 0) {
    const delta = (recentMedian - baselineMedian) / baselineMedian;
    if (delta <= -0.2) {
      out.push({
        id: "travel.profit-hour-drop",
        domain: "travel",
        category: "TREND",
        title: "Travel returns per hour are below your recent baseline",
        summary: `Recent trips median ~${fmtMoney(recentMedian)}/hour versus ~${fmtMoney(baselineMedian)}/hour over the previous 30 days.`,
        evidence: [
          `Recent completed trips: ${recentTrips.length} (median ~${fmtMoney(recentMedian)}/hour)`,
          `Previous 30 days: ${baselineTrips.length} completed trips (median ~${fmtMoney(baselineMedian)}/hour)`,
          `Based on estimated resale values at catalog prices`,
        ],
        impact: `${delta <= -0.5 ? "≪" : "−"}${pct(Math.abs(delta))}% median profit/hour vs baseline`,
        confidence: confidenceFor(recentTrips.length, baselineTrips.length, "estimated"),
        provenance: "estimated",
        urgency: 58,
        horizon: "30d",
        metricBefore: Math.round(baselineMedian),
        metricAfter: Math.round(recentMedian),
        metricUnit: "$/hour (estimated)",
        reason: "Medians over completed trips with recorded durations; baseline = the previous 30 days (non-overlapping).",
        limitations: [
          "Resale values are catalog-price ESTIMATES, not realized sales.",
          "Descriptive history — not a live recommendation; current market prices and availability are not checked.",
        ],
        actionUrl: "/travel",
        generatedAt: now,
      });
    }
  }

  // 2. Best historical destination over 90 days (OPPORTUNITY, descriptive).
  const from90 = now - 90 * DAY;
  const trips90 = trips.filter((t) => t.departedAt >= from90);
  const byDest = new Map<string, number[]>();
  for (const t of trips90) {
    if (t.profit === null || t.hours === null || t.hours <= 0) continue;
    const list = byDest.get(t.destination) ?? [];
    list.push(t.profit / t.hours);
    byDest.set(t.destination, list);
  }
  const ranked = [...byDest.entries()]
    .map(([destination, list]) => ({ destination, median: median(list)!, trips: list.length }))
    .filter((r) => r.trips >= 3)
    .sort((a, b) => b.median - a.median);
  const best = ranked[0];
  if (best && ranked.length >= 2) {
    out.push({
      id: "travel.best-destination",
      domain: "travel",
      category: "OPPORTUNITY",
      title: `${best.destination} has produced your highest median profit/hour`,
      summary: `Over the last 90 days, ${best.destination} returned ~${fmtMoney(best.median)}/hour across ${best.trips} completed trips — your best consistent lane.`,
      evidence: [
        ...ranked.slice(0, 3).map((r) => `${r.destination}: ~${fmtMoney(r.median)}/hour over ${r.trips} trips`),
        `Based on estimated resale values at catalog prices`,
      ],
      impact: `~${fmtMoney(best.median)}/hour best historical lane`,
      confidence: best.trips >= 6 ? "medium" : "low",
      provenance: "estimated",
      urgency: 45,
      horizon: "90d",
      metricBefore: ranked[1] ? Math.round(ranked[1].median) : null,
      metricAfter: Math.round(best.median),
      metricUnit: "$/hour (estimated)",
      reason: "Median estimated profit/hour per destination over completed trips in the last 90 days; minimum 3 trips per destination.",
      limitations: [
        "Descriptive history — NOT a live recommendation. Current market prices and item availability are not checked.",
        "Estimated resale values at catalog prices, not realized sales.",
      ],
      actionUrl: "/travel",
      generatedAt: now,
    });
  }
}

/* ---- drugs & rehab ---- */

function buildDrugSignals(facts: DecisionFacts, out: DecisionSignal[]): void {
  const now = facts.now;
  const recentFrom = now - RECENT_WINDOW_SEC;
  const baselineFrom = now - RECENT_WINDOW_SEC - BASELINE_WINDOW_SEC;

  const xanax = facts.drugs.events.filter((e) => e.drugName === "Xanax" && e.outcome === "success");
  const recentXanax = windowStat(xanax.map((e) => ({ t: e.t, value: 1 })), recentFrom, now);
  const baselineXanax = windowStat(xanax.map((e) => ({ t: e.t, value: 1 })), baselineFrom, recentFrom);

  // 1. Xanax pace (TREND) — descriptive only, never a prescription.
  if (recentXanax.coveredDays >= MIN_RECENT_COVERED_DAYS && baselineXanax.perCoveredDay !== null && baselineXanax.perCoveredDay > 0) {
    const delta = ((recentXanax.perCoveredDay ?? 0) - baselineXanax.perCoveredDay) / baselineXanax.perCoveredDay;
    if (Math.abs(delta) >= 0.3) {
      const down = delta < 0;
      out.push({
        id: "drugs.xanax-pace",
        domain: "drugs",
        category: "TREND",
        title: down ? "Your Xanax pace is below your recent baseline" : "Your Xanax pace is above your recent baseline",
        summary: `Recent pace: ${(recentXanax.perCoveredDay ?? 0).toFixed(1)}/day versus a ${(baselineXanax.perCoveredDay).toFixed(1)}/day baseline over the previous 30 days.`,
        evidence: [
          `Recent: ${recentXanax.events} successful uses over ${recentXanax.coveredDays} covered days`,
          `Previous 30-day baseline: ${(baselineXanax.perCoveredDay).toFixed(1)}/day (${baselineXanax.events} uses)`,
          `Energy contribution uses the documented +250 estimate per use`,
        ],
        impact: `${down ? "−" : "+"}${pct(Math.abs(delta))}% pace vs baseline`,
        confidence: confidenceFor(recentXanax.events, baselineXanax.coveredDays, "estimated"),
        provenance: "estimated",
        urgency: 40,
        horizon: "7d",
        metricBefore: Number(baselineXanax.perCoveredDay.toFixed(1)),
        metricAfter: Number((recentXanax.perCoveredDay ?? 0).toFixed(1)),
        metricUnit: "uses/covered day (estimated energy)",
        reason: BASELINE_REASON,
        limitations: [
          "Per-use energy is the documented +250 convention, not a recorded value.",
          "Descriptive only — TornScope does not prescribe drug targets.",
        ],
        actionUrl: "/drugs",
        generatedAt: now,
      });
    }
  }

  // 2. OD rate trend (RISK).
  const all = facts.drugs.events;
  const recentWindow = all.filter((e) => e.t >= recentFrom && e.t <= now);
  const baselineWindow = all.filter((e) => e.t >= baselineFrom && e.t < recentFrom);
  const recentOdRate = recentWindow.length >= 10 ? recentWindow.filter((e) => e.outcome === "overdose").length / recentWindow.length : null;
  const baselineOdRate = baselineWindow.length >= 20 ? baselineWindow.filter((e) => e.outcome === "overdose").length / baselineWindow.length : null;
  if (recentOdRate !== null && baselineOdRate !== null && recentOdRate > baselineOdRate * 2 && recentOdRate - baselineOdRate >= 0.02) {
    out.push({
      id: "drugs.od-rate-up",
      domain: "drugs",
      category: "RISK",
      title: "Overdose rate is up versus your recent history",
      summary: `${Math.round(recentOdRate * 100)}% of your recent uses overdosed versus ${Math.round(baselineOdRate * 100)}% over the previous 30 days.`,
      evidence: [
        `Recent: ${recentWindow.filter((e) => e.outcome === "overdose").length} overdoses in ${recentWindow.length} uses`,
        `Previous 30 days: ${baselineWindow.filter((e) => e.outcome === "overdose").length} overdoses in ${baselineWindow.length} uses`,
      ],
      impact: `${Math.round(recentOdRate * 100)}% vs ${Math.round(baselineOdRate * 100)}% OD rate`,
      confidence: confidenceFor(recentWindow.length, baselineWindow.length, "exact"),
      provenance: "exact",
      urgency: 66,
      horizon: "7d",
      metricBefore: Number((baselineOdRate * 100).toFixed(1)),
      metricAfter: Number((recentOdRate * 100).toFixed(1)),
      metricUnit: "% of uses",
      reason: "Outcome rates over the trailing 7 days versus the previous 30 days; minimum 10 recent and 20 baseline uses.",
      limitations: ["Game-economy context only — no health claims."],
      actionUrl: "/drugs",
      generatedAt: now,
    });
  }

  // 3. Rehab cost trend (TREND).
  const recentCosts = facts.drugs.rehab.filter((r) => r.t >= recentFrom && r.cost !== null).map((r) => r.cost!);
  const baselineCosts = facts.drugs.rehab.filter((r) => r.t >= baselineFrom && r.t < recentFrom && r.cost !== null).map((r) => r.cost!);
  const recentMedianCost = median(recentCosts);
  const baselineMedianCost = median(baselineCosts);
  if (recentCosts.length >= 3 && baselineCosts.length >= 5 && recentMedianCost !== null && baselineMedianCost !== null && baselineMedianCost > 0) {
    const delta = (recentMedianCost - baselineMedianCost) / baselineMedianCost;
    if (Math.abs(delta) >= 0.25) {
      const up = delta > 0;
      out.push({
        id: "drugs.rehab-cost-trend",
        domain: "drugs",
        category: up ? "TREND" : "OPPORTUNITY",
        title: up ? "Rehab costs are trending above your recent baseline" : "Rehab costs are trending below your recent baseline",
        summary: `Recent visits median ${fmtMoney(recentMedianCost)} versus ${fmtMoney(baselineMedianCost)} over the previous 30 days.`,
        evidence: [
          `Recent visits: ${recentCosts.length} (median ${fmtMoney(recentMedianCost)})`,
          `Previous 30 days: ${baselineCosts.length} costed visits (median ${fmtMoney(baselineMedianCost)})`,
        ],
        impact: `${up ? "+" : "−"}${pct(Math.abs(delta))}% median rehab cost vs baseline`,
        confidence: confidenceFor(recentCosts.length, baselineCosts.length, "exact"),
        provenance: "exact",
        urgency: 44,
        horizon: "7d",
        metricBefore: Math.round(baselineMedianCost),
        metricAfter: Math.round(recentMedianCost),
        metricUnit: "$/visit (median)",
        reason: "Median visit cost, trailing 7 days versus the previous 30 days; minimum 3 recent and 5 baseline costed visits.",
        limitations: ["Rehab pricing scales with addiction level — the delta reflects level changes as much as behaviour."],
        actionUrl: "/drugs",
        generatedAt: now,
      });
    }
  }
}

/* ---- energy ---- */

function buildEnergySignals(facts: DecisionFacts, out: DecisionSignal[]): void {
  const now = facts.now;
  const recentFrom = now - RECENT_WINDOW_SEC;
  const baselineFrom = now - RECENT_WINDOW_SEC - BASELINE_WINDOW_SEC;

  const gym = facts.energy.gym.map((g) => ({ t: g.t, value: g.energyUsed }));
  const recentGym = windowStat(gym, recentFrom, now);
  const baselineGym = windowStat(gym, baselineFrom, recentFrom);

  // 1. Gym allocation trend (TREND/INEFFICIENCY) — exact payload energy.
  if (recentGym.coveredDays >= MIN_RECENT_COVERED_DAYS && baselineGym.perCoveredDay !== null && baselineGym.perCoveredDay > 0) {
    const delta = ((recentGym.perCoveredDay ?? 0) - baselineGym.perCoveredDay) / baselineGym.perCoveredDay;
    if (Math.abs(delta) >= 0.3) {
      const up = delta > 0;
      out.push({
        id: "energy.gym-allocation",
        domain: "energy",
        category: up ? "TREND" : "TREND",
        title: up ? "Energy spent on gym training is at a recent high" : "Gym training energy is below your recent baseline",
        summary: `Gym logs recorded ${Math.round(recentGym.perCoveredDay ?? 0)} energy/covered day recently versus ${Math.round(baselineGym.perCoveredDay)} over the previous 30 days.`,
        evidence: [
          `Recent: ${Math.round(recentGym.total)} energy across ${recentGym.events} gym logs (${recentGym.coveredDays} covered days)`,
          `Previous 30 days: ${Math.round(baselineGym.total)} energy (${baselineGym.events} logs)`,
        ],
        impact: `${up ? "+" : "−"}${pct(Math.abs(delta))}% gym energy/day vs baseline`,
        confidence: confidenceFor(recentGym.events, baselineGym.coveredDays, "exact"),
        provenance: "exact",
        urgency: 42,
        horizon: "7d",
        metricBefore: Math.round(baselineGym.perCoveredDay),
        metricAfter: Math.round(recentGym.perCoveredDay ?? 0),
        metricUnit: "energy/covered day (exact)",
        reason: BASELINE_REASON,
        limitations: ["Gym energy comes from Torn's own gym-train logs (exact); unlogged uses are not attributed."],
        actionUrl: "/energy",
        generatedAt: now,
      });
    }
  }

  // 2. Refill pace (TREND).
  const refills = facts.energy.refills.map((r) => ({ t: r.t, value: 1 }));
  const recentRefills = windowStat(refills, recentFrom, now);
  const baselineRefills = windowStat(refills, baselineFrom, recentFrom);
  if (recentRefills.coveredDays >= MIN_RECENT_COVERED_DAYS && baselineRefills.perCoveredDay !== null && baselineRefills.perCoveredDay > 0) {
    const delta = ((recentRefills.perCoveredDay ?? 0) - baselineRefills.perCoveredDay) / baselineRefills.perCoveredDay;
    if (Math.abs(delta) >= 0.5) {
      out.push({
        id: "energy.refill-pace",
        domain: "energy",
        category: "TREND",
        title: delta > 0 ? "You are using points refills more often than usual" : "Refill usage is below your recent baseline",
        summary: `${recentRefills.events} refills this week (${(recentRefills.perCoveredDay ?? 0).toFixed(1)}/covered day) versus ${(baselineRefills.perCoveredDay).toFixed(1)}/covered day over the previous 30 days.`,
        evidence: [
          `Recent: ${recentRefills.events} refills (exact points cost recorded per refill)`,
          `Previous 30 days: ${baselineRefills.events} refills`,
        ],
        impact: `${delta > 0 ? "+" : "−"}${pct(Math.abs(delta))}% refill pace vs baseline`,
        confidence: confidenceFor(recentRefills.events, baselineRefills.coveredDays, "exact"),
        provenance: "exact",
        urgency: 36,
        horizon: "7d",
        metricBefore: Number(baselineRefills.perCoveredDay.toFixed(1)),
        metricAfter: Number((recentRefills.perCoveredDay ?? 0).toFixed(1)),
        metricUnit: "refills/covered day",
        reason: BASELINE_REASON,
        limitations: ["Points spent per refill are exact; the cash value of points is not attributed."],
        actionUrl: "/energy",
        generatedAt: now,
      });
    }
  }
}

/* ---- goals ---- */

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

export interface DecisionInput extends BuildInput {
  prefs: DecisionPrefs;
  /** Recent net-worth pace per covered day (service-derived), for goal pacing. */
  networthPaceRecent?: { perDay: number | null; coveredDays: number } | null;
}

export interface DecisionResult {
  signals: DecisionSignal[];
  suppressedInsufficientData: number;
  domainsSuppressed: DecisionDomain[];
}

export function buildDecisionSignals(input: DecisionInput): DecisionResult {
  const { facts, prefs } = input;
  const generated: DecisionSignal[] = [];
  let suppressed = 0;
  const suppressedDomains = new Set<DecisionDomain>();

  const push = (domain: DecisionDomain, build: (out: DecisionSignal[]) => void, covered: (c: DomainCoverage) => DecisionCoverageEntry): void => {
    if (!prefs.enabled || !prefs.domains[domain]) return;
    const before = generated.length;
    build(generated);
    if (generated.length === before) {
      // Count a domain as suppressed-when-insufficient only if it has some
      // activity but not enough coverage to compare.
      const entry = covered(input.coverage);
      if (entry.events > 0 && (entry.coveredDays < MIN_BASELINE_COVERED_DAYS)) {
        suppressed += 1;
        suppressedDomains.add(domain);
      }
    }
  };

  push("money", (o) => buildMoneySignals(facts, o), (c) => c.money);
  push("travel", (o) => buildTravelSignals(facts, o), (c) => c.travel);
  push("drugs", (o) => buildDrugSignals(facts, o), (c) => c.drugs);
  push("energy", (o) => buildEnergySignals(facts, o), (c) => c.energy);

  // Goals: pace input is injected by the service (needs goal facts + recent pace).
  if (prefs.enabled && prefs.domains.goals && input.networthPaceRecent) {
    buildGoalSignalsWithPace(facts, input.networthPaceRecent, generated);
  }

  // Filter by prefs + confidence, then order deterministically.
  const filtered = generated.filter((s) => prefs.includeLowConfidence || s.confidence !== "low");
  filtered.sort(
    (a, b) => b.urgency - a.urgency || a.id.localeCompare(b.id)
  );
  for (const signal of filtered) signal.generatedAt = facts.now;
  return { signals: filtered, suppressedInsufficientData: suppressed, domainsSuppressed: [...suppressedDomains] };
}

function buildGoalSignalsWithPace(
  facts: DecisionFacts,
  pace: { perDay: number | null; coveredDays: number },
  out: DecisionSignal[]
): void {
  const now = facts.now;
  for (const goal of facts.goals.paced) {
    const daysLeft = (goal.targetDate - now) / DAY;
    if (daysLeft <= 0 || pace.perDay === null || pace.perDay <= 0 || pace.coveredDays < MIN_RECENT_COVERED_DAYS) continue;
    const requiredPerDay = goal.target / daysLeft;
    if (recentPaceBelowRequired(pace.perDay, requiredPerDay)) {
      const shortfall = 1 - pace.perDay / requiredPerDay;
      out.push({
        id: `goals.pace-${goal.id}`,
        domain: "goals",
        category: "TREND",
        title: `Your pace is below what the "${goal.label}" target date requires`,
        summary: `Recent pace is ~${fmtMoney(pace.perDay)}/day; the target date needs ~${fmtMoney(requiredPerDay)}/day for ${Math.ceil(daysLeft)} more days.`,
        evidence: [
          `Recent 7-day pace: ~${fmtMoney(pace.perDay)}/day (${pace.coveredDays} covered days)`,
          `Required pace: ~${fmtMoney(requiredPerDay)}/day over ${Math.ceil(daysLeft)} days`,
          "Only shown because the goal has an explicit target date",
        ],
        impact: `−${pct(shortfall)}% vs required pace`,
        confidence: pace.coveredDays >= 5 ? "medium" : "low",
        provenance: "derived",
        urgency: 60,
        horizon: "30d",
        metricBefore: Math.round(requiredPerDay),
        metricAfter: Math.round(pace.perDay),
        metricUnit: "$/day required",
        reason: "Recent pace (trailing 7 days over covered days) versus the straight-line pace the target date implies.",
        limitations: ["Straight-line pacing — real progress is rarely linear.", "Only goals with an explicit target date are paced."],
        actionUrl: "/goals",
        generatedAt: now,
      });
    }
  }
}

function recentPaceBelowRequired(recentPerDay: number, requiredPerDay: number): boolean {
  return requiredPerDay > 0 && recentPerDay < requiredPerDay * 0.8;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle (stable keys + firstSeen/lastSeen/resolved)                       */
/* -------------------------------------------------------------------------- */

export interface SignalLifecycleEntry {
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
}

export type SignalLifecycleState = Record<string, SignalLifecycleEntry>;

export const SIGNAL_LIFECYCLE_KEEP_MS = 30 * DAY * 1000;
/** A signal counts as "new" for this long after firstSeen. */
export const SIGNAL_NEW_WINDOW_MS = 24 * 3600 * 1000;

/**
 * Reconcile this run's signal keys with persisted lifecycle state.
 * Pure: returns the next state and, per signal, whether it is new.
 */
export function reconcileLifecycle(
  currentKeys: ReadonlyArray<string>,
  state: SignalLifecycleState,
  nowMs: number
): { nextState: SignalLifecycleState; newKeys: Set<string> } {
  const nextState: SignalLifecycleState = { ...state };
  const newKeys = new Set<string>();
  for (const key of currentKeys) {
    const existing = nextState[key];
    if (!existing) {
      nextState[key] = { firstSeenAt: nowMs, lastSeenAt: nowMs, resolvedAt: null };
      newKeys.add(key);
    } else {
      nextState[key] = { ...existing, lastSeenAt: nowMs, resolvedAt: null };
    }
  }
  for (const key of Object.keys(nextState)) {
    if (currentKeys.includes(key)) continue;
    const entry = nextState[key]!;
    if (entry.resolvedAt === null) nextState[key] = { ...entry, resolvedAt: nowMs };
  }
  // Prune long-resolved entries.
  for (const key of Object.keys(nextState)) {
    const entry = nextState[key]!;
    if (entry.resolvedAt !== null && nowMs - entry.resolvedAt > SIGNAL_LIFECYCLE_KEEP_MS) delete nextState[key];
  }
  return { nextState, newKeys };
}
