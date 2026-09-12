import { describe, expect, it } from "vitest";
import { formatMoneyCompact, formatSignedMoneyCompact } from "../src/format.js";

/**
 * PF-018 regression: a NONZERO amount under one dollar must never render as
 * "$0" — an actual zero and a rounded-away fraction are different facts
 * (Crimes "per nerve -$0" was really -$0.23). True zero still renders "$0".
 */
describe("formatMoneyCompact sub-dollar precision", () => {
  it("shows cents for nonzero amounts under $1", () => {
    expect(formatMoneyCompact(0.227)).toBe("$0.23");
    expect(formatMoneyCompact(-0.227)).toBe("-$0.23");
    expect(formatMoneyCompact(0.5)).toBe("$0.50");
    expect(formatMoneyCompact(0.99)).toBe("$0.99");
  });

  it("renders actual zero and sub-cent rounding as $0", () => {
    expect(formatMoneyCompact(0)).toBe("$0");
    expect(formatMoneyCompact(-0)).toBe("$0");
    expect(formatMoneyCompact(0.004)).toBe("$0");
  });

  it("keeps dollar-and-above amounts compact without cents", () => {
    expect(formatMoneyCompact(1)).toBe("$1");
    expect(formatMoneyCompact(666)).toBe("$666");
    expect(formatMoneyCompact(1234.56)).toBe("$1,235");
  });

  it("signed variant inherits the sub-dollar precision", () => {
    expect(formatSignedMoneyCompact(-0.227)).toBe("-$0.23");
    expect(formatSignedMoneyCompact(0)).toBe("$0");
  });
});
