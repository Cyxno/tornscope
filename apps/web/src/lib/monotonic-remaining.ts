/**
 * Monotonic cockpit timers (2.0.7) — per-event-identity countdown projection.
 *
 * SERVER DATA = CHECKPOINT. BROWSER TIMER = LIVE PROJECTION.
 * When TornScope reliably knows landsAt/endsAt/readyAt/maturesAt, the
 * remaining time is derived locally; Torn does not need to re-confirm every
 * 30 seconds that 14:32 is getting closer.
 *
 * Guarantees (per event identity = `${key}:${dueAt}`):
 * - remaining NEVER increases between responses for the same dueAt — clock
 *   skew corrections, delayed responses and older snapshots cannot make a
 *   countdown jump up;
 * - a genuinely NEW dueAt (Torn reports a changed state) resets the timer —
 *   with one anti-wobble guard: an arrival-time change of ≤ 90 s is treated
 *   as server-side rounding noise and keeps the earlier dueAt, so
 *   "2h → 1h50m → 2h" wobble cannot render;
 * - out-of-order responses are handled by the identity check itself: an
 *   older response with the SAME dueAt only ever clamps (never raises), and
 *   one with a different dueAt is a new identity that must come from a
 *   newer fetch (callers gate on fetchedAt via acceptToday).
 */

interface MonotonicEntry {
  dueAt: number;
  minRemaining: number;
  updatedAt: number;
}

const entries = new Map<string, MonotonicEntry>();

/** Anti-wobble: arrival estimates wobble by ±1 min server-side. */
export const DUEAT_WOBBLE_TOLERANCE_SEC = 90;

/** Max tracked identities (bounded memory; prune on access). */
const MAX_ENTRIES = 256;

export interface MonotonicResult {
  /** Display remaining (monotonic non-increasing for a stable dueAt). */
  remainingSeconds: number;
  /** The stabilized dueAt actually displayed against. */
  dueAt: number;
  /** True when the dueAt was accepted as a genuine change (timer reset). */
  identityChanged: boolean;
}

function prune(nowSec: number): void {
  if (entries.size <= MAX_ENTRIES) return;
  for (const [k, e] of entries) {
    if (nowSec - e.updatedAt > 86_400) entries.delete(k);
  }
}

/**
 * Project remaining seconds for `identityKey` toward `dueAt` at `nowSec`.
 * Monotonic per identity; dueAt wobble ≤ 90 s keeps the earlier dueAt.
 */
export function monotonicRemaining(identityKey: string, dueAtSec: number, nowSec: number): MonotonicResult {
  prune(nowSec);
  const prev = entries.get(identityKey);

  if (prev) {
    const wobble = Math.abs(dueAtSec - prev.dueAt);
    if (wobble > 0 && wobble <= DUEAT_WOBBLE_TOLERANCE_SEC) {
      dueAtSec = prev.dueAt; // server rounding noise — keep the established boundary
    }
  }

  const identityChanged = prev === undefined || prev.dueAt !== dueAtSec;
  const rawRemaining = Math.round(dueAtSec - nowSec);
  let remaining = rawRemaining;

  if (!identityChanged) {
    // Same boundary: monotonic clamp (clock skew / older snapshot can only
    // hold the countdown steady, never push it back up).
    remaining = Math.min(rawRemaining, prev!.minRemaining);
  }

  entries.set(identityKey, { dueAt: dueAtSec, minRemaining: remaining, updatedAt: nowSec });
  return { remainingSeconds: Math.max(0, remaining), dueAt: dueAtSec, identityChanged };
}

/** Test/dev hook: clear all tracked identities. */
export function resetMonotonicTimers(): void {
  entries.clear();
}
