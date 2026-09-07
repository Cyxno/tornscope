import { describe, expect, it } from "vitest";
import { formatDecimal } from "../src/format.js";

describe("formatDecimal", () => {
  it("strips floating-point artifacts from respect-like values", () => {
    expect(formatDecimal(36.60000000000001)).toBe("36.6");
    expect(formatDecimal(0.1 + 0.2)).toBe("0.3");
    expect(formatDecimal(136)).toBe("136");
    expect(formatDecimal(-12.006)).toBe("-12.01");
  });

  it("handles null/undefined/NaN as em dash", () => {
    expect(formatDecimal(null)).toBe("—");
    expect(formatDecimal(undefined)).toBe("—");
    expect(formatDecimal(Number.NaN)).toBe("—");
  });
});
