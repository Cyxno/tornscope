/**
 * Proactive Alerts domain (2.9.0, trigger catalog 2.10.0) — built-in trigger
 * registry, per-rule quiet-hours policy, and the pure transition/threshold
 * evaluators.
 *
 * Mirrors the notifications.ts architecture: every behavior is declared once
 * in ALERT_TRIGGERS, evaluators are pure functions over explicit inputs, and
 * the worker only wires persisted state to them. A draft produced here is
 * deterministic — the same inputs always yield the same dedupeKey, so the
 * AlertDelivery unique constraint makes re-evaluation idempotent.
 *
 * EVALUATION CONTRACT (documented per evaluator):
 * - The FIRST observation for a rule always establishes the baseline and
 *   never fires (initial-activation protection).
 * - A stale previous observation (older than the trigger's max gap) is
 *   re-baselined: no transition is fabricated across the gap.
 * - Missing or failed current observations keep the previous baseline
 *   untouched (a failed fetch never advances or invents state).
 * - Threshold episodes (net_worth_drop) fire once per baseline crossing and
 *   re-arm only when the condition has genuinely reset.
 */
import { z } from "zod";
import { isValidTimeZone, localMinutesInZone, nextWallClockOccurrence } from "./day.js";
import { COOLDOWN_KINDS, type CooldownKind } from "./today.js";
import type { DiscordErrorKind } from "./discord.js";

/* -------------------------------------------------------------------------- */
/* Delivery statuses                                                          */
/* -------------------------------------------------------------------------- */

/** pending | sent | failed | suppressed | deferred — "deferred" (2.10.0) is
 *  the quiet-hours state: committed during the rule's quiet window, external
 *  delivery scheduled for the window's end instead of being dropped. */
export const ALERT_DELIVERY_STATUSES = ["pending", "sent", "failed", "suppressed", "deferred"] as const;
export type AlertDeliveryStatus = (typeof ALERT_DELIVERY_STATUSES)[number];

export const ALERT_DELIVERY_STATUS_LABELS: Record<AlertDeliveryStatus, string> = {
  pending: "Pending",
  sent: "Delivered",
  failed: "Failed",
  suppressed: "Suppressed",
  deferred: "Deferred",
};

/* -------------------------------------------------------------------------- */
/* Quiet hours (per rule, IANA timezone, midnight-crossing, DST-safe)         */
/* -------------------------------------------------------------------------- */

export const AlertQuietHoursSchema = z.object({
  /** Local wall-clock "HH:MM" (24h). */
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** IANA timezone identifier — never the server's local zone. */
  tz: z.string().min(1).max(64),
});
export type AlertQuietHours = z.infer<typeof AlertQuietHoursSchema>;

function hhmmToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

/** Parse + fully validate stored quiet-hours JSON; anything invalid → null
 *  (quiet hours OFF). A malformed timezone or clock can never suppress a
 *  rule forever by accident. */
export function parseAlertQuietHours(raw: unknown): AlertQuietHours | null {
  const parsed = AlertQuietHoursSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (!isValidTimeZone(parsed.data.tz)) return null;
  return parsed.data;
}

/**
 * Whether `nowSec` falls inside the configured quiet window, resolved in the
 * window's own timezone. Midnight-crossing windows (23:00→07:00) wrap;
 * start === end reads as a FULL-DAY quiet window (mirrors the push engine's
 * isWithinQuietHours). DST is handled by the shared local-minutes lookup:
 * the wall clock decides, never a fixed UTC offset.
 */
export function isAlertQuietNow(qh: AlertQuietHours, nowSec: number): boolean {
  const startMin = hhmmToMinutes(qh.start);
  const endMin = hhmmToMinutes(qh.end);
  const nowMin = localMinutesInZone(nowSec, qh.tz);
  return startMin < endMin ? nowMin >= startMin && nowMin < endMin : nowMin >= startMin || nowMin < endMin;
}

/** Epoch seconds at which the current quiet window ends (>= nowSec). */
export function alertQuietEndSec(qh: AlertQuietHours, nowSec: number): number {
  return nextWallClockOccurrence(hhmmToMinutes(qh.end), qh.tz, nowSec);
}

/* -------------------------------------------------------------------------- */
/* Trigger registry                                                           */
/* -------------------------------------------------------------------------- */

export const ALERT_TRIGGER_IDS = [
  "cooldown_ready",
  "oc_ready",
  "education_done",
  "bank_matured",
  "travel_landed",
  "net_worth_drop",
  "sync_failure",
  "sync_recovery",
  "networth_drawdown",
  "bar_capped",
  "bank_maturity_soon",
  "oc_almost_ready",
  "goal_milestone",
  "rehab_advice",
  "drug_overdose_spike",
  "training_stagnation",
] as const;
export type AlertTriggerId = (typeof ALERT_TRIGGER_IDS)[number];

/** Canonical alert categories (2.10.0). "operational" covers app-health
 *  triggers that are not part of the five Torn domains. */
export const ALERT_CATEGORIES = ["economy", "progression", "health", "travel", "combat", "operational"] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/**
 * How a trigger dedupes its alerts:
 * - per-incident: one alert per distinct real-world event (a maturity, an OC,
 *   an overdose cluster);
 * - per-episode: one alert while a condition episode stays open; re-arms only
 *   after the episode has genuinely closed (recovery / reset);
 * - per-day: at most one alert per calendar day (bar-capped chatter).
 */
export const ALERT_DEDUPE_SCOPES = ["per-incident", "per-episode", "per-day"] as const;
export type AlertDedupeScope = (typeof ALERT_DEDUPE_SCOPES)[number];

/**
 * Confidence label of the FACT the alert claims (mirrors the app-wide
 * provenance vocabulary): exact (Torn-provided verbatim), derived (computed
 * from exact data), estimated (bounded internal estimate), inferred
 * (indirect proxy — the alert copy must say so).
 */
export const ALERT_CONFIDENCE_LABELS = ["exact", "derived", "estimated", "inferred"] as const;
export type AlertConfidenceLabel = (typeof ALERT_CONFIDENCE_LABELS)[number];

/** Per-trigger configuration schemas (validated on create AND update).
 *  Fields are optional: defaults fill in AFTER validation, so a partial
 *  config is valid while an unknown key (typo) is rejected — strict(). */
export const CooldownReadyConfigSchema = z
  .object({
    /** Which cooldown kinds the rule watches (default: all three). */
    cooldowns: z.array(z.enum(COOLDOWN_KINDS)).min(1).max(3).optional(),
  })
  .strict();
export const NetWorthDropConfigSchema = z
  .object({
    /** Percentage drop (of the baseline) that fires the alert. */
    pct: z.number().min(0.5).max(95).optional(),
    /** Observation window ending at the latest snapshot. */
    window_hours: z.number().int().min(1).max(24 * 30).optional(),
  })
  .strict();
export const NetworthDrawdownConfigSchema = z
  .object({
    /** Percentage drop against the 7-day baseline that fires the alert. */
    pct: z.number().min(0.5).max(95).optional(),
  })
  .strict();
export const BarCappedConfigSchema = z
  .object({
    /** Which bars the rule watches (default: energy). */
    bars: z.array(z.enum(["energy", "nerve", "happy"])).min(1).max(3).optional(),
    /** How long the bar must sit at maximum (uninterrupted) before firing. */
    minutes: z.number().int().min(5).max(24 * 60).optional(),
  })
  .strict();
export const WithinHoursConfigSchema = z
  .object({
    /** How far ahead the upcoming event may be to fire the alert. */
    within_hours: z.number().int().min(1).max(24 * 30).optional(),
  })
  .strict();
export const DrugWindowConfigSchema = z
  .object({
    /** Number of events inside the window that triggers the alert. */
    count: z.number().int().min(2).max(50).optional(),
    window_hours: z.number().int().min(1).max(24 * 14).optional(),
    /** Hours without events after which an open episode closes again. */
    clean_hours: z.number().int().min(1).max(24 * 14).optional(),
  })
  .strict();
export const OverdoseSpikeConfigSchema = z
  .object({
    /** Overdoses inside the window that trigger the alert. */
    count: z.number().int().min(2).max(20).optional(),
    window_hours: z.number().int().min(1).max(24 * 7).optional(),
    /** Personal-baseline length: overdoses/day over this period. */
    baseline_days: z.number().int().min(7).max(365).optional(),
  })
  .strict();
export const TrainingStagnationConfigSchema = z
  .object({
    /** No battlestat gain over this many days = stagnant. */
    window_days: z.number().int().min(1).max(90).optional(),
  })
  .strict();
export const EmptyConfigSchema = z.object({}).strict();

export type CooldownReadyConfig = z.infer<typeof CooldownReadyConfigSchema>;
export type NetWorthDropConfig = z.infer<typeof NetWorthDropConfigSchema>;
export type BarCappedConfig = z.infer<typeof BarCappedConfigSchema>;
export type WithinHoursConfig = z.infer<typeof WithinHoursConfigSchema>;
export type DrugWindowConfig = z.infer<typeof DrugWindowConfigSchema>;
export type OverdoseSpikeConfig = z.infer<typeof OverdoseSpikeConfigSchema>;
export type TrainingStagnationConfig = z.infer<typeof TrainingStagnationConfigSchema>;

export interface AlertTriggerMeta {
  id: AlertTriggerId;
  label: string;
  /** One-line explanation shown on the rule card. */
  description: string;
  /** Canonical category (2.10.0) — was `group` in 2.9.0. */
  category: AlertCategory;
  severity: AlertSeverity;
  dedupeScope: AlertDedupeScope;
  /** Confidence label of the fact the alert claims. */
  confidenceLabel: AlertConfidenceLabel;
  /** Suggested state when a user creates a rule for this trigger. */
  defaultEnabled: boolean;
  /** In-app destination for the alert. */
  clickPath: string;
  /**
   * True when the evaluator needs a fresh live Torn observation (one
   * /user call per account per evaluation tick). False = evaluated purely
   * from persisted application data.
   */
  needsLiveFetch: boolean;
  defaultConfig: Record<string, unknown>;
  configSchema: z.ZodTypeAny;
  /**
   * Maximum age of the previous observation for transition detection.
   * Older baselines are re-established instead of fabricating a crossing.
   */
  maxObservationGapSeconds: number;
}

/** Cooldown-ready edge detection freshness bound (spec: 12h for the MVP). */
export const ALERT_MAX_OBSERVATION_GAP_SECONDS = 12 * 3600;

export const ALERT_TRIGGERS: AlertTriggerMeta[] = [
  {
    id: "cooldown_ready",
    label: "Cooldown ready",
    description: "A tracked cooldown (drug, booster or medical) finished. Fires on the transition, not repeatedly.",
    category: "health",
    severity: "info",
    dedupeScope: "per-incident",
    confidenceLabel: "exact",
    defaultEnabled: true,
    clickPath: "/today",
    needsLiveFetch: true,
    defaultConfig: {},
    configSchema: CooldownReadyConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "oc_ready",
    label: "OC ready",
    description: "One of your organized crimes becomes ready to initiate. Fires once per OC.",
    category: "combat",
    severity: "info",
    dedupeScope: "per-incident",
    confidenceLabel: "exact",
    defaultEnabled: true,
    clickPath: "/faction",
    needsLiveFetch: false,
    defaultConfig: {},
    configSchema: EmptyConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "education_done",
    label: "Education completed",
    description: "Your education course finished. Fires once per course completion.",
    category: "progression",
    severity: "info",
    dedupeScope: "per-incident",
    confidenceLabel: "exact",
    defaultEnabled: true,
    clickPath: "/progression",
    needsLiveFetch: true,
    defaultConfig: {},
    configSchema: EmptyConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "bank_matured",
    label: "Bank matured",
    description: "A city-bank investment reached its maturity date and can be collected.",
    category: "economy",
    severity: "info",
    dedupeScope: "per-incident",
    confidenceLabel: "exact",
    defaultEnabled: true,
    clickPath: "/money",
    needsLiveFetch: true,
    defaultConfig: {},
    configSchema: EmptyConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "travel_landed",
    label: "Travel landed",
    description: "Your flight landed and you can act again. Fires once per trip.",
    category: "travel",
    severity: "info",
    dedupeScope: "per-incident",
    confidenceLabel: "exact",
    defaultEnabled: true,
    clickPath: "/travel",
    needsLiveFetch: true,
    defaultConfig: {},
    configSchema: EmptyConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "net_worth_drop",
    label: "Net worth drop",
    description: "Your official net worth fell by a percentage over an observation window, using persisted snapshots.",
    category: "economy",
    severity: "warning",
    dedupeScope: "per-episode",
    confidenceLabel: "exact",
    defaultEnabled: true,
    clickPath: "/money",
    needsLiveFetch: false,
    defaultConfig: { pct: 5, window_hours: 24 },
    configSchema: NetWorthDropConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "sync_failure",
    label: "Sync failure",
    description: "One or more data sources stopped updating. Grouped per incident.",
    category: "operational",
    severity: "warning",
    dedupeScope: "per-incident",
    confidenceLabel: "exact",
    defaultEnabled: true,
    clickPath: "/sync",
    needsLiveFetch: false,
    defaultConfig: {},
    configSchema: EmptyConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "sync_recovery",
    label: "Sync recovery",
    description: "A previously failing data source is healthy again.",
    category: "operational",
    severity: "info",
    dedupeScope: "per-incident",
    confidenceLabel: "exact",
    defaultEnabled: true,
    clickPath: "/sync",
    needsLiveFetch: false,
    defaultConfig: {},
    configSchema: EmptyConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "networth_drawdown",
    label: "Net worth drawdown (7d)",
    description: "Your official net worth fell by a percentage against the snapshot from exactly 7 days ago.",
    category: "economy",
    severity: "warning",
    dedupeScope: "per-episode",
    confidenceLabel: "exact",
    defaultEnabled: true,
    clickPath: "/money",
    needsLiveFetch: false,
    defaultConfig: { pct: 10 },
    configSchema: NetworthDrawdownConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "bar_capped",
    label: "Bar capped",
    description: "Energy, nerve or happy sat at its maximum for longer than the configured duration — capped regen is wasted. At most one alert per bar per day.",
    category: "health",
    severity: "info",
    dedupeScope: "per-day",
    confidenceLabel: "exact",
    defaultEnabled: false,
    clickPath: "/energy",
    needsLiveFetch: true,
    defaultConfig: { bars: ["energy"], minutes: 30 },
    configSchema: BarCappedConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "bank_maturity_soon",
    label: "Bank maturity soon",
    description: "A city-bank investment matures within the configured horizon.",
    category: "economy",
    severity: "info",
    dedupeScope: "per-incident",
    confidenceLabel: "exact",
    defaultEnabled: true,
    clickPath: "/money",
    needsLiveFetch: true,
    defaultConfig: { within_hours: 24 },
    configSchema: WithinHoursConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "oc_almost_ready",
    label: "OC almost ready",
    description: "One of your organized crimes becomes ready to initiate within the configured horizon.",
    category: "combat",
    severity: "info",
    dedupeScope: "per-incident",
    confidenceLabel: "exact",
    defaultEnabled: true,
    clickPath: "/faction",
    needsLiveFetch: false,
    defaultConfig: { within_hours: 6 },
    configSchema: WithinHoursConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "goal_milestone",
    label: "Goal milestone",
    description: "Progress on an active goal crosses a milestone fraction (50%, 75%, 90% — achievement itself is a different notification).",
    category: "progression",
    severity: "info",
    dedupeScope: "per-episode",
    confidenceLabel: "derived",
    defaultEnabled: true,
    clickPath: "/goals",
    needsLiveFetch: false,
    defaultConfig: {},
    configSchema: EmptyConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "rehab_advice",
    label: "Rehab advice",
    description: "Drug use volume passed the configured threshold. Torn publishes no addiction meter — this trigger uses recent drug-event volume as an honest proxy and says so in the alert.",
    category: "health",
    severity: "warning",
    dedupeScope: "per-episode",
    confidenceLabel: "inferred",
    defaultEnabled: true,
    clickPath: "/drugs",
    needsLiveFetch: false,
    defaultConfig: { count: 3, window_hours: 24, clean_hours: 24 },
    configSchema: DrugWindowConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "drug_overdose_spike",
    label: "Overdose spike",
    description: "Overdoses inside the configured window exceed your own historical baseline rate, not just an absolute count.",
    category: "health",
    severity: "critical",
    dedupeScope: "per-incident",
    confidenceLabel: "exact",
    defaultEnabled: true,
    clickPath: "/drugs",
    needsLiveFetch: false,
    defaultConfig: { count: 2, window_hours: 24, baseline_days: 90 },
    configSchema: OverdoseSpikeConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
  {
    id: "training_stagnation",
    label: "Training stagnation",
    description: "Your total battle stats showed no gain over the configured number of days, based on stored stat snapshots.",
    category: "progression",
    severity: "info",
    dedupeScope: "per-episode",
    confidenceLabel: "derived",
    defaultEnabled: false,
    clickPath: "/progression",
    needsLiveFetch: false,
    defaultConfig: { window_days: 7 },
    configSchema: TrainingStagnationConfigSchema,
    maxObservationGapSeconds: ALERT_MAX_OBSERVATION_GAP_SECONDS,
  },
];

export function alertTrigger(id: string): AlertTriggerMeta | undefined {
  return ALERT_TRIGGERS.find((t) => t.id === id);
}

/** Validate + normalize a rule config for its trigger type. Returns the
 *  defaults back when the stored value is missing; throws on invalid values
 *  (callers translate into 4xx). */
export function normalizeAlertConfig(triggerType: string, config: unknown): Record<string, unknown> {
  const meta = alertTrigger(triggerType);
  if (!meta) throw new Error(`unsupported trigger type: ${triggerType}`);
  const parsed = meta.configSchema.safeParse(config ?? {});
  if (!parsed.success) throw new AlertConfigError(parsed.error.flatten());
  return { ...meta.defaultConfig, ...(parsed.data as Record<string, unknown>) };
}

export class AlertConfigError extends Error {
  constructor(readonly details: unknown) {
    super("Invalid alert configuration");
    this.name = "AlertConfigError";
  }
}

/* -------------------------------------------------------------------------- */
/* Live observation state                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Live timer observation for the alerts engine — the same shape the push
 * engine persists (LiveTimerState), restricted to the timers alerts track.
 * Values are absolute unix seconds of the tracked end, null = ready/none.
 * energyFullAt/nerveFullAt (2.10.0) double as bar-capped observations: a
 * fullAt in the past means the bar sat at maximum at fetch time.
 */
export interface AlertTimerState {
  cooldownDrugEndsAt?: number | null;
  cooldownBoosterEndsAt?: number | null;
  cooldownMedicalEndsAt?: number | null;
  travelLandsAt?: number | null;
  educationEndsAt?: number | null;
  bankMaturesAt?: number | null;
  energyFullAt?: number | null;
  nerveFullAt?: number | null;
}

/** Evaluator working state persisted on AlertRule.lastState (Json). Only the
 *  slice owned by the rule's trigger is written; unknown keys are preserved
 *  by the merge in the worker. */
export interface AlertRuleState {
  /** Previous observation instant (unix seconds) — the transition anchor. */
  observedAt: number;
  /** Timer ends at the previous observation (state-transition triggers). */
  timers?: AlertTimerState;
  /** Open threshold episode (net_worth_drop / networth_drawdown): the alerting baseline key. */
  openEpisode?: { baselineId: string } | null;
  /** Previously failing resources (sync_failure / sync_recovery). */
  failing?: string[];
  /** Imminent-event signals (bank_maturity_soon / oc_almost_ready):
   *  endSec already alerted for, per kind ("bank", "oc:<id>"). */
  signaled?: Record<string, number>;
  /** bar_capped: when the watched bar first read capped at the previous
   *  observation (null = not capped then), and the last day a capped alert
   *  fired for it ("YYYY-MM-DD" in the rule's quiet-hours tz, else UTC). */
  cappedSince?: Record<string, number | null>;
  cappedFiredDay?: Record<string, string>;
  /** goal_milestone: last notified fraction per goal id. */
  goalFractions?: Record<string, number>;
  /** Open condition episode (rehab_advice / training_stagnation):
   *  when the current episode started; null = no open episode. */
  conditionEpisode?: { sinceSec: number } | null;
}

export function parseAlertRuleState(raw: unknown): AlertRuleState | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as Record<string, unknown>;
  if (typeof state.observedAt !== "number" || !Number.isFinite(state.observedAt)) return null;
  return state as unknown as AlertRuleState;
}

/** One ready-transition of a tracked timer. */
export interface AlertTimerEvent {
  kind: "cooldown_drug" | "cooldown_booster" | "cooldown_medical" | "travel" | "education" | "bank";
  /** The timer's end timestamp — the stable identity of the transition. */
  endSec: number;
  label: string;
}

const COOLDOWN_KIND_TO_KEY: Record<CooldownKind, keyof AlertTimerState> = {
  drug: "cooldownDrugEndsAt",
  booster: "cooldownBoosterEndsAt",
  medical: "cooldownMedicalEndsAt",
};

const TIMER_LABELS: Record<AlertTimerEvent["kind"], string> = {
  cooldown_drug: "Drug cooldown ready",
  cooldown_booster: "Booster cooldown ready",
  cooldown_medical: "Medical cooldown ready",
  travel: "Travel landed",
  education: "Education completed",
  bank: "Bank investment matured",
};

/**
 * Diff the previous and current timer observations into ready events.
 *
 * An event is a GENUINE transition only when ALL of these hold:
 * - the previous observation exists and is fresh (nowSec - prevObservedAt ≤
 *   maxGapSeconds) — a stale gap is re-baselined by the caller instead;
 * - the timer was STILL ACTIVE at the previous observation (its end was in
 *   the future then) — an already-expired timer never retroactively fires;
 * - the timer is ready now (end cleared, or end ≤ now + grace).
 *
 * Same-second re-observations stay eligible: the active-at-previous check is
 * the anti-fabrication bound (mirrors the push engine's diffTimerTransitions),
 * and the stable `endSec` identity + the AlertDelivery unique constraint make
 * a replay of the same transition idempotent.
 */
export function diffAlertTimers(
  previous: { observedAt: number; timers: AlertTimerState },
  current: AlertTimerState,
  nowSec: number,
  kinds: ReadonlyArray<AlertTimerEvent["kind"]>,
  maxGapSeconds: number = ALERT_MAX_OBSERVATION_GAP_SECONDS,
  graceSeconds = 120
): AlertTimerEvent[] {
  if (nowSec - previous.observedAt > maxGapSeconds) return [];
  const events: AlertTimerEvent[] = [];
  for (const kind of kinds) {
    const key = kind === "cooldown_drug" || kind === "cooldown_booster" || kind === "cooldown_medical"
      ? COOLDOWN_KIND_TO_KEY[kind.replace("cooldown_", "") as CooldownKind]
      : kind === "travel"
        ? "travelLandsAt"
        : kind === "education"
          ? "educationEndsAt"
          : "bankMaturesAt";
    const prevEnd = previous.timers[key] ?? null;
    if (prevEnd === null || prevEnd <= previous.observedAt) continue; // not active at previous observation
    const curEnd = current[key] ?? null;
    if (curEnd !== null && curEnd > nowSec + graceSeconds) continue; // still active
    events.push({ kind, endSec: prevEnd, label: TIMER_LABELS[kind] });
  }
  return events;
}

/** The timer kinds a cooldown_ready rule watches, from its config. */
export function cooldownKindsFromConfig(config: Record<string, unknown>): CooldownKind[] {
  const raw = (config as { cooldowns?: unknown }).cooldowns;
  if (!Array.isArray(raw) || raw.length === 0) return [...COOLDOWN_KINDS];
  return raw.filter((k): k is CooldownKind => typeof k === "string" && (COOLDOWN_KINDS as readonly string[]).includes(k));
}

/* -------------------------------------------------------------------------- */
/* Net-worth threshold evaluation                                             */
/* -------------------------------------------------------------------------- */

export interface NetworthPoint {
  /** Stable snapshot identity (used in dedupe keys). */
  id: string;
  capturedAt: number;
  /** BigInt total as string (JSON-safe). */
  total: string;
}

export interface NetworthDropResult {
  eligible: boolean;
  /** Machine-readable reason when not eligible (documented behavior). */
  reason?: "missing_baseline" | "missing_current" | "stale_current" | "baseline_outside_window" | "nonpositive_baseline" | "still_open_episode";
  dropPct: number;
  baselineTotal: string | null;
  currentTotal: string | null;
}

/** Tolerance around the window boundary when picking the baseline snapshot:
 *  snapshots are NOT taken at exact window boundaries, so the baseline is the
 *  closest snapshot at or before the boundary, accepted within 3h of it
 *  (documented cadence tolerance). */
export const NETWORTH_BASELINE_TOLERANCE_SECONDS = 3 * 3600;
/** A current snapshot older than this is stale: never evaluated. */
export const NETWORTH_CURRENT_MAX_AGE_SECONDS = 12 * 3600;

/**
 * Evaluate a percentage-drop crossing against persisted snapshots.
 *
 * - Zero, negative or missing baselines are NEVER interpreted as a 100%
 *   loss — the evaluation is simply not eligible.
 * - The episode identity is the baseline snapshot id: the same crossing
 *   cannot fire twice; a new baseline (window moved on) starts a new episode.
 * - Re-arming requires the current value to recover above the firing
 *   threshold (baseline × (1 − pct/100)); the caller clears the open
 *   episode based on `stillOpenEpisode`.
 *
 * `config` accepts the raw normalized rule config; documented defaults fill
 * in here so callers never see undefined thresholds.
 */
export function evaluateNetworthDrop(
  baseline: NetworthPoint | null,
  current: NetworthPoint | null,
  rawConfig: { pct?: number; window_hours?: number },
  nowSec: number,
  openEpisodeKey: string | null,
  episodeKeyPrefix: string = "nwdrop"
): NetworthDropResult {
  const config: { pct: number; window_hours: number } = {
    pct: typeof rawConfig.pct === "number" ? rawConfig.pct : 5,
    window_hours: typeof rawConfig.window_hours === "number" ? rawConfig.window_hours : 24,
  };
  const windowStartSec = nowSec - config.window_hours * 3600;
  if (!baseline || !Number.isFinite(Number(baseline.total))) {
    return { eligible: false, reason: "missing_baseline", dropPct: 0, baselineTotal: null, currentTotal: current?.total ?? null };
  }
  if (!current || !Number.isFinite(Number(current.total))) {
    return { eligible: false, reason: "missing_current", dropPct: 0, baselineTotal: baseline.total, currentTotal: null };
  }
  if (nowSec - current.capturedAt > NETWORTH_CURRENT_MAX_AGE_SECONDS) {
    return { eligible: false, reason: "stale_current", dropPct: 0, baselineTotal: baseline.total, currentTotal: current.total };
  }
  // Baseline must sit inside the window (within the documented boundary
  // tolerance) and must not be the current snapshot itself.
  if (baseline.capturedAt < windowStartSec - NETWORTH_BASELINE_TOLERANCE_SECONDS || baseline.capturedAt > nowSec) {
    return { eligible: false, reason: "baseline_outside_window", dropPct: 0, baselineTotal: baseline.total, currentTotal: current.total };
  }
  const baselineTotal = Number(baseline.total);
  const currentTotal = Number(current.total);
  if (!(baselineTotal > 0)) {
    // A zero/negative baseline makes a percentage drop meaningless — it is
    // never reported as a total loss (documented behavior).
    return { eligible: false, reason: "nonpositive_baseline", dropPct: 0, baselineTotal: baseline.total, currentTotal: current.total };
  }
  const dropPct = ((baselineTotal - currentTotal) / baselineTotal) * 100;
  const thresholdPct = config.pct;
  const crossed = dropPct >= thresholdPct;
  const episodeKey = `${episodeKeyPrefix}:${baseline.id}`;
  // Recovery resets the episode even when the window's baseline has not
  // moved yet: the condition has genuinely reset.
  if (!crossed) {
    return { eligible: false, dropPct, baselineTotal: baseline.total, currentTotal: current.total };
  }
  if (openEpisodeKey === episodeKey) {
    return { eligible: false, reason: "still_open_episode", dropPct, baselineTotal: baseline.total, currentTotal: current.total };
  }
  return { eligible: true, dropPct, baselineTotal: baseline.total, currentTotal: current.total };
}

/** Stable episode key for a fired net-worth alert (persisted in lastState). */
export function networthEpisodeKey(baselineId: string): string {
  return `nwdrop:${baselineId}`;
}

/* -------------------------------------------------------------------------- */
/* Sync-health transitions                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Diff the previously-failing resource set into failure/recovery events.
 * A resource appears in `failures` when it is failing now but was not
 * before; `recoveries` when it was failing before and is healthy now.
 * First observation (previous === null) yields nothing — baseline.
 */
export function diffSyncHealth(
  previousFailing: string[] | null,
  currentFailing: string[]
): { failures: string[]; recoveries: string[] } {
  if (previousFailing === null) return { failures: [], recoveries: [] };
  const prev = new Set(previousFailing);
  const cur = new Set(currentFailing);
  return {
    failures: currentFailing.filter((r) => !prev.has(r)),
    recoveries: previousFailing.filter((r) => !cur.has(r)),
  };
}

/** Deterministic incident signature for dedupe keys. */
export function syncIncidentSignature(resources: string[]): string {
  return [...resources].sort().join(",");
}

/* -------------------------------------------------------------------------- */
/* Alert drafts                                                               */
/* -------------------------------------------------------------------------- */

/** Bounded, human formatting helpers shared by evaluators. */
export function formatMoney(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}b`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}m`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1000)}k`;
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
}

/* -------------------------------------------------------------------------- */
/* 2.10.0 trigger evaluators                                                  */
/* -------------------------------------------------------------------------- */

/**
 * EVALUATION CONTRACT (2.10.0 additions) — same rules as the 2.9.0
 * contract above, plus two trigger families with their own semantics:
 *
 * - IMMINENT triggers (bank_maturity_soon, oc_almost_ready) alert on the
 *   CURRENT state crossing a horizon ("matures within 24h"), not on an edge.
 *   Creating such a rule must warn about an event that is already imminent —
 *  so there is NO first-observation baseline deferral. Idempotency comes
 *   from the per-event endSec dedupe persisted in lastState.signaled.
 * - CONDITION EPISODES (rehab_advice, training_stagnation) open when a
 *   condition starts and close only on a documented reset (a clean window /
 *   observed gain). An episode alerts ONCE — re-alerting requires a genuine
 *   close and re-open, never a repeated evaluation of the same state.
 */

/* --- Net-worth drawdown vs the 7-day baseline ------------------------------ */

/** The drawdown baseline is the snapshot closest to exactly 7 days ago. */
export const NETWORTH_DRAWDOWN_BASELINE_SECONDS = 7 * 24 * 3600;

/** Same semantics as evaluateNetworthDrop with a fixed 168h window; the
 *  episode identity uses the `nwdrawdown:` prefix so the two economy
 *  triggers never share an episode key. */
export function evaluateNetworthDrawdown(
  baseline: NetworthPoint | null,
  current: NetworthPoint | null,
  rawConfig: { pct?: number },
  nowSec: number,
  openEpisodeKey: string | null
): NetworthDropResult {
  return evaluateNetworthDrop(
    baseline,
    current,
    { pct: rawConfig.pct, window_hours: NETWORTH_DRAWDOWN_BASELINE_SECONDS / 3600 },
    nowSec,
    openEpisodeKey,
    "nwdrawdown"
  );
}

/** Stable episode key for a fired drawdown alert (persisted in lastState). */
export function networthDrawdownEpisodeKey(baselineId: string): string {
  return `nwdrawdown:${baselineId}`;
}

/* --- Imminent timers (bank maturity soon / OC almost ready) ---------------- */

export interface ImminentTimerResult {
  eligible: boolean;
  /** Machine-readable reason when not eligible (documented behavior). */
  reason?: "no_timer" | "already_signaled";
  /** The event's end timestamp — its stable per-incident identity. */
  endSec: number | null;
}

/**
 * An imminent alert fires when a known future end timestamp lies inside the
 * configured horizon and that exact end was not alerted before. The endSec
 * is the per-incident dedupe identity: replays of the same maturity or the
 * same OC ready-moment stay idempotent through lastState.signaled.
 */
export function evaluateImminentTimer(
  endSec: number | null,
  nowSec: number,
  withinSeconds: number,
  signaledEndSec: number | null
): ImminentTimerResult {
  if (endSec === null || !Number.isFinite(endSec)) return { eligible: false, reason: "no_timer", endSec: null };
  if (endSec <= nowSec || endSec - nowSec > withinSeconds) return { eligible: false, reason: "no_timer", endSec };
  if (signaledEndSec === endSec) return { eligible: false, reason: "already_signaled", endSec };
  return { eligible: true, endSec };
}

/* --- Bar capped (energy / nerve / happy) ----------------------------------- */

export interface BarCappedResult {
  eligible: boolean;
  /** Machine-readable reason when not eligible (documented behavior). */
  reason?: "not_capped" | "duration_not_reached" | "already_fired_today";
  /** Continuous capped duration at this observation (seconds). */
  durationSec: number;
}

/**
 * A bar-capped alert fires when a bar's capped duration reaches the
 * configured minutes, at most once per calendar day. The caller owns the
 * capped-since state machine (a bar still capped keeps its original
 * cappedSinceSec; a bar no longer capped resets it to null) — this function
 * only decides on the presented duration, so it stays pure and testable.
 * A bar observed capped for the first time starts its duration at this
 * observation (initial-activation protection, same contract as transitions).
 */
export function evaluateBarCappedDuration(
  cappedSinceSec: number | null,
  nowSec: number,
  minutes: number,
  alreadyFiredToday: boolean
): BarCappedResult {
  if (cappedSinceSec === null) return { eligible: false, reason: "not_capped", durationSec: 0 };
  const durationSec = Math.max(0, nowSec - cappedSinceSec);
  if (durationSec < minutes * 60) return { eligible: false, reason: "duration_not_reached", durationSec };
  if (alreadyFiredToday) return { eligible: false, reason: "already_fired_today", durationSec };
  return { eligible: true, durationSec };
}

/* --- Goal milestones -------------------------------------------------------- */

export interface GoalMilestoneResult {
  /** The highest fraction newly crossed since lastNotifiedFraction. */
  newlyReached: number | null;
  /** The highest fraction the progress currently satisfies (state to persist). */
  highestReached: number | null;
}

/**
 * Which milestone fractions a progress value satisfies, and which of them is
 * new since the last notified fraction. The fraction list is the caller's
 * (the worker passes the canonical GOAL_MILESTONE_FRACTIONS so push and
 * alerts can never drift apart). Achievement (1.0) is deliberately NOT a
 * milestone here — it has its own notification semantics.
 */
export function evaluateGoalMilestone(
  progress: number | null,
  lastNotifiedFraction: number | null,
  fractions: readonly number[]
): GoalMilestoneResult {
  if (progress === null || !Number.isFinite(progress)) return { newlyReached: null, highestReached: null };
  let highestReached: number | null = null;
  for (const f of fractions) {
    if (progress >= f) highestReached = f;
  }
  if (highestReached === null) return { newlyReached: null, highestReached: null };
  const newlyReached = lastNotifiedFraction !== null && lastNotifiedFraction >= highestReached ? null : highestReached;
  return { newlyReached, highestReached };
}

/* --- Drug-window episode (rehab advice) ------------------------------------- */

export interface DrugWindowResult {
  /** Whether the alert fires NOW (threshold reached, no open episode). */
  eligible: boolean;
  /** Whether a condition episode is open AFTER this evaluation. */
  episodeOpen: boolean;
  /** Episode start to persist (first event of the current cluster). */
  episodeSinceSec: number | null;
  windowCount: number;
  /** First/last drug event inside the window (fact timestamps). */
  windowEarliestAtSec: number | null;
  latestEventAtSec: number | null;
}

/**
 * Rehab-advice episode logic over drug-event timestamps (seconds, any
 * order). The episode OPENS when the event count inside the window reaches
 * the threshold; it closes only after `cleanHours` without any event. While
 * the episode is open the threshold may not fire again — repeated
 * evaluations of the same cluster never re-alert.
 */
export function evaluateDrugWindow(
  eventTimesSec: readonly number[],
  nowSec: number,
  config: { count: number; windowHours: number; cleanHours: number },
  episodeSinceSec: number | null
): DrugWindowResult {
  const windowStart = nowSec - config.windowHours * 3600;
  const inWindow = eventTimesSec.filter((t) => t >= windowStart && t <= nowSec).sort((a, b) => a - b);
  const latestEventAtSec = eventTimesSec.length > 0 ? Math.max(...eventTimesSec) : null;
  const windowEarliestAtSec = inWindow.length > 0 ? inWindow[0]! : null;

  const currentlyOpen =
    episodeSinceSec !== null && latestEventAtSec !== null && nowSec - latestEventAtSec <= config.cleanHours * 3600;
  if (inWindow.length >= config.count) {
    if (currentlyOpen) {
      return { eligible: false, episodeOpen: true, episodeSinceSec, windowCount: inWindow.length, windowEarliestAtSec, latestEventAtSec };
    }
    const since = episodeSinceSec !== null && episodeSinceSec > windowStart ? episodeSinceSec : windowEarliestAtSec;
    return { eligible: true, episodeOpen: true, episodeSinceSec: since, windowCount: inWindow.length, windowEarliestAtSec, latestEventAtSec };
  }
  if (currentlyOpen) {
    // Threshold no longer met but the clean window has not elapsed either:
    // the episode stays open without re-alerting.
    return { eligible: false, episodeOpen: true, episodeSinceSec, windowCount: inWindow.length, windowEarliestAtSec, latestEventAtSec };
  }
  return { eligible: false, episodeOpen: false, episodeSinceSec: null, windowCount: inWindow.length, windowEarliestAtSec, latestEventAtSec };
}

/* --- Overdose spike vs personal baseline ------------------------------------ */

export interface OverdoseSpikeResult {
  eligible: boolean;
  /** Machine-readable reason when not eligible (documented behavior). */
  reason?: "below_count" | "baseline_not_exceeded" | "insufficient_baseline";
  windowCount: number;
  /** Observed overdoses per day over the baseline period (null = no baseline). */
  baselineRatePerDay: number | null;
}

/**
 * An overdose spike is not just "N overdoses happened" — it is N inside the
 * window WHILE the personal baseline rate over `baselineDays` (the period
 * BEFORE the window) says that volume is unusual. Without a usable baseline
 * (< minBaselineEvents events in the baseline period) no spike is claimed:
 * the absolute count alone never justifies the word "spike" (documented
 * behavior — insufficient_baseline).
 */
export function evaluateOverdoseSpike(
  overdoseTimesSec: readonly number[],
  nowSec: number,
  config: { count: number; windowHours: number; baselineDays: number; minBaselineEvents?: number }
): OverdoseSpikeResult {
  const windowStart = nowSec - config.windowHours * 3600;
  const baselineStart = nowSec - config.baselineDays * 86_400;
  const minBaselineEvents = config.minBaselineEvents ?? 3;
  const inWindow = overdoseTimesSec.filter((t) => t >= windowStart && t <= nowSec).sort((a, b) => a - b);
  const inBaseline = overdoseTimesSec.filter((t) => t >= baselineStart && t < windowStart);
  if (inWindow.length < config.count) {
    return { eligible: false, reason: "below_count", windowCount: inWindow.length, baselineRatePerDay: null };
  }
  if (inBaseline.length < minBaselineEvents) {
    return { eligible: false, reason: "insufficient_baseline", windowCount: inWindow.length, baselineRatePerDay: null };
  }
  const baselineRatePerDay = inBaseline.length / config.baselineDays;
  const expectedInWindow = baselineRatePerDay * (config.windowHours / 24);
  // The window volume must EXCEED double the baseline expectation. With a
  // near-zero baseline the count threshold alone carries the decision; an
  // active baseline (e.g. one overdose every few days) must actually be
  // doubled before the word "spike" is justified.
  if (inWindow.length <= expectedInWindow * 2) {
    return { eligible: false, reason: "baseline_not_exceeded", windowCount: inWindow.length, baselineRatePerDay };
  }
  return { eligible: true, windowCount: inWindow.length, baselineRatePerDay };
}

/* --- Training stagnation ----------------------------------------------------- */

export interface TrainingStagnationResult {
  stagnant: boolean;
  /** Machine-readable reason when not stagnant (documented behavior). */
  reason?: "missing_latest" | "missing_comparison" | "stale_comparison" | "gained";
  /** Observed total battlestat gain over the comparison bracket. */
  gain: number | null;
}

/**
 * Stagnation = no gain in total battle stats between the latest stored stat
 * snapshot and the newest snapshot at or before `windowDays` ago. The
 * comparison snapshot must actually sit inside the window (within 2× the
 * window as a documented cadence tolerance): hourly snapshots can miss the
 * exact day boundary, but a comparison three windows old is not "the value
 * N days ago", it is just old — that renders "—", not zero gain.
 */
export function evaluateTrainingStagnation(
  latest: { total: number; atSec: number } | null,
  comparison: { total: number; atSec: number } | null,
  nowSec: number,
  config: { windowDays: number }
): TrainingStagnationResult {
  if (latest === null || !Number.isFinite(latest.total)) return { stagnant: false, reason: "missing_latest", gain: null };
  if (comparison === null || !Number.isFinite(comparison.total)) return { stagnant: false, reason: "missing_comparison", gain: null };
  const windowStartSec = nowSec - config.windowDays * 86_400;
  if (comparison.atSec > latest.atSec || comparison.atSec < windowStartSec - config.windowDays * 86_400) {
    return { stagnant: false, reason: "stale_comparison", gain: null };
  }
  const gain = latest.total - comparison.total;
  if (gain > 0) return { stagnant: false, reason: "gained", gain };
  return { stagnant: true, gain };
}

/* -------------------------------------------------------------------------- */
/* Provenance (2.10.0)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Where an alert's fact came from. Every draft carries one; the UI explains
 * the alert with it. `sources` names the stored resources / event tables the
 * evaluation read (never live-API optimization claims), `window` the
 * observed period. Unavailable pieces render "—" — never a fabricated zero.
 */
export interface AlertProvenance {
  confidence: AlertConfidenceLabel;
  /** Stored resources the alert is derived from (e.g. "NetworthSnapshot"). */
  sources: string[];
  /** Observed period (unix seconds), when the alert has one. */
  window?: { fromSec: number; toSec: number };
  /** Honest caveat shown verbatim in the UI (proxy semantics, tolerances). */
  note?: string;
}

/** A raised alert draft — deterministic, privacy-safe, dedupe-keyed. */
export interface AlertDraft {
  triggerType: AlertTriggerId;
  /** Stable per-episode identity; the AlertDelivery unique constraint uses it. */
  dedupeKey: string;
  /** When the underlying fact happened (unix seconds) — never "now" for facts. */
  occurredAt: number;
  title: string;
  message: string;
  /** Structured inbox context (amounts, destinations, resource lists). */
  payload?: Record<string, unknown>;
  /** Where the fact came from — mandatory on every draft. */
  provenance: AlertProvenance;
  clickPath: string;
}

/* -------------------------------------------------------------------------- */
/* API response contracts                                                     */
/* -------------------------------------------------------------------------- */

/** Webhook URLs are secrets: the API only ever surfaces targetPreview. */
export interface AlertChannelDto {
  id: string;
  type: string;
  targetPreview: string;
  verifiedAtSec: number | null;
  enabled: boolean;
  createdAtSec: number;
}

export interface AlertChannelCreateResult {
  channel: AlertChannelDto;
}

export interface AlertChannelTestResult {
  ok: boolean;
  errorKind?: DiscordErrorKind;
  message?: string;
}

export interface AlertRuleDto {
  id: string;
  triggerType: AlertTriggerId;
  enabled: boolean;
  config: Record<string, unknown>;
  quietHours: AlertQuietHours | null;
  cooldownMinutes: number;
  lastFiredAtSec: number | null;
  /** User snooze (2.10.0): unix seconds until the rule is skipped; null = not snoozed. */
  snoozedUntilSec: number | null;
  createdAtSec: number;
}

export interface AlertRulesResponse {
  rules: AlertRuleDto[];
  triggers: AlertTriggerMeta[];
}

export interface AlertChannelDeliveryDto {
  channelId: string;
  status: AlertDeliveryStatus;
  errorKind: string | null;
  errorMessage: string | null;
  attempts: number;
}

/** One inbox entry: the logical alert AND its in-app delivery. `status` is
 *  the IN-APP state; `channels` carries per-Discord-delivery states so the UI
 *  can label which status belongs to what. */
export interface AlertDeliveryDto {
  id: string;
  /** Owning rule (2.10.0) — lets the inbox offer per-rule snooze. */
  ruleId: string;
  triggerType: AlertTriggerId;
  title: string;
  message: string;
  payload: Record<string, unknown> | null;
  provenance: AlertProvenance | null;
  status: AlertDeliveryStatus;
  /** Quiet-hours deferral (2.10.0): unix seconds until external delivery is
   *  scheduled; null unless status is "deferred". */
  deferredUntilSec: number | null;
  occurredAtSec: number;
  readAtSec: number | null;
  channels: AlertChannelDeliveryDto[];
}

export interface AlertDeliveriesResponse {
  entries: AlertDeliveryDto[];
  nextCursor: string | null;
}

export interface AlertUnreadCountResponse {
  count: number;
}
