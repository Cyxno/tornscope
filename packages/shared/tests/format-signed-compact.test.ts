import { describe, expect, it } from "vitest";
import { formatSignedMoneyCompact } from "../src/format.js";

describe("formatSignedMoneyCompact", () => {
  it("signs positive compact values", () => {
    expect(formatSignedMoneyCompact(9_090_000)).toBe("+$9.09m");
  });

  it("keeps negatives signed by the compact formatter", () => {
    expect(formatSignedMoneyCompact(-52_636_687)).toBe("-$52.64m");
  });

  it("renders zero without a sign", () => {
    expect(formatSignedMoneyCompact(0)).toBe("$0");
  });

  it("renders null as an em dash", () => {
    expect(formatSignedMoneyCompact(null)).toBe("—");
  });
});
