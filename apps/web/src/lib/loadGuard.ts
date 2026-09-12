/**
 * Stale-response guard for page loads driven by the shared date-range state.
 *
 * Switching range/launches a new request while the previous one may still be
 * in flight; a slower older response must never overwrite the newer view
 * (the same contract DailySummary's loadSeq already enforces).
 *
 *   const guard = createLoadGuard();
 *   async function load() {
 *     const seq = guard.begin();
 *     ...
 *     if (!guard.isCurrent(seq)) return; // superseded — discard
 *     data = res;
 *   }
 */
export function createLoadGuard() {
  let seq = 0;
  return {
    begin: () => ++seq,
    isCurrent: (n: number) => n === seq,
  };
}
