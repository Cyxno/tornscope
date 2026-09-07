/**
 * Provenance-aware Xanax funding ledger.
 *
 * Replaces the naive "purchase timestamp within the selected window" matcher.
 * Core ideas:
 *
 * 1. STOCK, not timestamp proximity: uses are drawn from an inventory pool
 *    built from EVERY recorded acquisition (any time — never restricted to
 *    the UI display range). A Xanax bought 35 days ago and consumed 20 days
 *    ago is correctly attributed in a 30-day view.
 *
 * 2. OPENING INVENTORY: uses before the selected range prove possession
 *    before the range. Stock replayed from the earliest evidence forms the
 *    opening pool; uses drawing from it do NOT require an in-range purchase.
 *
 * 3. HONEST ORIGIN: opening stock is only "personal" when recorded pre-range
 *    acquisitions prove it. Deficits (uses exceeding recorded acquisitions)
 *    prove stock existed whose origin is unknown — reported as
 *    opening_inventory_unknown, never silently labeled personal.
 *
 * 4. POSITIVE EVIDENCE ONLY: faction sponsorship requires faction armory
 *    evidence tied to the member and time (a use logged at the same moment
 *    the armory news records it, or stock drawn from an armory withdrawal).
 *    War timing alone never counts. A missing faction event never implies
 *    "personal funded".
 */

export type XanaxAcquisitionSource = "personal_purchase" | "travel_purchase" | "gift" | "faction_armory";

export interface XanaxAcquisition {
  /** Unix seconds. */
  occurredAt: number;
  units: number;
  source: XanaxAcquisitionSource;
}

export type XanaxFundingBucket =
  | "confirmed_personal"
  | "confirmed_faction"
  | "confirmed_other"
  | "opening_inventory_unknown"
  | "unknown";

export interface XanaxOpeningStock {
  /** Replayed recorded stock still held at the range start. */
  knownUnits: number;
  fromRecordedPurchases: number;
  fromFaction: number;
  fromOther: number;
  /**
   * Proven-but-unrecorded stock: pre-range uses exceeded recorded
   * acquisitions, so at least this many units existed with unknown origin.
   */
  unrecorded: number;
}

export interface XanaxFundingClassification {
  confirmedPersonal: number;
  confirmedFaction: number;
  /** Explicit non-personal, non-faction evidence (e.g. player gifts). */
  confirmedOther: number;
  openingInventoryUnknown: number;
  /** Uses with no ledger coverage at all (e.g. no pre-range evidence). */
  unknown: number;
  openingStock: XanaxOpeningStock;
  /** Earliest acquisition or use seen by the ledger (unix seconds). */
  earliestEvidenceAt: number | null;
  /** True when any acquisition/use evidence exists strictly before the range. */
  hasPreRangeEvidence: boolean;
}

export interface XanaxLedgerInput {
  /** In-range uses to classify (unix seconds). */
  uses: Array<{ occurredAt: number }>;
  /** EVERY known acquisition — any time. Never clipped to the display range. */
  acquisitions: XanaxAcquisition[];
  /** Uses BEFORE the range (prove possession + consume the pre-range pool). */
  preRangeUses: Array<{ occurredAt: number }>;
  /** Faction armory "used" evidence times for THIS member (unix seconds). */
  armoryUseTimes: number[];
  /** Range start (unix seconds). */
  rangeFrom: number;
  /** ± tolerance for armory use matching (default 300s). */
  sponsoredToleranceSeconds?: number;
}

interface PoolBatch {
  occurredAt: number;
  units: number;
  source: XanaxAcquisitionSource;
}

function sourceBucket(source: XanaxAcquisitionSource): XanaxFundingBucket {
  switch (source) {
    case "personal_purchase":
    case "travel_purchase":
      return "confirmed_personal";
    case "faction_armory":
      return "confirmed_faction";
    case "gift":
      return "confirmed_other";
  }
}

/**
 * Consume ONE unit from the pool for a use at `useAt`: FIFO from the oldest
 * batch at/before the use (future stock never feeds an earlier use). Returns
 * the source of the drawn batch, or null when the recorded pool is empty.
 */
function drawFromPool(pool: PoolBatch[], useAt: number): XanaxAcquisitionSource | null {
  for (let i = 0; i < pool.length; i++) {
    const batch = pool[i]!;
    if (batch.occurredAt > useAt) return null; // sorted: every later batch is newer
    if (batch.units > 1) batch.units -= 1;
    else pool.splice(i, 1);
    return batch.source;
  }
  return null;
}

/**
 * Classify Xanax uses into evidence-based funding buckets via stock-flow
 * replay. Pure function; deterministic; range-independent (the caller passes
 * the full acquisition history, not just the window).
 */
export function classifyXanaxFunding(input: XanaxLedgerInput): XanaxFundingClassification {
  const tolerance = input.sponsoredToleranceSeconds ?? 300;

  const acquisitions = input.acquisitions
    .filter((a) => a.units > 0)
    .map((a) => ({ occurredAt: a.occurredAt, units: a.units, source: a.source }))
    .sort((a, b) => a.occurredAt - b.occurredAt);
  const preUses = [...input.preRangeUses].sort((a, b) => a.occurredAt - b.occurredAt);

  const allEvidenceTimes = [
    ...acquisitions.map((a) => a.occurredAt),
    ...preUses.map((u) => u.occurredAt),
  ];
  const earliestEvidenceAt = allEvidenceTimes.length > 0 ? Math.min(...allEvidenceTimes) : null;
  const hasPreRangeEvidence = earliestEvidenceAt !== null && earliestEvidenceAt < input.rangeFrom;

  // ---- Build the pool, then replay pre-range uses against it --------------
  // The pool holds ALL recorded acquisitions; pre-range uses consume from the
  // batches that existed at their time, leaving the opening stock behind.
  const pool: PoolBatch[] = acquisitions.map((a) => ({ ...a }));
  let unrecorded = 0;
  for (const use of preUses) {
    if (drawFromPool(pool, use.occurredAt) === null) {
      // Use with no recorded stock: proves unrecorded inventory existed.
      unrecorded += 1;
    }
  }

  // Opening stock = recorded batches acquired BEFORE the range that survived
  // the replay, plus the proven unrecorded deficit. In-range acquisitions
  // stay in the pool (in-range uses draw from them) but are not opening stock.
  const preRangeBatches = pool.filter((b) => b.occurredAt < input.rangeFrom);
  const openingStock: XanaxOpeningStock = {
    knownUnits: preRangeBatches.reduce((s, b) => s + b.units, 0),
    fromRecordedPurchases: preRangeBatches
      .filter((b) => b.source === "personal_purchase" || b.source === "travel_purchase")
      .reduce((s, b) => s + b.units, 0),
    fromFaction: preRangeBatches.filter((b) => b.source === "faction_armory").reduce((s, b) => s + b.units, 0),
    fromOther: preRangeBatches.filter((b) => b.source === "gift").reduce((s, b) => s + b.units, 0),
    unrecorded,
  };

  // ---- Classify in-range uses in time order -------------------------------
  const armoryTimes = [...input.armoryUseTimes].sort((a, b) => a - b);
  const result: XanaxFundingClassification = {
    confirmedPersonal: 0,
    confirmedFaction: 0,
    confirmedOther: 0,
    openingInventoryUnknown: 0,
    unknown: 0,
    openingStock,
    earliestEvidenceAt,
    hasPreRangeEvidence,
  };

  const inRangeUses = [...input.uses].sort((a, b) => a.occurredAt - b.occurredAt);
  for (const use of inRangeUses) {
    // 1. Faction sponsorship: positive armory evidence at (near) the same
    //    moment — the armory news and the personal use log land together.
    const sIdx = armoryTimes.findIndex((t) => Math.abs(use.occurredAt - t) <= tolerance);
    if (sIdx !== -1) {
      armoryTimes.splice(sIdx, 1);
      result.confirmedFaction += 1;
      continue;
    }
    // 2. Draw FIFO from the recorded stock pool (any acquisition age —
    //    provenance is range-independent).
    const drawn = drawFromPool(pool, use.occurredAt);
    if (drawn !== null) {
      const bucket = sourceBucket(drawn);
      if (bucket === "confirmed_personal") result.confirmedPersonal += 1;
      else if (bucket === "confirmed_faction") result.confirmedFaction += 1;
      else result.confirmedOther += 1;
      continue;
    }
    // 3. Proven unrecorded stock (deficit replayed before the range): the use
    //    drew from inventory that demonstrably predates the range — origin
    //    unknown, honestly reported, NOT assumed personal.
    if (unrecorded > 0) {
      unrecorded -= 1;
      result.openingInventoryUnknown += 1;
      continue;
    }
    // 4. No recorded stock and no proven deficit: if any pre-range evidence
    //    exists, possession before the window is still the best-supported
    //    explanation (stock levels are unknown, not the use). Without ANY
    //    pre-range evidence we cannot distinguish opening stock from an
    //    unrecorded in-range acquisition (e.g. an unlogged gift) → unknown.
    if (hasPreRangeEvidence) result.openingInventoryUnknown += 1;
    else result.unknown += 1;
  }
  return result;
}
