import { formatMoneyCompact } from "@tornscope/shared";

/**
 * Shared ECharts theme + option fragments — the one chart language.
 * Pages compose these; they never restate axis/tooltip/legend styling.
 */

/** Keep in sync with --color-surface in app.css (donut hole / tooltip). */
export const CHART_SURFACE = "#141417";

export const C = {
  accent: "#2dd4bf",
  accentStrong: "#14b8a6",
  positive: "#3fd68f",
  negative: "#f87171",
  warning: "#f0b24a",
  violet: "#a78bfa",
  pink: "#f472b6",
  label: "#8f8f99",
  labelFaint: "#7d7d87",
  axisLine: "#232329",
  splitLine: "#1b1b20",
  tooltipBg: "#141417",
  tooltipBorder: "#34343c",
  tooltipText: "#f4f4f1",
};

export const AXIS_LABEL = { color: C.label, fontSize: 10.5, fontFamily: "Inter Variable" };
export const AXIS_LINE = { lineStyle: { color: C.axisLine } };
export const SPLIT_LINE = { lineStyle: { color: C.splitLine } };

export const TOOLTIP = {
  backgroundColor: C.tooltipBg,
  borderColor: C.tooltipBorder,
  borderRadius: 10,
  padding: [8, 12],
  // Keep the tooltip inside the chart box: the chart container clips its
  // overflow (mobile page-width safety), so an unconfined tooltip would
  // be cut off at the panel edge on narrow screens.
  confine: true,
  textStyle: { color: C.tooltipText, fontSize: 11.5, fontFamily: "Inter Variable" },
  extraCssText: "box-shadow: 0 12px 32px -12px rgba(0,0,0,.6);",
};

export const LEGEND = {
  textStyle: { color: C.label, fontSize: 11, fontFamily: "Inter Variable" },
  itemWidth: 14,
  itemHeight: 8,
  icon: "roundRect",
};

export const GRID = { left: 10, right: 16, top: 32, bottom: 10, containLabel: true };

/** Calm default motion: short, once. The Chart wrapper disables it entirely
 * under prefers-reduced-motion. */
export const MOTION = { animation: true, animationDuration: 320, animationDurationUpdate: 200 };

/** Teal gradient area fill for hero line charts. */
export function tealArea(): Record<string, unknown> {
  return {
    color: {
      type: "linear",
      x: 0,
      y: 0,
      x2: 0,
      y2: 1,
      colorStops: [
        { offset: 0, color: "rgba(45,212,191,0.2)" },
        { offset: 1, color: "rgba(45,212,191,0)" },
      ],
    },
  };
}

export function timeAxis(data: (number | string)[], opts: { boundaryGap?: boolean } = {}): Record<string, unknown> {
  return {
    type: "category",
    data,
    boundaryGap: opts.boundaryGap,
    // hideOverlap keeps dense ranges readable on narrow charts: ECharts
    // drops colliding labels instead of letting them collide or forcing
    // every label onto tiny screens.
    axisLabel: { ...AXIS_LABEL, hideOverlap: true },
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
  const d = new Date(t * 1000);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

export function hourLabel(t: number): string {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
