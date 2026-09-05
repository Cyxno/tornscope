import type { DateRangePreset } from "@tornscope/shared";

/**
 * Global app state (Svelte 5 runes module): current date range filter and
 * the signed-in player snapshot from /api/me.
 */

export const DATE_PRESETS: Array<{ value: DateRangePreset; label: string }> = [
  { value: "1d", label: "1D" },
  { value: "7d", label: "7D" },
  { value: "14d", label: "14D" },
  { value: "30d", label: "30D" },
  { value: "90d", label: "90D" },
  { value: "this_month", label: "Month" },
  { value: "this_year", label: "Year" },
  { value: "all", label: "All" },
];

export const dateRange = $state<{ preset: DateRangePreset; from?: number; to?: number }>({ preset: "30d" });

export interface MeState {
  loaded: boolean;
  data: import("@tornscope/shared").MeResponse | null;
  error: string | null;
}

export const me = $state<MeState>({ loaded: false, data: null, error: null });

export async function refreshMe(): Promise<void> {
  const { endpoints } = await import("./api.js");
  try {
    me.data = await endpoints.me();
    me.error = null;
  } catch (err) {
    me.error = (err as Error).message;
  } finally {
    me.loaded = true;
  }
}

export function setPreset(preset: DateRangePreset): void {
  dateRange.preset = preset;
  dateRange.from = undefined;
  dateRange.to = undefined;
}

export function setCustomRange(from: number, to: number): void {
  dateRange.preset = "custom";
  dateRange.from = from;
  dateRange.to = to;
}
