import { describe, expect, it } from "vitest";
import {
  buildEnergyLedger,
  buildBattlestatSeries,
  detectTrainingSessions,
  XANAX_ENERGY_ESTIMATE,
  type BattlestatPoint,
  type EnergyGainEvent,
  type EnergyObservation,
} from "../src/progression.js";

/**
 * ENERGY RECONCILIATION FIXTURES (real-user remediation; over-max correction).
 *
 * Deterministic timelines that pin the ledger's semantics from first
 * principles. Torn's observable inputs are:
 *   EXACT      — bar readings, refill energy_increased
 *   ESTIMATED  — Xanax +250 per successful use (documented mechanic; the
 *                success log carries no energy field)
 *   DERIVED    — natural regen on clean rise intervals
 *   INFERRED   — training spend from declines PLUS delivered gains credited
 *                inside them (consumption between snapshots)
 *
 * Verified mechanics (2026-09-14): a Xanax gives +250 energy, and Torn's
 * energy bar can hold up to an ABSOLUTE 1,000 — gains are NOT clamped at
 * the natural bar maximum (100/150). A Xanax taken at a "full" 150 bar
 * therefore delivers real energy, and when the player trains immediately
 * the 150 → 400 → low transition happens entirely between snapshots. The
 * ledger must treat unobserved delivered energy as UNRESOLVED — consumed
 * between polls, banked above the natural max, or wasted — never as
 * "lost at cap".
 *
 * Identity: closing = opening + knownGains + derivedRegen − inferredSpent
 * − unresolvedGains.
 */

const T = 1_750_000_000;
const MAX = 150;

function bars(points: Array<[number, number]>, max = MAX): EnergyObservation[] {
  return points.map(([t, e]) => ({ t, energyCurrent: e, energyMaximum: max }));
}

function xanax(t: number, amount = XANAX_ENERGY_ESTIMATE): EnergyGainEvent {
  return { t, amount, category: "xanax", provenance: "estimated" };
}

function refill(t: number, amount: number): EnergyGainEvent {
  return { t, amount, category: "refill", provenance: "exact" };
}

/** Expected: closing = opening + knownGains + derivedRegen − inferredSpent − unresolvedGains. */
function expectReconciliation(observations: EnergyObservation[], gains: EnergyGainEvent[]) {
  const ledger = buildEnergyLedger(observations, gains);
  const rec = ledger.reconciliation;
  if (rec.opening !== null && rec.closing !== null && rec.observedDelta !== null) {
    expect(rec.opening + ledger.knownGains + ledger.derivedRegen - ledger.inferredSpent - ledger.unresolvedGains).toBe(rec.closing);
  }
  return ledger;
}

describe("fixture A — Xanax at full 150, trained away before the next poll", () => {
  // The user's actual pattern: take a Xanax at the natural maximum, train
  // immediately. The 150 → 400 → 0 transition happens entirely inside one
  // 5-minute snapshot interval — no snapshot ever shows 400. The delivered
  // 250 is credited in full and the observed 150 drop adds on top:
  // training = 250 + 150 = 400. NOTHING is lost.
  const points = bars([
    [T, 150],
    [T + 300, 0],
  ]);
  const gains = [xanax(T + 120)];

  it("credits the full delivery as training spend between snapshots", () => {
    const ledger = expectReconciliation(points, gains);
    expect(ledger.knownGains).toBe(XANAX_ENERGY_ESTIMATE);
    expect(ledger.inferredSpent).toBe(XANAX_ENERGY_ESTIMATE + 150);
    expect(ledger.unresolvedGains).toBe(0);
    expect(ledger.spendIntervals[0]?.estimatedGainsIncluded).toBe(XANAX_ENERGY_ESTIMATE);
    const sessions = detectTrainingSessions(ledger, []);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.energySpent).toBe(XANAX_ENERGY_ESTIMATE + 150);
    expect(sessions[0]!.evidence.join(" ")).toContain("Xanax delivery included");
  });
});

describe("fixture B — temporary energy above the natural max, never directly observed", () => {
  // Rise interval where the delivery exceeds the visible rise: opening 100,
  // Xanax +250 delivered, some consumption inside, closing 130. The bar
  // never showed the whole delivery — the unobservable remainder (220) is
  // UNRESOLVED, not lost, and the full 250 still counts as delivered.
  const points = bars([
    [T, 100],
    [T + 300, 130],
  ]);
  const gains = [xanax(T + 150)];

  it("delivers in full and marks the unobservable remainder unresolved", () => {
    const ledger = expectReconciliation(points, gains);
    expect(ledger.knownGains).toBe(XANAX_ENERGY_ESTIMATE);
    expect(ledger.derivedRegen).toBe(0);
    expect(ledger.inferredSpent).toBe(0); // no decline evidence — no invented spend
    expect(ledger.unresolvedGains).toBe(XANAX_ENERGY_ESTIMATE - 30);
    expect(ledger.reconciliation.closing).toBe(130);
  });
});

describe("fixture C — multiple Xanax/training bursts between two snapshots", () => {
  // Sparse polling (the pre-5-minute era sampled ~5×/day): a long gap can
  // hide two Xanax and two training passes. All delivered energy is real
  // and was consumed inside the gap: spend = 500 + 120 = 620.
  const points = bars([
    [T, 150],
    [T + 7_200, 30],
    [T + 7_500, 60], // small regen afterwards
  ]);
  const gains = [xanax(T + 600), xanax(T + 4_800)];

  it("credits both deliveries into the gap's inferred spend", () => {
    const ledger = expectReconciliation(points, gains);
    expect(ledger.knownGains).toBe(2 * XANAX_ENERGY_ESTIMATE);
    expect(ledger.inferredSpent).toBe(2 * XANAX_ENERGY_ESTIMATE + 120);
    expect(ledger.unresolvedGains).toBe(0);
    expect(ledger.reconciliation.closing).toBe(60);
  });
});

describe("fixture D — no false 'lost at cap' anywhere", () => {
  // Pinned-at-max interval with a Xanax inside (the historical pattern).
  // The delivery is real; whether it was consumed between the snapshots or
  // banked above the max is not observable. The ledger must say
  // "unresolved", keep it in known gains, and NEVER report it as lost.
  const points = bars([
    [T, 150],
    [T + 300, 150],
    [T + 600, 150],
  ]);
  const gains = [xanax(T + 150)];

  it("reports unresolved — never lost — and keeps the delivery in known gains", () => {
    const ledger = expectReconciliation(points, gains);
    expect(ledger.knownGains).toBe(XANAX_ENERGY_ESTIMATE);
    expect(ledger.unresolvedGains).toBe(XANAX_ENERGY_ESTIMATE);
    expect(ledger.inferredSpent).toBe(0);
    expect(ledger.cappedSeconds).toBe(600);
    // The API/ledger vocabulary has no "lost" concept:
    const serialized = JSON.stringify(ledger);
    expect(serialized).not.toContain("lost");
    expect(serialized).not.toContain("absorbedOvershoot");
  });
});

describe("fixture E — idle natural regeneration only", () => {
  it("derives regen from clean rises and bounds pinned time", () => {
    const ledger = expectReconciliation(
      bars([
        [T, 30],
        [T + 300, 80],
        [T + 600, 130],
        [T + 900, 150],
        [T + 1_500, 150], // pinned hour tail
      ]),
      []
    );
    expect(ledger.knownGains).toBe(0);
    expect(ledger.inferredSpent).toBe(0);
    expect(ledger.derivedRegen).toBe(120);
    expect(ledger.regenPerHour).toBe(600); // median of 240, 600, 600
    expect(ledger.cappedSeconds).toBe(600);
  });
});

describe("fixture F — refill lands in a rise; Xanax in a later decline", () => {
  // Refill is EXACT and lands in the first rise; the Xanax hits a decline
  // and is credited in full on top of the observed drop.
  const adjusted = bars([
    [T, 0],
    [T + 300, 60],
    [T + 600, 10],
  ]);
  const gains = [refill(T + 150, 50), xanax(T + 350)];

  it("attributes the refill exactly and the Xanax in full", () => {
    const ledger = expectReconciliation(adjusted, gains);
    expect(ledger.knownGainsByCategory).toContainEqual({ category: "refill", amount: 50, provenance: "exact" });
    expect(ledger.knownGainsByCategory).toContainEqual({ category: "xanax", amount: XANAX_ENERGY_ESTIMATE, provenance: "estimated" });
    // second interval 60 → 10 decline with xanax inside: spend = 250 + 50 = 300.
    expect(ledger.inferredSpent).toBe(XANAX_ENERGY_ESTIMATE + 50);
    expect(ledger.unresolvedGains).toBe(0);
    expect(ledger.reconciliation.closing).toBe(10);
  });
});

describe("fixture — two Xanax at full bar in one day (the '0 Xanax' complaint shape)", () => {
  // Both uses land on a full bar and are trained away within the same
  // 5-minute snapshot: nothing is directly observable except the declines,
  // yet both deliveries are real and land in training spend.
  const points = bars([
    [T, 150], // full
    [T + 300, 0], // Xanax 1 at T+100, trained away inside the interval
    [T + 3_600, 150], // regen back to full
    [T + 3_900, 5], // Xanax 2 at T+3_700, trained away inside the interval
  ]);
  const gains = [xanax(T + 100), xanax(T + 3_700)];

  it("credits both deliveries to training spend", () => {
    const ledger = expectReconciliation(points, gains);
    expect(ledger.knownGains).toBe(2 * XANAX_ENERGY_ESTIMATE);
    expect(ledger.unresolvedGains).toBe(0);
    expect(ledger.inferredSpent).toBe(150 + XANAX_ENERGY_ESTIMATE + (145 + XANAX_ENERGY_ESTIMATE));
    // regen: the 0 → 150 rise only.
    expect(ledger.derivedRegen).toBe(150);
  });
});

describe("fixture — real problematic-day shape (sanitized from the user's day)", () => {
  // Real user's 05:15 event: snapshot 05:11 E=105, Xanax 05:15:12, snapshot
  // 05:17 E=5. Delivery is credited in full and consumed inside the
  // interval: training = 250 + 100 = 350.
  const points = bars([
    [T, 105],
    [T + 360, 5],
  ]);
  const gains = [xanax(T + 250)];

  it("reports ~350 inferred, delivery included", () => {
    const ledger = expectReconciliation(points, gains);
    expect(ledger.inferredSpent).toBe(XANAX_ENERGY_ESTIMATE + 100);
    expect(ledger.knownGains).toBe(XANAX_ENERGY_ESTIMATE);
    expect(ledger.unresolvedGains).toBe(0);
    const sessions = detectTrainingSessions(ledger, []);
    expect(sessions[0]!.energySpent).toBe(XANAX_ENERGY_ESTIMATE + 100);
    expect(sessions[0]!.evidence.join(" ")).toContain("Xanax delivery included");
  });

  it("keeps the session honest when a stat bracket exists", () => {
    const ledger = buildEnergyLedger(points, gains);
    const statSeries: BattlestatPoint[] = buildBattlestatSeries([
      { capturedAt: T - 60, stats: { battle_stats: { strength: 100, defense: 100, speed: 100, dexterity: 100, total: 400 } } },
      { capturedAt: T + 600, stats: { battle_stats: { strength: 1_500, defense: 100, speed: 100, dexterity: 100, total: 1_800 } } },
    ]);
    const sessions = detectTrainingSessions(ledger, statSeries);
    expect(sessions[0]!.inference).toBe("likely");
    expect(sessions[0]!.gymGain).toBe(1_400);
    expect(sessions[0]!.gainPerEnergy).toBeCloseTo(1_400 / (XANAX_ENERGY_ESTIMATE + 100), 5);
  });
});

describe("fixture — the stack is banked and directly observed: 150/150 -> 400/150 (1.0.4 display regression)", () => {
  // The canonical over-cap case this display bug came from: Xanax taken at
  // the full natural cap, and the player HOLDS the stacked energy (no
  // immediate training). The next snapshot directly observes 400 against a
  // 150 natural cap. The ledger must keep the whole +250 as delivered and
  // observed — no cap clipping, no "lost at cap", nothing unresolved.
  const points = bars([
    [T, 150],
    [T + 300, 400],
  ]);
  const gains = [xanax(T + 120)];

  it("keeps the full +250 delivered and observed above the natural cap", () => {
    const ledger = expectReconciliation(points, gains);
    expect(ledger.knownGains).toBe(XANAX_ENERGY_ESTIMATE);
    expect(ledger.inferredSpent).toBe(0); // nothing was spent — it is banked
    expect(ledger.unresolvedGains).toBe(0); // the delivery is fully visible
    expect(ledger.reconciliation.closing).toBe(400);
    expect(ledger.reconciliation.closing - ledger.reconciliation.opening!).toBe(250);
  });
});
