import {
  energyChartInterval,
  buildEnergyAccounting,
  rebucketEnergyDaily,
  shapeDeepEnergyInputs,
  shapeGymUses,
  shapeOverdoseLosses,
  type AttackEvidenceRow,
  type GymEvidenceRow,
  type OverdoseEvidenceRow,
} from "@tornscope/analytics";
import { resolveDateRange, type DateRangeInput, type EnergySummaryResponse } from "@tornscope/shared";
import { getPrismaClient } from "@tornscope/database";
import { loadAvailabilityContext, sectionAvailability } from "./availability.js";

/**
 * Deep Energy Analytics (2.1.0) — one bounded read per source, all math in
 * @tornscope/analytics. See docs/ANALYTICS.md for the exact/derived/
 * estimated/inferred contract per figure.
 *
 * Bounds: bars capped (≈70 days at 5-min cadence) and evidence rows capped
 * far above any real range. Caps only downgrade coverage disclosure — they
 * never change a value's provenance.
 */
const BARS_MAX_ROWS = 20_000;
const EVIDENCE_MAX_ROWS = 20_000;
const GYM_MAX_ROWS = 10_000;

const sec = (d: Date): number => Math.floor(d.getTime() / 1000);

/** Titles that evidence an overdose with an exact energy loss. */
function overdoseWhere() {
  return [
    { title: { contains: "overdose", mode: "insensitive" as const } },
    { title: { startsWith: "Overdosed on", mode: "insensitive" as const } },
  ];
}

export async function getEnergySummary(userId: string, rangeInput: DateRangeInput): Promise<EnergySummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const { from, to } = range;
  const availCtx = await loadAvailabilityContext(userId);

  const [barsRows, refillRows, drugRows, consumptionRows, gymRows, overdoseRows, combatRows] = await Promise.all([
    db.barsSnapshot.findMany({
      where: { userId, capturedAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
      orderBy: { capturedAt: "desc" },
      take: BARS_MAX_ROWS,
      select: { capturedAt: true, energyCurrent: true, energyMaximum: true },
    }),
    db.timelineEvent.findMany({
      where: { userId, title: "Points energy refill use", occurredAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      take: EVIDENCE_MAX_ROWS,
      select: { occurredAt: true, metadata: true },
    }),
    db.drugEvent.findMany({
      where: { userId, drugName: "Xanax", outcome: "success", occurredAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      take: EVIDENCE_MAX_ROWS,
      select: { occurredAt: true, drugName: true, outcome: true },
    }),
    db.consumptionEvent.findMany({
      where: { userId, category: "energy", occurredAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      take: EVIDENCE_MAX_ROWS,
      select: { occurredAt: true, category: true, metadata: true },
    }),
    db.timelineEvent.findMany({
      where: { userId, title: { startsWith: "Gym train", mode: "insensitive" }, occurredAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      take: GYM_MAX_ROWS,
      select: { occurredAt: true, metadata: true },
    }),
    db.timelineEvent.findMany({
      where: { userId, OR: overdoseWhere(), occurredAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      take: EVIDENCE_MAX_ROWS,
      select: { occurredAt: true, title: true, metadata: true },
    }),
    db.combatEvent.findMany({
      where: { userId, direction: "outgoing", occurredAt: { gte: new Date(from * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      take: EVIDENCE_MAX_ROWS,
      select: { occurredAt: true },
    }),
  ]);

  const barsTruncated = barsRows.length >= BARS_MAX_ROWS;
  const bars = barsRows
    .reverse()
    .map((r) => ({ t: sec(r.capturedAt), energyCurrent: r.energyCurrent, energyMaximum: r.energyMaximum }));

  const gains = shapeDeepEnergyInputs(
    refillRows.map((r) => ({ occurredAt: r.occurredAt, metadata: r.metadata })),
    drugRows.map((r) => ({ occurredAt: r.occurredAt, drugName: r.drugName, outcome: r.outcome })),
    consumptionRows.map((r) => ({ occurredAt: r.occurredAt, category: r.category, metadata: r.metadata }))
  );
  const gymUses = shapeGymUses(gymRows.map((r): GymEvidenceRow => ({ occurredAt: r.occurredAt, metadata: r.metadata })));
  const losses = shapeOverdoseLosses(overdoseRows.map((r): OverdoseEvidenceRow => ({ occurredAt: r.occurredAt, title: r.title, metadata: r.metadata })));
  const attacks: AttackEvidenceRow[] = combatRows.map((r) => ({ occurredAt: r.occurredAt }));

  const accounting = buildEnergyAccounting({ from, to, gains, gymUses, losses, attacks, bars, barsTruncated });
  const interval = energyChartInterval(from, to);

  return {
    range: { from, to },
    generatedAt: Math.floor(Date.now() / 1000),
    availability: {
      bars: sectionAvailability(availCtx, "progression_energy", "bars"),
      logs: sectionAvailability(availCtx, "drugs_history", "drugs"),
    },
    balance: accounting.balance,
    sources: accounting.sources,
    uses: accounting.uses,
    losses: accounting.losses,
    daily: rebucketEnergyDaily(accounting.daily, interval),
    chartInterval: interval,
    coverage: accounting.coverage,
    intelligence: accounting.intelligence,
  };
}
