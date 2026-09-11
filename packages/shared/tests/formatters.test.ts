import { describe, expect, it } from "vitest";
import {
  formatMoneyCompact,
  formatMoneyFull,
  formatNumberCompact,
  formatSignedMoneyCompact,
  formatSignedNumberCompact,
} from "../src/format.js";
import { formatBuildIdentity, resolveBuildIdentity, shortSha } from "../src/build.js";

/**
 * Formatter regression coverage (roadmap #9, phases 71–73):
 * money formatters carry "$", number formatters NEVER do — battlestats,
 * energy, happy, points and counts are unit-less Torn numbers — and the
 * compact scales/zero/null semantics stay stable.
 */
describe("money formatters", () => {
  it("compact scale + zero + null", () => {
    expect(formatMoneyCompact(0)).toBe("$0");
    expect(formatMoneyCompact(null)).toBe("—");
    expect(formatMoneyCompact(532_100)).toBe("$532.1k");
    expect(formatMoneyCompact(12_400_000)).toBe("$12.40m");
    expect(formatMoneyCompact(1_250_000_000)).toBe("$1.25b");
    expect(formatMoneyCompact(-532_100)).toBe("-$532.1k");
  });

  it("full + signed variants (no double signs)", () => {
    expect(formatMoneyFull(1_234_567)).toBe("$1,234,567");
    expect(formatSignedMoneyCompact(12_400_000)).toBe("+$12.40m");
    expect(formatSignedMoneyCompact(-532_100)).toBe("-$532.1k"); // sign once
    expect(formatSignedMoneyCompact(0)).toBe("$0");
    expect(formatSignedMoneyCompact(null)).toBe("—");
  });
});

describe("number formatters (never currency)", () => {
  it("compact scale matches money WITHOUT $", () => {
    expect(formatNumberCompact(0)).toBe("0");
    expect(formatNumberCompact(null)).toBe("—");
    expect(formatNumberCompact(532_100)).toBe("532.1k");
    expect(formatNumberCompact(12_400_000)).toBe("12.40m");
    expect(formatNumberCompact(1_250_000_000)).toBe("1.25b");
    expect(formatNumberCompact(-532_100)).toBe("-532.1k");
  });

  it("signed variants (sign once; positive +)", () => {
    expect(formatSignedNumberCompact(3_090_000)).toBe("+3.09m");
    expect(formatSignedNumberCompact(-80_000)).toBe("-80.0k");
    expect(formatSignedNumberCompact(0)).toBe("0");
    expect(formatSignedNumberCompact(null)).toBe("—");
  });

  it("contract: number formatters never emit a currency symbol", () => {
    for (const v of [0, 1, 999, -4500, 12_400_000, null]) {
      expect(formatNumberCompact(v as number)).not.toContain("$");
      expect(formatSignedNumberCompact(v as number)).not.toContain("$");
    }
  });
});

describe("build identity", () => {
  it("short sha + canonical one-line format", () => {
    expect(shortSha("f63f466a84834f3898a5730889f83f90b45e4548")).toBe("f63f466");
    expect(formatBuildIdentity({ version: "0.2.0-dev.0", gitSha: "f63f466a84834f3898a5730889f83f90b45e4548", environment: "Development" })).toBe(
      "0.2.0-dev.0 · f63f466"
    );
  });

  it("safe fallbacks for missing pieces", () => {
    expect(formatBuildIdentity(resolveBuildIdentity({}))).toBe("0.0.0-dev · dev");
  });
});
