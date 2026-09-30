/**
 * ONE shared dashboard ticker for the whole Overview cockpit (2.0.5).
 *
 * LiveNow, CommandCenter and the Heads-up layer all need a 1-second "now",
 * but each running its own setInterval duplicates work and multiplies wakeups.
 * This module owns the single interval (visibility-gated) and hands out the
 * reactive value. Components import `dashboardNow` — reading it inside a
 * template/derived expression subscribes them to the tick.
 */
import { onMount } from "svelte";

const state = $state({ nowMs: Date.now() });
let started = false;

export function startDashboardClock(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  setInterval(() => {
    if (document.visibilityState === "visible") state.nowMs = Date.now();
  }, 1000);
}

/** Reactive server-agnostic wall clock (unix ms). */
export function dashboardNow(): number {
  startDashboardClock();
  return state.nowMs;
}

/** Server-clock skew correction, set once a Today payload has landed. */
export function setDashboardClockOffset(offsetMs: number): void {
  if (Number.isFinite(offsetMs)) state.nowMs = Date.now() + offsetMs;
}
