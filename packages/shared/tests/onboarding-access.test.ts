import { describe, expect, it } from "vitest";
import { resourceAllowed, summarizeKeyAccess } from "../src/capabilities.js";
import { accessLevelName } from "../src/today.js";
import { OC_PARTICIPATION_LABELS, ocParticipationState } from "../src/oc.js";
import type { KeyCapabilities } from "../src/torn.js";

/** A Full Access key blob (all selections). */
const FULL_CAPS: KeyCapabilities = {
  canReadUserBasic: true, canReadUserBars: true, canReadUserCooldowns: true, canReadUserEducation: true,
  canReadUserTravel: true, canReadUserMoney: true, canReadUserLogs: true, canReadUserAttacks: true,
  canReadUserNetworth: true, canReadUserEvents: true, canReadUserPersonalStats: true,
  canReadFactionBasic: true, canReadFactionMembers: true, canReadFactionRankedWars: true,
  canReadFactionChains: true, canReadFactionCrimes: true, canReadFactionArmoryNews: true,
  canReadFactionBalance: true, canReadFactionLogs: true,
};

/** A Limited key: live stats + basics, no logs/events, no faction. */
const LIMITED_CAPS: KeyCapabilities = {
  canReadUserBasic: true, canReadUserBars: true, canReadUserCooldowns: true, canReadUserEducation: true,
  canReadUserTravel: true, canReadUserMoney: false, canReadUserLogs: false, canReadUserAttacks: false,
  canReadUserNetworth: false, canReadUserEvents: false, canReadUserPersonalStats: true,
  canReadFactionBasic: false, canReadFactionMembers: false, canReadFactionRankedWars: false,
  canReadFactionChains: false, canReadFactionCrimes: false, canReadFactionArmoryNews: false,
  canReadFactionBalance: false, canReadFactionLogs: false,
};

describe("summarizeKeyAccess (first-run access detection)", () => {
  it("detects and names a Limited key without treating it as an error", () => {
    const s = summarizeKeyAccess(LIMITED_CAPS, 3, "Limited Access");
    expect(s.levelName).toBe("Limited");
    expect(s.level).toBe(3);
    expect(s.available).toContain("Basic profile data");
    expect(s.available).toContain("Live stats");
    // Unavailable resources carry the missing permission, not a failure.
    const unavailableLabels = s.unavailable.map((u) => u.label);
    expect(unavailableLabels).toContain("Drug history");
    expect(unavailableLabels).toContain("Economy & money logs");
    expect(unavailableLabels).toContain("Flight & travel history");
    expect(s.unavailable.find((u) => u.label === "Drug history")?.reason).toContain("Logs");
  });

  it("tells the user a limited key is fully usable", () => {
    const s = summarizeKeyAccess(LIMITED_CAPS, 3, "Limited Access");
    expect(s.note).toContain("You can continue with this key");
    expect(s.note).not.toMatch(/required/i);
  });

  it("describes Full access as unlocking complete analytics — never as mandatory", () => {
    const s = summarizeKeyAccess(FULL_CAPS, 4, "Full Access");
    expect(s.levelName).toBe("Full");
    expect(s.unavailable).toHaveLength(0);
    expect(s.note).toContain("Full Access unlocks");
  });

  it("every synced resource is classified exactly once", () => {
    for (const caps of [FULL_CAPS, LIMITED_CAPS]) {
      const s = summarizeKeyAccess(caps, 3, "Limited Access");
      expect(s.available.length + s.unavailable.length).toBe(15);
    }
  });

  it("gates logs-only resources off for limited keys", () => {
    expect(resourceAllowed(LIMITED_CAPS, "drugs")).toBe(false);
    expect(resourceAllowed(LIMITED_CAPS, "money_logs")).toBe(false);
    expect(resourceAllowed(LIMITED_CAPS, "profile")).toBe(true);
    expect(resourceAllowed(FULL_CAPS, "organized_crimes")).toBe(true);
  });

  it("accessLevelName maps Torn levels to friendly names", () => {
    expect(accessLevelName(4)).toBe("Full");
    expect(accessLevelName(3)).toBe("Limited");
    expect(accessLevelName(null)).toBe("unknown");
  });
});

describe("ocParticipationState (three explicit states, never blank)", () => {
  it("positively identifies participation by Torn ID", () => {
    expect(ocParticipationState({ myParticipation: true, participantsIdentifiable: true })).toBe("participating");
    expect(OC_PARTICIPATION_LABELS.participating).toBe("You are participating");
  });

  it("reports not participating only when the participant list is available and the ID is absent", () => {
    expect(ocParticipationState({ myParticipation: false, participantsIdentifiable: true })).toBe("not_participating");
    expect(OC_PARTICIPATION_LABELS.not_participating).toBe("Not participating");
  });

  it("reports unavailable when the payload cannot answer — never a blank or a guess", () => {
    expect(ocParticipationState({ myParticipation: false, participantsIdentifiable: false })).toBe("unavailable");
    expect(OC_PARTICIPATION_LABELS.unavailable).toBe("Participation unavailable");
  });
});
