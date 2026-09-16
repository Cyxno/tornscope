import { formatMoneyCompact } from "@tornscope/shared";
import { appearance, resolvedTheme, prefersReducedMotion } from "$lib/appearance-state.svelte";
import { alternateTimeTooltip, chartDay, chartHour, displayDateTime } from "$lib/time-display.svelte.js";
import { CATEGORICAL, RAMPS, BATTLESTATS } from "$lib/chart-palettes";
import type { ChartPalette, ResolvedTheme } from "$lib/appearance.svelte";

/**
 * Shared ECharts theme + option fragments — the one chart language.
 * Pages compose these; they never restate axis/tooltip/legend styling.
 *
 * THEME INTEGRATION: `C`, `TOOLTIP`, `LEGEND`, `AXIS_*` and `SPLIT_LINE`
 * resolve through getters that read the reactive appearance state, so option
 * builders inside $derived re-run when the user changes theme/accent/palette
 * and mounted charts update live (Chart.svelte re-applies options). Always
 * read chart colors through these getters — never hardcode hex values in
 * pages. Semantic positive/negative/warning are per-theme constants and are
 * deliberately NOT affected by the accent preference.
 */

/** Keep in sync with --ds-surface in app.css (donut hole / tooltip).
 *  Canvas-aware: each background preset carries its surface into charts. */
const CANVAS_SURFACE: Record<string, { dark: string; light: string }> = {
  graphite: { dark: "#141417", light: "#fbfaf6" },
  midnight: { dark: "#10131c", light: "#fbfaf6" },
  charcoal: { dark: "#191a1b", light: "#fbfaf6" },
  slate: { dark: "#171d26", light: "#fbfaf6" },
  paper: { dark: "#141417", light: "#fbfaf6" },
  warm: { dark: "#141417", light: "#fbf7ee" },
  mist: { dark: "#141417", light: "#f7fafa" },
};
export function surface(): string {
  const theme: ResolvedTheme = resolvedTheme() === "light" ? "light" : "dark";
  const canvas = typeof document !== "undefined" ? document.documentElement.dataset.canvas ?? "" : "";
  const entry = CANVAS_SURFACE[canvas] ?? CANVAS_SURFACE.graphite;
  return theme === "light" ? entry.light : entry.dark;
}

/** Canvas-safe accent colors live in the pure, unit-testable
 *  chart-colors module (runes-free so tests can import it directly). */
import { accentFamilyFor, accentRgbaFor, accentRgbCommaFor, tealAreaFor } from "./chart-colors";

function accentFamily() {
  const mode: ResolvedTheme = resolvedTheme() === "light" ? "light" : "dark";
  return accentFamilyFor(appearance.accent, mode);
}

/** Accent as an "r, g, b" triplet string for rgba() composition. */
function accentRgb(): string {
  return accentFamily().rgb;
}

/** Preview helpers for the Appearance tab (reactive to theme). */
export function palettePreview(id: ChartPalette): string[] {
  const mode: ResolvedTheme = resolvedTheme() === "light" ? "light" : "dark";
  return [...CATEGORICAL[id][mode]];
}
export function palettePreviewFor(id: ChartPalette, theme: ResolvedTheme): string[] {
  return [...CATEGORICAL[id][theme]];
}
/** The LIVE categorical palette (theme/palette-reactive) for charts whose
 *  series are categories — never sentiments (V1.0 sign-is-not-sentiment). */
export function categoricalColors(): string[] {
  const mode: ResolvedTheme = resolvedTheme() === "light" ? "light" : "dark";
  return [...CATEGORICAL[appearance.palette][mode]];
}
export function accentPreviewFor(id: string, theme: ResolvedTheme): string {
  return accentFamilyFor(id, theme).main;
}

export function accentPreviewHex(id: string): string {
  const mode: ResolvedTheme = resolvedTheme() === "light" ? "light" : "dark";
  return accentFamilyFor(id, mode).main;
}

/** Accent with alpha for canvas colors — always the legacy rgba() form
 *  (see chart-colors: zrender cannot parse the modern space syntax). */
export function accentRgba(alpha: number): string {
  const mode: ResolvedTheme = resolvedTheme() === "light" ? "light" : "dark";
  return accentRgbaFor(appearance.accent, mode, alpha);
}

export interface ChartTheme {
  theme: ResolvedTheme;
  accent: string;
  accentRgb: string;
  accentStrong: string;
  accentDeep: string;
  positive: string;
  negative: string;
  warning: string;
  info: string;
  violet: string;
  pink: string;
  label: string;
  labelFaint: string;
  axisLine: string;
  splitLine: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  surface: string;
  /** Categorical series colors for the selected palette + theme. */
  palette: string[];
  battlestats: { strength: string; defense: string; speed: string; dexterity: string };
  inflowRamp: string[];
  outflowRamp: string[];
}

/** The one chart theme. Call inside $derived so options track appearance. */
export function ct(): ChartTheme {
  const light = resolvedTheme() === "light";
  const mode = light ? "light" : "dark";
  return {
    theme: resolvedTheme(),
    accent: accentFamily().main,
    accentRgb: accentRgb(),
    accentStrong: accentFamily().strong,
    accentDeep: accentFamily().deep,
    positive: light ? "#178a4e" : "#3fd68f",
    negative: light ? "#c53f3f" : "#f87171",
    warning: light ? "#9a6a10" : "#f0b24a",
    info: light ? "#6d4fd0" : "#a78bfa",
    violet: light ? "#6d28d9" : "#a78bfa",
    pink: light ? "#be185d" : "#f472b6",
    label: light ? "#5b5a50" : "#8f8f99",
    labelFaint: light ? "#83826f" : "#7d7d87",
    axisLine: light ? "#dfded4" : "#232329",
    splitLine: light ? "#e9e8e0" : "#1b1b20",
    tooltipBg: light ? "#fbfaf6" : "#141417",
    tooltipBorder: light ? "#c6c5b9" : "#34343c",
    tooltipText: light ? "#26251f" : "#f4f4f1",
    surface: surface(),
    palette: CATEGORICAL[appearance.palette][mode],
    battlestats: BATTLESTATS[resolvedTheme()],
    inflowRamp: RAMPS[appearance.palette][mode].inflow,
    outflowRamp: RAMPS[appearance.palette][mode].outflow,
  };
}

/* Compatibility constants: getters resolve against the LIVE chart theme so
   existing `C.accent`-style call sites are theme/palette reactive. */
export const C = {
  get accent() { return ct().accent; },
  /** Neutral series color (the categorical palette's gray slot) — for
   *  movement/transport series that must NOT read as gain/loss. */
  get neutral() { return ct().palette[7] ?? ct().label; },
  get accentStrong() { return ct().accentStrong; },
  get accentDeep() { return ct().accentDeep; },
  get positive() { return ct().positive; },
  get negative() { return ct().negative; },
  get warning() { return ct().warning; },
  get violet() { return ct().violet; },
  get pink() { return ct().pink; },
  get label() { return ct().label; },
  get labelFaint() { return ct().labelFaint; },
  get axisLine() { return ct().axisLine; },
  get splitLine() { return ct().splitLine; },
  get tooltipBg() { return ct().tooltipBg; },
  get tooltipBorder() { return ct().tooltipBorder; },
  get tooltipText() { return ct().tooltipText; },
};

export const AXIS_LABEL = { get color() { return ct().label; }, fontSize: 10.5, fontFamily: "Inter Variable" };
export const AXIS_LINE = { get lineStyle() { return { color: ct().axisLine }; } };
export const SPLIT_LINE = { get lineStyle() { return { color: ct().splitLine }; } };

export const TOOLTIP = {
  get backgroundColor() { return ct().tooltipBg; },
  get borderColor() { return ct().tooltipBorder; },
  borderRadius: 10,
  padding: [8, 12],
  // Keep the tooltip inside the chart box: the chart container clips its
  // overflow (mobile page-width safety), so an unconfined tooltip would
  // be cut off at the panel edge on narrow screens.
  confine: true,
  get textStyle() { return { color: ct().tooltipText, fontSize: 11.5, fontFamily: "Inter Variable" }; },
  get extraCssText() { return `box-shadow: 0 12px 32px -12px ${resolvedTheme() === "light" ? "rgba(38,37,31,.25)" : "rgba(0,0,0,.6)"};`; },
};

export const LEGEND = {
  get textStyle() { return { color: ct().label, fontSize: 11, fontFamily: "Inter Variable" }; },
  itemWidth: 14,
  itemHeight: 8,
  icon: "roundRect",
};

export const GRID = { left: 10, right: 16, top: 32, bottom: 10, containLabel: true };

/** Motion: resolved from the motion preference (system/reduced/full). */
export function motionEnabled(): boolean {
  return !prefersReducedMotion;
}

/** Short, once. Disabled entirely under reduced motion. */
export const MOTION = {
  get animation() { return motionEnabled(); },
  get animationDuration() { return motionEnabled() ? 320 : 0; },
  get animationDurationUpdate() { return motionEnabled() ? 200 : 0; },
};

/** Accent gradient area fill for hero line charts. */
export function tealArea(): Record<string, unknown> {
  const mode: ResolvedTheme = resolvedTheme() === "light" ? "light" : "dark";
  return tealAreaFor(appearance.accent, mode);
}
export const accentArea = tealArea;

export function timeAxis(data: (number | string)[], opts: { boundaryGap?: boolean } = {}): Record<string, unknown> {
  // Dense per-point labels repeat the same day ("14/9 14/9 14/9 …"), which
  // tells the reader nothing. Show a label only when it differs from the
  // previously shown one — one label per run of identical values. The
  // closure lives per options object, so charts rebuild it with their data.
  let lastShown: string | null = null;
  return {
    type: "category",
    data,
    boundaryGap: opts.boundaryGap,
    // hideOverlap keeps dense ranges readable on narrow charts: ECharts
    // drops colliding labels instead of letting them collide or forcing
    // every label onto tiny screens.
    axisLabel: {
      ...AXIS_LABEL,
      hideOverlap: true,
      interval: (_index: number, value: string | number) => {
        const label = String(value);
        if (label === lastShown) return false;
        lastShown = label;
        return true;
      },
    },
    axisLine: AXIS_LINE,
    axisTick: { show: false },
  };
}

/** Money value axis: ticks carry the "$" so axis units match the KPI
 *  cells beside the chart (RC unit audit). */
export function moneyValueAxis(): Record<string, unknown> {
  return {
    ...valueAxis(),
    axisLabel: { ...AXIS_LABEL, formatter: (v: number) => formatMoneyCompact(v) },
  };
}

/** Axis tooltip formatter for money series ("Net worth: $849.3m"). */
export function moneyTooltipValue(): (v: unknown) => string {
  return (v: unknown) => (typeof v === "number" ? formatMoneyCompact(v) : String(v));
}

export function valueAxis(): Record<string, unknown> {
  return {
    type: "value",
    // scale: true lets the axis fit the ACTUAL data range. Without it ECharts
    // anchors the axis at 0, so small-but-real movements (e.g. networth
    // drifting a few $m across a $849m base) render as a flat line.
    scale: true,
    axisLabel: { ...AXIS_LABEL, formatter: (v: number) => compact(v) },
    splitLine: SPLIT_LINE,
    axisLine: { show: false },
  };
}

/** Integer-valued count axis (drug uses, attacks, attempts). */
export function countAxis(): Record<string, unknown> {
  return {
    type: "value",
    minInterval: 1,
    axisLabel: AXIS_LABEL,
    splitLine: SPLIT_LINE,
    axisLine: { show: false },
  };
}

function compact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}b`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}m`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return String(Math.round(v));
}

export function dayLabel(t: number): string {
  return chartDay(t);
}

export function hourLabel(t: number): string {
  return chartHour(t);
}

/**
 * Axis tooltip titled with the FULL display-zone timestamp plus the
 * alternate-zone line — a hovered point reads as an exact moment ("14-09-2026
 * 22:43 · 20:43 Torn time (UTC)"), not the compact axis label ("14/9").
 * `buckets` are the timestamps behind the axis categories, in the same order
 * as the xAxis data (V1.0: closes the chart-tooltip P3 without restructuring
 * how pages build options).
 */
export function axisTimeTooltip(buckets: number[], valueFormatter?: (v: unknown) => string): Record<string, unknown> {
  const fmt = valueFormatter ?? ((v: unknown) => (v === null || v === undefined ? "—" : typeof v === "number" ? v.toLocaleString("en-US") : String(v)));
  return {
    ...TOOLTIP,
    trigger: "axis",
    formatter: (params: unknown) => {
      const list = (Array.isArray(params) ? params : [params]) as Array<{ dataIndex?: number; marker?: string; seriesName?: string; value?: unknown }>;
      const ts = list[0]?.dataIndex !== undefined ? buckets[list[0].dataIndex] : undefined;
      if (ts === undefined) return "";
      const alt = alternateTimeTooltip(ts);
      const head = `${displayDateTime(ts)}${alt ? `<span style="opacity:.65"> · ${alt}</span>` : ""}`;
      const rows = list
        .map((p) => `${p.marker ?? ""} ${p.seriesName ?? ""} <b>${fmt(p.value)}</b>`)
        .join("<br/>");
      return rows ? `${head}<br/>${rows}` : head;
    },
  };
}
