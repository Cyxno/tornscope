import type { Provenance } from "@tornscope/shared";
import { bucketStart, type Interval } from "./series.js";
import {
  XANAX_ENERGY_ESTIMATE,
  type ConsumptionEvidenceRow,
  type DrugEvidenceRow,
  type EnergyObservation,
  type RefillEvidenceRow,
} from "./progression.js";

/**
 * Deep energy accounting (2.1.0) — "where did my energy come from and where
 * did it go?" over a selected range.
 *
 * SEMANTIC CONTRACT (docs/ANALYTICS.md — energy):
 *   EXACT      refill `energy_increased`, energy-drink `energy_increased`,
 *              gym-log `energy_used`, overdose `energy_decreased`,
 *              refill `points_used`
 *   ESTIMATED  Xanax +250 per successful use (normal-use logs carry no energy
 *              field; documented mechanic, see XANAX_ENERGY_ESTIMATE)
 *   DERIVED    natural regeneration from bar observations net of known gains,
 *              and any total that is a deterministic sum of the above
 *   INFERRED   outflow that bar declines prove but logs cannot attribute
 *              (attacks, reviving, unlogged uses) — bounded, shown with "~"
 *
 * The engine NEVER claims a closed balance when the bar history does not
 * cover the range, never attributes declines to training/attacks when a log
 * proves otherwise, and never sums rows of mixed provenance into an
 * "exact" total. Where a figure mixes provenance, its own provenance is the
 * worst of its parts.
 */

/* -------------------------------------------------------------------------- */
/* Input shaping                                                               */
/* -------------------------------------------------------------------------- */

export interface GymEvidenceRow {
  occurredAt: Date | number;
  metadata: unknown;
}

export interface OverdoseEvidenceRow {
  occurredAt: Date | number;
  title: string;
  metadata: unknown;
}

/** An outgoing attack window (bounded inference input). */
export interface AttackEvidenceRow {
  occurredAt: Date | number;
}

export interface EnergyGainRow {
  t: number;
  amount: number;
  /** Points spent for a refill (exact from the log; null when absent). */
  pointsUsed: number | null;
  category: "refill" | "xanax" | "energy_drink";
  provenance: "exact" | "estimated";
}

export interface EnergyLossRowExact {
  t: number;
  amount: number;
  category: string;
  title: string;
}

export interface GymUseRow {
  t: number;
  energyUsed: number;
  trains: number | null;
  happyUsed: number | null;
}

function sec(d: Date | number): number {
  return typeof d === "number" ? d : Math.floor(d.getTime() / 1000);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dataOf(metadata: unknown): Record<string, unknown> {
  return asRecord((metadata as { data?: unknown } | null)?.data) ?? {};
}

function positive(value: unknown): number | null {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
}

/** Exact `energy_used` from a Gym train log payload. */
export function gymEnergyFromMetadata(metadata: unknown): number | null {
  return positive(dataOf(metadata).energy_used);
}

export function shapeGymUses(rows: readonly GymEvidenceRow[]): GymUseRow[] {
  const out: GymUseRow[] = [];
  for (const row of rows) {
    const energy = gymEnergyFromMetadata(row.metadata);
    if (energy === null) continue;
    const data = dataOf(row.metadata);
    out.push({
      t: sec(row.occurredAt),
      energyUsed: energy,
      trains: positive(data.trains),
      happyUsed: positive(data.happy_used),
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

const OD_DRUG_ALIASES: Array<[RegExp, string]> = [
  [/\bxanax\b/i, "Xanax"],
  [/\becstasy\b|\bextacy\b/i, "Ecstasy"],
  [/\bcannabis\b|\bweed\b|\bpot\b/i, "Cannabis"],
  [/\bshrooms?\b|\bmushrooms?\b/i, "Shrooms"],
  [/\bspeed\b|\bamphetamines?\b/i, "Speed"],
  [/\bvicodin\b/i, "Vicodin"],
  [/\blsd\b/i, "LSD"],
  [/\bketamine\b/i, "Ketamine"],
  [/\bopium\b/i, "Opium"],
];

function odCategoryFromTitle(title: string): string | null {
  for (const [pattern, name] of OD_DRUG_ALIASES) {
    if (pattern.test(title)) return name;
  }
  return null;
}

/**
 * Exact overdose energy losses. Only payloads that actually carry
 * `energy_decreased` count — an Ecstasy overdose raises happiness and does
 * NOT drain the energy bar, so it never appears here (honesty over symmetry).
 */
export function shapeOverdoseLosses(rows: readonly OverdoseEvidenceRow[]): EnergyLossRowExact[] {
  const out: EnergyLossRowExact[] = [];
  for (const row of rows) {
    const amount = positive(dataOf(row.metadata).energy_decreased);
    if (amount === null) continue;
    out.push({
      t: sec(row.occurredAt),
      amount,
      category: odCategoryFromTitle(row.title) ?? "Overdose",
      title: row.title,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

const ATTACK_COMPETITION_SECONDS = 15 * 60;

/**
 * Canonical range inputs: one shaped set of evidence rows.
 * Refill rows are TimelineEvent "Points energy refill use" payloads;
 * xanax/energy-drink shaping mirrors progression's shapeEnergyInputs so both
 * views can never diverge on what a gain is worth.
 */
export function shapeDeepEnergyInputs(
  refillRows: readonly RefillEvidenceRow[],
  drugRows: readonly DrugEvidenceRow[],
  consumptionRows: readonly ConsumptionEvidenceRow[]
): EnergyGainRow[] {
  const gains: EnergyGainRow[] = [];
  for (const r of refillRows) {
    const amount = positive(dataOf(r.metadata).energy_increased);
    if (amount === null) continue;
    gains.push({
      t: sec(r.occurredAt),
      amount,
      pointsUsed: positive(dataOf(r.metadata).points_used),
      category: "refill",
      provenance: "exact",
    });
  }
  for (const r of drugRows) {
    if (r.drugName === "Xanax" && r.outcome === "success") {
      gains.push({ t: sec(r.occurredAt), amount: XANAX_ENERGY_ESTIMATE, pointsUsed: null, category: "xanax", provenance: "estimated" });
    }
  }
  for (const r of consumptionRows) {
    if (r.category === "energy") {
      const amount = positive(dataOf(r.metadata).energy_increased);
      if (amount !== null) gains.push({ t: sec(r.occurredAt), amount, pointsUsed: null, category: "energy_drink", provenance: "exact" });
    }
  }
  return gains.sort((a, b) => a.t - b.t);
}

/* -------------------------------------------------------------------------- */
/* Provenance helpers                                                          */
/* -------------------------------------------------------------------------- */

const PROVENANCE_RANK: Record<EnergyProvenance, number> = { exact: 0, derived: 1, estimated: 2, inferred: 3 };

/** The worst provenance of a set — mixed figures are never upgraded. */
export function worstProvenance(values: readonly EnergyProvenance[]): EnergyProvenance {
  let worst: EnergyProvenance = "exact";
  for (const value of values) {
    if (PROVENANCE_RANK[value] > PROVENANCE_RANK[worst]) worst = value;
  }
  return worst;
}

/* -------------------------------------------------------------------------- */
/* Energy accounting                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Value provenance for deep analytics. Same ladder as insights/command-center:
 * bounded bar-decline inference is its own level so UI can render "~" and an
 * explicit tooltip instead of silently upgrading it to a computed estimate.
 */
export type EnergyProvenance = Provenance | "inferred";

export interface EnergyBreakdownRow {
  category: string;
  label: string;
  amount: number;
  events: number;
  provenance: EnergyProvenance;
  /** Share of the breakdown total this row represents (0..1). */
  share: number | null;
  /** Optional extra context (exact points cost for refills). */
  pointsUsed?: number | null;
}

export interface EnergyBalance {
  /** Natural regeneration (derived from bar observations). */
  generated: { value: number | null; provenance: EnergyProvenance };
  /** Refills + Xanax + energy drinks. */
  gainedExternally: { value: number; provenance: EnergyProvenance };
  /** Explicit logged uses (gym) + bounded bar-decline inference. */
  spent: { value: number | null; provenance: EnergyProvenance };
  /** Exact overdose energy losses. */
  lost: { value: number; provenance: EnergyProvenance };
  /** generated + gainedExternally − spent − lost. Null when spent/generated
   *  are unavailable (bars not covered) — a partial net is never claimed. */
  net: { value: number | null; provenance: EnergyProvenance };
}

export interface EnergyCoverage {
  /**
   * Share of observed outflow that explicit logs attribute (gym + losses)
   * inside the bar-covered window. Null when there is no bar coverage or no
   * observed outflow — never a fake 100%.
   */
  accountedShare: number | null;
  /** Bar-covered window actually analyzed (null when bars absent). */
  coveredFrom: number | null;
  coveredTo: number | null;
  /** True when the bar observations were capped mid-range (analysis truncated). */
  truncated: boolean;
  quality: "full" | "partial" | "unavailable";
}

export interface EnergyIntelligence {
  /** External gains + generated regen per covered day (derived; null uncovered). */
  averageEnergyPerDay: { value: number | null; provenance: EnergyProvenance };
  gymShareOfSpent: number | null;
  attackShareOfSpent: number | null;
  xanaxPerDay: { value: number | null; provenance: EnergyProvenance };
  refillCount: number;
  refillEnergy: number;
  refillPointsSpent: number | null;
  /** Lower-bound natural energy generated while the bar sat pinned at max
   *  (estimated from the observed regen rate — only when a rate exists). */
  potentialRegenWhileCapped: { value: number | null; provenance: EnergyProvenance };
  cappedHoursObserved: number;
}

export interface EnergyDailyPoint {
  t: number;
  gained: number;
  spent: number;
  lost: number;
}

export interface EnergyAccountingInput {
  from: number;
  to: number;
  gains: readonly EnergyGainRow[];
  gymUses: readonly GymUseRow[];
  losses: readonly EnergyLossRowExact[];
  attacks: readonly AttackEvidenceRow[];
  /** Bar observations sorted ascending; may cover only part of the range. */
  bars: readonly EnergyObservation[];
  /** True when a fetch row cap cut the bar history mid-range. */
  barsTruncated?: boolean;
}

export interface EnergyAccounting {
  range: { from: number; to: number };
  balance: EnergyBalance;
  sources: EnergyBreakdownRow[];
  uses: EnergyBreakdownRow[];
  losses: EnergyBreakdownRow[];
  daily: EnergyDailyPoint[];
  coverage: EnergyCoverage;
  intelligence: EnergyIntelligence;
}

const GAIN_LABELS: Record<EnergyGainRow["category"], string> = {
  refill: "Points refills",
  xanax: "Xanax",
  energy_drink: "Energy drinks",
};

export function buildEnergyAccounting(input: EnergyAccountingInput): EnergyAccounting {
  const { from, to } = input;
  const days = Math.max(1, (to - from) / 86_400);

  /* ---------------- external gains, in range ---------------- */
  const gainsInRange = input.gains.filter((g) => g.t >= from && g.t <= to);
  const gainTotals = new Map<EnergyGainRow["category"], { amount: number; events: number; provenance: EnergyProvenance; points: number }>();
  for (const g of gainsInRange) {
    const entry = gainTotals.get(g.category) ?? { amount: 0, events: 0, provenance: g.provenance, points: 0 };
    entry.amount += g.amount;
    entry.events += 1;
    if (g.pointsUsed !== null) entry.points += g.pointsUsed;
    entry.provenance = worstProvenance([entry.provenance, g.provenance]);
    gainTotals.set(g.category, entry);
  }
  const gainedExternally = gainsInRange.reduce((s, g) => s + g.amount, 0);
  const gainProvenances = [...gainTotals.values()].map((v) => v.provenance);

  /* ---------------- exact uses & losses, in range ---------------- */
  const gymInRange = input.gymUses.filter((g) => g.t >= from && g.t <= to);
  const gymEnergy = gymInRange.reduce((s, g) => s + g.energyUsed, 0);
  const gymTrains = gymInRange.reduce((s, g) => s + (g.trains ?? 0), 0);
  const lossesInRange = input.losses.filter((l) => l.t >= from && l.t <= to);
  const lostEnergy = lossesInRange.reduce((s, l) => s + l.amount, 0);
  const lossTotals = new Map<string, { amount: number; events: number }>();
  for (const l of lossesInRange) {
    const entry = lossTotals.get(l.category) ?? { amount: 0, events: 0 };
    entry.amount += l.amount;
    entry.events += 1;
    lossTotals.set(l.category, entry);
  }

  /* ---------------- bars & ledger semantics ---------------- */
  const bars = [...input.bars].filter((b) => b.t >= from - 1 && b.t <= to + 1).sort((a, b) => a.t - b.t);
  const attacks = input.attacks.map((a) => sec(a.occurredAt)).sort((a, b) => a - b);
  // An attack competes with an interval when its ±competition window
  // overlaps the interval (same convention as progression's ledger).
  const isCompeted = (fromT: number, toT: number): boolean =>
    attacks.some((a) => a >= fromT - ATTACK_COMPETITION_SECONDS && a <= toT + ATTACK_COMPETITION_SECONDS);

  let derivedRegen = 0;
  let inferredSpent = 0;
  let competedSpent = 0;
  let cappedSeconds = 0;
  const cleanRates: number[] = [];
  // Per-interval daily buckets for the chart.
  const dailyRegen = new Map<number, number>();
  const dailySpent = new Map<number, number>();
  const gainsByDay = new Map<number, number>();
  const lossesByDay = new Map<number, number>();
  for (const g of gainsInRange) {
    const day = bucketStart(g.t, "day");
    gainsByDay.set(day, (gainsByDay.get(day) ?? 0) + g.amount);
  }
  for (const l of lossesInRange) {
    const day = bucketStart(l.t, "day");
    lossesByDay.set(day, (lossesByDay.get(day) ?? 0) + l.amount);
  }

  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1]!;
    const b = bars[i]!;
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    const day = bucketStart(a.t, "day");
    const dE = b.energyCurrent - a.energyCurrent;
    const inside = gainsInRange.filter((g) => g.t > a.t && g.t <= b.t);
    const insideSum = inside.reduce((s, g) => s + g.amount, 0);
    if (dE >= 0) {
      const pinned = a.energyCurrent === a.energyMaximum && b.energyCurrent === b.energyMaximum;
      if (pinned) {
        cappedSeconds += dt;
        continue; // regen unobservable; gains already credited as gains
      }
      const natural = dE - insideSum;
      if (natural >= 0) {
        derivedRegen += natural;
        dailyRegen.set(day, (dailyRegen.get(day) ?? 0) + natural);
        cleanRates.push((natural / dt) * 3600);
      }
      // natural < 0: delivered gains exceeded the rise — consumed between
      // snapshots; already credited as gains, never double-counted.
    } else {
      // Decline: delivered gains inside the interval were consumed here too.
      const spend = insideSum + -dE;
      // Explicit losses observed inside the decline are subtracted so the
      // OD is not counted twice (it is already `lost`). When the logged
      // loss exceeds the observed drop (regen offset), the log still owns
      // the full loss and the interval contributes no inferred spend.
      const lossesInside = lossesInRange
        .filter((l) => l.t > a.t && l.t <= b.t)
        .reduce((s, l) => s + l.amount, 0);
      const effectiveSpend = Math.max(0, spend - lossesInside);
      inferredSpent += effectiveSpend;
      if (isCompeted(a.t, b.t) && effectiveSpend > 0) competedSpent += effectiveSpend;
      dailySpent.set(day, (dailySpent.get(day) ?? 0) + effectiveSpend);
    }
  }

  const barsCovered = bars.length >= 2;
  const coveredFrom = barsCovered ? bars[0]!.t : null;
  const coveredTo = barsCovered ? bars[bars.length - 1]!.t : null;

  /* ---------------- rows ---------------- */
  const sources: EnergyBreakdownRow[] = [];
  const sourceTotal = gainedExternally + derivedRegen;
  if (derivedRegen > 0 || barsCovered) {
    sources.push({
      category: "regen",
      label: "Natural regen",
      amount: derivedRegen,
      events: Math.max(0, bars.length - 1),
      provenance: "derived",
      share: sourceTotal > 0 ? derivedRegen / sourceTotal : null,
    });
  }
  for (const [category, label] of Object.entries(GAIN_LABELS) as Array<[EnergyGainRow["category"], string]>) {
    const entry = gainTotals.get(category);
    if (!entry) continue;
    sources.push({
      category,
      label,
      amount: entry.amount,
      events: entry.events,
      provenance: entry.provenance,
      share: sourceTotal > 0 ? entry.amount / sourceTotal : null,
      pointsUsed: category === "refill" ? entry.points : undefined,
    });
  }

  // Uses: exact gym first; bounded inference only inside bar coverage.
  const uses: EnergyBreakdownRow[] = [];
  const useTotalForShare = inferredSpent + gymEnergy;
  if (gymInRange.length > 0) {
    uses.push({
      category: "gym",
      label: "Gym",
      amount: gymEnergy,
      events: gymTrains > 0 ? gymTrains : gymInRange.length,
      provenance: "exact",
      share: useTotalForShare > 0 ? gymEnergy / useTotalForShare : null,
    });
  }
  if (barsCovered && competedSpent > 0) {
    uses.push({
      category: "attacks",
      label: "Attacks & reviving (bounded)",
      amount: competedSpent,
      events: attacks.length,
      provenance: "inferred",
      share: useTotalForShare > 0 ? competedSpent / useTotalForShare : null,
    });
  }
  if (barsCovered) {
    const other = Math.max(0, inferredSpent - competedSpent - gymEnergy);
    if (other > 0) {
      uses.push({
        category: "other",
        label: "Other observed declines (unattributed)",
        amount: other,
        events: 0,
        provenance: "inferred",
        share: useTotalForShare > 0 ? other / useTotalForShare : null,
      });
    }
  }

  const losses: EnergyBreakdownRow[] = [...lossTotals.entries()]
    .map(([category, entry]) => ({
      category,
      label: category,
      amount: entry.amount,
      events: entry.events,
      provenance: "exact" as Provenance,
      share: lostEnergy > 0 ? entry.amount / lostEnergy : null,
    }))
    .sort((a, b) => b.amount - a.amount);

  /* ---------------- summary figures ---------------- */
  const spentTotal = barsCovered ? inferredSpent + gymEnergy : null;
  const balanceProvenance = {
    // The METHOD is deterministic derivation from exact observations; a null
    // value (bars not covered) is how unavailability is expressed.
    generated: "derived" as EnergyProvenance,
    gainedExternally: worstProvenance(gainProvenances.length > 0 ? gainProvenances : ["derived"]),
    spent: worstProvenance(barsCovered ? ["derived", "exact", "inferred"] : gymEnergy > 0 ? ["exact"] : ["derived"]),
    lost: lossesInRange.length > 0 ? ("exact" as EnergyProvenance) : ("derived" as EnergyProvenance),
  };
  const netValue = barsCovered && spentTotal !== null ? derivedRegen + gainedExternally - spentTotal - lostEnergy : null;

  /* ---------------- coverage ---------------- */
  let accountedShare: number | null = null;
  if (barsCovered && inferredSpent > 0) {
    accountedShare = Math.min(1, (gymEnergy + lostEnergy) / inferredSpent);
  }
  const quality: EnergyCoverage["quality"] = !barsCovered ? "unavailable" : input.barsTruncated ? "partial" : "full";

  /* ---------------- daily series ---------------- */
  const axisDays = new Set<number>();
  for (const map of [gainsByDay, lossesByDay, dailyRegen, dailySpent]) for (const key of map.keys()) axisDays.add(key);
  const daily: EnergyDailyPoint[] = [...axisDays]
    .sort((a, b) => a - b)
    .map((t) => ({
      t,
      gained: (gainsByDay.get(t) ?? 0) + (dailyRegen.get(t) ?? 0),
      spent: dailySpent.get(t) ?? 0,
      lost: lossesByDay.get(t) ?? 0,
    }));

  /* ---------------- intelligence ---------------- */
  const coveredSeconds = barsCovered ? (Math.min(coveredTo!, to) - Math.max(coveredFrom!, from)) : 0;
  const coveredDays = barsCovered ? Math.max(1, coveredSeconds / 86_400) : days;
  const regenPerHour = cleanRates.length > 0 ? median(cleanRates) : null;
  const potentialRegen = cappedSeconds > 0 && regenPerHour !== null ? (cappedSeconds / 3600) * regenPerHour : null;
  const xanaxCount = gainTotals.get("xanax")?.events ?? 0;
  const refillEntry = gainTotals.get("refill");

  return {
    range: { from, to },
    balance: {
      generated: { value: barsCovered ? derivedRegen : null, provenance: balanceProvenance.generated },
      gainedExternally: { value: gainedExternally, provenance: balanceProvenance.gainedExternally },
      spent: { value: spentTotal, provenance: balanceProvenance.spent },
      lost: { value: lostEnergy, provenance: balanceProvenance.lost },
      net: { value: netValue, provenance: worstProvenance(["derived", "estimated", balanceProvenance.gainedExternally]) },
    },
    sources,
    uses,
    losses,
    daily,
    coverage: {
      accountedShare,
      coveredFrom,
      coveredTo,
      truncated: input.barsTruncated === true,
      quality,
    },
    intelligence: {
      averageEnergyPerDay: {
        value: barsCovered ? (derivedRegen + gainedExternally) / coveredDays : null,
        provenance: "derived",
      },
      gymShareOfSpent: spentTotal !== null && spentTotal > 0 ? gymEnergy / spentTotal : null,
      attackShareOfSpent: spentTotal !== null && spentTotal > 0 && barsCovered ? competedSpent / spentTotal : null,
      xanaxPerDay: {
        value: xanaxCount > 0 ? xanaxCount / days : null,
        provenance: "estimated",
      },
      refillCount: refillEntry?.events ?? 0,
      refillEnergy: refillEntry?.amount ?? 0,
      refillPointsSpent: refillEntry?.points ?? null,
      potentialRegenWhileCapped: { value: potentialRegen, provenance: "estimated" },
      cappedHoursObserved: cappedSeconds / 3600,
    },
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Re-bucket the daily series for long ranges (week/month). */
export function rebucketEnergyDaily(points: readonly EnergyDailyPoint[], interval: Interval): EnergyDailyPoint[] {
  const map = new Map<number, EnergyDailyPoint>();
  for (const p of points) {
    const bucket = bucketStart(p.t, interval);
    const entry = map.get(bucket) ?? { t: bucket, gained: 0, spent: 0, lost: 0 };
    entry.gained += p.gained;
    entry.spent += p.spent;
    entry.lost += p.lost;
    map.set(bucket, entry);
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

/** Interval chosen so a range never renders more buckets than it can carry. */
export function energyChartInterval(from: number, to: number): Exclude<Interval, "hour"> {
  const spanDays = (to - from) / 86_400;
  if (spanDays <= 70) return "day";
  if (spanDays <= 540) return "week";
  return "month";
}
