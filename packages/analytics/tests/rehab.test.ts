import { describe, expect, it } from "vitest";
import { calculateRehabStats } from "../src/rehab.js";

/**
 * Rehab contract (TERMINOLOGY VERIFIED AGAINST THE LIVE TORN PAYLOAD):
 * - One Torn "Rehab" log row is ONE VISIT — Torn pre-groups each visit into
 *   a single log with `rehab_times` = explicit session count and `cost` =
 *   the visit TOTAL. No time clustering is applied.
 * - `sessions` sums the EXPLICIT counts; a missing count renders "Sessions
 *   unavailable" (null) — never inferred from row counts or money amounts.
 * - Cost per session is only computed when EVERY visit carries a count
 *   (partial knowledge would bias the average).
 */
describe("calculateRehabStats", () => {
  const from = 0;
  const to = 1_000_000_000;

  it("sums costs and exposes exact provenance when every visit has a cost", () => {
    const s = calculateRehabStats(
      [
        { occurredAt: 100, cost: 750_000, rehabPercent: null, sessions: 3 },
        { occurredAt: 200, cost: 1_000_000, rehabPercent: null, sessions: 4 },
      ],
      from,
      to
    );
    expect(s.totalSpend).toBe(1_750_000);
    expect(s.provenance).toBe("exact");
  });

  it("treats one log row as ONE VISIT — no 12h clustering", () => {
    // Two rows 60s apart are two separate visits (Torn logs each visit once).
    const s = calculateRehabStats(
      [
        { occurredAt: 3_600, cost: 750_000, rehabPercent: null, sessions: 3 },
        { occurredAt: 3_660, cost: 500_000, rehabPercent: null, sessions: 2 },
      ],
      from,
      to
    );
    expect(s.visits).toBe(2);
    expect(s.sessions).toBe(5);
    expect(s.averageSessionsPerVisit).toBeCloseTo(2.5, 5);
  });

  it("a multi-session visit sums the explicit rehab_times, never 1 row = 1 session", () => {
    // The real live shape: 3 visits of 3-4 sessions each.
    const s = calculateRehabStats(
      [
        { occurredAt: 100, cost: 750_000, rehabPercent: null, sessions: 3 },
        { occurredAt: 200, cost: 1_000_000, rehabPercent: null, sessions: 4 },
        { occurredAt: 300, cost: 500_000, rehabPercent: null, sessions: 2 },
      ],
      from,
      to
    );
    expect(s.visits).toBe(3);
    expect(s.sessions).toBe(9);
    expect(s.averageSessionsPerVisit).toBeCloseTo(3, 5);
    expect(s.averageCostPerVisit).toBe(Math.round(2_250_000 / 3));
    expect(s.averageCostPerSession).toBe(Math.round(2_250_000 / 9));
    expect(s.visitTrend[2]).toMatchObject({ sessions: 2, cost: 500_000, costPerSession: 250_000 });
  });

  it("a missing session count stays unavailable — never inferred from money", () => {
    const s = calculateRehabStats(
      [
        { occurredAt: 100, cost: 750_000, rehabPercent: null, sessions: 3 },
        { occurredAt: 200, cost: 1_000_000, rehabPercent: null, sessions: null },
      ],
      from,
      to
    );
    // Known visits contribute their counts; the unknown one is reported.
    expect(s.visits).toBe(2);
    expect(s.sessionsUnavailable).toBe(1);
    expect(s.averageSessionsPerVisit).toBe(3);
    // Cost per session needs the FULL count — unavailable otherwise.
    expect(s.averageCostPerSession).toBeNull();
    expect(s.visitTrend.find((v) => v.startedAt === 200)?.sessions).toBeNull();
  });

  it("with NO session counts anywhere, sessions are unavailable (null), not 0", () => {
    const s = calculateRehabStats(
      [
        { occurredAt: 100, cost: 750_000, rehabPercent: null, sessions: null },
        { occurredAt: 200, cost: 500_000, rehabPercent: null, sessions: null },
      ],
      from,
      to
    );
    expect(s.sessions).toBeNull();
    expect(s.sessionsUnavailable).toBe(2);
    expect(s.averageSessionsPerVisit).toBeNull();
    expect(s.averageCostPerSession).toBeNull();
  });

  it("is an empty confirmed zero when no visits exist", () => {
    const s = calculateRehabStats([], 0, to);
    expect(s.visits).toBe(0);
    expect(s.totalSpend).toBe(0);
    expect(s.sessions).toBeNull();
  });
});
