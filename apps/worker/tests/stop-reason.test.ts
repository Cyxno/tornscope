import { describe, expect, it } from "vitest";
import { aggregateStopReason } from "../src/sync/handlers.js";

/**
 * Backfill completion semantics: a resource must not say caught_up merely
 * because the latest page completed. The resource-level stop reason must
 * surface ANY incompleteness across categories.
 */
describe("aggregateStopReason", () => {
  it("max_pages wins over everything (history incomplete)", () => {
    expect(aggregateStopReason(["history_boundary_reached", "source_exhausted", "max_pages"])).toBe("max_pages");
  });

  it("cursor_stalled beats complete reasons", () => {
    expect(aggregateStopReason(["source_exhausted", "cursor_stalled"])).toBe("cursor_stalled");
  });

  it("a boundary hit is reported even when other categories exhausted", () => {
    expect(aggregateStopReason(["source_exhausted", "history_boundary_reached"])).toBe("history_boundary_reached");
  });

  it("all-exhausted means the source simply has no more rows", () => {
    expect(aggregateStopReason(["source_exhausted", "source_exhausted"])).toBe("source_exhausted");
  });

  it("no categories at all is treated as exhausted, not complete", () => {
    expect(aggregateStopReason([])).toBe("source_exhausted");
  });
});
