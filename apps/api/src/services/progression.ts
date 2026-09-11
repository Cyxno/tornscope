import {
  kpiAvailabilityFromConfidence,
  resolveDateRange,
  type DateRangeInput,
  type KpiAvailability,
  type KpiValue,
  type ProgressionResponse,
  type SyncResource,
} from "@tornscope/shared";
import {
  battlestatProgression,
  buildBattlestatSeries,
  buildEnergyLedger,
  detectHappyJumps,
  detectStatMilestones,
  detectTrainingSessions,
  efficiencyBaseline,
  extractStatCounters,
  sessionMedians,
  trainingFrequency,
  XANAX_ENERGY_ESTIMATE,
  type BattlestatPoint,
  type CompetingWindow,
  type EnergyGainEvent,
  type EnergyObservation,
  type HappyJumpEvent,
  type TrainingSession,
} from "@tornscope/analytics";
import { getPrismaClient } from "@tornscope/database";
import { loadAvailabilityContext, sectionAvailability } from "./availability.js";
import { resourceConfidence } from "./confidence.js";

/**
 * Progression & Energy Intelligence (docs/PROGRESSION-ENERGY.md).
 *
 * One bounded read per source, one analysis pass:
 *  - BarsSnapshot (5-min, from bars-resource collection start) → energy ledger
 *  - PersonalStatSnapshot (hourly) → battle_stats series + cumulative counters
 *  - TimelineEvent (exact title) → points-refill events with energy_increased
 *  - DrugEvent → Xanax/Ecstasy uses (Xanax energy = documented estimate)
 *  - ConsumptionEvent → energy-drink gains (exact), candy/EDVD happy evidence
 *  - CombatEvent → competing-energy windows (drops during attacks are NEVER
 *    attributed to training)
 *  - UserSnapshot → level history
 *
 * Bounds: bars capped (≈70 days at 5-min cadence) and stat snapshots capped
 * (≈166 days at hourly) — longer ranges degrade to partial coverage instead
 * of unbounded reads. The fetch window extends one baseline period before
 * `from` so personal medians come from prior history.
 */

const BARS_MAX_ROWS = 20_000;
const STATS_MAX_ROWS = 4_000;
// Evidence queries (refills/drugs/consumption/combat/levels) never need the
// full history — the analysis window is the fetch range + baseline. Caps are
// pure runaway guards (roadmap #8), far above any real range.
const EVIDENCE_MAX_ROWS = 20_000;
const LEVELS_MAX_ROWS = 2_000;
const BASELINE_WINDOW_SECONDS = 30 * 86_400;
const ATTACK_COMPETITION_SECONDS = 900;

/** Extract the exact refilled energy from a raw points-refill log payload. */
function refillEnergyFromMetadata(metadata: unknown): number | null {
  const amount = (metadata as { data?: { energy_increased?: unknown } } | null)?.data?.energy_increased;
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** Extract the exact energy delta from an item-use consumption payload. */
function energyFromConsumptionMetadata(metadata: unknown): number | null {
  const amount = (metadata as { data?: { energy_increased?: unknown } } | null)?.data?.energy_increased;
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : null;
}

const sec = (d: Date): number => Math.floor(d.getTime() / 1000);

function toEnergyObservations(rows: Array<{ capturedAt: Date; energyCurrent: number; energyMaximum: number; happyCurrent: number; happyMaximum: number }>): EnergyObservation[] {
  return rows.map((r) => ({
    t: sec(r.capturedAt),
    energyCurrent: r.energyCurrent,
    energyMaximum: r.energyMaximum,
    happyCurrent: r.happyCurrent,
    happyMaximum: r.happyMaximum,
  }));
}

function medianOf(values: number[]): number | null {
  if (values.length < 2) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export async function getProgression(userId: string, rangeInput: DateRangeInput): Promise<ProgressionResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const from = range.from;
  const to = range.to;
  const fetchFrom = from - BASELINE_WINDOW_SECONDS;

  const availCtx = await loadAvailabilityContext(userId);
  const barsConfidence = resourceConfidence(availCtx, "bars" as SyncResource, { range: { from, to } });
  const statsConfidence = resourceConfidence(availCtx, "personal_stats" as SyncResource, { range: { from, to } });
  const logsConfidence = resourceConfidence(availCtx, "drugs" as SyncResource, { range: { from, to } });

  const [barsRows, statRows, refillRows, drugRows, consumptionRows, combatRows, levelRows] = await Promise.all([
    // Descending fetch + reverse: when the row cap cuts a long range it must
    // drop the OLDEST observations, never the most recent ones — a stale
    // closing value presented as current would be silent dishonesty.
    db.barsSnapshot.findMany({
      where: { userId, capturedAt: { gte: new Date(fetchFrom * 1000), lte: new Date(to * 1000) } },
      orderBy: { capturedAt: "desc" },
      take: BARS_MAX_ROWS,
      select: { capturedAt: true, energyCurrent: true, energyMaximum: true, happyCurrent: true, happyMaximum: true },
    }),
    db.personalStatSnapshot.findMany({
      where: { userId, capturedAt: { gte: new Date(fetchFrom * 1000), lte: new Date(to * 1000) } },
      orderBy: { capturedAt: "desc" },
      take: STATS_MAX_ROWS,
      select: { capturedAt: true, stats: true },
    }),
    db.timelineEvent.findMany({
      where: { userId, title: "Points energy refill use", occurredAt: { gte: new Date(fetchFrom * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      take: EVIDENCE_MAX_ROWS,
      select: { occurredAt: true, metadata: true },
    }),
    db.drugEvent.findMany({
      where: { userId, drugName: { in: ["Xanax", "Ecstasy"] }, occurredAt: { gte: new Date(fetchFrom * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      take: EVIDENCE_MAX_ROWS,
      select: { occurredAt: true, drugName: true, outcome: true },
    }),
    db.consumptionEvent.findMany({
      where: { userId, category: { in: ["energy", "candy", "happy_jump"] }, occurredAt: { gte: new Date(fetchFrom * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      take: EVIDENCE_MAX_ROWS,
      select: { occurredAt: true, category: true, metadata: true },
    }),
    db.combatEvent.findMany({
      where: { userId, direction: "outgoing", occurredAt: { gte: new Date(fetchFrom * 1000), lte: new Date(to * 1000) } },
      take: EVIDENCE_MAX_ROWS,
      select: { occurredAt: true },
    }),
    db.userSnapshot.findMany({
      where: { userId, capturedAt: { gte: new Date(fetchFrom * 1000), lte: new Date(to * 1000) } },
      orderBy: { capturedAt: "asc" },
      take: LEVELS_MAX_ROWS,
      select: { capturedAt: true, level: true },
    }),
  ]);

  /* ----------------------------- build inputs ----------------------------- */
  barsRows.reverse();
  statRows.reverse();
  const bars = toEnergyObservations(barsRows);
  const statRowsShaped = statRows.map((r) => ({ capturedAt: sec(r.capturedAt), stats: r.stats }));
  const statSeries: BattlestatPoint[] = buildBattlestatSeries(statRowsShaped);
  const counterSeries = statRowsShaped.map((r) => ({ t: r.capturedAt, ...extractStatCounters(r.stats) }));

  const gains: EnergyGainEvent[] = [];
  const xanaxEvents: HappyJumpEvent[] = [];
  const ecstasyEvents: HappyJumpEvent[] = [];
  const happyItemEvents: HappyJumpEvent[] = [];

  for (const r of refillRows) {
    const amount = refillEnergyFromMetadata(r.metadata);
    if (amount !== null) gains.push({ t: sec(r.occurredAt), amount, category: "refill", provenance: "exact" });
  }
  for (const r of drugRows) {
    const t = sec(r.occurredAt);
    if (r.drugName === "Xanax") {
      if (r.outcome === "success") {
        // Documented game convention: normal Xanax logs record NO energy
        // field. The canonical amount is applied per use, provenance
        // "estimated"; cap interactions surface via reconciliation overshoot.
        gains.push({ t, amount: XANAX_ENERGY_ESTIMATE, category: "xanax", provenance: "estimated" });
        xanaxEvents.push({ t, kind: "xanax" });
      }
    } else {
      ecstasyEvents.push({ t, kind: "ecstasy" });
    }
  }
  for (const r of consumptionRows) {
    const t = sec(r.occurredAt);
    if (r.category === "energy") {
      const amount = energyFromConsumptionMetadata(r.metadata);
      if (amount !== null) gains.push({ t, amount, category: "energy_drink", provenance: "exact" });
    } else if (r.category === "happy_jump") {
      happyItemEvents.push({ t, kind: "happy_item" });
    }
  }
  const competing: CompetingWindow[] = combatRows.map((r) => ({
    from: sec(r.occurredAt) - ATTACK_COMPETITION_SECONDS,
    to: sec(r.occurredAt) + ATTACK_COMPETITION_SECONDS,
    kind: "attack" as const,
  }));
  const jumpEvents: HappyJumpEvent[] = [...xanaxEvents, ...ecstasyEvents, ...happyItemEvents];

  /* --------------------------- energy analysis ---------------------------- */
  const rangeBars = bars.filter((o) => o.t >= from && o.t <= to);
  const covered = rangeBars.length >= 2;
  // Row cap hit → history before the range start was dropped, the ledger's
  // opening is not the true opening: reconciliation is explicitly "partial".
  const barsTruncated = barsRows.length >= BARS_MAX_ROWS;
  const ledger = buildEnergyLedger(rangeBars, gains.filter((g) => g.t >= from), competing, { truncated: barsTruncated });

  /* -------------------------- battlestat analysis ------------------------- */
  const rangeStats = statSeries.filter((p) => p.t >= from && p.t <= to);
  const progression = battlestatProgression(statSeries, from, to);
  const statMilestones = detectStatMilestones(rangeStats);
  const trackedSince = statSeries.length > 0 ? statSeries[0]!.t : null;
  const latestCounters = counterSeries.length > 0 ? counterSeries[counterSeries.length - 1]! : null;
  const baselineCounters = counterSeries.find((c) => c.t >= from) ?? counterSeries[0] ?? null;

  /* --------------------------- training sessions -------------------------- */
  // Sessions computed over the FETCH window so the baseline prefix feeds the
  // personal medians; only sessions inside the range are reported.
  const ledgerWhole = buildEnergyLedger(bars, gains, competing);
  const statSeriesWhole = buildBattlestatSeries(statRowsShaped);
  const allSessions = detectTrainingSessions(ledgerWhole, statSeriesWhole);
  const rangeSessions = allSessions.filter((s) => s.startedAt >= from && s.startedAt <= to);
  const baselineSessions = allSessions.filter((s) => s.startedAt < from);
  const baseline = efficiencyBaseline(baselineSessions, rangeSessions[rangeSessions.length - 1] ?? null);
  const medians = sessionMedians(allSessions);

  /* ------------------------------ happy jumps ----------------------------- */
  const jumps = detectHappyJumps(rangeSessions, jumpEvents, rangeBars, {
    medianSessionEnergy: medians.energy,
    medianSessionGain: medians.gain,
  });
  const isJump = (s: TrainingSession): boolean =>
    jumps.some((j) => j.trainedFrom === s.startedAt && j.trainedTo === s.endedAt);
  const jumpSessions = rangeSessions.filter(isJump);
  const normalSessions = rangeSessions.filter((s) => !isJump(s));
  const gainPerE = (sessions: TrainingSession[]): number[] =>
    sessions.filter((s) => s.gainPerEnergy !== null).map((s) => s.gainPerEnergy!);

  const freq = trainingFrequency(rangeSessions, to);
  // Spec phase 10: unexplained drops are NOT training. Only "likely" sessions
  // (energy decline + observed stat gain, no competing evidence) carry energy;
  // "possible" bursts stay in Unattributed.
  const energyTrained = rangeSessions
    .filter((s) => s.inference === "likely")
    .reduce((sum, s) => sum + (s.energySpent ?? 0), 0);
  const unattributed = Math.max(0, ledger.observedSpent - energyTrained);

  const statsAvailability: KpiAvailability = kpiAvailabilityFromConfidence(statsConfidence);
  const energyAvailability: KpiAvailability = kpiAvailabilityFromConfidence(barsConfidence);
  const kpi = (value: number | null, provenance: KpiValue["provenance"], availability: KpiAvailability = "ok"): KpiValue => ({
    value,
    provenance,
    availability,
  });

  return {
    range: { from, to },
    generatedAt: Math.floor(Date.now() / 1000),
    availability: {
      battlestats: sectionAvailability(availCtx, "progression_battlestats", "personal_stats"),
      energy: sectionAvailability(availCtx, "progression_energy", "bars"),
      training: sectionAvailability(availCtx, "progression_training", "bars"),
      happyJumps: sectionAvailability(availCtx, "progression_happy_jumps", "drugs"),
    },
    summary: {
      totalBattlestats: kpi(progression.closingTotal, "exact", statsAvailability),
      totalDelta: kpi(progression.deltaTotal, "derived", statsAvailability),
      gainPerDay: kpi(progression.gainPerDay, "derived", statsAvailability),
      energyTrained: kpi(covered ? energyTrained : null, "estimated", energyAvailability),
      sessions: rangeSessions.length,
      likelyJumps: jumps.filter((j) => j.confidence === "likely").length,
    },
    battlestats: {
      perStat: progression.perStat,
      openingTotal: progression.openingTotal,
      closingTotal: progression.closingTotal,
      deltaTotal: progression.deltaTotal,
      changePct: progression.changePct,
      gainPerDay: progression.gainPerDay,
      distribution: progression.distribution,
      series: rangeStats,
      milestones: statMilestones,
      trackedSince,
      confidence: statsConfidence,
    },
    energy: {
      covered,
      coveredFrom: ledger.coveredFrom,
      coveredTo: ledger.coveredTo,
      sources: [
        ...ledger.knownGainsByCategory.map((g) => ({
          category:
            g.category === "refill" ? "Refill" : g.category === "xanax" ? "Xanax (est.)" : g.category === "energy_drink" ? "Energy drinks" : g.category,
          amount: g.amount,
          provenance: g.provenance,
        })),
        ...(covered ? [{ category: "Natural regen (derived)", amount: ledger.derivedRegen, provenance: "derived" as const }] : []),
      ] as ProgressionResponse["energy"]["sources"],
      uses: [
        { category: "Training (inferred)", amount: energyTrained, provenance: "estimated" as const },
        { category: "Unattributed (observed)", amount: unattributed, provenance: "derived" as const },
      ].filter((u) => u.amount > 0),
      derivedRegen: covered ? ledger.derivedRegen : null,
      regenPerHour: ledger.regenPerHour,
      potentialRegen: ledger.potentialRegen,
      cappedSeconds: ledger.cappedSeconds > 0 ? ledger.cappedSeconds : null,
      absorbedOvershoot: ledger.absorbedOvershoot > 0 ? ledger.absorbedOvershoot : null,
      reconciliation: ledger.reconciliation,
      confidence: barsConfidence,
    },
    training: {
      sessions: rangeSessions,
      medianGainPerEnergy: medianOf(gainPerE(rangeSessions)),
      baselineMedianGainPerEnergy: baseline.medianGainPerEnergy,
      baselineSamples: baseline.samples,
      efficiencyVsBaseline: baseline.ratio,
      daysTrained: freq.daysTrained,
      avgEnergyPerTrainingDay: freq.avgEnergyPerTrainingDay,
      normalVsJump: {
        normalMedianGainPerEnergy: medianOf(gainPerE(normalSessions)),
        jumpMedianGainPerEnergy: medianOf(gainPerE(jumpSessions)),
        normalSamples: gainPerE(normalSessions).length,
        jumpSamples: gainPerE(jumpSessions).length,
      },
      confidence: barsConfidence,
    },
    happyJumps: {
      jumps,
      confidence: logsConfidence,
    },
    profile: {
      level: levelRows.length > 0 ? levelRows[levelRows.length - 1]!.level : null,
      levelHistory: levelRows.map((r) => ({ t: sec(r.capturedAt), level: r.level })),
      awards: latestCounters?.awards ?? null,
      awardsDelta:
        latestCounters?.awards != null && baselineCounters?.awards != null ? latestCounters.awards - baselineCounters.awards : null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Compact integration helpers (Daily Summary + Overview)                      */
/* -------------------------------------------------------------------------- */

export interface ProgressionGlimpse {
  /** Observed battlestat gain over the window (derived, hourly brackets). */
  battlestatGain: number | null;
  /** Energy attributed to inferred training sessions (estimated). */
  energyTrained: number | null;
  sessions: number;
  likelyJumps: number;
}

/**
 * One bounded read + one analysis pass for the compact Progression glimpse
 * used by Daily Summary and Overview. Never null-into-zero: without bar or
 * stat history the figures stay null.
 */
export async function getProgressionGlimpse(userId: string, from: number, to: number): Promise<ProgressionGlimpse> {
  const db = getPrismaClient();
  const windowFrom = from - BASELINE_WINDOW_SECONDS;
  const [barsRows, statRows] = await Promise.all([
    db.barsSnapshot.findMany({
      where: { userId, capturedAt: { gte: new Date(windowFrom * 1000), lte: new Date(to * 1000) } },
      orderBy: { capturedAt: "desc" },
      take: BARS_MAX_ROWS,
      select: { capturedAt: true, energyCurrent: true, energyMaximum: true, happyCurrent: true, happyMaximum: true },
    }),
    // One hour of pre-window fetch anchors the baseline for the day delta.
    db.personalStatSnapshot.findMany({
      where: { userId, capturedAt: { gte: new Date((from - 3600) * 1000), lte: new Date(to * 1000) } },
      orderBy: { capturedAt: "asc" },
      take: STATS_MAX_ROWS,
      select: { capturedAt: true, stats: true },
    }),
  ]);
  barsRows.reverse();
  const statSeries = buildBattlestatSeries(statRows.map((r) => ({ capturedAt: sec(r.capturedAt), stats: r.stats })));
  const prog = battlestatProgression(statSeries, from, to);
  const bars = toEnergyObservations(barsRows);
  if (bars.length < 2) {
    return { battlestatGain: prog.deltaTotal, energyTrained: null, sessions: 0, likelyJumps: 0 };
  }
  const ledger = buildEnergyLedger(bars.filter((o) => o.t >= from), [], []);
  const sessions = detectTrainingSessions(ledger, statSeries).filter((s) => s.startedAt >= from && s.startedAt <= to);
  return {
    battlestatGain: prog.deltaTotal,
    energyTrained: sessions.reduce((sum, s) => sum + (s.energySpent ?? 0), 0),
    sessions: sessions.length,
    likelyJumps: 0, // jump detection needs drug events — full getProgression only
  };
}
