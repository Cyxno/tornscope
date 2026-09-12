import { describe, expect, it } from "vitest";
import {
  MERIT_CATALOG,
  assembleMerits,
  filterMerits,
  meritState,
  type NormalizedMeritInput,
} from "../src/merits.js";

/**
 * Merits golden coverage (v0.2 feature completion).
 * Ranks are exact API values; caps come from the TornScope-maintained
 * catalog — the maxed/partial classification must never claim a maxed
 * state without BOTH an exact rank and a maintained cap.
 */

const OFFICIAL = new Map([
  [1, { name: "Nerve Bar", description: "+1 nerve per rank." }],
  [3, { name: "Critical Hit Rate", description: "+0.5% critical chance per rank." }],
  [4, { name: "Awareness", description: "+20% city items per rank." }],
  [5, { name: "Masterful Looting", description: "+5% mug money per rank." }],
  [7, { name: "Bank Interest", description: "+5% bank interest per rank." }],
  [9, { name: "Brawn", description: "+3% strength per rank (cap not maintained)." }],
  [14, { name: "Crime XP", description: "+3% crime XP per rank (cap not maintained)." }],
]);

function build(over: Partial<NormalizedMeritInput> = {}) {
  return {
    upgrades: over.upgrades ?? [],
    available: over.available ?? null,
    used: over.used ?? null,
    medals: over.medals ?? null,
    honors: over.honors ?? null,
    catalog: over.catalog ?? OFFICIAL,
  };
}

describe("meritState classification", () => {
  it("classifies maxed/partial only with a maintained cap", () => {
    expect(meritState(10, 10)).toBe("maxed");
    expect(meritState(7, 10)).toBe("partial");
    expect(meritState(42, null)).toBe("owned");
    expect(meritState(null, 10)).toBe("untouched");
    expect(meritState(0, 10)).toBe("untouched");
  });
});

describe("assembleMerits", () => {
  it("rows cover the union of catalog and owned ids", () => {
    const { rows } = assembleMerits(build({ upgrades: [{ id: 99, level: 2 }] }));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(99); // owned, unknown to catalog
    expect(ids).toContain(1); // catalog, untouched
  });

  it("classifies a maintained-cap mix exactly", () => {
    const { rows, summary } = assembleMerits(
      build({
        upgrades: [
          { id: 1, level: 10 }, // maxed (cap 10)
          { id: 3, level: 7 }, // partial (cap 10)
          { id: 9, level: 42 }, // invested, cap unknown
        ],
        available: 2,
        used: 30,
        medals: 12,
        honors: 8,
      })
    );
    const nerve = rows.find((r) => r.id === 1)!;
    const crit = rows.find((r) => r.id === 3)!;
    const brawn = rows.find((r) => r.id === 9)!;
    const aware = rows.find((r) => r.id === 4)!;
    expect(nerve.state).toBe("maxed");
    expect(nerve.remaining).toBe(0);
    expect(crit.state).toBe("partial");
    expect(crit.remaining).toBe(3);
    expect(brawn.state).toBe("owned");
    expect(brawn.maxLevel).toBeNull();
    expect(brawn.remaining).toBeNull();
    expect(aware.state).toBe("untouched");
    expect(aware.owned).toBe(false);

    expect(summary.maxedCount).toBe(1);
    expect(summary.partialCount).toBe(1);
    expect(summary.capUnknownCount).toBe(1);
    expect(summary.untouchedCount).toBe(OFFICIAL.size - 3);
    expect(summary.ownedCount).toBe(3);
    expect(summary.available).toBe(2);
    expect(summary.used).toBe(30);
  });

  it("flags a catalog mismatch instead of trusting a stale cap", () => {
    const { rows } = assembleMerits(build({ upgrades: [{ id: 1, level: 11 }] }));
    const nerve = rows.find((r) => r.id === 1)!;
    expect(nerve.catalogMismatch).toBe(true);
    expect(nerve.remaining).toBe(0); // never negative
  });

  it("summarizes category concentration from exact ranks only", () => {
    const { summary } = assembleMerits(
      build({
        upgrades: [
          { id: 4, level: 10 },
          { id: 5, level: 5 },
          { id: 14, level: 3 },
        ],
        used: 18,
      })
    );
    const crime = summary.byCategory.find((c) => c.category === "Crime")!;
    expect(crime.points).toBe(18);
    expect(summary.byCategory.every((c) => c.points > 0)).toBe(true);
  });

  it("every catalog id matches the official 27-merit id set", () => {
    // Official /torn/merits ids (verified live; id 2 does not exist).
    const official = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, ...[16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26], 27, 28];
    expect(official.length).toBe(27);
    for (const id of official) expect(MERIT_CATALOG.has(id)).toBe(true);
    expect(MERIT_CATALOG.has(2)).toBe(false);
  });
});

describe("filterMerits", () => {
  const { rows } = assembleMerits(
    build({
      upgrades: [
        { id: 1, level: 10 },
        { id: 3, level: 4 },
        { id: 9, level: 30 },
      ],
    })
  );

  it("filters by state", () => {
    expect(filterMerits(rows, "maxed", null, "").map((r) => r.id)).toEqual([1]);
    expect(filterMerits(rows, "partial", null, "").map((r) => r.id)).toEqual([3]);
    expect(filterMerits(rows, "owned", null, "").map((r) => r.id)).toEqual([1, 3, 9]);
    expect(filterMerits(rows, "unowned", null, "").every((r) => !r.owned)).toBe(true);
    expect(filterMerits(rows, "all", null, "").length).toBe(rows.length);
  });

  it("filters by category and search", () => {
    expect(filterMerits(rows, "all", "Battlestats", "").map((r) => r.id)).toEqual([9]);
    const hit = filterMerits(rows, "all", null, "nerve");
    expect(hit.map((r) => r.id)).toContain(1);
    expect(filterMerits(rows, "all", null, "zzz-no-match")).toEqual([]);
  });
});
