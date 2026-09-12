/**
 * Appearance preferences — theme, accent, chart palette, density, motion.
 *
 * PERSISTENCE MODEL (browser-local): preferences live in localStorage and are
 * applied to <html> data-attributes BEFORE first paint by the bootstrap
 * script in app.html. Rationale: anonymous visitors, demo sessions and
 * linked profiles all get correct theming with no server roundtrip and no
 * schema; visual identity is per-browser by design (a shared server stores
 * Torn data, not the household's light/dark preference). Demo mode also uses
 * the local store — appearance intentionally carries across demo entry/exit
 * because it belongs to the browser, never to profile data.
 *
 * NO-FLASH CONTRACT: app.html resolves theme/accent/density/motion and sets
 * data-attributes before the stylesheet applies. This module reads the same
 * storage key and never sets attributes during SSR; hydration therefore
 * agrees with the initial DOM (no mismatch, no flash).
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type AccentPreference = "teal" | "blue" | "indigo" | "violet" | "emerald" | "amber" | "rose";
export type ChartPalette = "default" | "muted" | "high-contrast" | "colorblind" | "monochrome";
export type DensityPreference = "comfortable" | "compact";
export type MotionPreference = "system" | "reduced" | "full";

export interface Appearance {
  theme: ThemePreference;
  accent: AccentPreference;
  palette: ChartPalette;
  density: DensityPreference;
  motion: MotionPreference;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "system",
  accent: "teal",
  palette: "default",
  density: "comfortable",
  motion: "system",
};

const STORAGE_KEY = "tornscope.appearance.v1";

const THEMES: ThemePreference[] = ["system", "light", "dark"];
export const ACCENTS: AccentPreference[] = ["teal", "blue", "indigo", "violet", "emerald", "amber", "rose"];
export const PALETTES: ChartPalette[] = ["default", "muted", "high-contrast", "colorblind", "monochrome"];
export const DENSITIES: DensityPreference[] = ["comfortable", "compact"];
export const MOTIONS: MotionPreference[] = ["system", "reduced", "full"];

export function isTheme(v: unknown): v is ThemePreference {
  return THEMES.includes(v as ThemePreference);
}
export function isAccent(v: unknown): v is AccentPreference {
  return ACCENTS.includes(v as AccentPreference);
}
export function isPalette(v: unknown): v is ChartPalette {
  return PALETTES.includes(v as ChartPalette);
}
export function isDensity(v: unknown): v is DensityPreference {
  return DENSITIES.includes(v as DensityPreference);
}
export function isMotion(v: unknown): v is MotionPreference {
  return MOTIONS.includes(v as MotionPreference);
}

/** Parse a stored blob; unknown/invalid fields fall back to defaults. */
export function parseStoredAppearance(raw: unknown): Appearance {
  const base = { ...DEFAULT_APPEARANCE };
  if (typeof raw !== "object" || raw === null) return base;
  const src = raw as Record<string, unknown>;
  return {
    theme: isTheme(src.theme) ? src.theme : base.theme,
    accent: isAccent(src.accent) ? src.accent : base.accent,
    palette: isPalette(src.palette) ? src.palette : base.palette,
    density: isDensity(src.density) ? src.density : base.density,
    motion: isMotion(src.motion) ? src.motion : base.motion,
  };
}

export function loadStoredAppearance(storage: Pick<Storage, "getItem">): Appearance {
  try {
    return parseStoredAppearance(JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveStoredAppearance(storage: Pick<Storage, "setItem">, appearance: Appearance): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(appearance));
}
