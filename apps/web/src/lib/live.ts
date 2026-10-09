import { formatCountdownCompact, remainingSeconds } from "@tornscope/shared";

/**
 * Shared live-state presentation semantics for Today AND the Overview
 * "Right now" strip. One calculation per payload: the same payload + same
 * server clock must render identically on every page.
 *
 * The "Ready · just now" bug happened because Overview formatted an
 * expired-cached cooldown's endsAt with a relative-time helper. These
 * helpers encode the rule once: a cooldown whose clock ran out (or whose
 * state is already "ready") is Ready — a countdown is shown only while the
 * timer is genuinely still running.
 */

export interface CooldownLike {
  state: "active" | "ready";
  endsAt: number | null;
}

/**
 * Plausible api↔browser clock skew (2.6.2). Both endpoints are NTP-class
 * clocks; a fetchedAt further from local time than this is a corrupt stamp
 * (broken clock at fetch time), not a real reading. Corrupt stamps must
 * never drive clock sync or freshness ordering: a future-fetchedAt payload
 * once fast-forwarded the shared dashboard clock — every cooldown rendered
 * "Ready" with a frozen countdown — and its fetchedAt then discarded every
 * genuinely fresh response, making the broken state permanent.
 */
export const PAYLOAD_CLOCK_TOLERANCE_MS = 5 * 60_000;

/** Clock offset (ms) a payload's fetchedAt may drive, or null when the
 *  stamp is impossible (non-finite, non-positive, or beyond the plausible
 *  skew bound in either direction). */
export function plausibleClockOffsetMs(fetchedAtMs: number, nowMs: number): number | null {
  if (!Number.isFinite(fetchedAtMs) || fetchedAtMs <= 0) return null;
  const offset = fetchedAtMs - nowMs;
  if (Math.abs(offset) > PAYLOAD_CLOCK_TOLERANCE_MS) return null;
  return offset;
}

/**
 * Response ordering for Today payloads: may `incoming` replace the held
 * payload? True only for a plausible incoming stamp that is not older than
 * a plausible held one. A held payload with an impossible-future fetchedAt
 * is corrupt and can NEVER suppress a fresh response — the permanent-ready
 * regression hinged on exactly that suppression. (Out-of-order delivery —
 * held genuinely newer than incoming — still keeps the held payload.)
 */
export function isNewerTodayPayload(
  heldFetchedAtMs: number | null | undefined,
  incomingFetchedAtMs: number,
  nowMs: number
): boolean {
  if (plausibleClockOffsetMs(incomingFetchedAtMs, nowMs) === null) return false;
  if (heldFetchedAtMs === null || heldFetchedAtMs === undefined || !Number.isFinite(heldFetchedAtMs)) return true;
  if (plausibleClockOffsetMs(heldFetchedAtMs, nowMs) === null) return true;
  return incomingFetchedAtMs >= heldFetchedAtMs;
}

export interface CooldownDisplay {
  /** "Ready" when the cooldown has cleared; countdown text while active. */
  text: string;
  /** False once Ready — UI should not append relative-time suffixes. */
  active: boolean;
  /** Seconds left while active; null when ready. */
  remainingSeconds: number | null;
}

export function cooldownDisplay(
  cd: CooldownLike | null | undefined,
  serverNowMs: number
): CooldownDisplay | null {
  if (!cd) return null;
  // A cached "active" cooldown whose clock ran out is Ready NOW — never
  // "Ready just now", never 00:00:00.
  if (cd.state === "ready") return { text: "Ready", active: false, remainingSeconds: null };
  const left = remainingSeconds(serverNowMs, cd.endsAt);
  if (left === null) return { text: "Ready", active: false, remainingSeconds: null };
  if (left <= 0) return { text: "Ready", active: false, remainingSeconds: null };
  return { text: formatCountdownCompact(left), active: true, remainingSeconds: left };
}

export interface BarFullDisplay {
  text: string;
  full: boolean;
  /** Seconds until full; null when full or indeterminable. */
  remainingSeconds: number | null;
  /** current exceeds the natural cap (stacking) — regen stopped, no countdown. */
  overCap: boolean;
  /** How far current is over the natural cap (0 unless overCap). */
  overBy: number;
  /** Bar fill derived from current/max AT RENDER TIME (0-100) — a cached
   *  `percent` field is never trusted (stale snapshot invariant). */
  pct: number;
  /** The payload's full-time boundary has passed while current is still
   *  below max — the fields cannot both be true in a live Torn read, so the
   *  snapshot they came from is stale or corrupt. Renders as "regen
   *  unknown", never as Full. */
  boundaryPassed: boolean;
}

/** Bar fill from current/max — the ONLY trusted source of the percentage. */
export function barFillPct(bar: { current: number; max: number }): number {
  if (!(bar.max > 0)) return 0;
  return Math.min(100, Math.max(0, (bar.current / bar.max) * 100));
}

/** Canonical over-cap copy, shared by Today and the Overview Right-now board. */
export function overCapText(overBy: number): string {
  return `Stacked · +${overBy.toLocaleString("en-US")} over cap`;
}

export function barFullDisplay(
  bar: { current: number; max: number; fullAt: number | null; regenState: string } | null | undefined,
  serverNowMs: number
): BarFullDisplay | null {
  if (!bar) return null;
  const pct = barFillPct(bar);
  // Stacked (Xanax, training stacks): current legitimately exceeds the
  // natural cap. Regen is stopped and Torn supplies no full time — show the
  // real numbers with the over-cap amount, never a countdown and never the
  // "not regenerating" fallback.
  const overBy = Math.max(0, bar.current - bar.max);
  if (overBy > 0) {
    return { text: overCapText(overBy), full: false, remainingSeconds: null, overCap: true, overBy, pct: 100, boundaryPassed: false };
  }
  // INVARIANT (2.6.2): current < max ⇒ NEVER Full — a cached `regenState:
  // "full"` is only believed when current >= max agrees, and an expired
  // fullAt never promotes the bar to Full by itself. Both shapes occur on a
  // stale snapshot (the value fields are old, the boundary has since passed)
  // and rendered as "25 / 150 — Full · 100%". A live Torn read cannot
  // produce them, so the honest render is "regen unknown".
  if (bar.current >= bar.max) {
    return { text: "Full", full: true, remainingSeconds: null, overCap: false, overBy: 0, pct: 100, boundaryPassed: false };
  }
  if (bar.regenState === "regenerating" && bar.fullAt !== null) {
    const left = remainingSeconds(serverNowMs, bar.fullAt);
    if (left !== null && left > 0) {
      return { text: `Full in ${formatCountdownCompact(left)}`, full: false, remainingSeconds: left, overCap: false, overBy: 0, pct, boundaryPassed: false };
    }
  }
  // Regen paused/unknown (or a stale boundary): never invent a timer, never Full.
  return {
    text: "—",
    full: false,
    remainingSeconds: null,
    overCap: false,
    overBy: 0,
    pct,
    boundaryPassed: bar.fullAt !== null && bar.fullAt <= Math.floor(serverNowMs / 1000),
  };
}
