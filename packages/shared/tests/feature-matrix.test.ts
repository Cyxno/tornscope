import { describe, expect, it } from "vitest";
import {
  CAPABILITY_KEYS,
  compareCapabilities,
  deriveKeyCapabilities,
  featureAvailability,
  hasCompleteCapabilityShape,
  normalizeCapabilities,
  normalizeCapabilitiesWithFallback,
  resourceAllowed,
  resourceRequirementLabel,
  capabilityLevel,
  moduleAvailability,
} from "../src/index.js";

const FULL_SELECTIONS = {
  user: ["basic", "profile", "bars", "cooldowns", "education", "travel", "money", "log", "attacks", "networth", "events", "personalstats", "merits", "stocks"],
  faction: ["basic", "members", "rankedwars", "chains", "crimes", "armorynews", "balance", "log"],
};

function caps(partial: Record<string, boolean>) {
  const base = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, false]));
  return { ...base, ...partial } as ReturnType<typeof deriveKeyCapabilities>;
}

describe("deriveKeyCapabilities (live /key/info shapes)", () => {
  it("a Full key with explicit selections grants everything TornScope can use", () => {
    const c = deriveKeyCapabilities({ ...FULL_SELECTIONS, factionAccess: true }, 4);
    expect(c.canReadUserBasic).toBe(true);
    expect(c.canReadUserLogs).toBe(true);
    expect(c.canReadUserEvents).toBe(true);
    expect(c.canReadUserPersonalStats).toBe(true);
    expect(c.canReadFactionChains).toBe(true);
    expect(c.canReadFactionArmoryNews).toBe(true);
    expect(CAPABILITY_KEYS.every((k) => c[k])).toBe(true);
  });

  it("a Limited logs-only key: identity + logs yes, faction no", () => {
    const c = deriveKeyCapabilities({ user: ["basic", "profile", "bars", "log"] }, 3);
    expect(c.canReadUserBasic).toBe(true);
    expect(c.canReadUserLogs).toBe(true);
    expect(c.canReadUserMoney).toBe(false);
    expect(c.canReadUserAttacks).toBe(false);
    expect(c.canReadUserNetworth).toBe(false);
    expect(c.canReadFactionBasic).toBe(false);
    expect(c.canReadFactionArmoryNews).toBe(false);
  });

  it("accepts 'basic' as basic-account access even when 'profile' is absent", () => {
    const c = deriveKeyCapabilities({ user: ["basic"] }, 1);
    expect(c.canReadUserBasic).toBe(true);
  });

  it("new capabilities follow their own selections", () => {
    const c = deriveKeyCapabilities({ user: ["travel", "cooldowns", "education", "events", "personalstats"] }, 3);
    expect(c.canReadUserTravel).toBe(true);
    expect(c.canReadUserCooldowns).toBe(true);
    expect(c.canReadUserEducation).toBe(true);
    expect(c.canReadUserEvents).toBe(true);
    expect(c.canReadUserPersonalStats).toBe(true);
    expect(c.canReadUserLogs).toBe(false); // no log selection
  });

  it("without a selections list, faction access is trusted only from Torn's own access.faction flag on a level-4 key", () => {
    const trusted = deriveKeyCapabilities({ factionAccess: true }, 4);
    expect(trusted.canReadFactionBasic).toBe(true);
    expect(trusted.canReadFactionArmoryNews).toBe(true);
    const notTrusted = deriveKeyCapabilities({ factionAccess: false }, 4);
    expect(notTrusted.canReadFactionBasic).toBe(false);
    const lowerLevel = deriveKeyCapabilities({ factionAccess: true }, 3);
    expect(lowerLevel.canReadFactionBasic).toBe(false);
  });

  it("without any selections, numeric level gives the conservative fallback", () => {
    const c = deriveKeyCapabilities(null, 3);
    expect(c.canReadUserBasic).toBe(true);
    expect(c.canReadUserLogs).toBe(true);
    expect(c.canReadUserPersonalStats).toBe(true);
    expect(c.canReadFactionBasic).toBe(false); // faction never assumed from level alone
  });
});

describe("normalizeCapabilities (legacy credential blobs)", () => {
  it("keeps old 13-key capability objects usable (missing keys read as false)", () => {
    const legacy = { canReadUserBasic: true, canReadUserLogs: true, canReadUserBars: true };
    const c = normalizeCapabilities(legacy);
    expect(c).not.toBeNull();
    expect(c!.canReadUserLogs).toBe(true);
    expect(c!.canReadUserEvents).toBe(false);
    expect(CAPABILITY_KEYS.every((k) => typeof c![k] === "boolean")).toBe(true);
  });

  it("returns null for junk so gating falls back to live detection", () => {
    expect(normalizeCapabilities(null)).toBeNull();
    expect(normalizeCapabilities({})).toBeNull();
    expect(normalizeCapabilities("x")).toBeNull();
  });
});

describe("legacy 13-key blobs must not block resources the key actually has", () => {
  // The exact blob shape stored by the earlier deployment.
  const STALE_BLOB = {
    canReadUserBars: true,
    canReadUserLogs: true,
    canReadUserBasic: true,
    canReadUserMoney: true,
    canReadFactionLogs: false,
    canReadUserAttacks: true,
    canReadFactionBasic: true,
    canReadUserNetworth: true,
    canReadFactionCrimes: true,
    canReadFactionBalance: true,
    canReadFactionMembers: true,
    canReadFactionArmoryNews: true,
    canReadFactionRankedWars: true,
  };

  it("incomplete-shape blobs are detected as stale (worker re-detects)", () => {
    expect(hasCompleteCapabilityShape(STALE_BLOB)).toBe(false);
    expect(hasCompleteCapabilityShape({ ...normalizeCapabilities(STALE_BLOB)!, canReadUserEvents: false })).toBe(true);
  });

  it("read paths fall back to the numeric level for the missing keys", () => {
    // A Full key (level 4) with a stale blob keeps working everywhere.
    const c = normalizeCapabilitiesWithFallback(STALE_BLOB, 4);
    expect(c).not.toBeNull();
    expect(c!.canReadUserCooldowns).toBe(true);
    expect(c!.canReadUserEducation).toBe(true);
    expect(c!.canReadUserTravel).toBe(true);
    expect(c!.canReadUserEvents).toBe(true);
    expect(c!.canReadUserPersonalStats).toBe(true);
    // Faction keys are never invented from the level alone (conservative);
    // the worker's re-detection fills them from /key/info.
    expect(c!.canReadFactionChains).toBe(false);
    // Explicit booleans stay authoritative even on a stale blob.
    expect(c!.canReadFactionLogs).toBe(false);
    expect(resourceAllowed(c, "events")).toBe(true);
  });

  it("a Limited key's stale blob does not gain Full-only powers", () => {
    const c = normalizeCapabilitiesWithFallback(STALE_BLOB, 3);
    // Level fallback cannot grant anything above the level either — but the
    // explicit stored booleans (which a Limited key would not have) win:
    // they are what the previous model detected.
    expect(c!.canReadUserLogs).toBe(true); // explicit from detection
    expect(c!.canReadFactionChains).toBe(false); // missing + level 3
  });
});

describe("compareCapabilities (upgrade/downgrade detection)", () => {
  it("detects newly unavailable capabilities on downgrade", () => {
    const change = compareCapabilities(caps({ canReadUserLogs: true, canReadUserAttacks: true }), caps({ canReadUserAttacks: true }));
    expect(change.newlyUnavailable).toContain("canReadUserLogs");
    expect(change.newlyAvailable).toHaveLength(0);
  });

  it("detects newly available capabilities on upgrade", () => {
    const change = compareCapabilities(caps({}), caps({ canReadFactionBasic: true }));
    expect(change.newlyAvailable).toContain("canReadFactionBasic");
    expect(change.newlyUnavailable).toHaveLength(0);
  });

  it("never claims changes against an unknown previous key", () => {
    const change = compareCapabilities(null, caps({}));
    expect(change.newlyAvailable).toHaveLength(0);
    expect(change.newlyUnavailable).toHaveLength(0);
  });
});

describe("featureAvailability (permission vs source vs stale)", () => {
  const logsKey = caps({ canReadUserBasic: true, canReadUserLogs: true });
  const limitedKey = caps({ canReadUserBasic: true, canReadUserBars: true });

  it("missing permission + no stored data -> unavailable_permission", () => {
    const av = featureAvailability(limitedKey, "travel_history", { hasStoredData: false });
    expect(av.state).toBe("unavailable_permission");
    expect(av.requiresLabel).toMatch(/user logs/i);
    expect(av.hasHistoricalData).toBe(false);
  });

  it("missing permission + stored data -> stale_permission with history preserved", () => {
    const av = featureAvailability(limitedKey, "travel_history", { hasStoredData: true, lastSuccessAt: 1000 });
    expect(av.state).toBe("stale_permission");
    expect(av.hasHistoricalData).toBe(true);
    expect(av.lastRefreshedAt).toBe(1000);
  });

  it("permission ok + no stored data -> unavailable_source (honest empty, not permission)", () => {
    const av = featureAvailability(logsKey, "drugs_history", { hasStoredData: false });
    expect(av.state).toBe("unavailable_source");
    expect(av.requiresLabel).toBeNull();
  });

  it("permission ok + data -> available", () => {
    const av = featureAvailability(logsKey, "money_cash_flow", { hasStoredData: true });
    expect(av.state).toBe("available_live");
  });

  it("partial features stay partial when only the optional capability is missing", () => {
    const av = featureAvailability(logsKey, "drugs_xanax_provenance", { hasStoredData: true });
    expect(av.state).toBe("partial");
    expect(av.requiresLabel).toMatch(/armory news/i);
  });

  it("null capabilities block permission-gated features", () => {
    const av = featureAvailability(null, "combat_history", { hasStoredData: true });
    expect(av.state).toBe("stale_permission");
  });
});

describe("resource gating (worker + manual sync)", () => {
  it("public catalog is always allowed", () => {
    expect(resourceAllowed(null, "torn_catalog")).toBe(true);
    expect(resourceRequirementLabel("torn_catalog")).toMatch(/public/i);
  });

  it("log resources need User Logs", () => {
    expect(resourceAllowed(caps({ canReadUserLogs: true }), "drugs")).toBe(true);
    expect(resourceAllowed(caps({ canReadUserLogs: true }), "money_logs")).toBe(true);
    expect(resourceAllowed(caps({ canReadUserBasic: true }), "travel")).toBe(false);
    expect(resourceRequirementLabel("travel")).toMatch(/user logs/i);
  });

  it("faction resources need their own faction capabilities", () => {
    expect(resourceAllowed(caps({ canReadUserLogs: true, canReadUserAttacks: true }), "ranked_wars")).toBe(false);
    expect(resourceAllowed(caps({ canReadFactionRankedWars: true }), "ranked_wars")).toBe(true);
    expect(resourceAllowed(caps({ canReadFactionCrimes: true }), "organized_crimes")).toBe(true);
    expect(resourceAllowed(caps({ canReadFactionBasic: true }), "chains")).toBe(false);
  });
});

describe("friendly summaries stay honest", () => {
  it("a Full key reads as full access; limited keys never claim Full", () => {
    expect(capabilityLevel(deriveKeyCapabilities(FULL_SELECTIONS, 4))).toMatch(/Full/i);
    expect(capabilityLevel(caps({ canReadUserBasic: true }))).toMatch(/Basic/i);
  });

  it("moduleAvailability explains without fabricating", () => {
    const modules = moduleAvailability(caps({ canReadUserBasic: true, canReadUserBars: true }));
    const travel = modules.find((m) => m.module === "travel")!;
    expect(travel.available).toBe(false);
    expect(travel.reason).toMatch(/user logs/i);
    const combat = modules.find((m) => m.module === "combat")!;
    expect(combat.reason).toMatch(/user attacks/i);
  });
});
