import { describe, expect, it } from "vitest";
import { aggregateStopReason, historyBoundaryTs } from "../../worker/src/sync/handlers.js";
import { assembleTripsFromTransitionRows } from "@tornscope/database";

/**
 * History-boundary semantics:
 * - initial backfill boundary = now - configured days (30/90/180/365 all valid)
 * - incremental boundary = last cursor (never re-walks the full window)
 * - the boundary-crossing page may be fetched, but the handler must not
 *   persist rows from before the requested window
 */

const DAY = 86_400;
const NOW = 1_788_633_600; // 2026-09-05 12:00:00 UTC

describe("historyBoundaryTs", () => {
  it("180-day default boundary", () => {
    expect(historyBoundaryTs(null, 180, NOW)).toBe(NOW - 180 * DAY);
  });

  it("30-day configured boundary", () => {
    expect(historyBoundaryTs(null, 30, NOW)).toBe(NOW - 30 * DAY);
  });

  it("365-day configured boundary", () => {
    expect(historyBoundaryTs(null, 365, NOW)).toBe(NOW - 365 * DAY);
  });

  it("incremental syncs use the last cursor, never the full window", () => {
    const cursor = BigInt(NOW - 2 * DAY);
    expect(historyBoundaryTs(cursor, 180, NOW)).toBe(NOW - 2 * DAY);
    expect(historyBoundaryTs(cursor, 30, NOW)).toBe(NOW - 2 * DAY);
  });

  it("incremental boundary is independent of the configured history depth", () => {
    const cursor = BigInt(NOW - 600);
    expect(historyBoundaryTs(cursor, 3650, NOW)).toBe(NOW - 600);
  });
});

describe("boundary-crossing page persistence filter", () => {
  // Mirrors the handler's insert filter: initial backfill persists only rows
  // at/after the boundary, even when Torn's boundary-crossing page carries
  // years-older rows (a low-volume category's whole history fits on one page).
  function persistFilter(logTimestamp: number, initialBackfill: boolean, boundary: number): boolean {
    return !(initialBackfill && logTimestamp < boundary);
  }

  it("keeps rows inside the requested window", () => {
    const boundary = NOW - 180 * DAY;
    expect(persistFilter(boundary, true, boundary)).toBe(true);
    expect(persistFilter(boundary + 3600, true, boundary)).toBe(true);
  });

  it("drops years-older rows carried by the crossing page", () => {
    const boundary = NOW - 180 * DAY;
    const year2020 = Date.UTC(2020, 0, 10) / 1000;
    expect(persistFilter(year2020, true, boundary)).toBe(false);
  });

  it("incremental syncs keep everything (dedup makes replay safe)", () => {
    const boundary = NOW - 2 * DAY;
    expect(persistFilter(NOW - 400 * DAY, false, boundary)).toBe(true);
  });
});

describe("permanent travel history survives source retention", () => {
  it("assembled trips persist as long as their stored transitions do — old trips are not dropped", () => {
    // A trip from March (well before Torn's ~60-day arrive-log retention)
    // that is fully stored must still assemble: raw stored history is the
    // permanent source of truth.
    const depart = Date.UTC(2026, 2, 10) / 1000; // 2026-03-10
    const arrive = depart + 3600;
    const returnHome = depart + 6 * 3600;
    const { trips } = assembleTripsFromTransitionRows([
      { id: "d", occurredAt: new Date(depart * 1000), type: "DEPARTED_TORN", country: "Switzerland", countryId: 8 },
      { id: "a", occurredAt: new Date(arrive * 1000), type: "ARRIVED_ABROAD", country: "Switzerland", countryId: 8 },
      { id: "h", occurredAt: new Date((arrive + 1800) * 1000), type: "DEPARTED_ABROAD", country: "Switzerland", countryId: 8 },
      { id: "r", occurredAt: new Date(returnHome * 1000), type: "ARRIVED_TORN", country: "Torn", countryId: 1 },
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.status).toBe("completed");
    expect(trips[0]!.returnedAt).not.toBeNull();
  });

  it("unattached purchases stay unattached when no trip evidence exists — never invented into a trip", () => {
    // Item abroad buy evidence survives but depart/arrive logs are gone:
    // assembly must produce NO trip from a purchase alone.
    const purchaseTime = Date.UTC(2026, 1, 15) / 1000; // 2026-02-15
    const { trips, unmatched } = assembleTripsFromTransitionRows([
      { id: "p", occurredAt: new Date(purchaseTime * 1000), type: "ITEM_PURCHASE", country: "UAE", countryId: 11 },
    ]);
    expect(trips).toHaveLength(0);
    expect(unmatched).toBe(0); // purchases are handled by the linking pass, not the state machine
  });
});

describe("travel source exhaustion reporting", () => {
  it("all-categories exhausted reports source_exhausted (honest stop)", () => {
    expect(aggregateStopReason(["source_exhausted", "source_exhausted"])).toBe("source_exhausted");
  });

  it("a category that reached the boundary reports boundary reached", () => {
    expect(aggregateStopReason(["history_boundary_reached"])).toBe("history_boundary_reached");
  });

  it("any incomplete category keeps the resource visibly incomplete", () => {
    expect(aggregateStopReason(["history_boundary_reached", "max_pages"])).toBe("max_pages");
  });
});
