import { describe, expect, it } from "vitest";
import {
  UserBarsSchema,
  UserCooldownsSchema,
  UserEducationSchema,
  UserMoneySchema,
  UserProfileSchema,
  UserTravelSchema,
  TornEducationCategorySchema,
} from "../src/index.js";
import fixtures from "./fixtures/today-selections.json";

/**
 * The Today feature consumes these selections; the fixtures are sanitized
 * payloads shaped per the official OpenAPI spec (6.13.1). These tests pin the
 * parsing contract: if Torn changes a shape we rely on, they fail loudly.
 */
describe("today selection schemas", () => {
  it("parses user bars with full_time and regen fields", () => {
    const parsed = UserBarsSchema.parse(fixtures.bars);
    expect(parsed.bars.energy.current).toBe(120);
    expect(parsed.bars.energy.full_time).toBeGreaterThan(0);
    expect(parsed.bars.life.maximum).toBe(4150);
  });

  it("parses paused bars (full_time = 0)", () => {
    const parsed = UserBarsSchema.parse(fixtures.bars_paused);
    expect(parsed.bars.energy.full_time).toBe(0);
    expect(parsed.bars.nerve.current).toBe(parsed.bars.nerve.maximum);
  });

  it("parses cooldowns as seconds remaining", () => {
    const parsed = UserCooldownsSchema.parse(fixtures.cooldowns);
    expect(parsed.cooldowns.drug).toBe(2531);
    expect(parsed.cooldowns.medical).toBe(0);
  });

  it("parses education state including a null current course", () => {
    const active = UserEducationSchema.parse(fixtures.education);
    expect(active.education.current?.id).toBe(74);
    expect(active.education.complete).toContain(27);

    const none = UserEducationSchema.parse(fixtures.education_none);
    expect(none.education.current).toBeNull();
  });

  it("parses travel states", () => {
    expect(UserTravelSchema.parse(fixtures.travel_home).travel.destination).toBe("Torn");
    expect(UserTravelSchema.parse(fixtures.travel_abroad).travel.destination).toBe("Argentina");
    const flying = UserTravelSchema.parse(fixtures.travel_flying);
    expect(flying.travel.time_left).toBe(5100);
  });

  it("parses money with and without a city bank investment", () => {
    const invested = UserMoneySchema.parse(fixtures.money);
    expect(invested.money.city_bank?.amount).toBe(450_000_000);
    expect(invested.money.city_bank?.interest_rate).toBeCloseTo(8.03);

    const empty = UserMoneySchema.parse(fixtures.money_no_investment);
    expect(empty.money.city_bank).toBeNull();
  });

  it("parses player status blocks", () => {
    expect(UserProfileSchema.parse(fixtures.profile).profile.status?.state).toBe("Okay");
    expect(UserProfileSchema.parse(fixtures.profile_hospital).profile.status?.state).toBe("Hospital");
    expect(UserProfileSchema.parse(fixtures.profile_jail).profile.status?.state).toBe("Jail");
    expect(UserProfileSchema.parse(fixtures.profile_traveling).profile.status?.state).toBe("Traveling");
  });

  it("parses the education catalog (course id -> name resolution)", () => {
    const [category] = fixtures.education_catalog.education;
    const parsed = TornEducationCategorySchema.parse(category);
    expect(parsed.name).toBe("Bachelor of Psychology");
    expect(parsed.courses.find((c) => c.id === 74)?.name).toBe("Cognitive Psychology");
  });
});
