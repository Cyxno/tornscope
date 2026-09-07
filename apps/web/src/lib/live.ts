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
}

export function barFullDisplay(
  bar: { current: number; max: number; fullAt: number | null; regenState: string } | null | undefined,
  serverNowMs: number
): BarFullDisplay | null {
  if (!bar) return null;
  if (bar.regenState === "full" || bar.current >= bar.max) {
    return { text: "Full", full: true, remainingSeconds: null };
  }
  if (bar.regenState === "regenerating" && bar.fullAt !== null) {
    const left = remainingSeconds(serverNowMs, bar.fullAt);
    if (left === null || left <= 0) return { text: "Full", full: true, remainingSeconds: null };
    return { text: `Full in ${formatCountdownCompact(left)}`, full: false, remainingSeconds: left };
  }
  // Regen paused/unknown: never invent a timer.
  return { text: "—", full: false, remainingSeconds: null };
}
