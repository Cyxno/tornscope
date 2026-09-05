import { describe, expect, it } from "vitest";
import {
  assembleBank,
  assembleBars,
  assembleCooldowns,
  assembleEducation,
  assembleTravel,
  buildDemoToday,
  clearEducationCatalogCache,
  collectUpcoming,
  extractNotice,
  normalizeTornTimestamp,
  toPlayerStatus,
} from "../src/services/today.js";
import { buildUpcomingEvents } from "@tornscope/shared";
import type { TornEducationCategory, TornUserProfile } from "@tornscope/torn-api";
import fixtures from "../../../packages/torn-api/tests/fixtures/today-selections.json";

/* -------------------------------------------------------------------------- */
/* Fixtures (sanitized, spec-shaped)                                          */
/* -------------------------------------------------------------------------- */

const now = 1_792_000_000;

const profileFixture = fixtures.profile as unknown as TornUserProfile;
const hospitalFixture = fixtures.profile_hospital as unknown as TornUserProfile;
const jailFixture = fixtures.profile_jail as unknown as TornUserProfile;
const travelingFixture = fixtures.profile_traveling as unknown as TornUserProfile;

/* -------------------------------------------------------------------------- */
/* Bars                                                                       */
/* -------------------------------------------------------------------------- */

describe("today service: bars", () => {
  it("assembles all four bars from the Torn payload", () => {
    const bars = assembleBars(now, fixtures.bars as never);
    expect(bars.energy.current).toBe(120);
    expect(bars.happy.remainingSeconds).toBe(fixtures.bars.bars.happy.full_time - now);
    expect(bars.life.percent).toBeCloseTo(94.5, 1);
  });

  it("handles the paused fixture (regen paused, no fake full time)", () => {
    const bars = assembleBars(now, fixtures.bars_paused as never);
    expect(bars.energy.regenState).toBe("paused");
    expect(bars.energy.remainingSeconds).toBeNull();
    expect(bars.nerve.regenState).toBe("full");
  });
});

/* -------------------------------------------------------------------------- */
/* Cooldowns                                                                  */
/* -------------------------------------------------------------------------- */

describe("today service: cooldowns", () => {
  it("maps active and ready states with absolute timestamps", () => {
    const cds = assembleCooldowns(now, fixtures.cooldowns as never);
    expect(cds.drug.state).toBe("active");
    expect(cds.drug.endsAt).toBe(now + 2531);
    expect(cds.medical.state).toBe("ready");
    expect(cds.booster.remainingSeconds).toBe(8048);
  });
});

/* -------------------------------------------------------------------------- */
/* Timestamp normalization                                                    */
/* -------------------------------------------------------------------------- */

describe("today service: normalizeTornTimestamp", () => {
  it("treats values >= 4e9 as milliseconds", () => {
    expect(normalizeTornTimestamp(1_792_005_100_000, now)).toBe(1_792_005_100);
  });

  it("treats values >= 1e9 as unix seconds", () => {
    expect(normalizeTornTimestamp(1_792_005_100, now)).toBe(1_792_005_100);
  });

  it("treats small values as seconds remaining", () => {
    expect(normalizeTornTimestamp(3600, now)).toBe(now + 3600);
  });
});

/* -------------------------------------------------------------------------- */
/* Education                                                                  */
/* -------------------------------------------------------------------------- */

describe("today service: education", () => {
  const catalog = (fixtures.education_catalog as { education: TornEducationCategory[] }).education;
  const catalogEndpoint = { tornEducationCatalog: async () => catalog };

  it("resolves the course name and remaining time", async () => {
    const edu = await assembleEducation(now, fixtures.education as never, catalogEndpoint);
    expect(edu.state).toBe("active");
    expect(edu.courseName).toBe("Cognitive Psychology");
    expect(edu.categoryName).toBe("Bachelor of Psychology");
    expect(edu.remainingSeconds).toBe(294_800);
  });

  it("reports complete when the end time has passed", async () => {
    const edu = await assembleEducation(now + 300_000, fixtures.education as never, catalogEndpoint);
    expect(edu.state).toBe("complete");
  });

  it("reports none when no course is active", async () => {
    const edu = await assembleEducation(now, fixtures.education_none as never, catalogEndpoint);
    expect(edu.state).toBe("none");
    expect(edu.completesAt).toBeNull();
  });

  it("still works when the catalog endpoint fails (name null, timer intact)", async () => {
    clearEducationCatalogCache();
    const broken = { tornEducationCatalog: async () => { throw new Error("boom"); } };
    const edu = await assembleEducation(now, fixtures.education as never, broken);
    expect(edu.courseName).toBeNull();
    expect(edu.completesAt).toBe(fixtures.education.education.current.until);
    clearEducationCatalogCache();
  });
});

/* -------------------------------------------------------------------------- */
/* Travel                                                                     */
/* -------------------------------------------------------------------------- */

describe("today service: travel", () => {
  const openTrip = { destination: "Argentina", departedAt: new Date((now - 400) * 1000) };

  it("reports home when the player is in Torn", () => {
    const travel = assembleTravel(now, profileFixture, fixtures.travel_home as never, null, null);
    expect(travel.state).toBe("home");
    expect(travel.landsAt).toBeNull();
  });

  it("reports abroad with the country", () => {
    const abroadProfile = {
      profile: { ...profileFixture.profile, status: { description: "Abroad", details: null, state: "Abroad", until: null } },
    } as never;
    const travel = assembleTravel(now, abroadProfile, fixtures.travel_abroad as never, null, null);
    expect(travel.state).toBe("abroad");
    expect(travel.country).toBe("Argentina");
  });

  it("derives outbound flights and the landing timer", () => {
    const outboundProfile = { ...travelingFixture } as TornUserProfile;
    const travel = assembleTravel(now, outboundProfile, { travel: { destination: "Argentina", method: "Airliner", departed_at: now - 300, arrival_at: now + 5100, time_left: 5400 } } as never, null, null);
    expect(travel.state).toBe("traveling");
    expect(travel.direction).toBe("outbound");
    expect(travel.country).toBe("Argentina");
    expect(travel.landsAt).toBe(now + 5100);
    expect(travel.remainingSeconds).toBe(5100);
  });

  it("uses the open historical trip as origin when flying home (no duplicate events)", () => {
    const travel = assembleTravel(now, travelingFixture, fixtures.travel_flying as never, null, openTrip);
    expect(travel.direction).toBe("returning");
    expect(travel.country).toBe("Argentina"); // from history, not the Torn payload
    expect(travel.landsAt).toBe(travelingFixture.profile.status?.until ?? null);
    expect(travel.remainingSeconds).toBeGreaterThan(0);
  });

  it("degrades to unavailable without failing when the selection is denied", () => {
    const travel = assembleTravel(now, profileFixture, null, { kind: "access_denied", message: null, requiredAccess: null }, null);
    expect(travel.state).toBe("unavailable");
    expect(travel.requiredAccess).toBe("Minimal");
  });
});

/* -------------------------------------------------------------------------- */
/* Bank                                                                       */
/* -------------------------------------------------------------------------- */

describe("today service: bank", () => {
  it("assembles an active investment with maturity timer (no invented interest)", () => {
    const bank = assembleBank(now, fixtures.money as never);
    expect(bank.state).toBe("active");
    expect(bank.amount).toBe(450000000);
    expect(bank.maturesAt).toBe(1_793_132_400);
    expect(bank.remainingSeconds).toBe(1_132_400);
    expect(bank.profit).toBe(36112500); // exact value provided by Torn
  });

  it("flips to mature once the end time passes", () => {
    const bank = assembleBank(now + 120_000, fixtures.money as never);
    expect(bank.state).toBe("active");
    const later = assembleBank(1_793_132_400, fixtures.money as never);
    expect(later.state).toBe("mature");
  });

  it("reports none when nothing is invested", () => {
    const bank = assembleBank(now, fixtures.money_no_investment as never);
    expect(bank.state).toBe("none");
  });
});

/* -------------------------------------------------------------------------- */
/* Hospital / jail priority                                                   */
/* -------------------------------------------------------------------------- */

describe("today service: notices", () => {
  it("extracts a hospital notice with release countdown", () => {
    const status = toPlayerStatus(hospitalFixture);
    const notice = extractNotice(now, status, "hospital");
    expect(notice).not.toBeNull();
    expect(notice?.releasedAt).toBe(1_792_001_122);
    expect(notice?.remainingSeconds).toBe(1122);
    expect(extractNotice(now, status, "jail")).toBeNull();
  });

  it("extracts a jail notice (including Federal)", () => {
    const status = toPlayerStatus(jailFixture);
    expect(extractNotice(now, status, "jail")?.remainingSeconds).toBe(1977);
    const federal = toPlayerStatus({
      profile: { ...jailFixture.profile, status: { description: "Federal", details: null, state: "Federal", until: 1792001977 } },
    } as never);
    expect(extractNotice(now, federal, "jail")).not.toBeNull();
  });

  it("returns no notices for an Okay player", () => {
    const status = toPlayerStatus(profileFixture);
    expect(extractNotice(now, status, "hospital")).toBeNull();
    expect(extractNotice(now, status, "jail")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Upcoming                                                                   */
/* -------------------------------------------------------------------------- */

describe("today service: upcoming", () => {
  it("merges all timers chronologically with priorities", () => {
    const bars = assembleBars(now, fixtures.bars as never);
    const cds = assembleCooldowns(now, fixtures.cooldowns as never);
    const education = {
      state: "active" as const,
      courseId: 74,
      courseName: "Cognitive Psychology",
      categoryName: null,
      completesAt: now + 294_800,
      remainingSeconds: 294_800,
      provenance: "exact" as const,
      unavailableReason: null,
      requiredAccess: null,
    };
    const bank = assembleBank(now, fixtures.money as never);
    const hospital = extractNotice(now, toPlayerStatus(hospitalFixture), "hospital");
    const jail = extractNotice(now, toPlayerStatus(jailFixture), "jail");
    const travel = assembleTravel(now, travelingFixture, fixtures.travel_flying as never, null, { destination: "Argentina", departedAt: new Date((now - 400) * 1000) });

    const upcoming = buildUpcomingEvents(collectUpcoming(now, { bars, cooldowns: cds, travel, education, bank, hospital, jail }));

    const ids = upcoming.map((u) => u.id);
    expect(ids).toContain("bar:happy");
    expect(ids).toContain("bar:energy");
    expect(ids).toContain("cooldown:drug");
    expect(ids).toContain("cooldown:booster");
    expect(ids).toContain("travel:landing");
    expect(ids).toContain("education:complete");
    expect(ids).toContain("bank:mature");
    // medical is ready -> no entry
    expect(ids).not.toContain("cooldown:medical");

    // Hospital (18m) must sort before the ready-at of drug (42m).
    expect(ids.indexOf("status:hospital")).toBeLessThan(ids.indexOf("cooldown:drug"));

    // Chronological ordering overall.
    const ats = upcoming.map((u) => u.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);

    // Hospital/jail are the critical entries.
    expect(upcoming.find((u) => u.id === "status:hospital")?.severity).toBe("critical");
    expect(upcoming.find((u) => u.id === "status:jail")?.severity).toBe("critical");
  });

  it("omits bar entries when a bar is full or paused", () => {
    const bars = assembleBars(now, fixtures.bars_paused as never);
    const events = collectUpcoming(now, {
      bars,
      cooldowns: null,
      travel: assembleTravel(now, profileFixture, fixtures.travel_home as never, null, null),
      education: { state: "none", courseId: null, courseName: null, categoryName: null, completesAt: null, remainingSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
      bank: { state: "none", amount: null, profit: null, interestRate: null, durationDays: null, investedAt: null, maturesAt: null, remainingSeconds: null, provenance: "exact", unavailableReason: null, requiredAccess: null },
      hospital: null,
      jail: null,
    });
    expect(events.filter((e) => e.category === "bar")).toHaveLength(1); // happy only
    expect(events).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Demo live data                                                             */
/* -------------------------------------------------------------------------- */

describe("today service: demo mode", () => {
  it("produces deterministic simulated live data (same clock -> same payload)", () => {
    const now = 1_792_000_000_000;
    const a = buildDemoToday(now);
    const b = buildDemoToday(now);
    expect(a).toEqual(b);
  });

  it("marks the payload as demo and fills every section", () => {
    const t = buildDemoToday();
    expect(t.demo).toBe(true);
    expect(t.player.name).toBe("DEMO_Player");
    expect(t.bars.energy).not.toBeNull();
    expect(t.bars.life).not.toBeNull();
    expect(t.cooldowns.drug).not.toBeNull();
    expect(t.cooldowns.medical?.state).toBe("ready");
    expect(t.travel.state).not.toBe("unavailable");
    expect(t.education.state).toBe("active");
    expect(t.bank.state).toBe("active");
    expect(t.hospital).toBeNull();
    expect(t.upcoming.length).toBeGreaterThan(0);
    // Simulation, never presented as exact Torn data:
    expect(t.bars.energy?.provenance).toBe("estimated");
  });
});
