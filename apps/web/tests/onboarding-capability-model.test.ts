import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FEATURE_REQUIREMENTS,
  LIMITED_PRESET,
  FULL_PRESET,
  featureConsequenceMatrix,
  capabilitySetName,
  unrecoverableWhileSkipping,
  RESOURCE_RECOVERABILITY,
  RECOVERABILITY_COPY,
} from "@tornscope/shared";

/**
 * Roadmap #4 regression coverage: the Limited-vs-Full consequence matrix,
 * the custom-key detection and the historical-recoverability model that the
 * onboarding flow renders. These pin the SHARED model (not the markup) so
 * the onboarding copy can never silently drift from what the app enforces.
 */
describe("onboarding capability model (roadmap #4)", () => {
  const matrix = featureConsequenceMatrix();

  it("covers every feature requirement exactly once", () => {
    expect(matrix.length).toBe(FEATURE_REQUIREMENTS.length);
    expect(new Set(matrix.map((r) => r.feature)).size).toBe(FEATURE_REQUIREMENTS.length);
  });

  it("the privacy-first Limited preset keeps live state, combat and net worth", () => {
    const byLabel = new Map(matrix.map((r) => [r.label, r]));
    expect(byLabel.get("Current stats")!.limited).toBe("enabled");
    expect(byLabel.get("Live bars")!.limited).toBe("enabled");
    expect(byLabel.get("Cooldowns")!.limited).toBe("enabled");
    expect(byLabel.get("Net worth history")!.limited).toBe("enabled");
    expect(byLabel.get("Combat history")!.limited).toBe("enabled");
  });

  it("the Limited preset honestly marks every User-Logs history as unavailable", () => {
    const logsFeatures = FEATURE_REQUIREMENTS.filter((f) => f.requires.includes("canReadUserLogs")).map((f) => f.feature);
    expect(logsFeatures.length).toBeGreaterThan(5);
    for (const row of matrix.filter((r) => logsFeatures.includes(r.feature))) {
      expect(row.limited).toBe("unavailable");
      expect(row.limitedMissing).toBe("User Logs");
    }
  });

  it("the Full preset enables or fully-partially covers every user-key feature", () => {
    for (const row of matrix.filter((r) => !r.factionSelection)) {
      expect(row.full === "enabled" || row.full === "partial").toBe(true);
      expect(row.full).not.toBe("unavailable");
    }
    // The only partials under Full are features enriched by separate faction
    // selections (e.g. Xanax provenance via armory news).
    for (const row of matrix.filter((r) => r.full === "partial")) {
      expect(row.factionSelection).toBe(false);
    }
  });

  it("faction features require separate faction selections in BOTH presets", () => {
    const factionRows = matrix.filter((r) => r.factionSelection);
    expect(factionRows.length).toBeGreaterThanOrEqual(6);
    for (const row of factionRows) {
      expect(row.limited).toBe("unavailable");
      expect(row.full).toBe("unavailable");
    }
  });

  describe("capabilitySetName", () => {
    it("recognizes both presets", () => {
      expect(capabilitySetName(FULL_PRESET)).toBe("Full");
      expect(capabilitySetName(LIMITED_PRESET)).toBe("Limited");
    });

    it("labels anything else Custom — ignoring faction selections", () => {
      expect(capabilitySetName({ ...FULL_PRESET, canReadUserLogs: false })).toBe("Custom");
      expect(capabilitySetName({ ...LIMITED_PRESET, canReadUserMoney: true })).toBe("Custom");
      // Faction selections never change the user-key preset name.
      expect(capabilitySetName({ ...FULL_PRESET, canReadFactionLogs: true })).toBe("Full");
      expect(capabilitySetName(null)).toBe("Custom");
    });
  });

  describe("historical recoverability", () => {
    it("classifies log history as a limited-time window", () => {
      for (const resource of ["money_logs", "drugs", "travel", "rehab", "events", "attacks"] as const) {
        expect(RESOURCE_RECOVERABILITY[resource]).toBe("window");
      }
    });

    it("is honest that accrued histories start at sync time and live state is always collectable", () => {
      expect(RESOURCE_RECOVERABILITY.networth).toBe("from_start");
      expect(RESOURCE_RECOVERABILITY.personal_stats).toBe("from_start");
      expect(RESOURCE_RECOVERABILITY.profile).toBe("current");
      expect(RESOURCE_RECOVERABILITY.torn_catalog).toBe("source");
    });

    it("every class has copy — the warning can never render a bare code", () => {
      for (const copy of Object.values(RECOVERABILITY_COPY)) {
        expect(copy.length).toBeGreaterThan(20);
      }
    });

    it("the Limited preset skips the four log-window resources but NOT net worth", () => {
      const skippedLabels = unrecoverableWhileSkipping(LIMITED_PRESET);
      const windowLabels = skippedLabels.filter((r) => r.recoverability === "window").map((r) => r.label);
      // money_logs, drugs, travel, rehab — everything gated behind User Logs.
      expect(windowLabels.sort()).toEqual(["Drug history", "Economy & money logs", "Flight & travel history", "Rehab history"].sort());
      // Net worth is in the privacy-first preset: accrued, never skipped.
      expect(skippedLabels.some((r) => r.label.includes("Net worth"))).toBe(false);
    });
  });
});

/**
 * Source-level contracts: the welcome flow must SHOW the matrix, the
 * historical-loss warning and the recovery disclosure before confirmation,
 * and the initial-sync summary must speak in stages, never percentages.
 */
describe("onboarding flow renders the capability model (roadmap #4)", () => {
  const welcome = readFileSync(fileURLToPath(new URL("../src/routes/welcome/+page.svelte", import.meta.url)), "utf8");
  const settings = readFileSync(fileURLToPath(new URL("../src/routes/settings/+page.svelte", import.meta.url)), "utf8");

  it("step 1 shows the feature consequence matrix before any key is entered", () => {
    expect(welcome).toContain("featureConsequenceMatrix");
    expect(welcome).toContain("Feature-by-feature: what Limited vs Full enables");
  });

  it("the historical-loss warning appears before confirmation, with a recovery disclosure", () => {
    expect(welcome).toContain("Some Torn history is only available for a limited time");
    expect(welcome).toContain("What can be recovered later?");
    expect(welcome).toContain("RECOVERABILITY_COPY");
    // The upgrade promise must stay honest: new areas start collecting, no
    // guarantee of a full backfill.
    expect(welcome).toContain("does <span class=\"font-medium text-fg\">not</span> guarantee a full backfill");
  });

  it("step 2 names custom capability sets and warns per skipped resource", () => {
    expect(welcome).toContain("capabilitySetName");
    expect(welcome).toContain("Custom capability set");
    expect(welcome).toContain("skippedResources");
    expect(welcome).toContain("unrecoverableWhileSkipping");
  });

  it("initial sync reports staged progress and progressive readiness", () => {
    expect(welcome).toContain("resources ready");
    expect(welcome).toContain("skipped (permission)");
    expect(welcome).toContain("some history is still importing in the background");
    // Never an invented percentage.
    expect(welcome).not.toMatch(/%\s*complete|progress\s*%/i);
  });

  it("validation errors are mapped to honest states", () => {
    expect(welcome).toContain("validationErrorMessage");
    expect(welcome).toContain("Torn's API isn't answering right now");
    expect(welcome).toContain("Too many attempts");
    expect(welcome).toContain("Could not reach the TornScope server");
  });

  it("Settings shows the capability mode, at-a-glance counts and per-feature reasons", () => {
    expect(settings).toContain("capabilitySetName");
    expect(settings).toContain("Custom capability set");
    expect(settings).toContain("matrixCounts");
    expect(settings).toContain("Missing ");
  });
});
