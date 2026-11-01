/**
 * Proactive Alerts domain (2.9.0) — built-in trigger registry, per-rule
 * quiet-hours policy, and the pure transition/threshold evaluators.
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

export const ALERT_DELIVERY_STATUSES = ["pending", "sent", "failed", "suppressed"] as const;
export type AlertDeliveryStatus = (typeof ALERT_DELIVERY_STATUSES)[number];

export const ALERT_DELIVERY_STATUS_LABELS: Record<AlertDeliveryStatus, string> = {
  pending: "Pending",
  sent: "Delivered",
  failed: "Failed",
  suppressed: "Suppressed",
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
] as const;
export type AlertTriggerId = (typeof ALERT_TRIGGER_IDS)[number];

export const ALERT_TRIGGER_GROUPS = ["gameplay", "operational"] as const;
export type AlertTriggerGroup = (typeof ALERT_TRIGGER_GROUPS)[number];

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
export const EmptyConfigSchema = z.object({}).strict();

export type CooldownReadyConfig = z.infer<typeof CooldownReadyConfigSchema>;
export type NetWorthDropConfig = z.infer<typeof NetWorthDropConfigSchema>;

export interface AlertTriggerMeta {
  id: AlertTriggerId;
  label: string;
  /** One-line explanation shown on the rule card. */
  description: string;
  group: AlertTriggerGroup;
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
    group: "gameplay",
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
    group: "gameplay",
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
    group: "gameplay",
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
    group: "gameplay",
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
    group: "gameplay",
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
    group: "gameplay",
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
    group: "operational",
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
    group: "operational",
    clickPath: "/sync",
    needsLiveFetch: false,
    defaultConfig: {},
    configSchema: EmptyConfigSchema,
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
 */
export interface AlertTimerState {
  cooldownDrugEndsAt?: number | null;
  cooldownBoosterEndsAt?: number | null;
  cooldownMedicalEndsAt?: number | null;
  travelLandsAt?: number | null;
  educationEndsAt?: number | null;
  bankMaturesAt?: number | null;
}

/** Evaluator working state persisted on AlertRule.lastState (Json). Only the
 *  slice owned by the rule's trigger is written; unknown keys are preserved
 *  by the merge in the worker. */
export interface AlertRuleState {
  /** Previous observation instant (unix seconds) — the transition anchor. */
  observedAt: number;
  /** Timer ends at the previous observation (state-transition triggers). */
  timers?: AlertTimerState;
  /** Open threshold episode (net_worth_drop): the alerting baseline. */
  openEpisode?: { baselineId: string } | null;
  /** Previously failing resources (sync_failure / sync_recovery). */
  failing?: string[];
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
  openEpisodeKey: string | null
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
  const episodeKey = `nwdrop:${baseline.id}`;
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
  clickPath: string;
}

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
  triggerType: AlertTriggerId;
  title: string;
  message: string;
  payload: Record<string, unknown> | null;
  status: AlertDeliveryStatus;
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
