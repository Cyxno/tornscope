import { describe, expect, it } from "vitest";
import { formatKpiValue, formatMoneyCompact } from "../src/format.js";

/**
 * Zero-vs-unknown UX contract:
 *   $0 only ever means a CONFIRMED zero;
 *   "—" not available; "Importing" still backfilling; "Incomplete" when
 *   parser coverage is insufficient.
 */
describe("formatKpiValue", () => {
  it("renders a confirmed zero as $0", () => {
    expect(formatKpiValue({ value: 0, availability: "ok" })).toBe("$0");
    expect(formatKpiValue({ value: 0 })).toBe("$0");
  });

  it("renders unavailable/null values as an em dash", () => {
    expect(formatKpiValue({ value: null, availability: "unavailable" })).toBe("—");
    expect(formatKpiValue({ value: null })).toBe("—");
  });

  it("renders importing state regardless of value", () => {
    expect(formatKpiValue({ value: 0, availability: "importing" })).toBe("Importing");
    expect(formatKpiValue({ value: null, availability: "importing" })).toBe("Importing");
  });

  it("renders Incomplete only when no partial value exists", () => {
    expect(formatKpiValue({ value: null, availability: "incomplete" })).toBe("Incomplete");
    // partial coverage still shows the derived number (flagged elsewhere)
    expect(formatKpiValue({ value: 1_500_000, availability: "incomplete" })).toBe("$1.50m");
  });

  it("delegates formatting of real values", () => {
    expect(formatKpiValue({ value: -3_140_000, availability: "ok" })).toBe(formatMoneyCompact(-3_140_000));
  });
});
