import type { ChartPalette, ResolvedTheme } from "./appearance.svelte";

/**
 * Pure chart palette data — the single source for the palette preference.
 * No SvelteKit/$app imports so it is unit-testable in plain vitest.
 * charts.ts consumes these via the reactive theme (ct()).
 */

export const CATEGORICAL: Record<ChartPalette, { dark: string[]; light: string[] }> = {
  default: {
    dark: ["#2dd4bf", "#a78bfa", "#3fd68f", "#f0b24a", "#f472b6", "#818cf8", "#14b8a6", "#94a3b8", "#c084fc", "#5eead4", "#fca5a5"],
    light: ["#0d9488", "#6d28d9", "#178a4e", "#9a6a10", "#db2777", "#4f46e5", "#0f766e", "#64748b", "#9333ea", "#0ea5e9", "#b91c1c"],
  },
  muted: {
    dark: ["#5fd3c2", "#9d97e8", "#7cc9a4", "#d4b078", "#d894b8", "#8f9bd6", "#3ba08f", "#9aa2b1", "#b493d4", "#8fd0c6", "#d4a5a5"],
    light: ["#4fa396", "#6f6ac2", "#57976f", "#a3823f", "#b06a8d", "#5b63a8", "#3d7d70", "#6e7480", "#8a63b3", "#4f9c92", "#a86a6a"],
  },
  "high-contrast": {
    dark: ["#00e5c3", "#b39cff", "#4ade80", "#fbbf24", "#ff6b9d", "#93b4ff", "#00b8a0", "#e2e8f0", "#d8b4fe", "#7ffdf0", "#ff8c8c"],
    light: ["#003d33", "#4c1d95", "#14532d", "#713f12", "#831843", "#1e3a8a", "#0f766e", "#111827", "#581c87", "#134e4a", "#7f1d1d"],
  },
  // Okabe–Ito-derived: hues chosen to remain distinguishable under the most
  // common color-vision deficiencies; positive/negative semantics elsewhere
  // in the product always pair color with sign/label.
  colorblind: {
    dark: ["#56b4e9", "#e69f00", "#009e73", "#f0e442", "#cc79a7", "#0072b2", "#d55e00", "#cccccc", "#8fa8c8", "#66c2b0", "#e8c468"],
    light: ["#0072b2", "#d55e00", "#009e73", "#8a7a00", "#cc79a7", "#5a5ab8", "#8b4513", "#444444", "#39608c", "#008b78", "#a8862a"],
  },
  // Luminance ramp on a neutral cast. Series stay interpretable through
  // clear luminance separation plus ECharts' own markers/legends.
  monochrome: {
    dark: ["#e8e8e4", "#b8bab8", "#8d918f", "#d5dbd8", "#666b6a", "#9fb0ac", "#4a504f", "#76908b", "#c2d4d2", "#3f5653", "#5f7370"],
    light: ["#22221e", "#5c5d55", "#797a70", "#3f403a", "#96978b", "#b3b4a6", "#575850", "#74756a", "#919184", "#aeafa1", "#2d3f3d"],
  },
};;

export const BATTLESTATS: Record<ResolvedTheme, { strength: string; defense: string; speed: string; dexterity: string }> = {
  dark: { strength: "#f87171", defense: "#60a5fa", speed: "#4ade80", dexterity: "#c084fc" },
  light: { strength: "#b91c1c", defense: "#1d4ed8", speed: "#15803d", dexterity: "#7e22ce" },
};;

export const RAMPS: Record<ChartPalette, { dark: { inflow: string[]; outflow: string[] }; light: { inflow: string[]; outflow: string[] } }> = {
  default: {
    dark: { inflow: ["#2dd4bf", "#14b8a6", "#3fd68f", "#5eead4", "#8fd6c0", "#a7f3d0"], outflow: ["#f87171", "#fb923c", "#f0b24a", "#e879a0", "#d4a5a5", "#c084fc"] },
    light: { inflow: ["#0d9488", "#0f766e", "#178a4e", "#14b8a6", "#4fa396", "#5eead4"], outflow: ["#c53f3f", "#c2410c", "#9a6a10", "#be185d", "#a86a6a", "#7e22ce"] },
  },
  muted: {
    dark: { inflow: ["#5fd3c2", "#3ba08f", "#7cc9a4", "#8fd0c6", "#4fa396", "#c2d4d2"], outflow: ["#d894b8", "#d4b078", "#d4a5a5", "#b493d4", "#9aa2b1", "#8f9bd6"] },
    light: { inflow: ["#4fa396", "#3d7d70", "#57976f", "#4f9c92", "#6e7480", "#4f9c92"], outflow: ["#b06a8d", "#a3823f", "#a86a6a", "#8a63b3", "#6e7480", "#5b63a8"] },
  },
  "high-contrast": {
    dark: { inflow: ["#00e5c3", "#4ade80", "#7ffdf0", "#00b8a0", "#e2e8f0", "#fbbf24"], outflow: ["#ff6b9d", "#fbbf24", "#ff8c8c", "#b39cff", "#93b4ff", "#e2e8f0"] },
    light: { inflow: ["#003d33", "#14532d", "#134e4a", "#0f766e", "#111827", "#713f12"], outflow: ["#831843", "#713f12", "#7f1d1d", "#4c1d95", "#1e3a8a", "#111827"] },
  },
  colorblind: {
    dark: { inflow: ["#009e73", "#56b4e9", "#66c2b0", "#8fa8c8", "#e8c468", "#f0e442"], outflow: ["#d55e00", "#e69f00", "#cc79a7", "#cccccc", "#0072b2", "#8fa8c8"] },
    light: { inflow: ["#009e73", "#0072b2", "#008b78", "#39608c", "#8a7a00", "#e8c468"], outflow: ["#d55e00", "#b8860b", "#cc79a7", "#444444", "#5a5ab8", "#39608c"] },
  },
  monochrome: {
    dark: { inflow: ["#e8e8e4", "#b8bab8", "#8d918f", "#666b6a", "#9fb0ac", "#4a504f"], outflow: ["#d5dbd8", "#76908b", "#c2d4d2", "#57706c", "#919184", "#3f5653"] },
    light: { inflow: ["#22221e", "#5c5d55", "#797a70", "#3f403a", "#96978b", "#b3b4a6"], outflow: ["#3a3b35", "#575850", "#74756a", "#919184", "#aeafa1", "#2d3f3d"] },
  },
};