import { describe, expect, it } from "vitest";
import { projectStatGoal, simulateStatGrowth, STAT_PROJECTION_POLICY, type StatGrowthSimulation } from "../src/stat-projection.js";

const DAY = 86_400;
const NOW = 1_750_000_000;

/** Daily points at noon with an exact daily RELATIVE growth rate. */
function compoundingSeries(startStat: number, dailyRate: number, days: number, jitterSeed = 0): ReturnType<typeof build> {
  return build(startStat, dailyRate, days, jitterSeed);
}

function build(startStat: number, dailyRate: number, days: number, jitterSeed: number) {
  const points = [];
  let stat = startStat;
  let seed = jitterSeed || 1;
  const jitter = (): number => {
    // Tiny deterministic jitter (keeps the log-fit R² ~1 while avoiding
    // perfectly straight lines that would make R²==1 trivially).
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return 1 + ((seed / 2147483648) - 0.5) * 0.002;
  };
  for (let i = 0; i <= days; i++) {
    points.push({ t: NOW - (days - i) * DAY + 43_200, value: stat });
    stat = stat * Math.exp(dailyRate) * jitter();
  }
  return points;
}

describe("projectStatGoal — Torn stat-scaling semantics", () => {
  it("CASE A — a 1M→10M goal is NOT remaining/gainPerDay: the modeled daily gain grows with the stat", () => {
    // +0.5%/day at 1M ≈ +5k/day initially. A LINEAR model would project
    // 9,000,000 / 5,000 ≈ 1800 days. The compounding model needs
    // ln(10)/0.005 ≈ 461 days.
    const series = compoundingSeries(1_000_000, 0.005, 40);
    const p = projectStatGoal(series, 10_000_000, NOW, 30);
    expect(p.model).toBe("relative_compounding");
    expect(p.insufficientReason).toBeNull();
    const etaDays = (p.etaAt! - NOW) / DAY;
    expect(etaDays).toBeGreaterThan(300);
    expect(etaDays).toBeLessThan(650);
    // The linear answer would be ~1800 days — the model must NOT produce it.
    expect(etaDays).toBeLessThan(900);

    // Proof that gains compound: simulating the calibrated rate, the daily
    // gain at half the trajectory clearly exceeds today's observed one.
    const sim: StatGrowthSimulation = simulateStatGrowth(1_000_000, 0.005, 462);
    expect(sim.dailyGains[0]!).toBeCloseTo(5_000, -2);
    expect(sim.dailyGains[Math.floor(sim.dailyGains.length / 2)]!).toBeGreaterThan(sim.dailyGains[0]! * 2);
    expect(sim.values[sim.values.length - 1]!).toBeGreaterThanOrEqual(10_000_000);
  });

  it("CASE B — same routine at 100M: absolute predicted gain scales with the stat", () => {
    const small = projectStatGoal(compoundingSeries(1_000_000, 0.005, 40), 10_000_000, NOW, 30);
    const large = projectStatGoal(compoundingSeries(100_000_000, 0.005, 40), 1_000_000_000, NOW, 30);
    // Identical relative pace → identical time-to-10x, regardless of level.
    const smallDays = (small.etaAt! - NOW) / DAY;
    const largeDays = (large.etaAt! - NOW) / DAY;
    expect(largeDays / smallDays).toBeCloseTo(1, 1);
    // But the absolute gain/train implied is 100× — the first simulated day
    // proves the model does not freeze today's absolute gain.
    const simSmall = simulateStatGrowth(1_000_000, 0.005, 1).dailyGains[0]!;
    const simLarge = simulateStatGrowth(100_000_000, 0.005, 1).dailyGains[0]!;
    expect(simLarge / simSmall).toBeCloseTo(100, 1);
  });

  it("CASE C — implicit +10% modifiers (faster observed gains) shorten the ETA without knowing the modifier", () => {
    const base = projectStatGoal(compoundingSeries(1_000_000, 0.005, 40), 10_000_000, NOW, 30);
    const boosted = projectStatGoal(compoundingSeries(1_000_000, 0.0055, 40), 10_000_000, NOW, 30);
    const baseDays = (base.etaAt! - NOW) / DAY;
    const boostedDays = (boosted.etaAt! - NOW) / DAY;
    // ln-scaling: the ratio must land close to ln(10)/ln(10)/1.1 ≈ 0.909.
    expect(boostedDays / baseDays).toBeGreaterThan(0.85);
    expect(boostedDays / baseDays).toBeLessThan(0.95);
  });

  it("CASE D — unstable training history degrades to no ETA", () => {
    // Real-ish pace buried in heavy noise: R² of the log-fit collapses.
    const points = compoundingSeries(1_000_000, 0.004, 40, 7).map((p, i) => ({
      t: p.t,
      value: p.value * (i % 2 === 0 ? 1.3 : 0.72),
    }));
    const p = projectStatGoal(points, 10_000_000, NOW, 30);
    expect(p.etaAt).toBeNull();
    // Either withhold gate is honest here (noise or receding window); the
    // semantic contract is: no ETA, degraded confidence, observation kept.
    expect(["too_volatile", "no_positive_trend"]).toContain(p.insufficientReason);
    expect(p.confidence).toBe("low");
    // Observed (descriptive) growth may still be reported honestly.
    expect(p.observedChangePerDay).not.toBeNull();
  });

  it("CASE E — insufficient history never fabricates an ETA", () => {
    const short = projectStatGoal(compoundingSeries(1_000_000, 0.005, 3), 10_000_000, NOW, 30);
    expect(short.etaAt).toBeNull();
    expect(short.insufficientReason).toBe("insufficient_history");
    expect(short.confidence).toBe("insufficient");
    const thin = projectStatGoal(compoundingSeries(1_000_000, 0.005, 4), 10_000_000, NOW, 30);
    expect(thin.etaAt).toBeNull();
    expect(thin.insufficientReason).toBe("insufficient_history");
  });

  it("CASE F — distant goals degrade confidence and return a RANGE, not a precise date", () => {
    // +0.2%/day toward 10× → ln(10)/0.002 ≈ 1151 days — beyond the
    // high-confidence horizon, inside the withhold horizon.
    const series = compoundingSeries(1_000_000, 0.002, 40);
    const p = projectStatGoal(series, 10_000_000, NOW, 30);
    expect(p.insufficientReason).toBeNull();
    expect(p.confidence).not.toBe("high");
    expect(p.etaRangeDays).not.toBeNull();
    const etaDays = (p.etaAt! - NOW) / DAY;
    expect(etaDays).toBeGreaterThan(1000);
    // The range must actually bracket the central ETA and be wide enough to
    // be honest (the UI renders "~X–Y months" from it, never a date).
    expect(p.etaRangeDays!.minDays).toBeLessThan(etaDays);
    expect(p.etaRangeDays!.maxDays).toBeGreaterThan(etaDays);
    expect(p.etaRangeDays!.maxDays - p.etaRangeDays!.minDays).toBeGreaterThan(30);
  });

  it("high confidence states a single date (no range) on a clean, near horizon", () => {
    // +1%/day toward 2× the current stat → ln(2)/0.01 ≈ 69 days, clean fit.
    const series = compoundingSeries(1_000_000, 0.01, 40);
    const last = series[series.length - 1]!.value;
    const p = projectStatGoal(series, last * 2, NOW, 30);
    expect(p.insufficientReason).toBeNull();
    expect(p.confidence).toBe("high");
    expect(p.etaRangeDays).toBeNull();
    const etaDays = (p.etaAt! - NOW) / DAY;
    expect(etaDays).toBeGreaterThan(55);
    expect(etaDays).toBeLessThan(85);
  });

  it("withholds beyond the sanity horizon and on receding series", () => {
    const far = projectStatGoal(compoundingSeries(1_000_000, 0.0005, 40), 1_000_000_000, NOW, 30);
    expect(far.etaAt).toBeNull();
    expect(far.insufficientReason).toBe("beyond_horizon");
    const receding = projectStatGoal(compoundingSeries(1_000_000, -0.003, 40), 2_000_000, NOW, 30);
    expect(receding.etaAt).toBeNull();
    expect(receding.insufficientReason).toBe("no_positive_trend");
  });

  it("keeps observed (descriptive) growth available even when the ETA is withheld", () => {
    const p = projectStatGoal(compoundingSeries(1_000_000, 0.005, 40), 10_000_000, NOW, 7);
    // 7d lookback: plenty of points but a short span — still calibratable.
    if (p.insufficientReason === "insufficient_history") {
      expect(p.observedChangePerDay).not.toBeNull();
    } else {
      expect(p.observedChangePerDay).not.toBeNull();
      expect(p.etaAt).not.toBeNull();
    }
  });

  it("policy constants keep their documented values", () => {
    expect(STAT_PROJECTION_POLICY.MIN_POINTS).toBe(5);
    expect(STAT_PROJECTION_POLICY.MIN_SPAN_DAYS).toBe(5);
    expect(STAT_PROJECTION_POLICY.HORIZON_DEGRADE_DAYS).toBe(365);
    expect(STAT_PROJECTION_POLICY.HORIZON_MAX_DAYS).toBe(5 * 365);
  });

  it("is deterministic", () => {
    const series = compoundingSeries(1_000_000, 0.005, 40, 3);
    expect(projectStatGoal(series, 10_000_000, NOW, 30)).toEqual(projectStatGoal(series, 10_000_000, NOW, 30));
  });
});
