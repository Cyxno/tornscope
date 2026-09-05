/**
 * Shared ECharts theme + option fragments for the graphite/teal design system.
 */

export const C = {
  accent: "#2dd4bf",
  accentStrong: "#14b8a6",
  positive: "#3fd68f",
  negative: "#f87171",
  warning: "#f0b24a",
  violet: "#a78bfa",
  pink: "#f472b6",
  label: "#8f8f99",
  labelFaint: "#70707a",
  axisLine: "#232327",
  splitLine: "#1c1c21",
  tooltipBg: "#161619",
  tooltipBorder: "#333339",
  tooltipText: "#f5f5f2",
};

export const AXIS_LABEL = { color: C.label, fontSize: 10.5, fontFamily: "Inter Variable" };
export const AXIS_LINE = { lineStyle: { color: C.axisLine } };
export const SPLIT_LINE = { lineStyle: { color: C.splitLine } };

export const TOOLTIP = {
  backgroundColor: C.tooltipBg,
  borderColor: C.tooltipBorder,
  borderRadius: 12,
  padding: [10, 14],
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
        { offset: 0, color: "rgba(45,212,191,0.22)" },
        { offset: 1, color: "rgba(45,212,191,0)" },
      ],
    },
  };
}

export function timeAxis(data: (number | string)[]): Record<string, unknown> {
  return {
    type: "category",
    data,
    axisLabel: AXIS_LABEL,
    axisLine: AXIS_LINE,
    axisTick: { show: false },
  };
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
