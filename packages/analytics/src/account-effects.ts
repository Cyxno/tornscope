/* -------------------------------------------------------------------------- */
/* Account effects (2.8.4) — combined actieve account-bonussen                */
/* -------------------------------------------------------------------------- */

/**
 * Read-time derivation over the two PROVEN effect sources — nothing else:
 *
 * - Merit ranks (exact): `MeritEffect[]` from buildMeritEffects — per-rank
 *   formula anchor-verified against the official description. Semantics: EXACT.
 * - Completed Education courses (catalog): the official `rewards.effect`
 *   strings of completed courses only. A numeric contribution is read ONLY
 *   when the value is literally stated in the catalog text (`+N% X` /
 *   `+N X`); the number is quoted, never inferred from prose. Semantics:
 *   CATALOG-derived. In-progress/remaining course rewards are NEVER active.
 *
 * POLICY:
 * - No double counting: an effect family from both sources becomes ONE row
 *   listing both sources; the two contributions are kept separate and never
 *   summed (different mechanics — additive stacking across source types is
 *   not verifiably known).
 * - Multiple completed courses stating the identical bonus are aggregated
 *   additively within the Education source (identical stated quantities),
 *   with the course count surfaced.
 * - Effect strings that cannot be read as a stated number are returned
 *   verbatim in `unknownEducationEffects` — unknown stays unknown.
 * - Family matching is conservative: unit + direction + normalized target
 *   must all match; unmatched families stay separate rows (never merged on
 *   description prose alone).
 */

import type { MeritEffect } from "./merits.js";

export type AccountEffectSource = "merits" | "education";

export interface AccountEffectMerit {
  unit: "percent" | "flat" | "special";
  perLevel: number;
  /** Exact owned rank. */
  level: number;
  /** perLevel × level (exact). */
  total: number;
  direction: "increase" | "reduce";
  appliesTo: string;
}

export interface AccountEffectEducation {
  unit: "percent" | "flat";
  /** Sum of the stated values across completed courses. */
  total: number;
  direction: "increase" | "reduce";
  /** How many completed courses state (a component of) this bonus. */
  courses: number;
}

export interface AccountEffect {
  /** Stable family key: unit|direction|normalized target. */
  key: string;
  label: string;
  /** Display grouping (merit group, or "Education" for education-only rows). */
  group: string;
  sources: AccountEffectSource[];
  /** exact = merit formula; catalog = value quoted from official course text. */
  provenance: "exact" | "catalog";
  merit: AccountEffectMerit | null;
  education: AccountEffectEducation | null;
}

export interface AccountEffectsSummary {
  effects: AccountEffect[];
  /** Official effect strings that cannot be stated numerically — verbatim. */
  unknownEducationEffects: string[];
}

/** Rows stating a number are read as written; everything else stays text.
 *  Observed official formats (live catalog): "+N% X", "+N X",
 *  "Gain a N% X bonus (to Y)", "Gain a bonus of N% to X". */
const PERCENT_EFFECT = /^\+\s*(\d+(?:\.\d+)?)\s*%\s+(.+)$/;
const FLAT_EFFECT = /^\+\s*(\d+(?:\.\d+)?)\s+(?!\d*%)(.+)$/;
const GAIN_PCT_BONUS = /^gain a\s+(\d+(?:\.\d+)?)\s*%\s+(.+?)(?:\s+bonus)?(?:\s+to\s+(.+))?$/i;
const BONUS_OF_PCT = /^(?:gain\s+)?a bonus of\s+(\d+(?:\.\d+)?)\s*%\s+to\s+(.+)$/i;

/** Conservative family normalization — light-touch token cleanup only.
 *  Texts that differ beyond this stay separate (never merged on prose). */
const STOP_TOKENS = new Set(["gain", "stat", "your", "the", "a", "an", "bonus", "extra", "passive"]);

function normalizeTarget(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9%+\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_TOKENS.has(t))
    .join(" ");
}

function titleCase(raw: string): string {
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

interface ParsedEffect {
  unit: "percent" | "flat";
  value: number;
  target: string;
  /** Raw target text (for display labels). */
  targetText: string;
}

/** Parse an official course effect string. Null = not numerically stated. */
export function parseEducationEffect(raw: string): ParsedEffect | null {
  const text = raw.trim();
  const pct = PERCENT_EFFECT.exec(text);
  if (pct) return { unit: "percent", value: Number(pct[1]), target: normalizeTarget(pct[2]!), targetText: pct[2]! };
  const flat = FLAT_EFFECT.exec(text);
  if (flat) return { unit: "flat", value: Number(flat[1]), target: normalizeTarget(flat[2]!), targetText: flat[2]! };
  const gain = GAIN_PCT_BONUS.exec(text);
  if (gain) {
    const targetText = `${gain[2] ?? ""} ${gain[3] ?? ""}`.trim();
    return { unit: "percent", value: Number(gain[1]), target: normalizeTarget(targetText), targetText };
  }
  const bonusOf = BONUS_OF_PCT.exec(text);
  if (bonusOf) return { unit: "percent", value: Number(bonusOf[1]), target: normalizeTarget(bonusOf[2]!), targetText: bonusOf[2]! };
  return null;
}

function keyOf(unit: string, direction: string, target: string): string {
  return `${unit}|${direction}|${target}`;
}

/**
 * Build the combined actieve account-bonussen. `educationEffects` must be the
 * EARNED (completed-course) effect strings — future course rewards are never
 * active and must not be passed in.
 */
export function buildAccountEffects(
  meritEffects: MeritEffect[] | null | undefined,
  educationEffects: string[] | null | undefined
): AccountEffectsSummary {
  const rows = new Map<string, AccountEffect>();
  const unknown: string[] = [];

  const seenMeritIds = new Set<number>();
  for (const m of meritEffects ?? []) {
    if (seenMeritIds.has(m.id)) continue; // duplicate input guard — never double count
    seenMeritIds.add(m.id);
    const familyKey = keyOf(m.unit, m.direction, normalizeTarget(m.appliesTo));
    const existing = rows.get(familyKey);
    if (existing) {
      if (existing.merit) {
        // Same family from another merit (e.g. each weapon mastery shares one
        // appliesTo): keep as its own row — never overwrite or double count.
        rows.set(`${familyKey}#${m.id}`, {
          key: `${familyKey}#${m.id}`,
          label: m.label,
          group: m.group,
          sources: ["merits"],
          provenance: "exact",
          merit: { unit: m.unit, perLevel: m.perLevel, level: m.level, total: m.total, direction: m.direction, appliesTo: m.appliesTo },
          education: null,
        });
      } else {
        existing.merit = { unit: m.unit, perLevel: m.perLevel, level: m.level, total: m.total, direction: m.direction, appliesTo: m.appliesTo };
        existing.sources = [...existing.sources, "merits"] as AccountEffectSource[];
      }
    } else {
      rows.set(familyKey, {
        key: familyKey,
        label: m.label,
        group: m.group,
        sources: ["merits"],
        provenance: "exact",
        merit: { unit: m.unit, perLevel: m.perLevel, level: m.level, total: m.total, direction: m.direction, appliesTo: m.appliesTo },
        education: null,
      });
    }
  }

  for (const raw of educationEffects ?? []) {
    const parsed = parseEducationEffect(raw);
    if (!parsed) {
      if (!unknown.includes(raw)) unknown.push(raw); // verbatim, deduplicated
      continue;
    }
    const key = keyOf(parsed.unit, "increase", parsed.target);
    const existing = rows.get(key);
    if (existing?.education) {
      existing.education.total += parsed.value;
      existing.education.courses += 1;
    } else if (existing) {
      existing.education = { unit: parsed.unit, total: parsed.value, direction: "increase", courses: 1 };
      existing.sources = [...existing.sources, "education"] as AccountEffectSource[];
    } else {
      rows.set(key, {
        key,
        label: titleCase(parsed.targetText) || raw,
        group: "Education",
        sources: ["education"],
        provenance: "catalog",
        merit: null,
        education: { unit: parsed.unit, total: parsed.value, direction: "increase", courses: 1 },
      });
    }
  }

  const effects = [...rows.values()].map((r) =>
    r.education ? { ...r, education: { ...r.education, total: Math.round(r.education.total * 100) / 100 } } : r
  );
  effects.sort(
    (a, b) =>
      a.group.localeCompare(b.group) ||
      a.label.localeCompare(b.label)
  );
  return { effects, unknownEducationEffects: unknown };
}
