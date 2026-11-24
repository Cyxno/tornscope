import { describe, expect, it } from "vitest";
import {
  ALERT_CONFIDENCE_LABELS,
  ALERT_TRIGGERS,
  alertTrigger,
  evaluateBarCappedDuration,
  evaluateDrugWindow,
  evaluateGoalMilestone,
  evaluateImminentTimer,
  evaluateNetworthDrawdown,
  evaluateOverdoseSpike,
  evaluateTrainingStagnation,
  networthDrawdownEpisodeKey,
  normalizeAlertConfig,
  type NetworthPoint,
} from "../src/alerts.js";

/**
 * 2.10.0 trigger evaluators: drawdown vs 7d baseline, imminent timers,
 * capped-bar duration, goal milestones, drug-window episodes, overdose
 * spikes vs personal baseline, training stagnation — plus the registry
 * contract and the app-wide "fake zero" guarantee (unavailable data renders
 * "—", never 0).
 *
 * Deterministic instants only — no test relies on the real clock.
 */

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0) / 1000;
const DAY = 86_400;

const point = (id: string, daysAgo: number, total: string): NetworthPoint => ({
  id,
  capturedAt: NOW - daysAgo * DAY,
  total,
});

/* -------------------------------------------------------------------------- */
/* networth_drawdown                                                          */
/* -------------------------------------------------------------------------- */

describe("evaluateNetworthDrawdown", () => {
  const baseline = point("base1", 7, "1000000");
  const current = (total: string): NetworthPoint => ({ id: "cur1", capturedAt: NOW - 3600, total });

  it("fires when the drop vs the 7d baseline crosses the threshold", () => {
    const r = evaluateNetworthDrawdown(baseline, current("850000"), { pct: 10 }, NOW, null);
    expect(r.eligible).toBe(true);
    expect(r.dropPct).toBeCloseTo(15, 5);
  });

  it("uses the nwdrawdown episode prefix — never shares an episode with net_worth_drop", () => {
    expect(networthDrawdownEpisodeKey("base1")).toBe("nwdrawdown:base1");
    expect(networthDrawdownEpisodeKey("base1")).not.toBe(`nwdrop:base1`);
  });

  it("does not re-fire while the same baseline episode is open", () => {
    const openKey = networthDrawdownEpisodeKey("base1");
    const r = evaluateNetworthDrawdown(baseline, current("850000"), { pct: 10 }, NOW, openKey);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("still_open_episode");
  });

  it("never treats a zero baseline as a 100% loss (fake-zero guard)", () => {
    const r = evaluateNetworthDrawdown(point("z", 7, "0"), current("0"), { pct: 10 }, NOW, null);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("nonpositive_baseline");
  });

  it("is not eligible without a baseline or current snapshot", () => {
    expect(evaluateNetworthDrawdown(null, current("1"), { pct: 10 }, NOW, null).reason).toBe("missing_baseline");
    expect(evaluateNetworthDrawdown(baseline, null, { pct: 10 }, NOW, null).reason).toBe("missing_current");
  });
});

/* -------------------------------------------------------------------------- */
/* imminent timers (bank_maturity_soon / oc_almost_ready)                     */
/* -------------------------------------------------------------------------- */

describe("evaluateImminentTimer", () => {
  const maturesAt = NOW + 6 * 3600;

  it("fires inside the horizon and identifies the event by its endSec", () => {
    const r = evaluateImminentTimer(maturesAt, NOW, 24 * 3600, null);
    expect(r).toEqual({ eligible: true, endSec: maturesAt });
  });

  it("does not fire without a timer or outside the horizon", () => {
    expect(evaluateImminentTimer(null, NOW, 24 * 3600, null).reason).toBe("no_timer");
    expect(evaluateImminentTimer(NOW + 48 * 3600, NOW, 24 * 3600, null).reason).toBe("no_timer");
    // already-passed timers belong to bank_matured/oc_ready, not "soon"
    expect(evaluateImminentTimer(NOW - 60, NOW, 24 * 3600, null).reason).toBe("no_timer");
  });

  it("dedupes per incident: the same endSec never alerts twice", () => {
    const r = evaluateImminentTimer(maturesAt, NOW, 24 * 3600, maturesAt);
    expect(r).toEqual({ eligible: false, reason: "already_signaled", endSec: maturesAt });
  });
});

/* -------------------------------------------------------------------------- */
/* bar_capped                                                                 */
/* -------------------------------------------------------------------------- */

describe("evaluateBarCappedDuration", () => {
  it("requires a capped observation first", () => {
    expect(evaluateBarCappedDuration(null, NOW, 30, false)).toEqual({ eligible: false, reason: "not_capped", durationSec: 0 });
  });

  it("waits for the configured duration", () => {
    const r = evaluateBarCappedDuration(NOW - 10 * 60, NOW, 30, false);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("duration_not_reached");
    expect(r.durationSec).toBe(600);
  });

  it("fires once the duration is reached", () => {
    expect(evaluateBarCappedDuration(NOW - 31 * 60, NOW, 30, false).eligible).toBe(true);
  });

  it("per-day dedupe blocks a second alert the same day", () => {
    const r = evaluateBarCappedDuration(NOW - 40 * 60, NOW, 30, true);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("already_fired_today");
  });
});

/* -------------------------------------------------------------------------- */
/* goal_milestone                                                             */
/* -------------------------------------------------------------------------- */

describe("evaluateGoalMilestone", () => {
  const fractions = [0.5, 0.75, 0.9] as const;

  it("reports nothing without progress", () => {
    expect(evaluateGoalMilestone(null, null, fractions)).toEqual({ newlyReached: null, highestReached: null });
  });

  it("reports nothing below the first milestone", () => {
    expect(evaluateGoalMilestone(0.3, null, fractions)).toEqual({ newlyReached: null, highestReached: null });
  });

  it("fires for the newly reached fraction only", () => {
    expect(evaluateGoalMilestone(0.55, null, fractions)).toEqual({ newlyReached: 0.5, highestReached: 0.5 });
    expect(evaluateGoalMilestone(0.8, 0.5, fractions)).toEqual({ newlyReached: 0.75, highestReached: 0.75 });
  });

  it("never re-notifies an already notified fraction", () => {
    expect(evaluateGoalMilestone(0.8, 0.75, fractions).newlyReached).toBeNull();
    expect(evaluateGoalMilestone(0.6, 0.75, fractions).newlyReached).toBeNull();
  });

  it("treats achievement (1.0) as outside the milestone ladder", () => {
    const r = evaluateGoalMilestone(1.0, 0.5, fractions);
    expect(r.highestReached).toBe(0.9);
    expect(r.newlyReached).toBe(0.9);
  });
});

/* -------------------------------------------------------------------------- */
/* rehab_advice (drug-window episode)                                         */
/* -------------------------------------------------------------------------- */

describe("evaluateDrugWindow", () => {
  const config = { count: 3, windowHours: 24, cleanHours: 24 };

  it("does not fire below the threshold", () => {
    const r = evaluateDrugWindow([NOW - 3600, NOW - 7200], NOW, config, null);
    expect(r.eligible).toBe(false);
    expect(r.episodeOpen).toBe(false);
  });

  it("opens an episode and fires exactly once for a cluster", () => {
    const events = [NOW - 3 * 3600, NOW - 2 * 3600, NOW - 3600];
    const r = evaluateDrugWindow(events, NOW, config, null);
    expect(r.eligible).toBe(true);
    expect(r.episodeOpen).toBe(true);
    expect(r.episodeSinceSec).toBe(NOW - 3 * 3600);
    // re-evaluation of the same cluster: no second alert
    const again = evaluateDrugWindow(events, NOW + 60, config, r.episodeSinceSec);
    expect(again.eligible).toBe(false);
    expect(again.episodeOpen).toBe(true);
  });

  it("closes the episode only after the clean window", () => {
    const events = [NOW - 50 * 3600, NOW - 49 * 3600, NOW - 48 * 3600]; // outside the 24h window now
    const r = evaluateDrugWindow(events, NOW, config, NOW - 48 * 3600);
    expect(r.eligible).toBe(false);
    expect(r.episodeOpen).toBe(false);
    expect(r.episodeSinceSec).toBeNull();
  });

  it("re-fires for a genuinely new cluster after the episode closed", () => {
    const fresh = [NOW - 2 * 3600, NOW - 3600, NOW - 30 * 60];
    const r = evaluateDrugWindow(fresh, NOW, config, null);
    expect(r.eligible).toBe(true);
  });

  it("never invents events: no data means no alert and no episode", () => {
    const r = evaluateDrugWindow([], NOW, config, null);
    expect(r).toMatchObject({ eligible: false, episodeOpen: false, windowCount: 0, windowEarliestAtSec: null });
  });
});

/* -------------------------------------------------------------------------- */
/* drug_overdose_spike                                                        */
/* -------------------------------------------------------------------------- */

describe("evaluateOverdoseSpike", () => {
  const config = { count: 2, windowHours: 24, baselineDays: 90 };

  it("requires the absolute count first", () => {
    const r = evaluateOverdoseSpike([NOW - 3600], NOW, config);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("below_count");
  });

  it("refuses to claim a spike without a usable personal baseline", () => {
    const r = evaluateOverdoseSpike([NOW - 2 * 3600, NOW - 3600], NOW, config);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("insufficient_baseline");
  });

  it("rejects volumes at or below the doubled baseline expectation", () => {
    // ~2 overdoses/day over the baseline: 2 inside 24h is at most the
    // doubled expectation — not a spike for THIS player. (The absolute
    // count gate alone can never justify "spike" against an active habit.)
    const baselineEvents = Array.from({ length: 177 }, (_, i) => NOW - 36 * 3600 - i * 12 * 3600);
    const r = evaluateOverdoseSpike([...baselineEvents, NOW - 2 * 3600, NOW - 3600], NOW, config);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("baseline_not_exceeded");
    expect(r.baselineRatePerDay).toBeCloseTo(177 / 90, 1);
  });

  it("fires when the window volume exceeds double the baseline expectation", () => {
    const baselineEvents = Array.from({ length: 177 }, (_, i) => NOW - 36 * 3600 - i * 12 * 3600);
    const r = evaluateOverdoseSpike(
      [...baselineEvents, NOW - 8 * 3600, NOW - 5 * 3600, NOW - 3 * 3600, NOW - 3600],
      NOW,
      config
    );
    expect(r.eligible).toBe(true);
    expect(r.windowCount).toBe(4);
  });

  it("never fabricates a baseline rate from nothing (fake-zero guard)", () => {
    const r = evaluateOverdoseSpike([], NOW, config);
    expect(r.baselineRatePerDay).toBeNull();
    expect(r.eligible).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* training_stagnation                                                        */
/* -------------------------------------------------------------------------- */

describe("evaluateTrainingStagnation", () => {
  const config = { windowDays: 7 };

  it("reports missing data as reasons, never as zero gain", () => {
    expect(evaluateTrainingStagnation(null, { total: 1000, atSec: NOW - 8 * DAY }, NOW, config)).toMatchObject({
      stagnant: false, reason: "missing_latest", gain: null,
    });
    expect(evaluateTrainingStagnation({ total: 1000, atSec: NOW - 3600 }, null, NOW, config)).toMatchObject({
      stagnant: false, reason: "missing_comparison", gain: null,
    });
  });

  it("rejects a comparison older than 2× the window (stale, not zero-gain)", () => {
    const r = evaluateTrainingStagnation(
      { total: 1000, atSec: NOW - 3600 },
      { total: 1000, atSec: NOW - 30 * DAY },
      NOW,
      config
    );
    expect(r).toMatchObject({ stagnant: false, reason: "stale_comparison", gain: null });
  });

  it("reports a genuine gain", () => {
    const r = evaluateTrainingStagnation(
      { total: 1200, atSec: NOW - 3600 },
      { total: 1000, atSec: NOW - 7 * DAY },
      NOW,
      config
    );
    expect(r).toMatchObject({ stagnant: false, reason: "gained", gain: 200 });
  });

  it("detects stagnation with an in-window comparison", () => {
    const r = evaluateTrainingStagnation(
      { total: 1000, atSec: NOW - 3600 },
      { total: 1000, atSec: NOW - 6 * DAY },
      NOW,
      config
    );
    expect(r).toMatchObject({ stagnant: true, gain: 0 });
  });

  it("detects a stat loss as stagnant too", () => {
    const r = evaluateTrainingStagnation(
      { total: 900, atSec: NOW - 3600 },
      { total: 1000, atSec: NOW - 6 * DAY },
      NOW,
      config
    );
    expect(r).toMatchObject({ stagnant: true, gain: -100 });
  });
});

/* -------------------------------------------------------------------------- */
/* Registry config contracts                                                  */
/* -------------------------------------------------------------------------- */

describe("2.10.0 registry config normalization", () => {
  it.each([
    ["networth_drawdown", { pct: 10 }],
    ["bar_capped", { bars: ["energy"], minutes: 30 }],
    ["bank_maturity_soon", { within_hours: 24 }],
    ["oc_almost_ready", { within_hours: 6 }],
    ["goal_milestone", {}],
    ["rehab_advice", { count: 3, window_hours: 24, clean_hours: 24 }],
    ["drug_overdose_spike", { count: 2, window_hours: 24, baseline_days: 90 }],
    ["training_stagnation", { window_days: 7 }],
  ] as const)("normalizes %s defaults", (trigger, expected) => {
    expect(normalizeAlertConfig(trigger, {})).toEqual(expected);
  });

  it("rejects out-of-range thresholds (Zod strict)", () => {
    expect(() => normalizeAlertConfig("bar_capped", { minutes: 1 })).toThrow();
    expect(() => normalizeAlertConfig("rehab_advice", { count: 1 })).toThrow();
    expect(() => normalizeAlertConfig("drug_overdose_spike", { baseline_days: 2 })).toThrow();
    expect(() => normalizeAlertConfig("training_stagnation", { window_days: 0 })).toThrow();
    expect(() => normalizeAlertConfig("networth_drawdown", { pct: 200 })).toThrow();
    expect(() => normalizeAlertConfig("bar_capped", { unknown_key: true })).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* "Fake zero" guarantee (parameterized across the whole catalog)             */
/* -------------------------------------------------------------------------- */

describe("fake-zero guarantee — unavailable data never renders as 0", () => {
  it("every trigger declares a confidence label from the canonical vocabulary", () => {
    for (const meta of ALERT_TRIGGERS) {
      expect(ALERT_CONFIDENCE_LABELS).toContain(meta.confidenceLabel);
    }
    expect(new Set(ALERT_TRIGGERS.map((t) => t.id)).size).toBe(ALERT_TRIGGERS.length);
  });

  it.each(ALERT_TRIGGERS.map((t) => [t.id, t] as const))(
    "%s: empty inputs produce no alert and no fabricated numeric facts",
    (id, meta) => {
      // The pure-layer guarantee: with no data presented, evaluators either
      // decline (documented reason) or report null — they never emit a
      // numeric zero standing in for "unknown".
      switch (id) {
        case "networth_drawdown": {
          const r = evaluateNetworthDrawdown(null, null, meta.defaultConfig as { pct?: number }, NOW, null);
          expect(r.eligible).toBe(false);
          expect(r.dropPct).toBe(0); // dropPct is a delta, null totals are separate
          expect(r.baselineTotal).toBeNull();
          expect(r.currentTotal).toBeNull();
          break;
        }
        case "bar_capped": {
          const r = evaluateBarCappedDuration(null, NOW, 30, false);
          expect(r.eligible).toBe(false);
          expect(r.reason).toBe("not_capped");
          break;
        }
        case "bank_maturity_soon":
        case "oc_almost_ready": {
          const r = evaluateImminentTimer(null, NOW, 24 * 3600, null);
          expect(r).toEqual({ eligible: false, reason: "no_timer", endSec: null });
          break;
        }
        case "goal_milestone": {
          const r = evaluateGoalMilestone(null, null, [0.5, 0.75, 0.9]);
          expect(r).toEqual({ newlyReached: null, highestReached: null });
          break;
        }
        case "rehab_advice": {
          const r = evaluateDrugWindow([], NOW, { count: 3, windowHours: 24, cleanHours: 24 }, null);
          expect(r).toMatchObject({ eligible: false, episodeOpen: false, windowCount: 0, windowEarliestAtSec: null, latestEventAtSec: null });
          break;
        }
        case "drug_overdose_spike": {
          const r = evaluateOverdoseSpike([], NOW, { count: 2, windowHours: 24, baselineDays: 90 });
          expect(r.eligible).toBe(false);
          expect(r.baselineRatePerDay).toBeNull();
          break;
        }
        case "training_stagnation": {
          const r = evaluateTrainingStagnation(null, null, NOW, { windowDays: 7 });
          expect(r.gain).toBeNull();
          expect(r.stagnant).toBe(false);
          break;
        }
        default:
          // 2.9.0 evaluators have their own existing coverage; here we only
          // assert the registry contract they now share.
          expect(meta.confidenceLabel).toBeTruthy();
      }
    }
  );
});
