/* -------------------------------------------------------------------------- */
/* Merit catalog + canonical merit intelligence                               */
/* -------------------------------------------------------------------------- */

/**
 * SOURCES (verified live against Torn API v2, spec 6.13.5):
 *
 * - `/v2/user/merits` → `{ merits: { upgrades: [{id, level}], available,
 *   used, medals, honors } }`. Ranks/levels, unspent points ("available")
 *   and invested points ("used") are EXACT API values. `medals`/`honors`
 *   are the counts of earned medals/honors (each grants one merit point).
 * - `/v2/torn/merits` (public) → `{ merits: [{id, name, description}] }` —
 *   the official id → name/description catalog. Fetched live by the API
 *   service and cached; this module carries ONLY the metadata Torn does not
 *   publish (see below).
 *
 * The Torn API publishes NO merit caps and NO categories. The enrichment
 * below is TornScope-maintained metadata:
 *
 * - `maxLevel` — Torn's long-standing merit caps. `null` = cap not
 *   maintained (merits whose in-game cap TornScope does not verifiably
 *   know); the UI renders "Level N" without a max and never claims maxed.
 * - `category` — TornScope UI grouping, NOT Torn-native taxonomy.
 *
 * A stored level above a maintained cap is surfaced as a catalog mismatch
 * (`catalogMismatch`) instead of being silently trusted.
 */

export interface MeritCatalogEntry {
  id: number;
  /** TornScope-maintained cap. null = not maintained (never claim maxed). */
  maxLevel: number | null;
  category: MeritCategory;
}

export type MeritCategory =
  | "Combat"
  | "Battlestats"
  | "Crime"
  | "Weapons mastery"
  | "Recovery"
  | "Money & career";

export const MERIT_CATEGORIES: MeritCategory[] = [
  "Combat",
  "Battlestats",
  "Crime",
  "Weapons mastery",
  "Recovery",
  "Money & career",
];

/** Weapon-master merit ids (16-26) share the same cap. */
const WEAPON_MASTERY_IDS = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26] as const;

const CAPPED_AT_10: Array<[number, MeritCategory]> = [
  [1, "Recovery"],
  [3, "Combat"],
  [4, "Crime"],
  [5, "Crime"],
  [6, "Combat"],
  [7, "Money & career"],
  [8, "Combat"],
  [15, "Money & career"],
];

/** id → TornScope-maintained enrichment. Ids follow the official catalog. */
export const MERIT_CATALOG: ReadonlyMap<number, MeritCatalogEntry> = new Map<number, MeritCatalogEntry>([
  ...CAPPED_AT_10.map(
    ([id, category]): [number, MeritCatalogEntry] => [id, { id, maxLevel: 10, category }]
  ),
  ...WEAPON_MASTERY_IDS.map(
    (id): [number, MeritCatalogEntry] => [id, { id, maxLevel: 10, category: "Weapons mastery" }]
  ),
  // Percentage-stat merits run on a different cap scale that TornScope does
  // not maintain — level-only rendering, never a maxed claim.
  [9, { id: 9, maxLevel: null, category: "Battlestats" }],
  [10, { id: 10, maxLevel: null, category: "Battlestats" }],
  [11, { id: 11, maxLevel: null, category: "Battlestats" }],
  [12, { id: 12, maxLevel: null, category: "Battlestats" }],
  [13, { id: 13, maxLevel: null, category: "Recovery" }],
  [14, { id: 14, maxLevel: null, category: "Crime" }],
  [27, { id: 27, maxLevel: null, category: "Recovery" }],
  [28, { id: 28, maxLevel: null, category: "Money & career" }],
]);

/* -------------------------------------------------------------------------- */
/* Canonical merit row / summary                                              */
/* -------------------------------------------------------------------------- */

export type MeritState = "maxed" | "partial" | "owned" | "untouched";

export interface MeritRow {
  /** Official catalog id. */
  id: number;
  /** Official name (`/torn/merits`); falls back to `Merit #id` on drift. */
  name: string | null;
  /** Official description, trimmed for display. */
  description: string | null;
  category: MeritCategory | null;
  /** Exact rank from `/user/merits`; null = untouched (not in upgrades). */
  level: number | null;
  /** TornScope-maintained cap; null = not maintained. */
  maxLevel: number | null;
  /** Exact remaining ranks to the maintained cap; null when cap unknown. */
  remaining: number | null;
  owned: boolean;
  /**
   * Maxed requires BOTH an exact rank and a maintained cap. "owned" is used
   * for invested merits whose cap is unknown (level is exact, max is not).
   */
  state: MeritState;
  /** level exceeds the maintained cap — catalog needs an update. */
  catalogMismatch: boolean;
}

export interface MeritSummary {
  /** Exact invested points (`used` from the API). */
  used: number;
  /** Exact unspent points (`available` from the API); null when unexposed. */
  available: number | null;
  /** Exact earned medal/honor counts (each grants one merit point). */
  medals: number | null;
  honors: number | null;
  ownedCount: number;
  maxedCount: number;
  partialCount: number;
  untouchedCount: number;
  /** Invested merits whose cap is unknown (owned but not classifiable). */
  capUnknownCount: number;
  byCategory: Array<{ category: MeritCategory; points: number }>;
}

/** State derivation: maxed/partial need an exact rank AND a maintained cap. */
export function meritState(level: number | null, maxLevel: number | null): MeritState {
  if (level === null || level <= 0) return "untouched";
  if (maxLevel === null) return "owned";
  if (level >= maxLevel) return "maxed";
  return "partial";
}

export interface NormalizedMeritInput {
  /** Raw upgrades: merit id → exact level. */
  upgrades: Array<{ id: number; level: number }>;
  /** Exact unspent points; null when the API omitted the field. */
  available: number | null;
  /** Exact invested points; null when the API omitted the field. */
  used: number | null;
  medals: number | null;
  honors: number | null;
  /** Official catalog entries (id → name/description). */
  catalog: Map<number, { name: string; description: string }>;
}

/** Assemble canonical merit rows over the union of catalog + owned ids. */
export function assembleMerits(input: NormalizedMeritInput): { rows: MeritRow[]; summary: MeritSummary } {
  const levelById = new Map<number, number>();
  for (const u of input.upgrades) levelById.set(u.id, u.level);

  // Union so unowned catalog merits still render (as untouched).
  const ids = new Set<number>([...input.catalog.keys(), ...levelById.keys()]);

  const rows: MeritRow[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const level = levelById.get(id) ?? null;
    const meta = MERIT_CATALOG.get(id) ?? null;
    const official = input.catalog.get(id) ?? null;
    const maxLevel = meta?.maxLevel ?? null;
    const state = meritState(level, maxLevel);
    rows.push({
      id,
      name: official?.name ?? null,
      description: official?.description ?? null,
      category: meta?.category ?? null,
      level,
      maxLevel,
      remaining: level !== null && maxLevel !== null ? Math.max(0, maxLevel - level) : null,
      owned: level !== null && level > 0,
      state,
      catalogMismatch: level !== null && maxLevel !== null && level > maxLevel,
    });
  }

  const summary = summarizeMerits(rows, input);
  return { rows, summary };
}

function summarizeMerits(rows: MeritRow[], input: NormalizedMeritInput): MeritSummary {
  const byCategory = new Map<MeritCategory, number>();
  let ownedCount = 0;
  let maxedCount = 0;
  let partialCount = 0;
  let untouchedCount = 0;
  let capUnknownCount = 0;
  for (const row of rows) {
    if (row.owned && row.category) {
      byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + (row.level ?? 0));
    }
    if (row.state === "maxed") maxedCount += 1;
    else if (row.state === "partial") partialCount += 1;
    else if (row.state === "untouched") untouchedCount += 1;
    else capUnknownCount += 1;
    if (row.owned) ownedCount += 1;
  }
  return {
    used: input.used ?? rows.reduce((sum, r) => sum + (r.level ?? 0), 0),
    available: input.available,
    medals: input.medals,
    honors: input.honors,
    ownedCount,
    maxedCount,
    partialCount,
    untouchedCount,
    capUnknownCount,
    byCategory: MERIT_CATEGORIES.filter((c) => (byCategory.get(c) ?? 0) > 0).map((category) => ({
      category,
      points: byCategory.get(category) ?? 0,
    })),
  };
}

/** Merit list filter — mirrors the UI's filter chips. */
export type MeritFilter = "all" | "owned" | "partial" | "maxed" | "unowned";

export function filterMerits(
  rows: MeritRow[],
  filter: MeritFilter,
  category: MeritCategory | null,
  query: string
): MeritRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter === "owned" && !row.owned) return false;
    if (filter === "partial" && row.state !== "partial") return false;
    if (filter === "maxed" && row.state !== "maxed") return false;
    if (filter === "unowned" && row.owned) return false;
    if (category && row.category !== category) return false;
    if (q) {
      const hay = `${row.name ?? ""} ${row.description ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Current merit effects (2.8.2)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Actuele effecten van geïnvesteerde merit ranks (2.8.2).
 *
 * SOURCE + FORMULA POLICY: every effect below is derived from the OFFICIAL
 * `/v2/torn/merits` description (verified live 2026-10-08), and each entry
 * carries an ANCHOR PHRASE that must be present in the live description
 * before the formula is applied. If Torn ever rewords a description and the
 * anchor disappears, that merit silently drops out of the effects summary —
 * it stays in the existing ledger with its description, never a guessed
 * number. Per-level semantics are internally cross-validated by Torn's own
 * text (e.g. Hospitalizing: "+5% ... 50% extra hospital time when fully
 * upgraded" ⇒ 5% × 10 ranks).
 *
 * Merits whose description cannot be parsed unambiguously (Awareness's
 * "20%" phrasing is included ONLY with its literal anchor) are NEVER
 * inferred from prose alone.
 */

export interface MeritEffect {
  /** Official catalog id (or negative synthetic id for combined groups). */
  id: number;
  /** Display label for the combined effect line. */
  label: string;
  /** percent | flat | special — rendering + combination semantics. */
  unit: "percent" | "flat" | "special";
  /** Signed per-rank magnitude (negative = reduction). */
  perLevel: number;
  /** Exact owned rank from /user/merits. */
  level: number;
  /** perLevel × level — the ACTUAL current effect. */
  total: number;
  /** increase | reduce — direction of benefit. */
  direction: "increase" | "reduce";
  /** Effect family for combining (weapon masteries share one group). */
  group: string;
  /** What the effect applies to, verbatim family ("defense stat", ...). */
  appliesTo: string;
}

interface EffectFormula {
  /** Anchor that MUST appear in the live description (drift guard). */
  anchor: RegExp;
  unit: "percent" | "flat" | "special";
  perLevel: number;
  direction: "increase" | "reduce";
  group: string;
  appliesTo: string;
  label?: string;
}

const WEAPON_MASTERY_FORMULA: EffectFormula = {
  anchor: /damage by 1% and accuracy by \+0\.2/i,
  unit: "special",
  perLevel: 1,
  direction: "increase",
  group: "Weapons mastery",
  appliesTo: "weapon class damage & accuracy",
};

const MERIT_EFFECT_FORMULAS: ReadonlyMap<number, EffectFormula> = new Map([
  [1, { anchor: /\+1 extra nerve point/i, unit: "flat", perLevel: 1, direction: "increase", group: "Nerve", appliesTo: "maximum nerve", label: "Maximum nerve" }],
  [3, { anchor: /extra 0\.5% chance/i, unit: "percent", perLevel: 0.5, direction: "increase", group: "Combat", appliesTo: "critical hit chance" }],
  [4, { anchor: /items you can find in the city by 20%/i, unit: "percent", perLevel: 20, direction: "increase", group: "Money & career", appliesTo: "city items found" }],
  [5, { anchor: /5% boost in money that you mug/i, unit: "percent", perLevel: 5, direction: "increase", group: "Money & career", appliesTo: "mug money" }],
  [6, { anchor: /stealth level by \+0\.2/i, unit: "flat", perLevel: 0.2, direction: "increase", group: "Combat", appliesTo: "stealth level" }],
  [7, { anchor: /increase of 5% to your investment bank interest/i, unit: "percent", perLevel: 5, direction: "increase", group: "Money & career", appliesTo: "bank interest" }],
  [8, { anchor: /hospitalize someone by 5%/i, unit: "percent", perLevel: 5, direction: "increase", group: "Combat", appliesTo: "hospitalize time" }],
  [9, { anchor: /passive 3% bonus to your strength stat/i, unit: "percent", perLevel: 3, direction: "increase", group: "Battlestats", appliesTo: "strength" }],
  [10, { anchor: /passive 3% bonus to your speed stat/i, unit: "percent", perLevel: 3, direction: "increase", group: "Battlestats", appliesTo: "speed" }],
  [11, { anchor: /passive 3% bonus to your dexterity stat/i, unit: "percent", perLevel: 3, direction: "increase", group: "Battlestats", appliesTo: "dexterity" }],
  [12, { anchor: /passive 3% bonus to your defense stat/i, unit: "percent", perLevel: 3, direction: "increase", group: "Battlestats", appliesTo: "defense" }],
  [13, { anchor: /maximum life by 5%/i, unit: "percent", perLevel: 5, direction: "increase", group: "Recovery", appliesTo: "maximum life" }],
  [14, { anchor: /complete an education course by 2%/i, unit: "percent", perLevel: 2, direction: "reduce", group: "Education", appliesTo: "education course time" }],
  [15, WEAPON_MASTERY_FORMULA], [16, WEAPON_MASTERY_FORMULA], [17, WEAPON_MASTERY_FORMULA],
  [18, WEAPON_MASTERY_FORMULA], [19, WEAPON_MASTERY_FORMULA], [20, WEAPON_MASTERY_FORMULA],
  [21, WEAPON_MASTERY_FORMULA], [22, WEAPON_MASTERY_FORMULA], [23, WEAPON_MASTERY_FORMULA],
  [24, WEAPON_MASTERY_FORMULA], [25, WEAPON_MASTERY_FORMULA], [26, WEAPON_MASTERY_FORMULA],
  [27, { anchor: /addiction causes by 2%/i, unit: "percent", perLevel: 2, direction: "reduce", group: "Recovery", appliesTo: "addiction effects" }],
  [28, { anchor: /\+1 bonus to employee effectiveness/i, unit: "flat", perLevel: 1, direction: "increase", group: "Money & career", appliesTo: "employee effectiveness" }],
]);

/**
 * Build the ACTUAL current effects from owned merit ranks + the official
 * catalog. Ranks with no owned level (untouched) produce nothing; a merit
 * whose live description no longer matches its anchor is excluded (drift
 * guard) — never approximated. Weapon masteries keep per-weapon rows but
 * share the "Weapons mastery" group so the UI can render them as one block.
 */
export function buildMeritEffects(
  levels: Array<{ id: number; level: number }>,
  catalogById: Map<number, { name: string; description: string }> | null
): MeritEffect[] {
  const out: MeritEffect[] = [];
  for (const { id, level } of levels) {
    if (!Number.isInteger(level) || level < 1) continue;
    const formula = MERIT_EFFECT_FORMULAS.get(id);
    if (!formula) continue;
    const official = catalogById?.get(id);
    // Drift guard: no official description, or the anchor phrase vanished —
    // the formula is no longer provably correct for this merit.
    if (!official || !formula.anchor.test(official.description)) continue;
    out.push({
      id,
      label: formula.label ?? official.name,
      unit: formula.unit,
      perLevel: formula.perLevel,
      level,
      total: Math.round(formula.perLevel * level * 100) / 100,
      direction: formula.direction,
      group: formula.group,
      appliesTo: formula.appliesTo,
    });
  }
  return out.sort((a, b) => a.group.localeCompare(b.group) || b.total - a.total || a.label.localeCompare(b.label));
}
