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
 * ENERGY RECONCILIATION FIXTURES (real-user remediation, Phase 18-19).
 *
 * Deterministic timelines that pin the ledger's semantics from first
 * principles. Torn's observable inputs are:
 *   EXACT      — bar readings, refill energy_increased
 *   ESTIMATED  — Xanax +250 per successful use (documented mechanic; the
 *                success log carries no energy field)
 *   DERIVED    — natural regen on clean rise intervals
 *   INFERRED   — training spend from declines (bounded: regen inside a
 *                decline is not separable, cap-affected gains are overshoot)
 * The fixtures prove the ledger NEVER invents energy that could not have
 * existed (the disputed 295/250/660 values) and never loses the ambiguous
 * remainder silently. Cap behavior is verified, not assumed: Torn's energy
 * bar hard-clamps at the player's maximum (six months of real snapshots
 * never once exceed the max, including Xanax-while-full events whose bars
 * stayed pinned for 25+ minutes), so energy above the cap is LOST.
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

/** Expected: closing = opening + knownGains + derivedRegen − observedSpent. */
function expectReconciliation(observations: EnergyObservation[], gains: EnergyGainEvent[]) {
  const ledger = buildEnergyLedger(observations, gains);
  const rec = ledger.reconciliation;
  if (rec.opening !== null && rec.closing !== null && rec.observedDelta !== null) {
    expect(rec.opening + ledger.knownGains + ledger.derivedRegen - ledger.observedSpent).toBe(rec.closing);
  }
  return ledger;
}

describe("fixture A — natural regen, Xanax at cap, one training burst", () => {
  // start E=100 → natural +50 → 150 (cap) → Xanax (+250 est, fully lost at
  // cap) → train to 50. The mental model says "Xanax +250, trained it all" —
  // the bar evidence cannot support that: the Xanax landed on a full bar and
  // Torn discards energy beyond the cap; only the observed 100 decline is
  // spend.
  const points = bars([
    [T, 100],
    [T + 300, 150],
    [T + 600, 50],
  ]);
  const gains = [xanax(T + 320)];

  it("credits natural regen, wastes the capped Xanax, and counts only the real decline", () => {
    const ledger = expectReconciliation(points, gains);
    expect(ledger.derivedRegen).toBe(50);
    expect(ledger.knownGains).toBe(0); // nothing materialized
    expect(ledger.absorbedOvershoot).toBe(XANAX_ENERGY_ESTIMATE); // surfaced, not silent
    expect(ledger.absorbedOvershootByCategory).toEqual([{ category: "xanax", amount: XANAX_ENERGY_ESTIMATE }]);
    expect(ledger.observedSpent).toBe(100);
    expect(ledger.reconciliation.closing).toBe(50);
  });

  it("reports the burst as a possible session — no invented precision", () => {
    const ledger = buildEnergyLedger(points, gains);
    const sessions = detectTrainingSessions(ledger, []);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.energySpent).toBe(100);
    expect(sessions[0]!.inference).toBe("possible"); // no stat bracket → not "likely"
  });
});

describe("fixture B — two Xanax, natural regen, two training bursts (the disputed day shape)", () => {
  // The real-user walkthrough produced "Xanax +300 / Natural +435 / Training
  // −660" under the old model, which charged every Xanax estimate on top of
  // observed declines regardless of the cap. Reconstructed honestly:
  //   morning: bar idle at cap (pinned), Xanax 1 wasted, burst 1 to 5
  //   evening: bar low, Xanax 2 fits, burst 2 spends it all
  const points = bars([
    [T, 150], // pinned at cap
    [T + 300, 150], // Xanax 1 at T+100: wasted (pinned interval)
    [T + 600, 5], // burst 1: 150 → 5 = 145 spend
    [T + 900, 40], // natural +35 rise
    [T + 1_100, 40],
    [T + 1_500, 5], // burst 2: 40 → 5 with Xanax 2 inside (T+1200)
  ]);
  const gains = [xanax(T + 100), xanax(T + 1_200)];

  it("splits effective gains from cap waste and keeps the identity exact", () => {
    const ledger = expectReconciliation(points, gains);
    // Xanax 1: pinned interval → overshoot. Xanax 2: headroom 110 at the
    // burst start → 110 materializes, 140 is lost at cap.
    expect(ledger.knownGainsByCategory).toContainEqual({ category: "xanax", amount: 110, provenance: "estimated" });
    expect(ledger.absorbedOvershoot).toBe(XANAX_ENERGY_ESTIMATE + 140); // 390
    expect(ledger.absorbedOvershootByCategory).toEqual([{ category: "xanax", amount: 390 }]);
    // regen: the +35 rise only (pinned time is unobservable, never banked).
    expect(ledger.derivedRegen).toBe(35);
    // spends: 145 + (110 + 35) = 290 — not 2×250 + something; no phantom energy.
    expect(ledger.observedSpent).toBe(290);
    expect(ledger.reconciliation.closing).toBe(5);
  });
});

describe("fixture C — snapshot gap with ambiguous gain/spend stays bounded", () => {
  // A long gap hides everything between two observations. The ledger refuses
  // to over-attribute: the interval is one bounded spend, overshoot surfaces
  // the cap-ambiguous part, and the session inherits the honesty.
  const points = bars([
    [T, 140],
    [T + 3_600, 10], // one hour gap: regen + possible xanax + training all inside
    [T + 3_900, 30],
  ]);
  const gains = [xanax(T + 1_800)];

  it("bounds the Xanax credit by start-of-gap headroom and spends the rest", () => {
    const ledger = expectReconciliation(points, gains);
    // headroom at gap start = 10; the rest of the Xanax is cap-ambiguous.
    expect(ledger.knownGains).toBe(10);
    expect(ledger.absorbedOvershoot).toBe(XANAX_ENERGY_ESTIMATE - 10);
    expect(ledger.observedSpent).toBe(140); // 10 gain + 130 observed drop
  });
});

describe("fixture D — refill, Xanax, training", () => {
  // Refill is EXACT: it lands in a rise and is attributed verbatim; the
  // Xanax estimate hits a bar with room, so most of it materializes.
  const points = bars([
    [T, 0],
    [T + 300, 60], // refill +50 inside + regen 10 → attributed exact first
    [T + 600, 60], // Xanax at T+350: headroom 90 → effective 90; 60→60 flat?? — see below
  ]);
  // Deterministic shape: refill lands in the first rise; the xanax in the
  // second interval which nets flat (rise cancelled by an equal spend —
  // ambiguous by observation, so nothing is claimed as regen).
  const adjusted = bars([
    [T, 0],
    [T + 300, 60],
    [T + 600, 10],
  ]);
  const gains = [refill(T + 150, 50), xanax(T + 350)];

  it("attributes the refill exactly and the Xanax up to headroom", () => {
    const ledger = expectReconciliation(adjusted, gains);
    expect(ledger.knownGainsByCategory).toContainEqual({ category: "refill", amount: 50, provenance: "exact" });
    // second interval 60 → 10 decline with xanax inside: headroom at start
    // is 90 → 90 applied, the rest overshoot, spend = 90 + 50 = 140.
    expect(ledger.knownGainsByCategory).toContainEqual({ category: "xanax", amount: 90, provenance: "estimated" });
    expect(ledger.absorbedOvershoot).toBe(XANAX_ENERGY_ESTIMATE - 90);
    expect(ledger.observedSpent).toBe(140);
    void points;
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
    expect(ledger.observedSpent).toBe(0);
    expect(ledger.derivedRegen).toBe(120);
    expect(ledger.regenPerHour).toBe(600); // median of 240, 600, 600
    expect(ledger.cappedSeconds).toBe(600);
  });
});

describe("fixture — two Xanax at full bar in one day (the '0 Xanax' complaint shape)", () => {
  // The real 2026-09-14 shape: both uses land on a full bar and are trained
  // away within the same 5-minute snapshot. Materialized Xanax energy is 0 —
  // which used to make the sources list omit Xanax entirely ("1D shows 0
  // Xanax despite 2 taken"). The per-category overshoot is what lets the
  // surface say "2 taken · est. +500 · 0 visible, lost at cap" honestly.
  const points = bars([
    [T, 150], // full
    [T + 300, 0], // Xanax 1 at T+100, trained away inside the interval
    [T + 3_600, 150], // regen back to full
    [T + 3_900, 5], // Xanax 2 at T+3_700, trained away inside the interval
  ]);
  const gains = [xanax(T + 100), xanax(T + 3_700)];

  it("materializes nothing but attributes the whole loss to Xanax", () => {
    const ledger = expectReconciliation(points, gains);
    expect(ledger.knownGains).toBe(0);
    expect(ledger.knownGainsByCategory).toEqual([]);
    expect(ledger.absorbedOvershoot).toBe(2 * XANAX_ENERGY_ESTIMATE);
    expect(ledger.absorbedOvershootByCategory).toEqual([{ category: "xanax", amount: 2 * XANAX_ENERGY_ESTIMATE }]);
    // spend stays the plain observed declines — never the phantom 2×250.
    expect(ledger.observedSpent).toBe(150 + 145);
    // regen: the 0 → 150 rise only.
    expect(ledger.derivedRegen).toBe(150);
  });
});

describe("fixture — real problematic-day shape (sanitized from the user's day)", () => {
  // Real user's 05:15 event: snapshot 05:11 E=105, Xanax 05:15:12, snapshot
  // 05:17 E=5. A naive model charges the full estimate on top of the visible
  // 100 decline (→ "+350 E trained"). Truth: the Xanax only filled the 45E
  // of headroom; the observed decline is the rest.
  const points = bars([
    [T, 105],
    [T + 360, 5],
  ]);
  const gains = [xanax(T + 250)];

  it("reports ~145 inferred, not the naive total", () => {
    const ledger = expectReconciliation(points, gains);
    expect(ledger.observedSpent).toBe(145);
    expect(ledger.knownGains).toBe(45);
    expect(ledger.absorbedOvershoot).toBe(XANAX_ENERGY_ESTIMATE - 45);
    const sessions = detectTrainingSessions(ledger, []);
    expect(sessions[0]!.energySpent).toBe(145);
    expect(sessions[0]!.evidence.join(" ")).toContain("cap");
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
    expect(sessions[0]!.gainPerEnergy).toBeCloseTo(1_400 / 145, 5);
  });
});
