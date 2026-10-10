import { describe, expect, it } from "vitest";
import { buildAccountEffects, parseEducationEffect } from "../src/account-effects.js";
import type { MeritEffect } from "../src/merits.js";
import { buildEducationProgress, type EducationCatalogCategory } from "../src/education.js";

/**
 * 2.8.4 — Account effects: combined active bonuses over the two PROVEN
 * sources (merit ranks — exact; completed education courses — catalog text
 * with literally stated values). Policy pinned here: no double counting
 * across sources, unknown text stays unknown, future course rewards are
 * never active, percent/flat/special semantics stay separated.
 */

function merit(partial: Partial<MeritEffect> & { id: number; label: string }): MeritEffect {
  return {
    unit: "percent",
    perLevel: 1,
    level: 1,
    total: 1,
    direction: "increase",
    group: "Test",
    appliesTo: "test target",
    ...partial,
  };
}

describe("account effects — sources", () => {
  it("merit-only: every owned merit row carries sources ['merits'] and provenance exact", () => {
    const { effects, unknownEducationEffects } = buildAccountEffects(
      [merit({ id: 7, label: "Bank Interest", total: 50, perLevel: 5, level: 10, appliesTo: "bank interest" })],
      null
    );
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      label: "Bank Interest",
      sources: ["merits"],
      provenance: "exact",
      merit: { total: 50, unit: "percent" },
      education: null,
    });
    expect(unknownEducationEffects).toEqual([]);
  });

  it("education-only: stated catalog values become catalog-provenance rows", () => {
    const { effects } = buildAccountEffects(null, ["Gain a 1% damage bonus to all weapons"]);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      sources: ["education"],
      provenance: "catalog",
      merit: null,
      education: { unit: "percent", total: 1, courses: 1 },
    });
    expect(effects[0]!.merit).toBeNull();
  });

  it("combined: same family from both sources becomes ONE row with both sources — never summed", () => {
    // Merit Crime XP: 9 ranks × 3% = 27%; course text states +2% crime XP.
    const { effects } = buildAccountEffects(
      [merit({ id: 14, label: "Crime XP", total: 27, perLevel: 3, level: 9, group: "Crime", appliesTo: "crime XP gain" })],
      ["+2% crime XP"]
    );
    expect(effects).toHaveLength(1);
    const row = effects[0]!;
    expect(row.sources).toEqual(["merits", "education"]);
    expect(row.merit?.total).toBe(27);
    expect(row.education?.total).toBe(2);
    // The two contributions stay separate — no cross-source addition.
    expect(row.key).toBe(row.key);
  });

  it("no false merge: sources with different semantics stay separate rows", () => {
    const { effects } = buildAccountEffects(
      [merit({ id: 12, label: "Protection", total: 30, perLevel: 3, level: 10, group: "Battlestats", appliesTo: "defense" })],
      ["Gain a 1% damage bonus to all weapons"]
    );
    expect(effects).toHaveLength(2);
    expect(effects.every((e) => e.sources.length === 1)).toBe(true);
    expect(effects.filter((e) => e.sources.includes("merits"))[0]!.merit?.total).toBe(30);
    expect(effects.filter((e) => e.sources.includes("education"))[0]!.education?.total).toBe(1);
  });
});

describe("account effects — duplicates & unknowns", () => {
  it("duplicate merit input never double counts", () => {
    const same = merit({ id: 7, label: "Bank Interest", total: 50, perLevel: 5, level: 10, appliesTo: "bank interest" });
    const { effects } = buildAccountEffects([same, { ...same }], null);
    expect(effects.filter((e) => e.label === "Bank Interest")).toHaveLength(1);
  });

  it("weapon masteries share one appliesTo but each keeps its own row", () => {
    const masteries = [16, 21, 25].map((id) =>
      merit({ id, label: `Mastery ${id}`, unit: "special", total: 8, perLevel: 1, level: 8, group: "Weapons mastery", appliesTo: "weapon class damage & accuracy" })
    );
    const { effects } = buildAccountEffects(masteries, null);
    expect(effects).toHaveLength(3);
    expect(new Set(effects.map((e) => e.key)).size).toBe(3);
  });

  it("identical stated bonuses from two completed courses aggregate additively with a course count", () => {
    const { effects } = buildAccountEffects(null, ["+2% crime XP", "+2% crime XP"]);
    expect(effects).toHaveLength(1);
    expect(effects[0]!.education).toEqual({ unit: "percent", total: 4, direction: "increase", courses: 2 });
  });

  it("unknown: effect text without a stated number stays verbatim text, never a number", () => {
    const { effects, unknownEducationEffects } = buildAccountEffects(
      null,
      ["Gain a bonus of 10% to medical item effectiveness", "Unlock the ability to duel with a Francaigiddeus"]
    );
    // One quantified row, one unknown string.
    expect(effects).toHaveLength(1);
    expect(effects[0]!.education?.total).toBe(10);
    expect(unknownEducationEffects).toEqual(["Unlock the ability to duel with a Francaigiddeus"]);
  });
});

describe("account effects — units", () => {
  it("percentage and flat bonuses keep distinct unit semantics (and distinct families)", () => {
    const { effects } = buildAccountEffects(null, ["+2% crime XP", "+1 maximum nerve"]);
    const pct = effects.find((e) => e.education?.unit === "percent");
    const flat = effects.find((e) => e.education?.unit === "flat");
    expect(pct?.education?.total).toBe(2);
    expect(flat?.education?.total).toBe(1);
    expect(pct?.key).not.toBe(flat?.key);
  });

  it("merit percent × rank stays the only merit total (exact), education quotes catalog values", () => {
    const { effects } = buildAccountEffects(
      [merit({ id: 12, label: "Protection", total: 30, perLevel: 3, level: 10, group: "Battlestats", appliesTo: "defense" })],
      []
    );
    expect(effects[0]!.merit).toMatchObject({ perLevel: 3, level: 10, total: 30 });
    expect(effects[0]!.provenance).toBe("exact");
  });
});

describe("account effects — future rewards are never active", () => {
  const CATALOG: EducationCatalogCategory[] = [
    {
      id: 4,
      name: "Biology",
      courses: [
        {
          id: 34,
          name: "Introduction to Biochemistry",
          duration: 604_800,
          rewards: { working_stats: { manual_labor: 5, intelligence: 50, endurance: 5 }, effect: "+2% crime XP", honor: null },
          prerequisites: { cost: 200, courses: [] },
        },
        {
          id: 35,
          name: "Evolution",
          duration: 604_800,
          rewards: { working_stats: null, effect: "+4% crime XP", honor: "Darwinism" },
          prerequisites: { cost: 250, courses: [34] },
        },
      ],
    },
  ];

  it("buildEducationProgress keeps future course effects out of earned — only earned may feed the derivation", () => {
    const progress = buildEducationProgress(CATALOG, [34], null, 1_791_700_000, 1_791_700_000)!;
    expect(progress.earned.effects).toEqual(["+2% crime XP"]);
    expect(progress.future.effects).toEqual(["+4% crime XP"]);

    // Feeding only the EARNED list (as the API route does) yields the
    // completed course's bonus only.
    const { effects } = buildAccountEffects(null, progress.earned.effects);
    expect(effects).toHaveLength(1);
    expect(effects[0]!.education?.total).toBe(2);
    expect(effects[0]!.education?.courses).toBe(1);
  });

  it("in-progress course rewards stay in future, never in earned", () => {
    const progress = buildEducationProgress(CATALOG, [], { id: 35, until: 1_791_760_000 }, 1_791_700_000, 1_791_700_000)!;
    expect(progress.earned.effects).toEqual([]);
    expect(progress.future.effects).toEqual(["+2% crime XP", "+4% crime XP"]);
  });
});

describe("account effects — parser formats (live catalog)", () => {
  it("reads the observed official phrasings as catalog-quoted numbers", () => {
    expect(parseEducationEffect("Gain a 1% damage bonus to all weapons")).toMatchObject({ unit: "percent", value: 1 });
    expect(parseEducationEffect("Gain a bonus of 10% to medical item effectiveness")).toMatchObject({ unit: "percent", value: 10 });
    expect(parseEducationEffect("+2% crime XP")).toMatchObject({ unit: "percent", value: 2 });
    expect(parseEducationEffect("+1 maximum nerve")).toMatchObject({ unit: "flat", value: 1 });
    expect(parseEducationEffect("Unlocks a new combat animation")).toBeNull();
  });
});
