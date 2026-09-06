import { describe, expect, it } from "vitest";
import { capabilityLevel, deriveKeyCapabilities, moduleAvailability } from "../src/index.js";

const caps = (over: Partial<ReturnType<typeof deriveKeyCapabilities>>) =>
  deriveKeyCapabilities(
    {
      user: Object.entries({
        profile: over.canReadUserBasic,
        bars: over.canReadUserBars,
        money: over.canReadUserMoney,
        log: over.canReadUserLogs,
        attacks: over.canReadUserAttacks,
        networth: over.canReadUserNetworth,
      })
        .filter(([, v]) => v === true)
        .map(([k]) => k),
      faction: Object.entries({
        basic: over.canReadFactionBasic,
        members: over.canReadFactionMembers,
        rankedwars: over.canReadFactionRankedWars,
        crimes: over.canReadFactionCrimes,
        armorynews: over.canReadFactionArmoryNews,
        balance: over.canReadFactionBalance,
        log: over.canReadFactionLogs,
      })
        .filter(([, v]) => v === true)
        .map(([k]) => k),
    },
    null
  );

describe("capabilityLevel (friendly tiers derived from real selections)", () => {
  it("basic-only key reads as Basic", () => {
    expect(capabilityLevel(caps({ canReadUserBasic: true, canReadUserBars: true }))).toBe("Basic");
  });

  it("log+money+attacks reads as Extended", () => {
    expect(capabilityLevel(caps({ canReadUserBasic: true, canReadUserLogs: true, canReadUserMoney: true, canReadUserAttacks: true }))).toBe("Extended");
  });

  it("extended plus faction reads as Faction-enabled", () => {
    const level = capabilityLevel(caps({ canReadUserBasic: true, canReadUserLogs: true, canReadUserMoney: true, canReadUserAttacks: true, canReadFactionBasic: true, canReadFactionMembers: true }));
    expect(level).toBe("Faction-enabled");
  });

  it("everything on reads as Full available access", () => {
    const all = caps({
      canReadUserBasic: true, canReadUserBars: true, canReadUserMoney: true, canReadUserLogs: true,
      canReadUserAttacks: true, canReadUserNetworth: true, canReadFactionBasic: true, canReadFactionMembers: true,
      canReadFactionRankedWars: true, canReadFactionCrimes: true, canReadFactionArmoryNews: true,
      canReadFactionBalance: true, canReadFactionLogs: true,
    });
    expect(capabilityLevel(all)).toBe("Full available access");
  });
});

describe("moduleAvailability (limited-key degradation)", () => {
  it("basic-only key: analytics unavailable with a reason, no fabricated zeros", () => {
    const modules = moduleAvailability(caps({ canReadUserBasic: true, canReadUserBars: true }));
    const by = Object.fromEntries(modules.map((m) => [m.module, m.available]));
    expect(by.today).toBe(true);
    expect(by.drugs).toBe(false);
    expect(by.money).toBe(false);
    expect(by.faction).toBe(false);
    const drugs = modules.find((m) => m.module === "drugs")!;
    expect(drugs.reason).toMatch(/log access/i);
  });

  it("logs without faction: analytics on, faction off with an explanatory reason", () => {
    const modules = moduleAvailability(caps({ canReadUserBasic: true, canReadUserLogs: true, canReadUserMoney: true, canReadUserAttacks: true }));
    const by = Object.fromEntries(modules.map((m) => [m.module, m.available]));
    expect(by.drugs).toBe(true);
    expect(by.combat).toBe(true);
    expect(by.faction).toBe(false);
    expect(modules.find((m) => m.module === "faction")!.reason).toMatch(/faction access/i);
  });
});
