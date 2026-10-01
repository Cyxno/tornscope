/**
 * Heads-up layer (2.0.5) — ONE deterministic derivation that turns the live
 * Today payload (+ participating OCs) into the cockpit's anticipatory view:
 *
 *   "What is happening NOW, and what do I need to factor in soon?"
 *
 * Three consumers read the SAME model so timer semantics can never drift:
 *   - Overview active-state ordering (urgency tiers + time remaining),
 *   - the dashboard heads-up cues (threshold crossings),
 *   - the travel/OC conflict warning.
 *
 * Principles:
 * - STALE DATA NEVER SOUNDS ACTIONABLE: when the Today payload is stale
 *   (flag or age), every entry is marked stale and all actionable cues are
 *   suppressed.
 * - DETERMINISTIC EVENT KEYS (`type:dueAt:threshold`) make each threshold
 *   crossing a one-shot: rerenders, worker restarts and tab reopens cannot
 *   duplicate a cue (the caller persists fired keys).
 * - NO INTENT GUESSING: the travel/OC conflict is computed ONLY while a
 *   flight is actually in progress (or abroad), never for a hypothetical
 *   trip, and only when the destination's duration is known from the
 *   player's own recorded history.
 */
import type { TodayResponse } from "@tornscope/shared";
import { formatCountdownCompact } from "@tornscope/shared";

export type UpcomingType = "travel_landing" | "drug_ready" | "booster_ready" | "medical_ready" | "oc_ready" | "bank_matured" | "education_complete";

export interface UpcomingAction {
  type: UpcomingType;
  source: "today" | "faction";
  label: string;
  /** Destination / course name / "Ready to collect" context line. */
  state: string | null;
  dueAt: number;
  remainingSeconds: number;
  /** Payload staleness — actionable cues are suppressed when true. */
  stale: boolean;
  actionUrl: string;
  eventKeyBase: string;
  urgencyTier: 1 | 2 | 3 | 4;
}

export type Ocs = Array<{ name: string; tier: number | null; status: string; readyAt: number | null; myParticipation: boolean }>;

/** Payload staleness window — mirrors the travel freshness gate. */
export const HEADSUP_STALE_AFTER_SECONDS = 30 * 60;

/** Threshold options per type (minutes before the event); 0 = at-event only. */
export const HEADSUP_PRE_OPTIONS = {
  travel_landing: [0, 1, 2, 5],
  drug_ready: [0, 1, 2, 5],
  booster_ready: [0, 1, 2, 5],
  medical_ready: [0, 1, 2, 5],
  oc_ready: [0, 2, 5, 10],
  bank_matured: [0, 5, 10, 30],
  education_complete: [0],
} as const;

export type HeadsUpThresholds = { [K in keyof typeof HEADSUP_PRE_OPTIONS]: number };

/** Conservative defaults (2.0.5): travel T-2m, drug T-2m, OC T-5m, bank T-10m;
 *  booster/medical fire at-ready only; education is visual-only. */
export const HEADSUP_THRESHOLD_DEFAULTS: HeadsUpThresholds = {
  travel_landing: 2,
  drug_ready: 2,
  booster_ready: 0,
  medical_ready: 0,
  oc_ready: 5,
  bank_matured: 10,
  education_complete: 0,
};

const AT_EVENT_WINDOW_SECONDS = 10 * 60;

function isPayloadStale(today: TodayResponse, nowSec: number): boolean {
  const fetchedSec = Math.floor(today.fetchedAt / 1000);
  return today.stale === true || Math.max(0, nowSec - fetchedSec) > HEADSUP_STALE_AFTER_SECONDS;
}

/**
 * TRAVEL-SPECIFIC freshness (2.0.6): travel is fresh when the served payload
 * is live, OR the travel resource itself was worker-synced recently
 * (travel.syncedAt rides along in the payload). An unrelated section's
 * staleness (money/faction/education) can never suppress travel cues.
 */
function isTravelStale(today: TodayResponse, nowSec: number): boolean {
  const fetchedSec = Math.floor(today.fetchedAt / 1000);
  const payloadFresh = today.stale !== true;
  const syncedSec = today.travel.syncedAt ?? null;
  const confirmedSec = Math.max(payloadFresh ? fetchedSec : 0, syncedSec ?? 0);
  if (confirmedSec === 0) return true;
  return Math.max(0, nowSec - confirmedSec) > HEADSUP_STALE_AFTER_SECONDS;
}

/** Build the upcoming-action list from the live payload + participating OCs. */
export function deriveUpcomingActions(today: TodayResponse | null, ocs: Ocs | null, nowSec: number): UpcomingAction[] {
  if (!today) return [];
  const stale = isPayloadStale(today, nowSec);
  const travelStale = isTravelStale(today, nowSec);
  const out: UpcomingAction[] = [];

  // Travel landing (only while a flight is actually in progress).
  if (today.travel.state === "traveling" && today.travel.landsAt !== null) {
    const remaining = today.travel.landsAt - nowSec;
    if (remaining > -AT_EVENT_WINDOW_SECONDS) {
      out.push({
        type: "travel_landing",
        source: "today",
        label: "Travel",
        state: today.travel.country ?? (today.travel.direction === "returning" ? "Returning" : "In transit"),
        dueAt: today.travel.landsAt,
        remainingSeconds: remaining,
        stale: travelStale,
        actionUrl: "/today",
        eventKeyBase: `travel:${today.travel.landsAt}`,
        urgencyTier: 1,
      });
    }
  }

  // Cooldowns.
  const cds = [
    { cd: today.cooldowns.drug, type: "drug_ready" as const, label: "Drug" },
    { cd: today.cooldowns.booster, type: "booster_ready" as const, label: "Booster" },
    { cd: today.cooldowns.medical, type: "medical_ready" as const, label: "Medical" },
  ];
  for (const { cd, type, label } of cds) {
    if (cd === null || cd.endsAt === null) continue;
    const remaining = cd.endsAt - nowSec;
    if (remaining > AT_EVENT_WINDOW_SECONDS) continue; // not heads-up relevant yet
    out.push({
      type,
      source: "today",
      label,
      state: null,
      dueAt: cd.endsAt,
      remainingSeconds: remaining,
      stale,
      actionUrl: "/today",
      eventKeyBase: `${type.replace("_ready", "")}:${cd.endsAt}`,
      urgencyTier: 2,
    });
  }

  // Bank maturity (active or matured — matured stays actionable until collected).
  if (today.bank.state === "active" || today.bank.state === "mature") {
    const maturesAt = today.bank.maturesAt;
    if (today.bank.state === "mature") {
      out.push({
        type: "bank_matured",
        source: "today",
        label: "Bank",
        state: "Ready to collect",
        dueAt: nowSec,
        remainingSeconds: 0,
        stale,
        actionUrl: "/money",
        eventKeyBase: "bank:matured",
        urgencyTier: 2,
      });
    } else if (maturesAt !== null) {
      const remaining = maturesAt - nowSec;
      if (remaining <= AT_EVENT_WINDOW_SECONDS) {
        out.push({
          type: "bank_matured",
          source: "today",
          label: "Bank",
          state: "Maturing",
          dueAt: maturesAt,
          remainingSeconds: remaining,
          stale,
          actionUrl: "/money",
          eventKeyBase: `bank:${maturesAt}`,
          urgencyTier: 2,
        });
      }
    }
  }

  // Education — visual-only by default (no threshold), included for ordering.
  if (today.education.state === "active" && today.education.completesAt !== null) {
    const remaining = today.education.completesAt - nowSec;
    if (remaining > -AT_EVENT_WINDOW_SECONDS) {
      out.push({
        type: "education_complete",
        source: "today",
        label: "Education",
        state: today.education.courseName ?? "Course in progress",
        dueAt: today.education.completesAt,
        remainingSeconds: remaining,
        stale,
        actionUrl: "/today",
        eventKeyBase: `education:${today.education.completesAt}`,
        urgencyTier: remaining <= 3600 ? 3 : 4,
      });
    }
  }

  // Organized crime — earliest ready time of MY participating, recruiting OCs.
  if (ocs) {
    const ready = ocs
      .filter((o) => o.myParticipation && (o.status === "Recruiting" || o.status === "Planning") && o.readyAt !== null && o.readyAt > nowSec - AT_EVENT_WINDOW_SECONDS)
      .sort((a, b) => (a.readyAt ?? 0) - (b.readyAt ?? 0))[0];
    if (ready) {
      const remaining = (ready.readyAt ?? 0) - nowSec;
      out.push({
        type: "oc_ready",
        source: "faction",
        label: `OC · ${ready.name}`,
        state: ready.status,
        dueAt: ready.readyAt ?? nowSec,
        remainingSeconds: remaining,
        stale,
        actionUrl: "/faction",
        eventKeyBase: `oc:${ready.readyAt}`,
        urgencyTier: remaining <= 0 ? 2 : remaining <= 3600 ? 3 : 4,
      });
    }
  }

  return out.sort((a, b) => a.urgencyTier - b.urgencyTier || a.remainingSeconds - b.remainingSeconds);
}

export interface HeadsUpCue {
  /** Deterministic one-shot key: `type:dueAt:threshold`. */
  eventKey: string;
  kind: "pre" | "at";
  type: UpcomingType;
  label: string;
  state: string | null;
  dueAt: number;
  remainingSeconds: number;
  actionUrl: string;
}

export interface HeadsUpThresholdInput {
  travel_landing: number;
  drug_ready: number;
  booster_ready: number;
  medical_ready: number;
  oc_ready: number;
  bank_matured: number;
  education_complete: number;
}

/**
 * Derive the cues that should be (or have been) live right now. Pure: the
 * caller decides which of these are NEW (unfired event keys) and reacts —
 * dashboard banner, sound, persisted fired-set.
 */
export function deriveHeadsUpCues(upcoming: ReadonlyArray<UpcomingAction>, thresholds: HeadsUpThresholdInput, nowSec: number): HeadsUpCue[] {
  const cues: HeadsUpCue[] = [];
  for (const u of upcoming) {
    if (u.stale) continue; // stale data never sounds actionable
    const preMin = thresholds[u.type] ?? HEADSUP_THRESHOLD_DEFAULTS[u.type] ?? 0;
    const preSec = preMin * 60;
    if (preMin > 0 && u.remainingSeconds > 0 && u.remainingSeconds <= preSec) {
      cues.push({
        eventKey: `${u.eventKeyBase}:${preMin}`,
        kind: "pre",
        type: u.type,
        label: u.label,
        state: u.state,
        dueAt: u.dueAt,
        remainingSeconds: u.remainingSeconds,
        actionUrl: u.actionUrl,
      });
    }
    const educationVisualOnly = u.type === "education_complete" && (thresholds.education_complete ?? 0) <= 0;
    if (u.remainingSeconds <= 0 && u.remainingSeconds >= -AT_EVENT_WINDOW_SECONDS && !educationVisualOnly) {
      cues.push({
        eventKey: `${u.eventKeyBase}:0`,
        kind: "at",
        type: u.type,
        label: u.label,
        state: u.state,
        dueAt: u.dueAt,
        remainingSeconds: u.remainingSeconds,
        actionUrl: u.actionUrl,
      });
    }
  }
  return cues.sort((a, b) => a.remainingSeconds - b.remainingSeconds);
}

/* -------------------------------------------------------------------------- */
/* Travel / OC timing conflict (context-aware heads-up)                        */
/* -------------------------------------------------------------------------- */

export const TRAVEL_OC_CONFLICT_POLICY = {
  /** Extra minutes on the ground while abroad (buying, travelling to/from airport). */
  PURCHASE_BUFFER_MIN: 10,
  /** Safety margin so "just in time" is not presented as "fine". */
  SAFETY_BUFFER_MIN: 15,
} as const;

export interface TravelOcConflict {
  /** "Flying to UAE" / "Returning from UAE". */
  travelState: string;
  ocLabel: string;
  /** Minutes until the OC becomes ready. */
  ocInMinutes: number;
  /** Estimated minutes until the player is back home. */
  estimatedReturnInMinutes: number;
  /** outbound (still flying away) or returning (already heading home). */
  phase: "outbound" | "returning";
}

/**
 * Detect "you may not be back in time for your OC" — ONLY while a flight is
 * actually in progress (no intent guessing while sitting at home) and ONLY
 * when the destination's duration is known from the player's own history.
 *
 * requiredTime (from now):
 *   outbound   = remaining flight + purchase buffer + return flight + safety
 *   returning  = remaining flight + safety
 * Conflict when requiredTime > time until the OC is ready.
 */
export function deriveTravelOcConflict(input: {
  travel: TodayResponse["travel"];
  nowSec: number;
  ocReadyAt: number | null;
  ocLabel: string | null;
  /** Median recorded flight duration (seconds) for the destination; null = unknown. */
  destinationDurationSeconds: number | null;
  stale: boolean;
}): TravelOcConflict | null {
  const { travel, nowSec, ocReadyAt, ocLabel, destinationDurationSeconds, stale } = input;
  if (stale) return null; // stale data never drives a timing warning
  if (ocReadyAt === null || ocReadyAt <= nowSec) return null; // OC already ready/past
  if (travel.state !== "traveling") return null; // no intent guessing at home/abroad
  if (travel.landsAt === null || travel.landsAt <= nowSec) return null;

  const returning = travel.direction === "returning";
  const remainingFlightMin = Math.max(0, (travel.landsAt - nowSec) / 60);
  const safety = TRAVEL_OC_CONFLICT_POLICY.SAFETY_BUFFER_MIN;
  let requiredMin: number;
  if (returning) {
    requiredMin = remainingFlightMin + safety;
  } else {
    if (destinationDurationSeconds === null || destinationDurationSeconds <= 0) return null; // unknown duration → no fake warning
    const returnFlightMin = destinationDurationSeconds / 60;
    requiredMin = remainingFlightMin + TRAVEL_OC_CONFLICT_POLICY.PURCHASE_BUFFER_MIN + returnFlightMin + safety;
  }

  const ocInMin = (ocReadyAt - nowSec) / 60;
  if (requiredMin <= ocInMin) return null; // enough time — no warning

  return {
    travelState: returning ? `Returning from ${travel.country ?? "abroad"}` : `Flying to ${travel.country ?? "abroad"}`,
    ocLabel: ocLabel ?? "OC",
    ocInMinutes: Math.round(ocInMin),
    estimatedReturnInMinutes: Math.round(requiredMin),
    phase: returning ? "returning" : "outbound",
  };
}
