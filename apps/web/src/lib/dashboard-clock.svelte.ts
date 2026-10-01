/**
 * ONE shared dashboard ticker for the whole Overview cockpit (2.0.5/2.0.7).
 *
 * LiveNow, CommandCenter and the Heads-up layer all need a 1-second "now",
 * but each running its own setInterval duplicates work and multiplies wakeups.
 *
 * 2.0.7: the clock starts ONCE at module import (never inside a $derived
 * context — writing state during derivation is a Svelte error) and
 * `dashboardNow()` is a pure read. The value is MONOTONIC: anchored to
 * performance.now() and clamped non-decreasing, so server-clock corrections
 * via `setDashboardClockOffset` can never drag countdowns backwards.
 */

const state = $state({ nowMs: Date.now() });
let anchorPerf: number | null = null;

function reanchor(wallMs: number): void {
  if (typeof performance !== "undefined" && anchorPerf !== null) {
    const projected = state.nowMs + (performance.now() - anchorPerf);
    anchorPerf = performance.now();
    state.nowMs = Math.max(projected, wallMs);
  } else {
    anchorPerf = typeof performance !== "undefined" ? performance.now() : null;
    state.nowMs = wallMs;
  }
}

if (typeof document !== "undefined") {
  reanchor(Date.now());
  // No visibility gate: the clock is ONE 1s interval for the whole cockpit
  // (trivial cost) and freezing it would freeze every countdown — including
  // around landings, where it matters most.
  setInterval(() => {
    const base = anchorPerf !== null && typeof performance !== "undefined" ? state.nowMs + (performance.now() - anchorPerf) : Date.now();
    reanchor(Math.round(base));
  }, 1000);
}

/** Reactive, MONOTONIC wall clock (unix ms). Pure read — no side effects. */
export function dashboardNow(): number {
  return state.nowMs;
}

/**
 * Server-clock skew correction (fetchedAt − local at fetch time). Clamped
 * non-decreasing: a delayed/older response can never move the shared clock
 * (and therefore any countdown) backwards.
 */
export function setDashboardClockOffset(offsetMs: number): void {
  if (!Number.isFinite(offsetMs)) return;
  reanchor(Date.now() + offsetMs);
}
