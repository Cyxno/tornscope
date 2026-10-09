import { describe, expect, it } from "vitest";
import { buildEducationProgress, type EducationCatalogCategory } from "../src/education.js";
import { buildMeritEffects } from "../src/merits.js";

/**
 * 2.8.2 — Education progress + current merit effects. Fixtures mirror the
 * REAL live payloads (audited 2026-10-08): /user/education answers
 * {complete:[ids], current:{id,until}}, /torn/education delivers 12
 * categories / 143 courses with working_stats + free-text effect + honor,
 * and /torn/merits descriptions carry the per-rank formulas.
 */

const NOW = 1_791_700_000;

const CATALOG: EducationCatalogCategory[] = [
  {
    id: 4,
    name: "Biology",
    courses: [
      {
        id: 34,
        name: "Introduction to Biochemistry",
        duration: 604_800,
        rewards: { working_stats: { manual_labor: 5, intelligence: 50, endurance: 5 }, effect: null, honor: null },
        prerequisites: { cost: 200, courses: [] },
      },
      {
        id: 35,
        name: "Evolution",
        duration: 604_800,
        rewards: { working_stats: { manual_labor: null, intelligence: 60, endurance: null }, effect: "Gain a 1% damage bonus to all weapons", honor: "Darwinism" },
        prerequisites: { cost: 250, courses: [34] },
      },
    ],
  },
  {
    id: 6,
    name: "Combat Training",
    courses: [
      {
        id: 74,
        name: "Self-defense Basics",
        duration: 43_200,
        rewards: { working_stats: { manual_labor: 2, intelligence: 10, endurance: 20 }, effect: "Gain a bonus of 10% to medical item effectiveness", honor: null },
        prerequisites: { cost: 100, courses: [] },
      },
    ],
  },
];

/* ------------------------------- education -------------------------------- */

describe("education progress: completed / current / remaining", () => {
  it("classifies completed, in-progress and remaining courses against the live state", () => {
    const p = buildEducationProgress(CATALOG, [34, 74], { id: 35, until: NOW + 3 * 86_400 }, NOW, NOW)!;
    expect(p.total).toBe(3);
    expect(p.completed).toBe(2);
    expect(p.inProgress).toBe(1);
    expect(p.remaining).toBe(0);
    const evolution = p.courses.find((c) => c.id === 35)!;
    expect(evolution.state).toBe("in_progress");
    expect(p.currentCourse).toMatchObject({ id: 35, name: "Evolution", categoryName: "Biology", remainingSeconds: 3 * 86_400 });
  });

  it("renders remaining courses when nothing is current and few are complete", () => {
    const p = buildEducationProgress(CATALOG, [], null, NOW, NOW)!;
    expect(p.currentCourse).toBeNull();
    expect(p.completed).toBe(0);
    expect(p.remaining).toBe(3);
    expect(p.courses.every((c) => c.state === "remaining")).toBe(true);
  });

  it("shows category progress and flags a complete degree", () => {
    const p = buildEducationProgress(CATALOG, [74], null, NOW, NOW)!;
    const combat = p.categories.find((c) => c.name === "Combat Training")!;
    expect(combat).toEqual({ name: "Combat Training", completed: 1, total: 1, complete: true });
    const biology = p.categories.find((c) => c.name === "Biology")!;
    expect(biology).toEqual({ name: "Biology", completed: 0, total: 2, complete: false });
  });

  it("separates EARNED (completed) from FUTURE (remaining + in-progress) rewards", () => {
    const p = buildEducationProgress(CATALOG, [34, 74], { id: 35, until: NOW + 86_400 }, NOW, NOW)!;
    // Earned: Biochem (5/50/5) + Self-defense (2/10/20)
    expect(p.earned).toMatchObject({ manualLabor: 7, intelligence: 60, endurance: 25, effects: ["Gain a bonus of 10% to medical item effectiveness"] });
    // Future: Evolution (0/60/0 + effect + honor)
    expect(p.future).toMatchObject({ manualLabor: 0, intelligence: 60, endurance: 0, effects: ["Gain a 1% damage bonus to all weapons"], honors: ["Darwinism"] });
    // No reward is ever counted in both buckets.
    const totalInt = p.earned.intelligence + p.future.intelligence;
    const catalogInt = CATALOG.flatMap((c) => c.courses).reduce((s, c) => s + (c.rewards?.working_stats?.intelligence ?? 0), 0);
    expect(totalInt).toBe(catalogInt);
  });

  it("degrades to null when the catalog or the user state is missing (never partial)", () => {
    expect(buildEducationProgress(null, [34], null, NOW, NOW)).toBeNull();
    expect(buildEducationProgress([], [34], null, NOW, NOW)).toBeNull();
    expect(buildEducationProgress(CATALOG, null, null, NOW, NOW)).toBeNull();
  });

  it("handles a current course the catalog no longer knows (drift) without crashing", () => {
    const p = buildEducationProgress(CATALOG, [], { id: 9999, until: NOW + 100 }, NOW, NOW)!;
    expect(p.currentCourse).toMatchObject({ id: 9999, name: "Course #9999", categoryName: "Unknown category" });
  });
});

/* --------------------------------- merits --------------------------------- */

// Verbatim official descriptions (verified live 2026-10-08).
const MERIT_CATALOG = new Map<number, { name: string; description: string }>([
  [1, { name: "Nerve Bar", description: "This upgrade will give you +1 extra nerve point on your maximum nerve." }],
  [3, { name: "Critical Hit Rate", description: "This upgrade will give you an extra 0.5% chance at getting a critical hit during attacks. Critical hits are blows made on an opponent's head, throat or heart during an attack." }],
  [5, { name: "Masterful Looting", description: "This upgrade will give you a 5% boost in money that you mug from opponents. Perfect for experienced muggers, looking for some extra cash." }],
  [7, { name: "Bank Interest", description: "This upgrade will give you an increase of 5% to your investment bank interest. This upgrade will start working on your next investment." }],
  [12, { name: "Protection", description: "This upgrade will give you a passive 3% bonus to your defense stat. This upgrade will not increase your actual viewable stat number, but you will notice the effects during attacks." }],
  [14, { name: "Crime XP", description: "This upgrade will give you a passive boost of 3% (per upgrade) to your Crime XP resulting from successfully committing crimes." }],
  [15, { name: "Education Length", description: "This upgrade will decrease the amount of time you have to wait to complete an education course by 2%. This upgrade will start working on the next education course you start." }],
  [18, { name: "Rifle Mastery", description: "This upgrade will improve your proficiency with these weapons, increasing damage by 1% and accuracy by +0.2. Rifle weapons include: AK-47, Enfield SA-80, and ArmaLite M-15A4." }],
  [28, { name: "Employee Effectiveness", description: "This upgrade will provide an additional +1 bonus to employee effectiveness, helping you to earn more money for the company you work for." }],
]);

describe("merit current effects: level × formula", () => {
  it("computes percent, flat and reduction effects from the owned ranks", () => {
    const effects = buildMeritEffects(
      [
        { id: 1, level: 4 },
        { id: 3, level: 7 },
        { id: 5, level: 4 },
        { id: 7, level: 10 },
        { id: 12, level: 2 },
        { id: 14, level: 6 },
        { id: 15, level: 10 },
        { id: 28, level: 5 },
      ],
      MERIT_CATALOG
    );
    const byId = new Map(effects.map((e) => [e.id, e]));
    // flat bonus: +1 nerve per rank
    expect(byId.get(1)).toMatchObject({ label: "Maximum nerve", unit: "flat", perLevel: 1, level: 4, total: 4, direction: "increase" });
    // percentage: +0.5% crit chance × 7
    expect(byId.get(3)).toMatchObject({ unit: "percent", perLevel: 0.5, total: 3.5, appliesTo: "critical hit chance" });
    // +5% mug money × 4
    expect(byId.get(5)).toMatchObject({ unit: "percent", perLevel: 5, total: 20, appliesTo: "mug money" });
    // +5% bank interest maxed (the task's +15% example is a DIFFERENT merit scale — this account shows 10 ranks = +50%)
    expect(byId.get(7)).toMatchObject({ unit: "percent", perLevel: 5, total: 50, appliesTo: "bank interest" });
    // +3% defense × 2
    expect(byId.get(12)).toMatchObject({ unit: "percent", perLevel: 3, total: 6, appliesTo: "defense" });
    // reduction: −2% education course time × 10 (REAL id 15 — the initial
    // 2.8.2 table had 14/15 shifted; anchors blocked the misattribution).
    expect(byId.get(15)).toMatchObject({ unit: "percent", perLevel: 2, total: 20, direction: "reduce", appliesTo: "education course time" });
    // +3% crime XP × 6 (real id 14)
    expect(byId.get(14)).toMatchObject({ unit: "percent", perLevel: 3, total: 18, direction: "increase", appliesTo: "crime XP gain" });
    // flat +1 employee effectiveness × 5
    expect(byId.get(28)).toMatchObject({ unit: "flat", perLevel: 1, total: 5 });
  });

  it("groups weapon masteries under one effect family", () => {
    const effects = buildMeritEffects(
      [
        { id: 18, level: 3 },
        { id: 19, level: 1 },
      ],
      MERIT_CATALOG
    );
    expect(effects.every((e) => e.group === "Weapons mastery")).toBe(true);
    const rifle = effects.find((e) => e.id === 18)!;
    expect(rifle).toMatchObject({ label: "Rifle Mastery", unit: "special", perLevel: 1, total: 3 });
  });

  it("distinguishes maxed vs partial (rank × formula either way — no special casing)", () => {
    const effects = buildMeritEffects([{ id: 7, level: 10 }, { id: 7, level: 3 }].slice(0, 1).concat([{ id: 12, level: 1 }]), MERIT_CATALOG);
    expect(effects.find((e) => e.id === 7)!.level).toBe(10);
    expect(effects.find((e) => e.id === 7)!.total).toBe(50);
    expect(effects.find((e) => e.id === 12)!.level).toBe(1);
    expect(effects.find((e) => e.id === 12)!.total).toBe(3);
  });

  it("UNKNOWN effects are never summarized: unmodeled ids and description drift drop out", () => {
    // id 2 is not in the formula table at all.
    expect(buildMeritEffects([{ id: 2, level: 5 }], MERIT_CATALOG)).toEqual([]);
    // id 8 IS modeled but the description no longer matches its anchor (drift).
    const drifted = new Map(MERIT_CATALOG);
    drifted.set(8, { name: "Hospitalizing", description: "REWORDS: extends hospital time somehow." });
    expect(buildMeritEffects([{ id: 8, level: 5 }], drifted)).toEqual([]);
    // A missing catalog degrades to an empty summary — never a guessed effect.
    expect(buildMeritEffects([{ id: 7, level: 10 }], null)).toEqual([]);
    // Untouched merits (level 0 / missing) produce nothing.
    expect(buildMeritEffects([{ id: 7, level: 0 }], MERIT_CATALOG)).toEqual([]);
  });

  it("no double count: each owned rank appears exactly once in the summary", () => {
    const levels = [{ id: 7, level: 10 }, { id: 12, level: 2 }, { id: 18, level: 3 }];
    const effects = buildMeritEffects(levels, MERIT_CATALOG);
    expect(effects).toHaveLength(3);
    expect(new Set(effects.map((e) => e.id)).size).toBe(3);
    // The effects summary is additive-only: the existing ledger rows are the
    // caller's concern — this function MUTATES nothing and reads only levels.
  });
});
