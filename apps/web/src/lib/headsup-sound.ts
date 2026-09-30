/**
 * Heads-up local sound (2.0.5) — one short ping, strictly opt-in.
 *
 * Rules enforced here:
 * - WebAudio context is created lazily and UNLOCKED only by a real user
 *   gesture (one global pointerdown listener). If audio has never been
 *   unlocked, the ping is skipped silently — no autoplay hacks, no queued
 *   retries.
 * - One shot per call; nothing loops; gain is deliberately modest.
 * - The CALLER decides when to play (new unfired cue + sound enabled), so
 *   rerenders can never replay a sound.
 */

let ctx: AudioContext | null = null;
let unlocked = false;

function ensureUnlockListener(): void {
  if (unlocked || typeof document === "undefined") return;
  const unlock = (): void => {
    unlocked = true;
    try {
      ctx ??= new AudioContext();
      if (ctx.state === "suspended") void ctx.resume();
    } catch {
      // Audio unavailable — sound stays off, everything else works.
    }
    document.removeEventListener("pointerdown", unlock);
  };
  document.addEventListener("pointerdown", unlock, { once: true });
}

if (typeof document !== "undefined") ensureUnlockListener();

/** Play one short, modest ping. Returns whether a sound actually played. */
export function playHeadsUpPing(): boolean {
  if (!unlocked || ctx === null || ctx.state !== "running") return false;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
    return true;
  } catch {
    return false;
  }
}

/** Test hook: reset the unlock state (deterministic tests). */
export function resetHeadsUpSoundForTests(): void {
  ctx = null;
  unlocked = false;
}
