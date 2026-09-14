/**
 * Progression & Energy Intelligence analytics (docs/PROGRESSION-ENERGY.md).
 *
 * SEMANTIC CONTRACT — every figure this module produces is one of:
 *   exact     — recorded by Torn verbatim (battlestat snapshot values, refill
 *               energy_increased, candy/ecstasy happy_increased, bar readings)
 *   derived   — deterministically computed from exact observations
 *               (battlestat deltas, natural regeneration between snapshots)
 *   estimated — relies on a documented game convention rather than a Torn
 *               record (Xanax energy: normal-use logs carry NO energy field;
 *               the canonical 150 is applied per event and provenance-labeled)
 *   inferred  — a pattern-based classification from multiple exact
 *               observations (training sessions, happy jumps)
 * and anything unsupported stays null/unavailable. Never silently upgrades.
 *
 * TRAINING IS NOT DIRECTLY OBSERVABLE: Torn has no gym-training log and
 * personalstats carries no train counter. Sessions are INFERRED from observed
 * energy declines (BarsSnapshot) plus observed battlestat gains
 * (PersonalStatSnapshot.battle_stats), excluding intervals with competing
 * energy-use evidence (attacks). "Unattributed energy" is first-class.
 */

/* -------------------------------------------------------------------------- */
/* personalstats extraction                                                    */
/* -------------------------------------------------------------------------- */

export interface BattlestatPoint {
  t: number;
  strength: number | null;
  defense: number | null;
  speed: number | null;
  dexterity: number | null;
  total: number | null;
}

export interface StatCounters {
  t: number;
  /** Cumulative counters from personalstats (exact; null when absent). */
  xanax: number | null;
  ecstasy: number | null;
  refillsEnergy: number | null;
  candy: number | null;
  awards: number | null;
  level: number | null;
  /** Cumulative stat points gained from COMPANY/JOB activity (exact). The
   *  observable non-gym battlestat source (e.g. Mining Corporation job
   *  specials) — netted out of gym attribution. */
  jobStats: number | null;
  /** Cumulative stat trains RECEIVED from other players (exact count; the
   *  stat amount per train is NOT observable). */
  trainsReceived: number | null;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read a possibly-nested personalstats payload. Torn's cat=all nests groups
 * (e.g. battle_stats, drugs, other) — but every stored snapshot may come from
 * a different shape era, so flat top-level keys work as a fallback.
 */
function pickPath(stats: UnknownRecord, path: string[]): number | null {
  let node: UnknownRecord = stats;
  for (let i = 0; i < path.length - 1; i++) {
    const key: string | undefined = path[i];
    if (key === undefined) return null;
    const next = asRecord(node[key]);
    if (!next) return null;
    node = next;
  }
  const last = path[path.length - 1];
  return last === undefined ? null : numeric(node[last]);
}

const BATTLESTAT_KEYS = ["strength", "defense", "speed", "dexterity"] as const;
export type BattlestatKey = (typeof BATTLESTAT_KEYS)[number];

/** Extract exact battlestat observations from one personalstats JSON blob. */
export function extractBattlestats(stats: unknown): Omit<BattlestatPoint, "t"> {
  const out: Omit<BattlestatPoint, "t"> = { strength: null, defense: null, speed: null, dexterity: null, total: null };
  const root = asRecord(stats);
  if (!root) return out;
  const group = asRecord(root.battle_stats) ?? root;
  for (const key of BATTLESTAT_KEYS) {
    out[key] = pickPath(group as UnknownRecord, [key]) ?? pickPath(stats as UnknownRecord, ["battle_stats", key]);
  }
  const values = BATTLESTAT_KEYS.map((k) => out[k]);
  const groupTotal = pickPath(group as UnknownRecord, ["total"]);
  out.total = groupTotal ?? (values.every((v) => v !== null) ? values.reduce<number>((s, v) => s + (v ?? 0), 0) : null);
  return out;
}

/** Extract cumulative progression counters from one personalstats JSON blob. */
export function extractStatCounters(stats: unknown): Omit<StatCounters, "t"> {
  const root = asRecord(stats) ?? {};
  return {
    xanax: pickPath(root, ["drugs", "xanax"]),
    ecstasy: pickPath(root, ["drugs", "ecstasy"]),
    refillsEnergy: pickPath(root, ["other", "refills", "energy"]) ?? pickPath(root, ["refills"]),
    candy: pickPath(root, ["items", "used", "candy"]),
    awards: pickPath(root, ["other", "awards"]),
    level: pickPath(root, ["level"]),
    jobStats: pickPath(root, ["jobs", "stats", "total"]),
    trainsReceived: pickPath(root, ["jobs", "trains_received"]),
  };
}

/** Build the battlestat observation series from stored snapshot blobs. */
export function buildBattlestatSeries(
  snapshots: ReadonlyArray<{ capturedAt: number; stats: unknown }>
): BattlestatPoint[] {
  const series: BattlestatPoint[] = [];
  for (const s of snapshots) {
    const extracted = extractBattlestats(s.stats);
    if (BATTLESTAT_KEYS.every((k) => extracted[k] === null) && extracted.total === null) continue;
    series.push({ t: s.capturedAt, ...extracted });
  }
  return series.sort((a, b) => a.t - b.t);
}

/* -------------------------------------------------------------------------- */
/* Energy ledger & reconciliation                                              */
/* -------------------------------------------------------------------------- */

export interface EnergyObservation {
  t: number;
  energyCurrent: number;
  energyMaximum: number;
  happyCurrent?: number;
  happyMaximum?: number;
}

/** A known energy gain torn reported verbatim (refill) or via convention (xanax). */
export interface EnergyGainEvent {
  t: number;
  amount: number;
  category: "refill" | "xanax" | "energy_drink" | "other";
  provenance: "exact" | "estimated";
}

/** Competing energy-use evidence (an attack happened in this window). */
export interface CompetingWindow {
  from: number;
  to: number;
  kind: "attack";
}

/**
 * Canonical Xanax energy. Normal-use Torn logs carry NO energy field (raw
 * payload is {item, faction}), so the amount is applied per event with
 * provenance "estimated".
 *
 * Value verified 2026-09-14 against the official Torn wiki (fetched live):
 * the Xanax item page ("Increases energy by 250 and happiness by 75") and
 * the Energy page ("The Drugs Xanax and LSD provide 250 and 50 energy
 * respectively"). The earlier 150 was a stale historical value.
 *
 * Over-max behavior (corrected after an audit of an earlier "hard clamp at
 * the natural maximum" conclusion): the Energy page states "The maximum
 * energy one can have at any moment is 1,000" — a value only reachable if
 * gains can exceed the natural bar maximum (100/150). Community chaining
 * guides confirm the mechanic ("after 4 Xanax you have 1000e"). A Xanax
 * therefore DELIVERS its energy even when the bar is at the natural
 * maximum; the resulting 150 → 400 → low transition happens entirely
 * between snapshots when the player trains immediately, which is why bar
 * snapshots essentially never record values above the natural maximum.
 * Consequence for the ledger: unobserved delivered energy is UNRESOLVED
 * (consumed between snapshots, still banked, or wasted — not observable),
 * never claimed as "lost".
 */
export const XANAX_ENERGY_ESTIMATE = 250;

export interface EnergyLedgerSummary {
  /** Known gains delivered inside bar coverage (refills exact, xanax
   *  estimated) — credited in full whether or not a snapshot shows them. */
  knownGains: number;
  knownGainsByCategory: Array<{ category: string; amount: number; provenance: "exact" | "estimated" }>;
  /** Regeneration derived from observed rises net of known gains. */
  derivedRegen: number;
  /** Median observed regen per hour during clean regenerating intervals. */
  regenPerHour: number | null;
  /** What regen WOULD have been while observed pinned at cap (estimated). */
  potentialRegen: number | null;
  /** Lower-bound seconds observed pinned at the energy cap. */
  cappedSeconds: number;
  /** Inferred energy spend: observed declines plus delivered gains credited
   *  inside decline intervals (consumption between snapshots). Attribution
   *  is the sessions' job. */
  inferredSpent: number;
  /** Delivered gains that cannot be placed between two snapshots (rise
   *  exceeded by the gain, or pinned intervals): consumed, banked or wasted
   *  — not observable, never claimed as lost. */
  unresolvedGains: number;
  /** The same unresolved split by source category. */
  unresolvedGainsByCategory: Array<{ category: string; amount: number }>;
  reconciliation: {
    opening: number | null;
    closing: number | null;
    observedDelta: number | null;
    quality: "full" | "partial" | "unavailable";
  };
}

export interface EnergyLedgerResult extends EnergyLedgerSummary {
  /** Per-interval spends with competing-evidence flags (session detection input).
   *  `estimatedGainsIncluded` is the delivered-gain portion credited into
   *  that interval's spend (consumption between snapshots). */
  spendIntervals: Array<{ from: number; to: number; amount: number; competed: boolean; estimatedGainsIncluded: number }>;
  /** Median seconds between observations (cadence; null when too few). */
  cadenceSeconds: number | null;
  /** True when every observation in range carries bars data. */
  coveredFrom: number | null;
  coveredTo: number | null;
}

const isWithin = (t: number, from: number, to: number): boolean => t > from && t <= to;

/**
 * Derive the energy ledger from bar observations + known gain events.
 * Snapshots must be sorted by t. A gain inside a decline interval is
 * credited in full and the observed drop adds on top (a Xanax taken at a
 * full bar and trained away before the next poll is spend, not loss).
 *
 * `opts.truncated` marks a fetch whose row cap cut history before the
 * requested range start: the opening balance is then not the true opening,
 * so reconciliation degrades to "partial" instead of claiming "full".
 *
 * Identity: closing = opening + knownGains + derivedRegen − inferredSpent
 * − unresolvedGains.
 */
export function buildEnergyLedger(
  observations: readonly EnergyObservation[],
  gains: readonly EnergyGainEvent[],
  competing: readonly CompetingWindow[] = [],
  opts: { truncated?: boolean } = {}
): EnergyLedgerResult {
  const spendIntervals: EnergyLedgerResult["spendIntervals"] = [];
  const cleanRegenRates: number[] = [];
  let knownGains = 0;
  let derivedRegen = 0;
  let inferredSpent = 0;
  let unresolvedGains = 0;
  let cappedSeconds = 0;
  let cappedIntervals = 0;
  const byCategory = new Map<string, { amount: number; provenance: "exact" | "estimated" }>();
  const unresolvedByCategory = new Map<string, { amount: number }>();

  const sorted = [...observations].sort((a, b) => a.t - b.t);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    const dE = b.energyCurrent - a.energyCurrent;
    const inInterval = gains.filter((g) => isWithin(g.t, a.t, b.t));
    const intervalGains = inInterval.reduce((sum, g) => sum + g.amount, 0);
    const bumpUnresolved = (category: string, amount: number): void => {
      if (amount <= 0) return;
      unresolvedGains += amount;
      const entry = unresolvedByCategory.get(category);
      if (entry) entry.amount += amount;
      else unresolvedByCategory.set(category, { amount });
    };
    // Credit gains in full to the ledger and the per-category breakdown;
    // leftover budget is returned (callers turn it into unresolved).
    const applyGains = (): void => {
      for (const g of inInterval) {
        knownGains += g.amount;
        const entry = byCategory.get(g.category);
        if (entry) entry.amount += g.amount;
        else byCategory.set(g.category, { amount: g.amount, provenance: g.provenance });
      }
    };

    if (dE >= 0) {
      const pinned = a.energyCurrent === a.energyMaximum && b.energyCurrent === b.energyMaximum;
      if (pinned) {
        // Pinned at cap the whole interval: regen unobservable, only bounded.
        cappedSeconds += dt;
        cappedIntervals += 1;
        // Gains while pinned are not visible between these snapshots. Under
        // the over-max mechanic they were DELIVERED (a Xanax at the natural
        // maximum still adds energy); whether they were consumed in between
        // or waited above the max is not observable — unresolved, never
        // "lost", and never counted as regen.
        applyGains();
        for (const g of inInterval) bumpUnresolved(g.category, g.amount);
        continue;
      }
      const natural = dE - intervalGains;
      if (natural >= 0) {
        applyGains();
        derivedRegen += natural;
        cleanRegenRates.push((natural / dt) * 3600);
      } else {
        // Delivered gains exceed the observed rise: part of the delivery was
        // consumed (or banked above max) within the interval. Everything is
        // credited as delivered; the unobservable remainder is unresolved,
        // attributed across the interval's gains from the last one back (the
        // bar never showed the tail of the delivery).
        applyGains();
        let remaining = intervalGains - dE;
        for (let i = inInterval.length - 1; i >= 0 && remaining > 0; i--) {
          const g = inInterval[i]!;
          const take = Math.min(g.amount, remaining);
          bumpUnresolved(g.category, take);
          remaining -= take;
        }
      }
    } else {
      // Decline interval. Delivered gains inside the interval are credited in
      // FULL and the observed drop adds on top: a Xanax taken at the natural
      // maximum and trained away before the next poll delivers real energy
      // (the bar can hold up to 1,000), so spend = gains + |dE|. Natural
      // regeneration during a decline is NOT separately observable (bounded
      // by the derived rate), so `spend` remains a bounded inference ("~"),
      // never an exact read.
      applyGains();
      const spend = intervalGains + -dE;
      inferredSpent += spend;
      const competed = competing.some((c) => c.from <= b.t && c.to >= a.t);
      spendIntervals.push({ from: a.t, to: b.t, amount: spend, competed, estimatedGainsIncluded: intervalGains });
    }
  }

  const cadence = sorted.length >= 3 ? median(sorted.slice(1).map((s, i) => s.t - sorted[i]!.t)) : null;
  const regenPerHour = cleanRegenRates.length > 0 ? median(cleanRegenRates) : null;
  const potentialRegenTotal = cappedIntervals > 0 && regenPerHour !== null ? (cappedSeconds / 3600) * regenPerHour : null;

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    knownGains,
    knownGainsByCategory: [...byCategory.entries()]
      .map(([category, v]) => ({ category, amount: v.amount, provenance: v.provenance }))
      .filter((e) => Math.abs(e.amount) > 0)
      .sort((a, b) => b.amount - a.amount),
    derivedRegen,
    regenPerHour,
    potentialRegen: potentialRegenTotal,
    cappedSeconds,
    inferredSpent,
    unresolvedGains,
    unresolvedGainsByCategory: [...unresolvedByCategory.entries()]
      .map(([category, v]) => ({ category, amount: v.amount }))
      .filter((e) => e.amount > 0)
      .sort((a, b) => b.amount - a.amount),
    reconciliation: {
      opening: first ? first.energyCurrent : null,
      closing: last ? last.energyCurrent : null,
      observedDelta: sorted.length >= 2 && first && last ? last.energyCurrent - first.energyCurrent : null,
      quality: sorted.length >= 2 ? (opts.truncated ? "partial" : "full") : "unavailable",
    },
    spendIntervals,
    cadenceSeconds: cadence,
    coveredFrom: first ? first.t : null,
    coveredTo: last ? last.t : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Training sessions (inferred)                                                */
/* -------------------------------------------------------------------------- */

/** Centralized, documented thresholds — tune here, never ad hoc. */
export const SESSION_MIN_DROP = 25; // energy; noise floor for a training burst
export const SESSION_MERGE_GAP_SECONDS = 15 * 60; // spend intervals closer than this = one burst
export const SESSION_MIN_ENERGY_FOR_GAIN_PER_E = 50; // denominator floor for gain/E
export const JUMP_PREPARATION_WINDOW_SECONDS = 6 * 3600;
export const JUMP_ECSTASY_WINDOW_SECONDS = 2 * 3600;
export const JUMP_MIN_SIGNALS_LIKELY = 3;
export const JUMP_MIN_SIGNALS_POSSIBLE = 2;
export const JUMP_ENERGY_MULTIPLE = 3; // vs personal median session energy
export const JUMP_GAIN_MULTIPLE = 3; // vs personal median session gain
export const JUMP_PEAK_HAPPY_SHARE = 0.8; // of observed happy maximum
export const STAT_DOMINANCE_SHARE = 0.6; // one stat > 60% of gain = primary

export type InferenceStrength = "likely" | "possible";
export type StatKey = BattlestatKey | "mixed" | null;

export interface TrainingSession {
  startedAt: number;
  endedAt: number;
  /** Bounded energy inference for the burst (null when bars uncovered).
   *  Includes delivered gains credited inside the burst (a Xanax trained
   *  away between snapshots); regeneration during the burst is not
   *  separable — treat as "~". */
  energySpent: number | null;
  energyKnown: boolean;
  /** Observed battlestat gain bracketing the session; null when shared/absent. */
  gains: Record<BattlestatKey, number> | null;
  /** Bracket delta net of observable non-gym sources (job/company stats).
   *  The only figure gain-per-energy may divide by. */
  gymGain: number | null;
  totalGain: number | null;
  /** Exact job/company stat points inside the bracket (0 when none observable). */
  nonGymJobGain: number;
  /** Friend/job stat trains inside the bracket — count only; their stat
   *  amount is unobservable, so gym attribution stays provisional. */
  friendTrains: number;
  gainPerEnergy: number | null;
  primaryStat: StatKey;
  inference: InferenceStrength;
  evidence: string[];
  bracketShared: boolean;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Cluster spend intervals into bursts, attach observed battlestat gains from
 * the hourly stat brackets, and grade inference strength. An interval with
 * competing evidence (attack window) is EXCLUDED from training attribution —
 * unexplained does not mean training.
 *
 * NON-GYM ATTRIBUTION (real-user finding #13): battlestats also grow from
 * company/job activity (e.g. Mining Corporation job specials) and from stat
 * trains received from other players. Job stat points are an exact
 * cumulative counter and are netted out of the bracket; friend trains have
 * no observable stat amount, so their presence keeps gym attribution
 * provisional and disqualifies the session from gain-per-energy medians.
 */
export function detectTrainingSessions(
  ledger: EnergyLedgerResult,
  statSeries: readonly BattlestatPoint[],
  counters: readonly StatCounters[] = []
): TrainingSession[] {
  const usable = ledger.spendIntervals.filter((i) => i.amount >= SESSION_MIN_DROP && !i.competed);
  if (usable.length === 0 && statSeries.length === 0) return [];

  // Merge adjacent spend intervals into bursts.
  const bursts: Array<{ from: number; to: number; energy: number; estimatedGainsIncluded: number }> = [];
  const mergeGap = Math.max(SESSION_MERGE_GAP_SECONDS, (ledger.cadenceSeconds ?? SESSION_MERGE_GAP_SECONDS) * 2);
  for (const interval of usable) {
    const last = bursts[bursts.length - 1];
    if (last && interval.from - last.to <= mergeGap) {
      last.to = interval.to;
      last.energy += interval.amount;
      last.estimatedGainsIncluded += interval.estimatedGainsIncluded;
    } else {
      bursts.push({ from: interval.from, to: interval.to, energy: interval.amount, estimatedGainsIncluded: interval.estimatedGainsIncluded });
    }
  }

  const sessions: TrainingSession[] = [];
  for (const burst of bursts) {
    // Stat bracket: last observation at/before start and first at/after end.
    let s0: BattlestatPoint | undefined;
    let s1: BattlestatPoint | undefined;
    for (const p of statSeries) {
      if (p.t <= burst.from) s0 = p;
      if (p.t >= burst.to && !s1) {
        s1 = p;
        break;
      }
    }
    // One intervening observation (s0, s1 adjacent) and no sibling burst
    // inside the bracket → the delta belongs to this session alone.
    const adjacent = s0 && s1 ? statSeries.filter((p) => p.t > s0!.t && p.t < s1!.t).length === 0 : false;
    const bracketShared =
      !adjacent || bursts.some((other) => other !== burst && other.from < (s1?.t ?? Infinity) && other.to > (s0?.t ?? -Infinity));

    // Exact non-gym counters over the same bracket window.
    const counterAt = (t: number, pick: (c: StatCounters) => number | null): number | null => {
      let value: number | null = null;
      for (const c of counters) {
        if (c.t > t) break;
        const v = pick(c);
        if (v !== null) value = v;
      }
      return value;
    };
    const jobDelta =
      s0 && s1 ? sumCounterDelta(counterAt(burst.to, (c) => c.jobStats), counterAt(burst.from, (c) => c.jobStats)) : null;
    const trainsDelta =
      s0 && s1 ? sumCounterDelta(counterAt(burst.to, (c) => c.trainsReceived), counterAt(burst.from, (c) => c.trainsReceived)) : null;

    let gains: Record<BattlestatKey, number> | null = null;
    if (adjacent && !bracketShared && s0 && s1) {
      const g = {} as Record<BattlestatKey, number>;
      for (const key of BATTLESTAT_KEYS) {
        const a = s0[key];
        const b = s1[key];
        g[key] = a !== null && b !== null ? Math.max(0, b - a) : 0;
      }
      gains = g; // zero-gain brackets stay (energy with no gain)
    }

    const totalGain = gains ? BATTLESTAT_KEYS.reduce((s, k) => s + gains![k], 0) : null;
    // Gym-attributable gain: the bracket delta minus the exact job/company
    // portion. Clamped at 0 — the counter cannot attribute more than was
    // observed. Friend-train stat amounts are unobservable and stay inside.
    const nonGymJobGain = gains ? Math.min(Math.max(0, jobDelta ?? 0), totalGain ?? 0) : 0;
    const friendTrains = gains ? Math.max(0, trainsDelta ?? 0) : 0;
    const gymGain = gains ? Math.max(0, (totalGain ?? 0) - nonGymJobGain) : null;
    const energyKnown = burst.energy > 0;
    // Gain/E divides ONLY gym-attributable gain, and only when the bracket
    // carries no friend-train ambiguity (Phase 27: never divide mixed gains
    // by gym energy — the metric would read falsely high).
    const gainPerEnergy =
      gymGain !== null && gymGain > 0 && friendTrains === 0 && burst.energy >= SESSION_MIN_ENERGY_FOR_GAIN_PER_E
        ? gymGain / burst.energy
        : null;

    // Primary stat from the OBSERVED distribution when attribution is clean.
    let primaryStat: StatKey = null;
    if (gains && gymGain !== null && gymGain > 0) {
      const top = [...BATTLESTAT_KEYS].sort((a, b) => gains![b] - gains![a])[0]!;
      primaryStat = gains![top] / (totalGain || 1) >= STAT_DOMINANCE_SHARE ? top : "mixed";
    }

    const evidence: string[] = [];
    if (energyKnown) evidence.push(`energy decreased by ${Math.round(burst.energy)} during the window`);
    if (gains && totalGain) evidence.push(`battlestats increased by ${Math.round(totalGain)} across the bracket`);
    if (nonGymJobGain > 0) evidence.push(`${Math.round(nonGymJobGain)} stat points from job/company gains — excluded from gym attribution`);
    if (friendTrains > 0) evidence.push(`${friendTrains} stat train${friendTrains === 1 ? "" : "s"} received in the bracket — gym share not separable`);
    if (burst.estimatedGainsIncluded > 0)
      evidence.push(`~${Math.round(burst.estimatedGainsIncluded)} E from estimated Xanax delivery included (consumed between snapshots — not directly observed)`);
    if (bracketShared && statSeries.length > 0) evidence.push("stat window shared with other activity — gain not attributable");

    const inference: InferenceStrength =
      energyKnown && gymGain !== null && gymGain > 0 ? "likely" : "possible";

    sessions.push({
      startedAt: burst.from,
      endedAt: burst.to,
      energySpent: energyKnown ? burst.energy : null,
      energyKnown,
      gains,
      gymGain,
      totalGain,
      nonGymJobGain,
      friendTrains,
      gainPerEnergy,
      primaryStat,
      inference,
      evidence,
      bracketShared,
    });
  }

  return sessions.sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt);
}

/** Difference of a cumulative counter across a window (null-safe). */
function sumCounterDelta(after: number | null, before: number | null): number | null {
  return after !== null && before !== null ? after - before : null;
}

/* -------------------------------------------------------------------------- */
/* Happy jumps (inferred, deterministic rule engine)                           */
/* -------------------------------------------------------------------------- */

export interface HappyJumpEvent {
  /** Exact drug/consumption events used as evidence. */
  t: number;
  kind: "xanax" | "ecstasy" | "refill" | "happy_item";
}

export interface HappyJump {
  preparedFrom: number;
  trainedFrom: number;
  trainedTo: number;
  xanaxCount: number;
  ecstasyCount: number;
  refillUsed: boolean | null;
  energySpent: number | null;
  totalGain: number | null;
  primaryStat: StatKey;
  gainPerEnergy: number | null;
  peakHappyObserved: number | null;
  confidence: InferenceStrength;
  signals: string[];
  evidence: string[];
  missing: string[];
}

/**
 * Deterministic happy-jump inference. There is NO direct "happy jump" record
 * in Torn data — a jump is scored from evidence around a training burst:
 *   + ≥2 Xanax in the preparation window
 *   + Ecstasy close to the burst
 *   + refill inside the burst
 *   + energy far above the player's median session
 *   + gain far above the player's median session
 *   + observed happy ≥ 80% of observed max during the burst
 *   + dedicated happy item (EDVD) near the burst
 * ≥3 signals → "likely", 2 → "possible". Never "confirmed": Torn proves
 * no such classification.
 */
export function detectHappyJumps(
  sessions: readonly TrainingSession[],
  events: readonly HappyJumpEvent[],
  happyObservations: readonly EnergyObservation[],
  opts?: { medianSessionEnergy?: number | null; medianSessionGain?: number | null }
): HappyJump[] {
  const medianEnergy = opts?.medianSessionEnergy ?? null;
  const medianGain = opts?.medianSessionGain ?? null;
  const jumps: HappyJump[] = [];

  for (const session of sessions) {
    const signals: string[] = [];
    const evidence: string[] = [];
    const missing: string[] = [];

    const prepFrom = session.startedAt - JUMP_PREPARATION_WINDOW_SECONDS;
    const xanax = events.filter((e) => e.kind === "xanax" && e.t >= prepFrom && e.t <= session.endedAt);
    if (xanax.length >= 2) {
      signals.push("xanax_cluster");
      evidence.push(`${xanax.length} Xanax observed in the preparation window`);
    }
    const ecstasy = events.filter(
      (e) => e.kind === "ecstasy" && e.t >= session.startedAt - JUMP_ECSTASY_WINDOW_SECONDS && e.t <= session.endedAt
    );
    if (ecstasy.length > 0) {
      signals.push("ecstasy");
      evidence.push(`Ecstasy observed ${Math.max(0, Math.round((session.startedAt - ecstasy[ecstasy.length - 1]!.t) / 60))} min before the training burst`);
    }
    const refill = events.find((e) => e.kind === "refill" && e.t >= session.startedAt && e.t <= session.endedAt);
    if (refill) {
      signals.push("refill");
      evidence.push("energy refill observed inside the training window");
    }
    if (
      session.energySpent !== null &&
      medianEnergy !== null &&
      medianEnergy > 0 &&
      session.energySpent >= medianEnergy * JUMP_ENERGY_MULTIPLE
    ) {
      signals.push("large_energy");
      evidence.push(`energy spent (${Math.round(session.energySpent)}) is ${Math.round(session.energySpent / medianEnergy)}× your median session`);
    }
    if (session.totalGain !== null && medianGain !== null && medianGain > 0 && session.totalGain >= medianGain * JUMP_GAIN_MULTIPLE) {
      signals.push("large_gain");
      evidence.push(`observed gain (${Math.round(session.totalGain)}) is ${Math.round(session.totalGain / medianGain)}× your median session`);
    }
    const happyMax = happyObservations.find((o) => o.t >= session.startedAt && o.t <= session.endedAt && (o.happyMaximum ?? 0) > 0)
      ?.happyMaximum;
    const peakHappy = happyObservations
      .filter((o) => o.t >= session.startedAt && o.t <= session.endedAt && o.happyCurrent !== undefined)
      .reduce<number | null>((peak, o) => (peak === null || (o.happyCurrent ?? 0) > peak ? (o.happyCurrent ?? null) : peak), null);
    if (peakHappy !== null && happyMax && happyMax > 0 && peakHappy >= happyMax * JUMP_PEAK_HAPPY_SHARE) {
      signals.push("peak_happy");
      evidence.push(`observed happy peaked at ${Math.round(peakHappy)} (≥80% of ${happyMax})`);
    }
    const happyItem = events.find((e) => e.kind === "happy_item" && e.t >= prepFrom && e.t <= session.endedAt);
    if (happyItem) {
      signals.push("happy_item");
      evidence.push("happy item (EDVD) observed near the burst");
    }

    if (signals.length < JUMP_MIN_SIGNALS_POSSIBLE) continue;
    if (!happyObservations.some((o) => o.t >= session.startedAt && o.t <= session.endedAt && o.happyCurrent !== undefined)) {
      missing.push("no exact happy observation during training");
    }
    missing.push("Xanax energy is an estimate — Torn logs do not record per-use energy for Xanax");

    const confidence: InferenceStrength = signals.length >= JUMP_MIN_SIGNALS_LIKELY ? "likely" : "possible";
    jumps.push({
      preparedFrom: Math.min(prepFrom, session.startedAt),
      trainedFrom: session.startedAt,
      trainedTo: session.endedAt,
      xanaxCount: xanax.length,
      ecstasyCount: ecstasy.length,
      refillUsed: refill ? true : null,
      energySpent: session.energySpent,
      totalGain: session.totalGain,
      primaryStat: session.primaryStat,
      gainPerEnergy: session.gainPerEnergy,
      peakHappyObserved: peakHappy,
      confidence,
      signals,
      evidence,
      missing,
    });
  }

  return jumps.sort((a, b) => b.trainedFrom - a.trainedFrom);
}

/* -------------------------------------------------------------------------- */
/* Battlestat progression history, distribution, milestones                    */
/* -------------------------------------------------------------------------- */

export const TOTAL_MILESTONE_THRESHOLDS = [1e6, 5e6, 10e6, 25e6, 50e6, 1e8, 2.5e8, 5e8, 1e9];

export interface BattlestatProgression {
  perStat: Array<{ key: BattlestatKey; label: string; opening: number | null; closing: number | null; delta: number | null; changePct: number | null }>;
  openingTotal: number | null;
  closingTotal: number | null;
  deltaTotal: number | null;
  changePct: number | null;
  gainPerDay: number | null;
  /** How the opening baseline was chosen:
   *  - "at_range_start": latest snapshot at/before the range start (true
   *    range change);
   *  - "tracked_since": no snapshot exists at/before the range start, so the
   *    earliest IN-RANGE snapshot anchors the change — the figure covers a
   *    SHORTER span than requested and must be labeled "since tracking
   *    began" (real-user finding: the mysterious 7d dash for newer history);
   *  - null: no usable baseline at all — "Not enough history yet". */
  baselineKind: "at_range_start" | "tracked_since" | null;
  /** Actual observed span between baseline and closing, in days (null when
   *  unmeasurable). gainPerDay is only derived when this is >= 1. */
  spanDays: number | null;
  series: Array<{ t: number; strength: number | null; defense: number | null; speed: number | null; dexterity: number | null; total: number | null }>;
  distribution: Array<{ key: BattlestatKey; share: number | null }>;
}

const STAT_LABELS: Record<BattlestatKey, string> = { strength: "Strength", defense: "Defense", speed: "Speed", dexterity: "Dexterity" };

function lastAtOrBefore<T extends { t: number }>(series: readonly T[], t: number): T | undefined {
  let found: T | undefined;
  for (const p of series) {
    if (p.t <= t) found = p;
    else break;
  }
  return found;
}

export function battlestatProgression(series: readonly BattlestatPoint[], from: number, to: number): BattlestatProgression {
  let baseline = lastAtOrBefore(series, from);
  let baselineKind: BattlestatProgression["baselineKind"] = baseline ? "at_range_start" : null;
  if (!baseline) {
    // Tracking began inside the requested range. Fall back to the earliest
    // in-range observation so the change is still shown — but labeled as a
    // shorter "since tracking began" span, never a fabricated full-range
    // figure. The dash is reserved for genuinely no history at all.
    for (const p of series) {
      if (p.t >= from && p.t <= to) {
        baseline = p;
        baselineKind = "tracked_since";
        break;
      }
      if (p.t > to) break;
    }
  }
  const closing = lastAtOrBefore(series, to);
  const perStat = BATTLESTAT_KEYS.map((key) => {
    const a = baseline?.[key] ?? null;
    const b = closing?.[key] ?? null;
    const delta = a !== null && b !== null ? b - a : null;
    return {
      key,
      label: STAT_LABELS[key],
      opening: a,
      closing: b,
      delta,
      changePct: a !== null && b !== null && a > 0 ? ((b - a) / a) * 100 : null,
    };
  });
  const openingTotal = baseline?.total ?? null;
  const closingTotal = closing?.total ?? null;
  const deltaTotal = openingTotal !== null && closingTotal !== null ? closingTotal - openingTotal : null;
  const spanDays = baseline && closing ? (closing.t - baseline.t) / 86_400 : null;
  // Annualizing to a day requires at least a day of observed span — below
  // that the number would fabricate precision, so it stays null (the UI
  // explains "less than a day of history" instead of a bare dash).
  const gainPerDay = deltaTotal !== null && spanDays !== null && spanDays >= 1 ? deltaTotal / spanDays : null;
  const distribution = BATTLESTAT_KEYS.map((key) => {
    const value = closing?.[key] ?? null;
    const total = closingTotal;
    return { key, share: value !== null && total !== null && total > 0 ? value / total : null };
  });
  return {
    perStat,
    openingTotal,
    closingTotal,
    deltaTotal,
    changePct:
      openingTotal !== null && closingTotal !== null && openingTotal > 0 ? ((closingTotal - openingTotal) / openingTotal) * 100 : null,
    gainPerDay,
    baselineKind,
    spanDays,
    series: series.filter((p) => p.t >= from && p.t <= to),
    distribution,
  };
}

export interface StatMilestone {
  kind: "total" | BattlestatKey;
  label: string;
  threshold: number;
  crossedBetween: [number, number];
}

/** Deterministic threshold crossings with honest crossing windows. */
export function detectStatMilestones(series: readonly BattlestatPoint[], thresholds: readonly number[] = TOTAL_MILESTONE_THRESHOLDS): StatMilestone[] {
  const milestones: StatMilestone[] = [];
  const tracks: Array<{ kind: StatMilestone["kind"]; label: string; get: (p: BattlestatPoint) => number | null }> = [
    ...BATTLESTAT_KEYS.map((key) => ({ kind: key as StatMilestone["kind"], label: STAT_LABELS[key], get: (p: BattlestatPoint) => p[key] })),
    { kind: "total" as const, label: "Total battlestats", get: (p: BattlestatPoint) => p.total },
  ];
  for (const track of tracks) {
    for (let i = 1; i < series.length; i++) {
      const prev = track.get(series[i - 1]!);
      const cur = track.get(series[i]!);
      if (prev === null || cur === null) continue;
      for (const threshold of thresholds) {
        if (prev < threshold && cur >= threshold) {
          milestones.push({ kind: track.kind, label: track.label, threshold, crossedBetween: [series[i - 1]!.t, series[i]!.t] });
        }
      }
    }
  }
  return milestones.sort((a, b) => b.crossedBetween[1] - a.crossedBetween[1]);
}

/* -------------------------------------------------------------------------- */
/* Personal baselines                                                          */
/* -------------------------------------------------------------------------- */

export interface EfficiencyBaseline {
  /** Median session gain/E in the baseline window (null when < 2 samples). */
  medianGainPerEnergy: number | null;
  samples: number;
  /** Current-period ratio vs baseline (e.g. 1.12 = 12% above). */
  ratio: number | null;
}

/** "12% above your 30-day median" — never a universal good/bad judgment. */
export function efficiencyBaseline(baselineSessions: readonly TrainingSession[], current: TrainingSession | null): EfficiencyBaseline {
  const samples = baselineSessions.filter((s) => s.gainPerEnergy !== null);
  const medianGainPerEnergy = samples.length >= 2 ? median(samples.map((s) => s.gainPerEnergy!)) : null;
  return {
    medianGainPerEnergy,
    samples: samples.length,
    ratio: medianGainPerEnergy && current?.gainPerEnergy ? current.gainPerEnergy / medianGainPerEnergy : null,
  };
}

/** Median session energy / gain — the personal baselines for jump scoring. */
export function sessionMedians(sessions: readonly TrainingSession[]): { energy: number | null; gain: number | null } {
  const energies = sessions.filter((s) => s.energySpent !== null).map((s) => s.energySpent!);
  const gains = sessions.filter((s) => s.totalGain !== null && s.totalGain > 0).map((s) => s.totalGain!);
  return { energy: energies.length >= 2 ? median(energies) : null, gain: gains.length >= 2 ? median(gains) : null };
}

/** Training frequency context (days trained, sessions) over the series. */
export function trainingFrequency(sessions: readonly TrainingSession[], now: number): { sessions: number; daysTrained: number; avgEnergyPerTrainingDay: number | null } {
  const dayKeys = new Set(sessions.map((s) => Math.floor(s.startedAt / 86_400)));
  const energies = sessions.filter((s) => s.energySpent !== null).map((s) => s.energySpent!);
  return {
    sessions: sessions.length,
    daysTrained: dayKeys.size,
    avgEnergyPerTrainingDay: dayKeys.size > 0 ? energies.reduce((s, e) => s + e, 0) / dayKeys.size : null,
  };
}
