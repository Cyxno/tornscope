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
  buildAccountCounters,
  buildBattlestatSeries,
  buildEnergyCappedHours,
  buildEnergyLedger,
  buildTrainingIntelligence,
  detectHappyJumps,
  detectStatMilestones,
  detectTrainingSessions,
  efficiencyBaseline,
  extractStatCounters,
  sessionMedians,
  shapeEnergyInputs,
  trainingFrequency,
  XANAX_ENERGY_ESTIMATE,
  type BattlestatPoint,
  type CompetingWindow,
  type EnergyGainEvent,
  type EnergyObservation,
  type HappyJumpEvent,
  type StatCounters,
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
// pure runaway guards (roadmap #8), far above any real range. When a cap is
// HIT the energy analysis downgrades to partial/analysis_truncated instead
// of silently analyzing a clipped window (roadmap #9 remediation).
const cap = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 100 ? Math.round(parsed) : fallback;
};
const EVIDENCE_MAX_ROWS = cap(process.env.PROGRESSION_EVIDENCE_MAX_ROWS, 20_000);
const LEVELS_MAX_ROWS = cap(process.env.PROGRESSION_LEVELS_MAX_ROWS, 2_000);
const BASELINE_WINDOW_SECONDS = 30 * 86_400;
/** Extract the exact refilled energy from a raw points-refill log payload. */
function refillEnergyFromMetadata(metadata: unknown): number | null {
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
      orderBy: { occurredAt: "asc" },
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

  // Evidence truncation disclosure (roadmap #9 remediation).
  const evidenceTruncated =
    refillRows.length >= EVIDENCE_MAX_ROWS ||
    drugRows.length >= EVIDENCE_MAX_ROWS ||
    consumptionRows.length >= EVIDENCE_MAX_ROWS ||
    combatRows.length >= EVIDENCE_MAX_ROWS;
  const energyConfidence = evidenceTruncated
    ? { ...barsConfidence, confidence: "partial" as const, reason: "analysis_truncated" as const }
    : barsConfidence;

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

  // Canonical gain/competing shaping shared with the glimpse engine.
  const shaped = shapeEnergyInputs(refillRows, drugRows, consumptionRows, combatRows);
  gains.push(...shaped.gains);
  for (const r of drugRows) {
    const t = sec(r.occurredAt);
    if (r.drugName === "Xanax") {
      if (r.outcome === "success") xanaxEvents.push({ t, kind: "xanax" });
    } else {
      ecstasyEvents.push({ t, kind: "ecstasy" });
    }
  }
  for (const r of consumptionRows) {
    if (r.category === "happy_jump") happyItemEvents.push({ t: sec(r.occurredAt), kind: "happy_item" });
  }
  const competing: CompetingWindow[] = shaped.competing;
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
  // personal medians; only sessions inside the range are reported. Counter
  // series rides along so job/company stat gains are netted out of gym
  // attribution on every surface (real-user finding #13).
  const ledgerWhole = buildEnergyLedger(bars, gains, competing);
  const statSeriesWhole = buildBattlestatSeries(statRowsShaped);
  // Account progression counters (2.6.0): long-term cumulative counters from
  // the same PersonalStatSnapshot history — deltas over the selected range.
  const accountCounters = buildAccountCounters(
    statRowsShaped.map((r) => ({ t: r.capturedAt, stats: r.stats })),
    { from, to }
  );
  const allSessions = detectTrainingSessions(ledgerWhole, statSeriesWhole, counterSeries);
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
  const unattributed = Math.max(0, ledger.inferredSpent - energyTrained);

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
      baselineKind: progression.baselineKind,
      spanDays: progression.spanDays,
      // Exact attribution split of the range's total battlestat change
      // (real-user finding #13): gym-attributed from session brackets with
      // job/company gains netted, the exact job counter delta, and the
      // remainder (friend-train amounts, unbracketed moves) left honest.
      attribution: buildBattlestatAttribution(progression, rangeSessions, counterSeries, from, to),
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
        { category: "Unattributed (inferred)", amount: unattributed, provenance: "derived" as const },
      ].filter((u) => u.amount > 0),
      derivedRegen: covered ? ledger.derivedRegen : null,
      regenPerHour: ledger.regenPerHour,
      potentialRegen: ledger.potentialRegen,
      cappedSeconds: ledger.cappedSeconds > 0 ? ledger.cappedSeconds : null,
      unresolvedGains: ledger.unresolvedGains > 0 ? ledger.unresolvedGains : null,
      unresolvedGainsByCategory: ledger.unresolvedGainsByCategory.map((g) => ({
        category: g.category === "xanax" ? "Xanax (est.)" : g.category === "refill" ? "Refill" : g.category === "energy_drink" ? "Energy drinks" : g.category,
        amount: g.amount,
      })),
      xanax: (() => {
        const uses = xanaxEvents.filter((e) => e.t >= from && e.t <= to).length;
        if (uses === 0) return null;
        // "Attributed to training": delivered Xanax energy whose event falls
        // inside a LIKELY training session window (the take-then-train
        // pattern). The remainder is genuinely unresolved between snapshots.
        const attributed = xanaxEvents
          .filter((e) => e.t >= from && e.t <= to)
          .filter((e) =>
            rangeSessions.some(
              (s) => s.inference === "likely" && e.t >= s.startedAt && e.t <= s.endedAt
            )
          ).length;
        return { uses, estimatedDelivered: uses * XANAX_ENERGY_ESTIMATE, attributedToTraining: attributed * XANAX_ENERGY_ESTIMATE };
      })(),
      reconciliation: ledger.reconciliation,
      confidence: energyConfidence,
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
      confidence: energyConfidence,
    },
    happyJumps: {
      jumps,
      confidence: logsConfidence,
    },
    // Training Intelligence 2.0: fixed trailing windows anchored at the viewed
    // period end (`to`) — same inferred sessions, one inference path.
    trainingIntelligence: buildTrainingIntelligence({
      now: to,
      sessions: allSessions,
      energyCappedHours: buildEnergyCappedHours(
        barsRows.map((r) => ({ capturedAt: sec(r.capturedAt), energyCurrent: r.energyCurrent, energyMaximum: r.energyMaximum })),
        to - 37 * 86_400,
        to
      ),
    }),
    profile: {
      level: levelRows.length > 0 ? levelRows[levelRows.length - 1]!.level : null,
      levelHistory: levelRows.map((r) => ({ t: sec(r.capturedAt), level: r.level })),
      awards: latestCounters?.awards ?? null,
      awardsDelta:
        latestCounters?.awards != null && baselineCounters?.awards != null ? latestCounters.awards - baselineCounters.awards : null,
    },
    accountCounters: statRowsShaped.length > 0 ? accountCounters : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Compact integration helpers (Daily Summary + Overview)                      */
/* -------------------------------------------------------------------------- */

/**
 * Exact attribution split of a range's total battlestat change (Phase 25):
 *   gym   — session brackets with the exact job counter netted out
 *   job   — cumulative job/company stat counter delta over the range
 *   other — the remainder (friend-train stat amounts, unbracketed moves,
 *           price-era snapshot noise) — surfaced, never forced into "gym".
 */
function buildBattlestatAttribution(
  progression: ReturnType<typeof battlestatProgression>,
  rangeSessions: TrainingSession[],
  counterSeries: StatCounters[],
  from: number,
  to: number
): { gym: number | null; job: number | null; other: number | null; friendTrains: number | null } {
  if (progression.deltaTotal === null) return { gym: null, job: null, other: null, friendTrains: null };
  const counterAt = (t: number, pick: (c: StatCounters) => number | null): number | null => {
    let value: number | null = null;
    for (const c of counterSeries) {
      if (c.t > t) break;
      const v = pick(c);
      if (v !== null) value = v;
    }
    return value;
  };
  const jobAfter = counterAt(to, (c) => c.jobStats);
  const jobBefore = counterAt(from, (c) => c.jobStats);
  const trainsAfter = counterAt(to, (c) => c.trainsReceived);
  const trainsBefore = counterAt(from, (c) => c.trainsReceived);
  const job = jobAfter !== null && jobBefore !== null ? Math.max(0, jobAfter - jobBefore) : null;
  const friendTrains = trainsAfter !== null && trainsBefore !== null ? Math.max(0, trainsAfter - trainsBefore) : null;
  const gym = rangeSessions
    .filter((s) => s.inference === "likely")
    .reduce((sum, s) => sum + (s.gymGain ?? 0), 0);
  const other = Math.max(0, progression.deltaTotal - (gym + (job ?? 0)));
  return { gym, job, other, friendTrains };
}

export interface ProgressionGlimpse {
  /** Observed battlestat gain over the window (derived, hourly brackets). */
  battlestatGain: number | null;
  /**
   * Gym-ATTRIBUTABLE share of that gain (real-user finding #13: a snapshot
   * delta is a TOTAL stat change — job/company points are netted out and
   * friend-train amounts keep attribution provisional). Null when no likely
   * session has a clean stat bracket; the total delta stays in
   * battlestatGain with different wording.
   */
  gymGain: number | null;
  /** Energy attributed to inferred training sessions (estimated). */
  energyTrained: number | null;
  sessions: number;
  likelyJumps: number;
}

/**
 * One bounded read + one analysis pass for the compact Progression glimpse
 * used by Daily Summary and Overview. Never null-into-zero: without bar or
 * stat history the figures stay null.
 *
 * ONE CANONICAL ENGINE (real-user finding: Today said "360 E / 3 sessions"
 * while Progression disagreed): the glimpse feeds the SAME known-gain events
 * (refill exact, Xanax estimated, energy drinks) and the SAME competing
 * attack windows into buildEnergyLedger as the main page — raw observed
 * declines are never a separate definition of training energy.
 */
export async function getProgressionGlimpse(userId: string, from: number, to: number): Promise<ProgressionGlimpse> {
  const db = getPrismaClient();
  const windowFrom = from - BASELINE_WINDOW_SECONDS;
  const [barsRows, statRows, refillRows, drugRows, consumptionRows, combatRows] = await Promise.all([
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
    db.timelineEvent.findMany({
      where: { userId, title: "Points energy refill use", occurredAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      take: EVIDENCE_MAX_ROWS,
      select: { occurredAt: true, metadata: true },
    }),
    db.drugEvent.findMany({
      where: { userId, drugName: { in: ["Xanax", "Ecstasy"] }, occurredAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      take: EVIDENCE_MAX_ROWS,
      select: { occurredAt: true, drugName: true, outcome: true },
    }),
    db.consumptionEvent.findMany({
      where: { userId, category: { in: ["energy", "candy", "happy_jump"] }, occurredAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      take: EVIDENCE_MAX_ROWS,
      select: { occurredAt: true, category: true, metadata: true },
    }),
    db.combatEvent.findMany({
      where: { userId, direction: "outgoing", occurredAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      take: EVIDENCE_MAX_ROWS,
      select: { occurredAt: true },
    }),
  ]);
  barsRows.reverse();
  const statSeries = buildBattlestatSeries(statRows.map((r) => ({ capturedAt: sec(r.capturedAt), stats: r.stats })));
  const counterSeries = statRows.map((r) => ({ t: sec(r.capturedAt), ...extractStatCounters(r.stats) }));
  const prog = battlestatProgression(statSeries, from, to);
  const bars = toEnergyObservations(barsRows);
  if (bars.length < 2) {
    return { battlestatGain: prog.deltaTotal, gymGain: null, energyTrained: null, sessions: 0, likelyJumps: 0 };
  }
  const { gains, competing } = shapeEnergyInputs(refillRows, drugRows, consumptionRows, combatRows);
  const ledger = buildEnergyLedger(
    bars.filter((o) => o.t >= from),
    gains,
    competing
  );
  const sessions = detectTrainingSessions(ledger, statSeries, counterSeries).filter((s) => s.startedAt >= from && s.startedAt <= to);
  // Same definition as the full getProgression summary: only "likely"
  // sessions (decline + observed gym-attributable gain) count as energy
  // trained — a possible burst stays unattributed on every surface.
  const likely = sessions.filter((s) => s.inference === "likely");
  // Gym-attributable gain sums ONLY clean brackets (the same definition as
  // getProgression's battlestats.attribution.gym): shared/unclean brackets
  // contribute energy but no attributable gain, and the sum is null when no
  // session has a clean bracket at all — never zero-filled.
  const cleanGainSessions = likely.filter((s) => s.gains !== null && s.gymGain !== null);
  return {
    battlestatGain: prog.deltaTotal,
    gymGain: cleanGainSessions.length > 0 ? cleanGainSessions.reduce((sum, s) => sum + (s.gymGain ?? 0), 0) : null,
    energyTrained: likely.reduce((sum, s) => sum + (s.energySpent ?? 0), 0),
    sessions: sessions.length,
    likelyJumps: 0, // jump detection needs drug events — full getProgression only
  };
}

/* -------------------------------------------------------------------------- */
/* Shared energy-input shaping (main service + glimpse)                        */
/* -------------------------------------------------------------------------- */

/** Minimal row shapes shared by both fetch paths. */
interface RefillRow {
  occurredAt: Date;
  metadata: unknown;
}
interface DrugRow {
  occurredAt: Date;
  drugName: string | null;
  outcome: string;
}
interface ConsumptionRow {
  occurredAt: Date;
  category: string;
  metadata: unknown;
}
interface CombatRow {
  occurredAt: Date;
}


