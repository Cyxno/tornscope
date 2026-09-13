import { z } from "zod";
import { ProvenanceSchema } from "./contracts.js";

/**
 * Today / live status contracts.
 *
 * All timestamps are absolute unix SECONDS (Torn convention) unless the field
 * name ends in `At` with a `Ms` suffix. Countdown rendering happens client-side
 * from these absolute timestamps; the backend never needs per-second calls.
 *
 * Every timed section prefers the shape:
 *   { state, value?, max?, endsAt, remainingSeconds, provenance }
 * and degrades to `state: "unavailable"` with a reason / required access note
 * instead of failing the whole page when Torn denies or omits a selection.
 */

/* -------------------------------------------------------------------------- */
/* Bars                                                                       */
/* -------------------------------------------------------------------------- */

export const TODAY_BAR_KEYS = ["energy", "nerve", "happy", "life"] as const;
export type TodayBarKey = (typeof TODAY_BAR_KEYS)[number];

export const TODAY_BAR_LABELS: Record<TodayBarKey, string> = {
  energy: "Energy",
  nerve: "Nerve",
  happy: "Happy",
  life: "Life",
};

export const BAR_REGEN_STATES = ["regenerating", "full", "paused", "unknown"] as const;
export type BarRegenState = (typeof BAR_REGEN_STATES)[number];

export const LiveBarSchema = z.object({
  key: z.enum(TODAY_BAR_KEYS),
  label: z.string(),
  current: z.number(),
  max: z.number(),
  percent: z.number(),
  /** Amount regenerated per Torn tick (null when Torn does not expose it). */
  increment: z.number().nullable(),
  /** Seconds between regen ticks (null when not exposed). */
  intervalSeconds: z.number().nullable(),
  /** Absolute unix seconds when the bar reaches max (Torn `full_time`). */
  fullAt: z.number().nullable(),
  remainingSeconds: z.number().nullable(),
  /** Estimated units regenerated per hour (derived, null when indeterminable). */
  regenPerHour: z.number().nullable(),
  regenState: z.enum(BAR_REGEN_STATES),
  provenance: ProvenanceSchema,
});
export type LiveBar = z.infer<typeof LiveBarSchema>;

/** Primitives exactly as Torn's `/user/bars` UserBar object provides them. */
export interface TornBarPrimitives {
  current: number;
  maximum: number;
  increment: number;
  interval: number;
  full_time: number;
}

/** Clamp helper shared by bar math. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Build a LiveBar from Torn primitives. Never invents a full time:
 * when Torn reports full_time = 0 while the bar is not full, regen is
 * paused/capped and remainingSeconds stays null ("full time unavailable").
 *
 * Torn v2 /user/bars `full_time` is SECONDS REMAINING until the bar is full
 * (verified live 2026-09: energy 25/150 -> full_time 14540). Some older
 * payloads exposed an absolute unix timestamp, so values that already look
 * like epoch seconds (>= 1e9) pass through untouched — both shapes land on
 * an absolute fullAt and "full in 0s" becomes impossible.
 */
export function buildLiveBar(nowSec: number, key: TodayBarKey, torn: TornBarPrimitives): LiveBar {
  const max = torn.maximum > 0 ? torn.maximum : 0;
  const current = clamp(torn.current, 0, max || torn.current);
  const percent = max > 0 ? clamp((current / max) * 100, 0, 100) : 0;
  const fullAt = torn.full_time > 0 ? (torn.full_time >= 1e9 ? torn.full_time : nowSec + torn.full_time) : null;
  const full = max > 0 && current >= max;
  const regenPerHour =
    torn.increment > 0 && torn.interval > 0 ? (torn.increment / torn.interval) * 3600 : null;

  const regenState: BarRegenState = full ? "full" : fullAt ? "regenerating" : "paused";

  return {
    key,
    label: TODAY_BAR_LABELS[key],
    current,
    max,
    percent: Math.round(percent * 10) / 10,
    increment: torn.increment > 0 ? torn.increment : null,
    intervalSeconds: torn.interval > 0 ? torn.interval : null,
    fullAt,
    remainingSeconds: fullAt !== null ? Math.max(0, fullAt - nowSec) : null,
    regenPerHour: regenPerHour !== null ? Math.round(regenPerHour * 100) / 100 : null,
    regenState,
    provenance: "exact",
  };
}

/* -------------------------------------------------------------------------- */
/* Cooldowns                                                                  */
/* -------------------------------------------------------------------------- */

export const COOLDOWN_KINDS = ["drug", "booster", "medical"] as const;
export type CooldownKind = (typeof COOLDOWN_KINDS)[number];

export const COOLDOWN_LABELS: Record<CooldownKind, string> = {
  drug: "Drug cooldown",
  booster: "Booster cooldown",
  medical: "Medical cooldown",
};

export const CooldownStateSchema = z.object({
  kind: z.enum(COOLDOWN_KINDS),
  label: z.string(),
  state: z.enum(["active", "ready"]),
  /** Absolute unix seconds when the cooldown clears (null when ready). */
  endsAt: z.number().nullable(),
  remainingSeconds: z.number().nullable(),
  provenance: ProvenanceSchema,
});
export type CooldownState = z.infer<typeof CooldownStateSchema>;

/** Build a cooldown state from Torn's seconds-remaining value. */
export function buildCooldown(nowSec: number, kind: CooldownKind, secondsRemaining: number): CooldownState {
  const active = secondsRemaining > 0;
  return {
    kind,
    label: COOLDOWN_LABELS[kind],
    state: active ? "active" : "ready",
    endsAt: active ? nowSec + secondsRemaining : null,
    remainingSeconds: active ? secondsRemaining : null,
    provenance: "exact",
  };
}

/* -------------------------------------------------------------------------- */
/* Travel                                                                     */
/* -------------------------------------------------------------------------- */

export const TravelStatusSchema = z.object({
  state: z.enum(["home", "abroad", "traveling", "unavailable"]),
  /** Country while abroad, destination while outbound, origin when returning. */
  country: z.string().nullable(),
  direction: z.enum(["outbound", "returning"]).nullable(),
  method: z.string().nullable(),
  departedAt: z.number().nullable(),
  /** Absolute unix seconds of landing / arriving home. */
  landsAt: z.number().nullable(),
  remainingSeconds: z.number().nullable(),
  durationSeconds: z.number().nullable(),
  provenance: ProvenanceSchema,
  unavailableReason: z.string().nullable().default(null),
  requiredAccess: z.string().nullable().default(null),
});
export type TravelStatus = z.infer<typeof TravelStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Bank investment                                                            */
/* -------------------------------------------------------------------------- */

export const BankStatusSchema = z.object({
  state: z.enum(["active", "mature", "none", "unavailable"]),
  /**
   * Current city-bank investment value incl. accrued profit — equals the
   * city-bank component of Torn's net worth. This is the EXPECTED PAYOUT.
   */
  amount: z.number().nullable(),
  /** Invested principal = amount - profit (both exact Torn values). */
  principal: z.number().nullable(),
  /** Exact profit Torn projects for the investment (null when not exposed). */
  profit: z.number().nullable(),
  /**
   * Total-period return: profit / principal * 100 — derived from exact Torn
   * amounts. Torn's raw `interest_rate` field is deliberately NOT shown: its
   * value does not reconcile with the actual principal/profit movement
   * (e.g. rate 41.24 alongside profit/principal = 2.37%), so the meaning is
   * unverifiable and displaying it misleads.
   */
  returnPct: z.number().nullable(),
  /** Simple annualized rate: returnPct * 365 / durationDays (derived). */
  annualizedPct: z.number().nullable(),
  durationDays: z.number().nullable(),
  investedAt: z.number().nullable(),
  maturesAt: z.number().nullable(),
  remainingSeconds: z.number().nullable(),
  provenance: ProvenanceSchema,
  unavailableReason: z.string().nullable().default(null),
  requiredAccess: z.string().nullable().default(null),
});
export type BankStatus = z.infer<typeof BankStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Education                                                                  */
/* -------------------------------------------------------------------------- */

export const EducationStatusSchema = z.object({
  state: z.enum(["active", "complete", "none", "unavailable"]),
  courseId: z.number().nullable(),
  courseName: z.string().nullable(),
  categoryName: z.string().nullable(),
  completesAt: z.number().nullable(),
  remainingSeconds: z.number().nullable(),
  provenance: ProvenanceSchema,
  unavailableReason: z.string().nullable().default(null),
  requiredAccess: z.string().nullable().default(null),
});
export type EducationStatus = z.infer<typeof EducationStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Hospital / jail notices                                                    */
/* -------------------------------------------------------------------------- */

export const StatusNoticeSchema = z.object({
  kind: z.enum(["hospital", "jail"]),
  reason: z.string().nullable(),
  releasedAt: z.number().nullable(),
  remainingSeconds: z.number().nullable(),
  provenance: ProvenanceSchema,
});
export type StatusNotice = z.infer<typeof StatusNoticeSchema>;

/** Torn player status (profile.status) as Today consumes it. */
export const PlayerStatusSchema = z.object({
  /** Torn state string: Okay, Hospital, Jail, Federal, Traveling, Abroad, ... */
  state: z.string(),
  description: z.string().nullable(),
  details: z.string().nullable(),
  until: z.number().nullable(),
});
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Upcoming timeline                                                          */
/* -------------------------------------------------------------------------- */

export const UPCOMING_SEVERITIES = ["info", "success", "warning", "critical"] as const;
export type UpcomingSeverity = (typeof UPCOMING_SEVERITIES)[number];

export const UPCOMING_CATEGORIES = ["bar", "cooldown", "travel", "education", "bank", "status"] as const;
export type UpcomingCategory = (typeof UPCOMING_CATEGORIES)[number];

export const UpcomingEventSchema = z.object({
  /** Stable dedup key, e.g. "bar:energy", "cooldown:drug", "travel:landing". */
  id: z.string(),
  category: z.enum(UPCOMING_CATEGORIES),
  title: z.string(),
  /** Absolute unix seconds of the event. */
  at: z.number(),
  remainingSeconds: z.number(),
  severity: z.enum(UPCOMING_SEVERITIES),
});
export type UpcomingEvent = z.infer<typeof UpcomingEventSchema>;

/**
 * Merge future account timers into one chronological list (soonest first).
 * Drops non-finite timestamps and already-past events; caps length.
 */
export function buildUpcomingEvents(events: UpcomingEvent[], limit = 12): UpcomingEvent[] {
  return events
    .filter((e) => Number.isFinite(e.at) && e.at > 0 && e.remainingSeconds >= 0)
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Countdown formatting (pure, timezone-safe)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Zero-padded clock countdown, e.g. "00:42:11" or "2d 03:14:08".
 * Negative remaining renders as "00:00:00".
 */
export function formatCountdownClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return "00:00:00";
  }
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const rest = total % 86_400;
  const h = Math.floor(rest / 3600);
  const m = Math.floor((rest % 3600) / 60);
  const s = rest % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  const clock = `${p(h)}:${p(m)}:${p(s)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

/**
 * Compact human countdown: "42s", "3m 17s", "18m 42s", "1h 18m", "3d 18h".
 * Whole minutes drop the trailing seconds.
 */
export function formatCountdownCompact(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return "0s";
  }
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes >= 1) return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  return `${secs}s`;
}

/**
 * Timezone-safe remaining seconds between a reference instant (ms) and an
 * absolute unix-seconds timestamp. Pure arithmetic on absolute time — no
 * local-clock or DST assumptions.
 */
export function remainingSeconds(nowMs: number, endsAtSec: number | null | undefined): number | null {
  if (endsAtSec === null || endsAtSec === undefined || !Number.isFinite(endsAtSec)) return null;
  return Math.max(0, Math.round(endsAtSec - nowMs / 1000));
}

/* -------------------------------------------------------------------------- */
/* Status transition detection                                                */
/* -------------------------------------------------------------------------- */

/**
 * A meaningful live-state transition (e.g. landed, matured, released).
 * `key` is a stable deduplication key: detecting the same transition twice
 * yields the same key so upstream writers can skip duplicates.
 */
export interface StatusTransition {
  key: string;
  kind: "travel_landed" | "education_complete" | "bank_matured" | "hospital_released" | "jail_released";
  at: number;
  title: string;
}

interface TransitionInput {
  travel: Pick<TravelStatus, "state" | "landsAt" | "country"> | null;
  education: Pick<EducationStatus, "state" | "completesAt" | "courseName"> | null;
  bank: Pick<BankStatus, "state" | "maturesAt"> | null;
  hospital: Pick<StatusNotice, "releasedAt"> | null;
  jail: Pick<StatusNotice, "releasedAt"> | null;
}

/**
 * Detect transitions where the PREVIOUS state was pending and the CURRENT
 * state shows it resolved. Keys embed the affected timestamp, so a repeated
 * detection of the same resolution never produces a second key.
 */
export function detectTransitions(previous: TransitionInput, current: TransitionInput): StatusTransition[] {
  const out: StatusTransition[] = [];

  const landed =
    (previous.travel?.state === "traveling" || previous.travel?.state === "abroad") &&
    current.travel?.state !== "traveling" &&
    current.travel?.state !== "abroad" &&
    previous.travel?.landsAt;
  if (landed) {
    out.push({
      key: `travel:landed:${previous.travel?.landsAt}`,
      kind: "travel_landed",
      at: previous.travel?.landsAt ?? 0,
      title: "Landed home",
    });
  }

  const eduDone =
    previous.education?.state === "active" &&
    (current.education?.state === "complete" || current.education?.state === "none") &&
    previous.education?.completesAt;
  if (eduDone) {
    out.push({
      key: `education:complete:${previous.education?.completesAt}`,
      kind: "education_complete",
      at: previous.education?.completesAt ?? 0,
      title: `Education complete${previous.education?.courseName ? `: ${previous.education.courseName}` : ""}`,
    });
  }

  const bankMatured = previous.bank?.state === "active" && current.bank?.state !== "active" && previous.bank?.maturesAt;
  if (bankMatured) {
    out.push({
      key: `bank:matured:${previous.bank?.maturesAt}`,
      kind: "bank_matured",
      at: previous.bank?.maturesAt ?? 0,
      title: "Bank investment matured",
    });
  }

  const hospitalReleased =
    previous.hospital?.releasedAt !== null &&
    previous.hospital?.releasedAt !== undefined &&
    current.hospital === null &&
    previous.hospital?.releasedAt;
  if (hospitalReleased) {
    out.push({
      key: `hospital:released:${previous.hospital?.releasedAt}`,
      kind: "hospital_released",
      at: previous.hospital?.releasedAt ?? 0,
      title: "Released from hospital",
    });
  }

  const jailReleased =
    previous.jail?.releasedAt !== null &&
    previous.jail?.releasedAt !== undefined &&
    current.jail === null &&
    previous.jail?.releasedAt;
  if (jailReleased) {
    out.push({
      key: `jail:released:${previous.jail?.releasedAt}`,
      kind: "jail_released",
      at: previous.jail?.releasedAt ?? 0,
      title: "Released from jail",
    });
  }

  return out;
}

/** Drop transitions whose stable key was already recorded (idempotent writes). */
export function filterNewTransitions(
  transitions: StatusTransition[],
  seenKeys: ReadonlySet<string>
): { fresh: StatusTransition[]; seenKeys: Set<string> } {
  const seen = new Set(seenKeys);
  const fresh: StatusTransition[] = [];
  for (const t of transitions) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    fresh.push(t);
  }
  return { fresh, seenKeys: seen };
}

/* -------------------------------------------------------------------------- */
/* Today response                                                             */
/* -------------------------------------------------------------------------- */

export const TodayResponseSchema = z.object({
  /** Server wall clock at response build (unix ms) — used for skew correction. */
  fetchedAt: z.number(),
  /** Server clock in unix seconds. */
  serverTime: z.number(),
  /** True when the payload is simulated demo live data, not a real account. */
  demo: z.boolean(),
  /** True when this response is the persisted last-known payload, served
   *  immediately while a fresh upstream refresh runs in the background
   *  (stale-while-revalidate). Surfaces must show a freshness marker. */
  stale: z.boolean().optional(),
  player: z.object({
    name: z.string().nullable(),
    level: z.number().nullable(),
    status: PlayerStatusSchema,
  }),
  bars: z.object({
    energy: LiveBarSchema.nullable(),
    nerve: LiveBarSchema.nullable(),
    happy: LiveBarSchema.nullable(),
    life: LiveBarSchema.nullable(),
  }),
  cooldowns: z.object({
    drug: CooldownStateSchema.nullable(),
    booster: CooldownStateSchema.nullable(),
    medical: CooldownStateSchema.nullable(),
  }),
  travel: TravelStatusSchema,
  bank: BankStatusSchema,
  education: EducationStatusSchema,
  hospital: StatusNoticeSchema.nullable(),
  jail: StatusNoticeSchema.nullable(),
  upcoming: z.array(UpcomingEventSchema),
  access: z.object({
    level: z.number().nullable(),
    type: z.string().nullable(),
    /** Set when a section is limited by the key's access level. */
    note: z.string().nullable(),
  }),
});
export type TodayResponse = z.infer<typeof TodayResponseSchema>;

/** Torn API access levels (/key/info access.level). */
export const TORN_ACCESS_LEVELS = { public: 1, minimal: 2, limited: 3, full: 4 } as const;

/** Human name for a stored numeric access level. */
export function accessLevelName(level: number | null | undefined): string {
  if (level === null || level === undefined) return "unknown";
  if (level >= TORN_ACCESS_LEVELS.full) return "Full";
  if (level >= TORN_ACCESS_LEVELS.limited) return "Limited";
  if (level >= TORN_ACCESS_LEVELS.minimal) return "Minimal";
  return "Public";
}

/* -------------------------------------------------------------------------- */
/* First-run setup phase                                                      */
/* -------------------------------------------------------------------------- */

export const SETUP_PHASES = [
  "no_key",
  "queued",
  "syncing",
  "partial",
  "caught_up",
  "failed",
] as const;
export type SetupPhase = (typeof SETUP_PHASES)[number];

export interface SetupResourceSnapshot {
  status: string;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
}

/**
 * Derive the first-run phase from per-resource sync states. Pure function so
 * the API and tests share one definition:
 * - no_key:   no active credential
 * - queued:   key exists but nothing has been attempted/completed yet
 * - syncing:  at least one resource currently running
 * - partial:  some resources succeeded, others still pending/backfilling
 * - caught_up: every resource has succeeded at least once
 * - failed:   no success anywhere and at least one failure
 */
export function deriveSetupPhase(input: { hasApiKey: boolean; resources: SetupResourceSnapshot[] }): SetupPhase {
  if (!input.hasApiKey) return "no_key";
  const resources = input.resources;
  if (resources.length === 0) return "queued";

  if (resources.some((r) => r.status === "running")) return "syncing";

  const succeeded = resources.filter((r) => r.lastSuccessAt !== null);
  const attempted = resources.filter((r) => r.lastAttemptAt !== null);

  if (succeeded.length === resources.length) return "caught_up";
  if (succeeded.length > 0) return "partial";
  if (attempted.length > 0 && resources.some((r) => r.status === "failed")) return "failed";
  return "queued";
}
