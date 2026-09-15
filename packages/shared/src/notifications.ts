/**
 * Notification domain — canonical type registry, urgency model, quiet-hours
 * policy, and the pure classifiers that turn observed state into structured,
 * privacy-first notification drafts.
 *
 * EVERY push type TornScope can emit is declared exactly once in
 * NOTIFICATION_TYPES. Producers, preferences, the quiet-hours engine, the
 * Settings UI and the delivery ledger all read their semantics from this
 * registry — there is no second place where notification behavior is
 * configured.
 *
 * The pure functions here (classifyAttentionEvent, diffTimerTransitions,
 * decideQuietHours) are shared: the worker uses them for delivery and tests
 * exercise the exact same code paths, so a push and its recorded reason can
 * never disagree.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Urgency model (explicit — business-as-usual is never "critical")            */
/* -------------------------------------------------------------------------- */

export const NOTIFICATION_URGENCIES = ["critical", "time_sensitive", "normal", "low"] as const;
export type NotificationUrgency = (typeof NOTIFICATION_URGENCIES)[number];

/**
 * Urgency drives quiet-hours handling and default delivery treatment:
 *  - critical:      service-level (e.g. all syncing stopped). May bypass
 *                   quiet hours when the user allows it. Never used for
 *                   ordinary game events.
 *  - time_sensitive: useful soon; deferred during quiet hours and dropped
 *                   when stale past its maxDeferralAge.
 *  - normal:        can wait until quiet hours end; queued meanwhile.
 *  - low:           informational; push OFF by default.
 */
export type QuietHoursBehavior = "defer" | "suppress";

export const NOTIFICATION_GROUPS = [
  { id: "torn", label: "Torn activity", description: "Events Torn records in your timeline — mail, trades, items, faction." },
  { id: "timers", label: "Travel & timers", description: "Readiness transitions: travel landings, releases, cooldowns, education." },
  { id: "energy", label: "Energy & nerve", description: "Bar thresholds from fresh five-minute snapshots." },
  { id: "account", label: "Account & progression", description: "Daily summary, milestones and level changes." },
  { id: "economy", label: "Economy", description: "Large wallet movements and net-worth changes at your chosen thresholds." },
  { id: "system", label: "System", description: "TornScope's own health: sync problems and credential access." },
] as const;
export type NotificationGroupId = (typeof NOTIFICATION_GROUPS)[number]["id"];

/* -------------------------------------------------------------------------- */
/* Canonical type registry                                                     */
/* -------------------------------------------------------------------------- */

export interface NotificationTypeMeta {
  /** Stable id — also the key stored in the user's preference toggles. */
  id: string;
  label: string;
  /** One-line explanation shown in Settings (why you'd want it). */
  description: string;
  group: NotificationGroupId;
  defaultEnabled: boolean;
  urgency: NotificationUrgency;
  /** What quiet hours do with it when enabled. */
  quietHours: QuietHoursBehavior;
  /** Deferred events older than this are expired, never delivered stale. */
  maxDeferralAgeSeconds: number;
  /** Capability key (KeyCapabilities) that must not be false; null = always. */
  requires: string | null;
  /** Where a notification click lands. */
  clickPath: string;
  /** How the underlying fact is known — shown in delivery history. */
  provenance: "exact" | "derived" | "estimated" | "inferred";
  /** Inline configuration fields this type supports (see TypeConfig). */
  config: Array<"nearFullThreshold" | "cashThreshold" | "networthThreshold" | "summaryTimeMin">;
}

/**
 * The registry. urgency choices are documented per type — nothing here is
 * invented urgency: only TornScope's own delivery health is critical.
 */
export const NOTIFICATION_TYPES: NotificationTypeMeta[] = [
  /* ---- Torn activity (timeline classifications — exact recorded events) --- */
  {
    id: "mail", label: "New mail", group: "torn", defaultEnabled: true,
    description: "Someone sent you Torn mail.",
    urgency: "normal", quietHours: "defer", maxDeferralAgeSeconds: 24 * 3600,
    requires: "canReadUserEvents", clickPath: "/timeline", provenance: "exact", config: [],
  },
  {
    id: "items", label: "Item received", group: "torn", defaultEnabled: false,
    description: "Another player sent you an item.",
    urgency: "normal", quietHours: "defer", maxDeferralAgeSeconds: 24 * 3600,
    requires: "canReadUserLogs", clickPath: "/timeline", provenance: "exact", config: [],
  },
  {
    id: "money", label: "Money received", group: "torn", defaultEnabled: false,
    description: "Every incoming payment — noisy; the economy threshold below is usually better.",
    urgency: "normal", quietHours: "defer", maxDeferralAgeSeconds: 12 * 3600,
    requires: "canReadUserLogs", clickPath: "/money", provenance: "exact", config: [],
  },
  {
    id: "trades", label: "Trades & offers", group: "torn", defaultEnabled: true,
    description: "A trade you are part of was accepted or completed and needs your confirmation.",
    urgency: "time_sensitive", quietHours: "defer", maxDeferralAgeSeconds: 12 * 3600,
    requires: "canReadUserLogs", clickPath: "/timeline", provenance: "exact", config: [],
  },
  {
    id: "rentals", label: "Rental offers", group: "torn", defaultEnabled: true,
    description: "Rental offers and endings on your properties.",
    urgency: "time_sensitive", quietHours: "defer", maxDeferralAgeSeconds: 12 * 3600,
    requires: "canReadUserLogs", clickPath: "/timeline", provenance: "exact", config: [],
  },
  {
    id: "faction_oc", label: "Faction / OC", group: "torn", defaultEnabled: true,
    description: "OC starts and faction payouts.",
    urgency: "time_sensitive", quietHours: "defer", maxDeferralAgeSeconds: 12 * 3600,
    requires: "canReadFactionBasic", clickPath: "/faction", provenance: "exact", config: [],
  },
  /* ---- Travel & timers (live-state transitions — exact) ------------------- */
  {
    id: "travel_arrival", label: "Travel landed", group: "timers", defaultEnabled: true,
    description: "Your trip landed and you can act. Fires once per trip.",
    urgency: "time_sensitive", quietHours: "defer", maxDeferralAgeSeconds: 6 * 3600,
    requires: "canReadUserTravel", clickPath: "/travel", provenance: "exact", config: [],
  },
  {
    id: "hospital_release", label: "Hospital release", group: "timers", defaultEnabled: true,
    description: "You were released from hospital.",
    urgency: "time_sensitive", quietHours: "defer", maxDeferralAgeSeconds: 2 * 3600,
    requires: "canReadUserBasic", clickPath: "/today", provenance: "exact", config: [],
  },
  {
    id: "jail_release", label: "Jail release", group: "timers", defaultEnabled: true,
    description: "You were released from jail.",
    urgency: "time_sensitive", quietHours: "defer", maxDeferralAgeSeconds: 2 * 3600,
    requires: "canReadUserBasic", clickPath: "/today", provenance: "exact", config: [],
  },
  {
    id: "drug_cooldown", label: "Drug cooldown ready", group: "timers", defaultEnabled: true,
    description: "Your drug cooldown finished. Fires on the transition, not repeatedly.",
    urgency: "time_sensitive", quietHours: "defer", maxDeferralAgeSeconds: 6 * 3600,
    requires: "canReadUserCooldowns", clickPath: "/today", provenance: "exact", config: [],
  },
  {
    id: "medical_cooldown", label: "Medical cooldown ready", group: "timers", defaultEnabled: true,
    description: "Your medical cooldown finished.",
    urgency: "time_sensitive", quietHours: "defer", maxDeferralAgeSeconds: 6 * 3600,
    requires: "canReadUserCooldowns", clickPath: "/today", provenance: "exact", config: [],
  },
  {
    id: "booster_cooldown", label: "Booster cooldown ready", group: "timers", defaultEnabled: true,
    description: "Your booster cooldown finished.",
    urgency: "time_sensitive", quietHours: "defer", maxDeferralAgeSeconds: 6 * 3600,
    requires: "canReadUserCooldowns", clickPath: "/today", provenance: "exact", config: [],
  },
  {
    id: "education_complete", label: "Education completed", group: "timers", defaultEnabled: true,
    description: "Your education course finished.",
    urgency: "normal", quietHours: "defer", maxDeferralAgeSeconds: 24 * 3600,
    requires: "canReadUserEducation", clickPath: "/today", provenance: "exact", config: [],
  },
  /* ---- Energy & nerve ----------------------------------------------------- */
  {
    id: "energy_full", label: "Energy full", group: "energy", defaultEnabled: false,
    description: "Your energy bar reached full. Re-arms after you spend below it.",
    urgency: "time_sensitive", quietHours: "defer", maxDeferralAgeSeconds: 1 * 3600,
    requires: "canReadUserBars", clickPath: "/today", provenance: "exact", config: [],
  },
  {
    id: "energy_near_full", label: "Energy near full", group: "energy", defaultEnabled: false,
    description: "Your energy crossed your chosen threshold.",
    urgency: "time_sensitive", quietHours: "defer", maxDeferralAgeSeconds: 1 * 3600,
    requires: "canReadUserBars", clickPath: "/today", provenance: "exact", config: ["nearFullThreshold"],
  },
  {
    id: "nerve_full", label: "Nerve full", group: "energy", defaultEnabled: false,
    description: "Your nerve bar reached full.",
    urgency: "time_sensitive", quietHours: "defer", maxDeferralAgeSeconds: 1 * 3600,
    requires: "canReadUserBars", clickPath: "/today", provenance: "exact", config: [],
  },
  /* ---- Account & progression ---------------------------------------------- */
  {
    id: "daily_summary_ready", label: "Daily summary ready", group: "account", defaultEnabled: true,
    description: "A nudge that today's TornScope summary is ready — once per day, on your profile timezone.",
    urgency: "normal", quietHours: "defer", maxDeferralAgeSeconds: 4 * 3600,
    requires: null, clickPath: "/today", provenance: "derived", config: ["summaryTimeMin"],
  },
  {
    id: "progression_milestone", label: "Progression milestones", group: "account", defaultEnabled: true,
    description: "A battlestat crossed one of your milestone thresholds. Once per milestone, ever.",
    urgency: "normal", quietHours: "defer", maxDeferralAgeSeconds: 24 * 3600,
    requires: "canReadUserPersonalStats", clickPath: "/progression", provenance: "derived", config: [],
  },
  {
    id: "level_up", label: "Level ups", group: "account", defaultEnabled: true,
    description: "Your Torn level increased.",
    urgency: "normal", quietHours: "defer", maxDeferralAgeSeconds: 24 * 3600,
    requires: "canReadUserBasic", clickPath: "/progression", provenance: "exact", config: [],
  },
  {
    id: "bank_matured", label: "Bank maturity", group: "account", defaultEnabled: true,
    description: "A city-bank investment reached its maturity date.",
    urgency: "normal", quietHours: "defer", maxDeferralAgeSeconds: 24 * 3600,
    requires: "canReadUserMoney", clickPath: "/money", provenance: "exact", config: [],
  },
  /* ---- Economy ------------------------------------------------------------- */
  {
    id: "major_cash_movement", label: "Major cash movement", group: "economy", defaultEnabled: false,
    description: "A single wallet transaction above your threshold. Item sales are worded as asset sales, never profit.",
    urgency: "normal", quietHours: "defer", maxDeferralAgeSeconds: 12 * 3600,
    requires: "canReadUserLogs", clickPath: "/money", provenance: "exact", config: ["cashThreshold"],
  },
  {
    id: "networth_movement", label: "Large net-worth change", group: "economy", defaultEnabled: false,
    description: "An official net-worth snapshot differed from the previous one by more than your threshold. Not a profit figure.",
    urgency: "normal", quietHours: "defer", maxDeferralAgeSeconds: 12 * 3600,
    requires: "canReadUserNetworth", clickPath: "/money", provenance: "derived", config: ["networthThreshold"],
  },
  /* ---- System --------------------------------------------------------------- */
  {
    id: "sync_degraded", label: "Sync problems", group: "system", defaultEnabled: true,
    description: "One or more data sources stopped updating. Grouped into a single alert per incident.",
    urgency: "time_sensitive", quietHours: "defer", maxDeferralAgeSeconds: 12 * 3600,
    requires: null, clickPath: "/sync", provenance: "exact", config: [],
  },
  {
    id: "sync_recovered", label: "Sync recovered", group: "system", defaultEnabled: false,
    description: "A previously failing source is healthy again.",
    urgency: "low", quietHours: "defer", maxDeferralAgeSeconds: 24 * 3600,
    requires: null, clickPath: "/sync", provenance: "exact", config: [],
  },
  {
    id: "capability_lost", label: "Access lost", group: "system", defaultEnabled: true,
    description: "Torn revoked or paused a key permission — history is retained, new data is no longer syncing.",
    urgency: "critical", quietHours: "defer", maxDeferralAgeSeconds: 12 * 3600,
    requires: null, clickPath: "/settings", provenance: "exact", config: [],
  },
];

export const NOTIFICATION_TYPE_IDS = NOTIFICATION_TYPES.map((t) => t.id) as [string, ...string[]];

export function notificationType(id: string): NotificationTypeMeta | undefined {
  return NOTIFICATION_TYPES.find((t) => t.id === id);
}

/** Defaults for every type toggle, keyed by type id. */
export const DEFAULT_TYPE_TOGGLES: Record<string, boolean> = Object.fromEntries(
  NOTIFICATION_TYPES.map((t) => [t.id, t.defaultEnabled])
);

/**
 * Legacy preference maps used pre-registry category ids. Each legacy key
 * fans out to the types it used to cover; existing user choices survive.
 * `attention` was a dead toggle (no producer ever emitted it) and drops.
 */
const LEGACY_TOGGLE_MAP: Record<string, string[]> = {
  travel: ["travel_arrival"],
  hospital_jail: ["hospital_release", "jail_release"],
  cooldowns: ["drug_cooldown", "medical_cooldown", "booster_cooldown"],
  education: ["education_complete"],
  bank: ["bank_matured"],
  energy_nerve: ["energy_full", "nerve_full"],
  mail: ["mail"],
  items: ["items"],
  money: ["money"],
  trades: ["trades"],
  rentals: ["rentals"],
  faction_oc: ["faction_oc"],
};

/**
 * Normalize a stored toggle map to canonical type ids. Legacy keys are
 * applied only where the new key has no explicit stored value yet; unknown
 * keys (e.g. the dead `attention`) are ignored.
 */
export function normalizeTypeToggles(stored: Record<string, boolean> | null | undefined): Record<string, boolean> {
  const merged: Record<string, boolean> = { ...DEFAULT_TYPE_TOGGLES };
  if (!stored) return merged;
  for (const [key, value] of Object.entries(stored)) {
    const targets = LEGACY_TOGGLE_MAP[key];
    if (targets) {
      for (const target of targets) {
        if (merged[target] === DEFAULT_TYPE_TOGGLES[target]) merged[target] = value;
      }
    } else if (notificationType(key)) {
      merged[key] = value;
    }
  }
  return merged;
}

/* -------------------------------------------------------------------------- */
/* Per-type configuration                                                      */
/* -------------------------------------------------------------------------- */

export const TYPE_CONFIG_DEFAULTS = {
  /** energy_near_full threshold (absolute energy). */
  nearFullThreshold: 135,
  /** major_cash_movement threshold (absolute $ per transaction). */
  cashThreshold: 50_000_000,
  /** networth_movement threshold (absolute $ change between snapshots). */
  networthThreshold: 100_000_000,
  /** daily_summary_ready local delivery time (minutes since midnight). */
  summaryTimeMin: 8 * 60,
} as const;

export const TypeConfigSchema = z.object({
  nearFullThreshold: z.number().int().min(1).max(1000).optional(),
  cashThreshold: z.number().min(0).max(10_000_000_000).optional(),
  networthThreshold: z.number().min(0).max(1_000_000_000_000).optional(),
  summaryTimeMin: z.number().int().min(0).max(1439).optional(),
});
export type TypeConfig = z.infer<typeof TypeConfigSchema>;
/** All fields present — what producers receive (defaults filled in). */
export type ResolvedTypeConfig = Required<TypeConfig>;

export function normalizeTypeConfig(stored: unknown): ResolvedTypeConfig {
  const parsed = TypeConfigSchema.safeParse(stored ?? {});
  return { ...TYPE_CONFIG_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
}

/* -------------------------------------------------------------------------- */
/* Quiet-hours policy                                                          */
/* -------------------------------------------------------------------------- */

export interface QuietHoursSettings {
  startMin: number | null;
  endMin: number | null;
  /** Critical alerts may bypass quiet hours (user choice; default true). */
  bypassCritical: boolean;
}

export type QuietHoursDecision =
  | { action: "deliver" }
  | { action: "defer"; /** Earliest delivery: the quiet-hours end, epoch seconds. */ deliverAtSec: number }
  | { action: "suppress"; reason: "quiet_hours" };

/** True when `nowLocalMin` falls inside the (possibly overnight) window. */
export function isWithinQuietHours(startMin: number, endMin: number, nowLocalMin: number): boolean {
  return startMin < endMin ? nowLocalMin >= startMin && nowLocalMin < endMin : nowLocalMin >= startMin || nowLocalMin < endMin;
}

/**
 * Central quiet-hours policy. Explicit user action (the test push) is never
 * deferred: nothing about it can be stale. CRITICAL types bypass when the
 * preference allows; everything else defers per its registry behavior —
 * quiet hours never silently destroy an event anymore, the deferral queue
 * carries it (and expires it) instead.
 */
export function decideQuietHours(
  type: NotificationTypeMeta,
  quiet: QuietHoursSettings,
  nowLocalMin: number,
  opts: { quietEndSec: number | null; explicit?: boolean }
): QuietHoursDecision {
  if (quiet.startMin === null || quiet.endMin === null) return { action: "deliver" };
  if (!isWithinQuietHours(quiet.startMin, quiet.endMin, nowLocalMin)) return { action: "deliver" };
  if (opts.explicit) return { action: "deliver" };
  if (type.urgency === "critical") {
    return quiet.bypassCritical ? { action: "deliver" } : { action: "suppress", reason: "quiet_hours" };
  }
  if (type.quietHours === "defer") {
    if (opts.quietEndSec === null) return { action: "suppress", reason: "quiet_hours" };
    return { action: "defer", deliverAtSec: opts.quietEndSec };
  }
  return { action: "suppress", reason: "quiet_hours" };
}

/* -------------------------------------------------------------------------- */
/* Delivery reasons (machine → human readable in one place)                    */
/* -------------------------------------------------------------------------- */

export const DELIVERY_REASONS = [
  "quiet_hours",
  "disabled_by_user",
  "missing_capability",
  "insufficient_confidence",
  "duplicate",
  "rate_limited",
  "expired",
  "demo_suppressed",
  "invalid_subscription",
  "device_disabled",
  "stale_event",
  "unsupported_browser",
] as const;
export type DeliveryReason = (typeof DELIVERY_REASONS)[number];

export const DELIVERY_REASON_LABELS: Record<DeliveryReason, string> = {
  quiet_hours: "Quiet hours",
  disabled_by_user: "Disabled by you",
  missing_capability: "API key lacks the required permission",
  insufficient_confidence: "Source data was not reliable enough",
  duplicate: "Already notified",
  rate_limited: "Rate limited",
  expired: "No longer useful by delivery time",
  demo_suppressed: "Demo profile — no real alerts",
  invalid_subscription: "Device subscription expired",
  device_disabled: "Device was disabled",
  stale_event: "Event was too old to notify",
  unsupported_browser: "Browser does not support push",
};

/** Delivery lifecycle statuses. Web Push proves ACCEPTANCE, never display. */
export const DELIVERY_STATUSES = [
  "pending",
  "deferred",
  "sent",
  "failed",
  "invalid_subscription",
  "suppressed",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Event-level lifecycle (one logical event per profile, not per device). */
export const NOTIFICATION_EVENT_STATUSES = ["pending", "deferred", "delivered", "failed", "suppressed", "expired"] as const;
export type NotificationEventStatus = (typeof NOTIFICATION_EVENT_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Attention classifier (timeline titles → drafts)                             */
/* -------------------------------------------------------------------------- */

export interface AttentionClassification {
  /** Canonical notification type this event belongs to. */
  type: string;
  urgency: NotificationUrgency;
  /** Notification title (always safe — no sensitive detail). */
  title: string;
  /** Default body — privacy-first: no amounts, senders or item names. */
  body: string;
  /** Richer body used only when sensitiveDetails is enabled. */
  sensitiveBody: string | null;
  /** Stable dedupe key component: type + parsed identity (idempotent). */
  eventKey: string;
  /** In-app destination for notification click. */
  clickPath: string;
}

/**
 * Classify a normalized Timeline title into a notification draft, or null
 * when the event is not notification-worthy. Patterns are grounded in real
 * stored Torn titles (verified against production data).
 */
export function classifyAttentionEvent(title: string): AttentionClassification | null {
  const t = title.trim();

  // ---- Rental offers / extensions (attention-worthy, high value) ----------
  const rentalExt = /^(.+?) has offered you a (\d+) day extension on the rental of their (.+?) for \$([\d,]+)(?:\.\d+)?/i.exec(t);
  if (rentalExt) {
    const [, player, days, property, amount] = rentalExt as unknown as [string, string, string, string, string, string];
    const pretty = Number(amount.replace(/,/g, "")).toLocaleString("en-US");
    return {
      type: "rentals",
      urgency: "time_sensitive",
      title: "Rental offer",
      body: `${player} offered a ${days}-day ${property} rental extension.`,
      sensitiveBody: `${player} offered a ${days}-day ${property} rental extension for $${pretty}.`,
      eventKey: `rental:${player}:${days}:${property}:${amount}`,
      clickPath: "/timeline",
    };
  }
  if (/^Property rental market (extension )?rent(er)?/i.test(t) && /extension/i.test(t)) {
    return {
      type: "rentals",
      urgency: "time_sensitive",
      title: "Rental offer",
      body: "A property rental extension offer was made.",
      sensitiveBody: null,
      eventKey: `rental-market:${t}`,
      clickPath: "/timeline",
    };
  }
  const rentalEnd = /^Your rental agreement with (.+?) for the lease of their (.+?) is coming to an end/i.exec(t);
  if (rentalEnd) {
    const [, player, property] = rentalEnd;
    return {
      type: "rentals",
      urgency: "time_sensitive",
      title: "Rental ending soon",
      body: `Your rental agreement with ${player} (${property}) is coming to an end.`,
      sensitiveBody: null,
      eventKey: `rental-end:${player}:${property}`,
      clickPath: "/timeline",
    };
  }

  // ---- Trades -------------------------------------------------------------
  const tradeAccepted = /^(.+?) has accepted the trade titled ["“](.+)["”]/i.exec(t);
  if (tradeAccepted) {
    const [, player, tradeTitle] = tradeAccepted;
    return {
      type: "trades",
      urgency: "time_sensitive",
      title: "Trade updated",
      body: `${player} accepted a trade — your confirmation is required.`,
      sensitiveBody: `${player} accepted the trade titled "${tradeTitle}" — your confirmation is required.`,
      eventKey: `trade-accept:${player}:${tradeTitle}`,
      clickPath: "/timeline",
    };
  }
  if (/^Trade (accepted|completed)$/i.test(t)) {
    return {
      type: "trades",
      urgency: "time_sensitive",
      title: "Trade updated",
      body: `A trade was ${t.split(" ")[1]!.toLowerCase()}.`,
      sensitiveBody: null,
      eventKey: `trade-state:${t}`,
      clickPath: "/timeline",
    };
  }

  // ---- Mail ---------------------------------------------------------------
  if (/\bmail\b/i.test(t) && /(got|received|new|sent)/i.test(t)) {
    return {
      type: "mail",
      urgency: "normal",
      title: "New Torn mail",
      body: "You received a new message.",
      sensitiveBody: null,
      eventKey: `mail:${t}`,
      clickPath: "/timeline",
    };
  }

  // ---- Item received ------------------------------------------------------
  if (/sent you an item/i.test(t) || (/gave you \d+ ?x? ?/i.test(t) && /item/i.test(t))) {
    return {
      type: "items",
      urgency: "normal",
      title: "Item received",
      body: "Someone sent you an item.",
      sensitiveBody: t,
      eventKey: `item:${t}`,
      clickPath: "/timeline",
    };
  }

  // ---- Money received (activity; OFF by default) --------------------------
  if (/^Money receive$/i.test(t)) {
    return {
      type: "money",
      urgency: "normal",
      title: "Money received",
      body: "New incoming money detected.",
      sensitiveBody: null,
      eventKey: `money:${t}`,
      clickPath: "/money",
    };
  }

  // ---- Faction payouts ----------------------------------------------------
  if (/^Faction payout money (balance )?receive$/i.test(t) || /^Faction give money receive$/i.test(t)) {
    const oc = /balance/i.test(t);
    return {
      type: "faction_oc",
      urgency: "normal",
      title: oc ? "OC payout received" : "Faction payout received",
      body: oc ? "An OC payout was credited to your faction balance." : "A faction payout was credited to you.",
      sensitiveBody: null,
      eventKey: `faction-payout:${t}`,
      clickPath: "/faction",
    };
  }

  // ---- OC initiated (you participated) ------------------------------------
  const ocInit = /^The (.+?) scenario you participated in has been initiated/i.exec(t);
  if (ocInit) {
    return {
      type: "faction_oc",
      urgency: "time_sensitive",
      title: "OC started",
      body: `The ${ocInit[1]} scenario you joined has been initiated.`,
      sensitiveBody: null,
      eventKey: `oc-init:${ocInit[1]}`,
      clickPath: "/faction",
    };
  }

  // ---- Education / bank completion events (torn_event) --------------------
  if (/education course you were taking has ended/i.test(t)) {
    return {
      type: "education_complete",
      urgency: "normal",
      title: "Education completed",
      body: "Your education course has ended.",
      sensitiveBody: null,
      eventKey: `education:${t}`,
      clickPath: "/today",
    };
  }
  if (/your bank investment has ended/i.test(t)) {
    return {
      type: "bank_matured",
      urgency: "normal",
      title: "Bank investment matured",
      body: "Your bank investment has ended — collect your funds.",
      sensitiveBody: null,
      eventKey: `bank:${t}`,
      clickPath: "/money",
    };
  }

  return null;
}

/** Parse helper exposed for tests: extract the money amount from a rental title. */
export function parseRentalAmount(title: string): number | null {
  const m = /\$([\d,]+)(?:\.\d+)?/.exec(title);
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
}

/* -------------------------------------------------------------------------- */
/* Timer transitions (live-state diffing — single source of truth)             */
/* -------------------------------------------------------------------------- */

export interface LiveTimerState {
  cooldownDrugEndsAt?: number | null;
  cooldownMedicalEndsAt?: number | null;
  cooldownBoosterEndsAt?: number | null;
  travelLandsAt?: number | null;
  hospitalizedUntil?: number | null;
  jailedUntil?: number | null;
  educationEndsAt?: number | null;
  bankMaturesAt?: number | null;
  energyFullAt?: number | null;
  nerveFullAt?: number | null;
}

interface TimerRule {
  key: keyof LiveTimerState;
  type: string;
  label: string;
  readyLabel: string;
  /** Overrides the registry click path for more specific destinations. */
  clickPath?: string;
}

/** The tracked live timers. Keys are stable: rule + end timestamp.
 *  Energy is deliberately NOT here — its full/near-full state is owned by the
 *  bars-snapshot producer (fresh 5-minute snapshots + explicit re-arm
 *  hysteresis). Nerve stays on this live-timer path: one notification path
 *  per bar, never both. */
export const TIMER_RULES: TimerRule[] = [
  { key: "travelLandsAt", type: "travel_arrival", label: "Travel landed", readyLabel: "Travel landed — welcome home." },
  { key: "hospitalizedUntil", type: "hospital_release", label: "Hospital", readyLabel: "You have been released from hospital." },
  { key: "jailedUntil", type: "jail_release", label: "Jail", readyLabel: "You have been released from jail." },
  { key: "cooldownDrugEndsAt", type: "drug_cooldown", label: "Drug cooldown", readyLabel: "Your drug cooldown is ready." },
  { key: "cooldownMedicalEndsAt", type: "medical_cooldown", label: "Medical cooldown", readyLabel: "Your medical cooldown is ready." },
  { key: "cooldownBoosterEndsAt", type: "booster_cooldown", label: "Booster cooldown", readyLabel: "Your booster cooldown is ready." },
  { key: "educationEndsAt", type: "education_complete", label: "Education", readyLabel: "Your education course has completed." },
  { key: "bankMaturesAt", type: "bank_matured", label: "Bank investment", readyLabel: "Your bank investment has matured.", clickPath: "/money" },
  { key: "nerveFullAt", type: "nerve_full", label: "Nerve full", readyLabel: "Your nerve is full." },
];

export interface TimerTransitionEvent {
  type: string;
  urgency: NotificationUrgency;
  title: string;
  body: string;
  eventKey: string;
  clickPath: string;
}

/**
 * Diff the previous and current live-state snapshots: a timer that was
 * active (end in the future) and has now crossed its end emits exactly one
 * transition event with a STABLE key (rule + end timestamp), so the delivery
 * ledger can dedupe restarts and re-evaluations. Also returns the soonest
 * active end (+grace) so callers sleep until something can change.
 */
export function diffTimerTransitions(
  previous: LiveTimerState | null,
  current: LiveTimerState,
  nowSec: number,
  graceSeconds = 45
): { events: TimerTransitionEvent[]; nextEligibleAt: number | null } {
  const events: TimerTransitionEvent[] = [];
  let nextEligibleAt: number | null = null;
  for (const rule of TIMER_RULES) {
    const prevEnd = previous?.[rule.key] ?? null;
    const curEnd = current[rule.key] ?? null;
    if (prevEnd !== null && curEnd === null && prevEnd <= nowSec + graceSeconds) {
      const meta = notificationType(rule.type);
      events.push({
        type: rule.type,
        urgency: meta?.urgency ?? "time_sensitive",
        title: rule.label,
        body: rule.readyLabel,
        eventKey: `${rule.key}:ended:${prevEnd}`,
        clickPath: rule.clickPath ?? meta?.clickPath ?? "/today",
      });
    }
    if (curEnd !== null && curEnd > nowSec) {
      const eligible = curEnd + graceSeconds;
      if (nextEligibleAt === null || eligible < nextEligibleAt) nextEligibleAt = eligible;
    }
  }
  return { events, nextEligibleAt };
}

/* -------------------------------------------------------------------------- */
/* Sync-system coalescing                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Word a grouped sync-problem notification from machine state. Deliberately
 * free of internal jargon ("money_logs worker stale_running" never ships) —
 * resource labels are humanized and the click target explains the details.
 */
export function syncProblemCopy(failing: string[], humanLabels: Record<string, string>): { title: string; body: string } {
  const n = failing.length;
  if (n === 1) {
    const label = humanLabels[failing[0]!] ?? "Some data";
    return { title: "Data source needs attention", body: `${label} is no longer updating.` };
  }
  return { title: "Data sources need attention", body: `${n} data sources are no longer updating — check Sync Status.` };
}

export function capabilityLostCopy(resources: string[], humanLabels: Record<string, string>): { title: string; body: string } {
  const n = resources.length;
  const what = n === 1 ? (humanLabels[resources[0]!] ?? "A data source") : `${n} data sources`;
  return {
    title: "Torn access was removed",
    body: `${what} stopped syncing. Your existing history is retained; new data is no longer collected.`,
  };
}
