/**
 * Pure chart color emission — no runes, no DOM, directly unit-testable
 * (see tests/chart-colors.test.ts).
 *
 * EVERY color that reaches a CANVAS surface must use the legacy comma
 * rgba() form: ECharts 6 (zrender) re-parses gradient stops itself on the
 * emphasis/tooltip re-render path, and its parser rejects the modern
 * space-separated `rgb(r g b / a)` syntax — the failed parse threw
 * `addColorStop(undefined)` on every hovered frame, blanking the chart
 * until the pointer left (1.0.1 Overview net-worth hover bug).
 */

/** Canvas-safe accent family per preference — keep in sync with the
 *  [data-accent] blocks in app.css (CSS holds the same values). */
export const ACCENT_FAMILIES: Record<
  string,
  { dark: { main: string; strong: string; deep: string; rgb: string }; light: { main: string; strong: string; deep: string; rgb: string } }
> = {
  teal: {
    dark: { main: "#2dd4bf", strong: "#14b8a6", deep: "#0d9488", rgb: "45 212 191" },
    light: { main: "#0d9488", strong: "#0f766e", deep: "#115e59", rgb: "13 148 136" },
  },
  blue: {
    dark: { main: "#60a5fa", strong: "#3b82f6", deep: "#2563eb", rgb: "96 165 250" },
    light: { main: "#2563eb", strong: "#1d4ed8", deep: "#1e40af", rgb: "37 99 235" },
  },
  indigo: {
    dark: { main: "#818cf8", strong: "#6366f1", deep: "#4f46e5", rgb: "129 140 248" },
    light: { main: "#4f46e5", strong: "#4338ca", deep: "#3730a3", rgb: "79 70 229" },
  },
  violet: {
    dark: { main: "#a78bfa", strong: "#8b5cf6", deep: "#7c3aed", rgb: "167 139 250" },
    light: { main: "#7c3aed", strong: "#6d28d9", deep: "#5b21b6", rgb: "124 58 237" },
  },
  emerald: {
    dark: { main: "#34d399", strong: "#10b981", deep: "#059669", rgb: "52 211 153" },
    light: { main: "#059669", strong: "#047857", deep: "#065f46", rgb: "5 150 105" },
  },
  amber: {
    dark: { main: "#fbbf24", strong: "#f59e0b", deep: "#d97706", rgb: "251 191 36" },
    light: { main: "#b45309", strong: "#92400e", deep: "#78350f", rgb: "180 83 9" },
  },
  rose: {
    dark: { main: "#fb7185", strong: "#f43f5e", deep: "#e11d48", rgb: "251 113 133" },
    light: { main: "#e11d48", strong: "#be123c", deep: "#9f1239", rgb: "225 29 72" },
  },
};

export type AccentMode = "dark" | "light";

/** The accent family for a preference id + resolved theme mode. */
export function accentFamilyFor(accentId: string, mode: AccentMode): { main: string; strong: string; deep: string; rgb: string } {
  return ACCENT_FAMILIES[accentId]?.[mode] ?? ACCENT_FAMILIES.teal[mode];
}

/** "r, g, b" commas — the legacy rgba() form zrender parses on every path. */
export function accentRgbCommaFor(accentId: string, mode: AccentMode): string {
  return accentFamilyFor(accentId, mode).rgb.split(" ").join(", ");
}

/** Accent with alpha for canvas colors — always legacy rgba() form. */
export function accentRgbaFor(accentId: string, mode: AccentMode, alpha: number): string {
  return `rgba(${accentRgbCommaFor(accentId, mode)}, ${alpha})`;
}

/** Accent gradient area fill for hero line charts. */
export function tealAreaFor(accentId: string, mode: AccentMode): Record<string, unknown> {
  const rgb = accentRgbCommaFor(accentId, mode);
  return {
    color: {
      type: "linear",
      x: 0,
      y: 0,
      x2: 0,
      y2: 1,
      colorStops: [
        { offset: 0, color: `rgba(${rgb}, 0.2)` },
        { offset: 1, color: `rgba(${rgb}, 0)` },
      ],
    },
  };
}
