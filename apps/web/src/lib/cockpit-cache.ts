/**
 * Browser cockpit snapshot (2.0.7) — CACHE-FIRST cockpit rendering.
 *
 * The Overview renders instantly from the best locally known state, then
 * revalidates in the background. Priority order:
 *   1. in-memory session state (component $state),
 *   2. this persisted browser snapshot (localStorage, versioned, per user),
 *   3. server latest-known state (/api/today persisted copy),
 *   4. background revalidation (never blocking).
 *
 * Stored: ONLY the live-status subset + timestamps. No API keys, no
 * identifiers beyond the owning userId in the storage KEY (so a different
 * profile on a shared browser never reads another's snapshot).
 *
 * STALE ≠ UNUSABLE: timer-based states stay perfectly usable from
 * timestamps (landsAt in the future is a confirmed fact), so the snapshot
 * is served regardless of age and refreshed in the background.
 */

const SCHEMA_VERSION = 1;
const KEY_PREFIX = "tornscope.cockpit.v";

export interface CockpitSnapshot {
  schema: number;
  userId: string;
  fetchedAtMs: number;
  /** Live-status subset of the Today payload (bars/cooldowns/travel/education/bank/notices/player). */
  today: unknown;
  /** Participating active OCs (name/tier/status/readyAt/myParticipation). */
  ocs: unknown;
  /** Median travel durations per destination (travel/OC conflict input). */
  travelDurations: Record<string, number> | null;
}

function keyFor(userId: string): string {
  return `${KEY_PREFIX}${SCHEMA_VERSION}:${userId}`;
}

/** Persist the cockpit subset for THIS user. Never throws. */
export function saveCockpitSnapshot(userId: string, data: { fetchedAtMs: number; today: unknown; ocs: unknown; travelDurations: Record<string, number> | null }): void {
  if (typeof localStorage === "undefined" || !userId) return;
  try {
    const snap: CockpitSnapshot = { schema: SCHEMA_VERSION, userId, ...data };
    localStorage.setItem(keyFor(userId), JSON.stringify(snap));
  } catch {
    // Storage unavailable/full — cache-first degrades to in-memory only.
  }
}

/**
 * Load the snapshot for THIS user. Returns null when absent, from another
 * schema version, or belonging to a different profile (user switch).
 */
export function loadCockpitSnapshot(userId: string): CockpitSnapshot | null {
  if (typeof localStorage === "undefined" || !userId) return null;
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const snap = JSON.parse(raw) as CockpitSnapshot;
    if (snap.schema !== SCHEMA_VERSION || snap.userId !== userId) return null;
    if (typeof snap.fetchedAtMs !== "number" || !snap.today) return null;
    return snap;
  } catch {
    return null;
  }
}

/** Remove this user's snapshot (logout, profile deletion, user switch). */
export function clearCockpitSnapshot(userId: string): void {
  if (typeof localStorage === "undefined" || !userId) return;
  try {
    localStorage.removeItem(keyFor(userId));
  } catch {
    // Nothing to do — absence is the goal.
  }
}

/**
 * Snapshot freshness for the mount policy:
 * - FRESH (< 120s): skip the today request entirely — pure client projection.
 * - STALE-BUT-USABLE: render snapshot now, revalidate in the background.
 */
export const COCKPIT_FRESH_MS = 120_000;

export function snapshotAgeMs(snap: CockpitSnapshot | null, nowMs: number): number | null {
  if (!snap) return null;
  return Math.max(0, nowMs - snap.fetchedAtMs);
}

export function shouldSkipTodayRequest(snap: CockpitSnapshot | null, nowMs: number): boolean {
  const age = snapshotAgeMs(snap, nowMs);
  return age !== null && age < COCKPIT_FRESH_MS;
}
