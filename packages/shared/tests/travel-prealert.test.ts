import { describe, expect, it } from "vitest";
import { travelLandingPreAlert, type LiveTimerState } from "../src/notifications";

const MIN = 60;

const NOW = 1_750_000_000;

function timers(landsInSec: number | null): LiveTimerState {
  return {
    travelLandsAt: landsInSec === null ? null : NOW + landsInSec,
    cooldownDrugEndsAt: null,
    cooldownMedicalEndsAt: null,
    cooldownBoosterEndsAt: null,
    hospitalizedUntil: null,
    jailedUntil: null,
    educationEndsAt: null,
    bankMaturesAt: null,
    energyFullAt: null,
    nerveFullAt: null,
  };
}

describe("travelLandingPreAlert (push heads-up)", () => {
  it("fires once inside the threshold window with a deterministic key", () => {
    const e = travelLandingPreAlert(timers(90), NOW, 2);
    expect(e).not.toBeNull();
    expect(e!.type).toBe("travel_landing_soon");
    expect(e!.eventKey).toBe(`travelLandsAt:pre:${NOW + 90}:2`);
    expect(e!.body).toContain("2 minutes");
  });

  it("does not fire before the threshold window opens", () => {
    expect(travelLandingPreAlert(timers(5 * MIN), NOW, 2)).toBeNull();
  });

  it("threshold 0 disables the pre-alert (at-landing transition still exists elsewhere)", () => {
    expect(travelLandingPreAlert(timers(30), NOW, 0)).toBeNull();
  });

  it("never fires after the landing (the at-transition owns that moment)", () => {
    expect(travelLandingPreAlert(timers(-30), NOW, 2)).toBeNull();
    expect(travelLandingPreAlert(timers(null), NOW, 2)).toBeNull();
  });

  it("singular wording for a 1-minute threshold", () => {
    const e = travelLandingPreAlert(timers(45), NOW, 1);
    expect(e!.body).toBe("Your flight lands in about 1 minute.");
  });
});

