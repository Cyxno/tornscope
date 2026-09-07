/**
 * Notification domain: canonical categories, defaults, and the attention
 * classifier that turns normalized Torn Timeline titles into structured,
 * privacy-first notification events.
 *
 * The classifier is PURE and shared: the worker uses it for push delivery
 * and the Overview "Needs attention" card renders the same classifications,
 * so a push and its on-site representation can never disagree.
 */

export const NOTIFICATION_CATEGORIES = [
  { id: "attention", label: "Torn needs attention", default: true, requires: "canReadUserEvents" },
  { id: "mail", label: "Mail", default: true, requires: "canReadUserEvents" },
  { id: "items", label: "Items received", default: false, requires: "canReadUserLogs" },
  { id: "money", label: "Money received", default: false, requires: "canReadUserLogs" },
  { id: "trades", label: "Trades & offers", default: true, requires: "canReadUserLogs" },
  { id: "rentals", label: "Rental offers", default: true, requires: "canReadUserLogs" },
  { id: "faction_oc", label: "Faction / OC", default: true, requires: "canReadFactionBasic" },
  { id: "travel", label: "Travel", default: true, requires: "canReadUserTravel" },
  { id: "hospital_jail", label: "Hospital / Jail", default: true, requires: "canReadUserBasic" },
  { id: "education", label: "Education", default: true, requires: "canReadUserEducation" },
  { id: "bank", label: "Bank", default: true, requires: "canReadUserMoney" },
  { id: "cooldowns", label: "Cooldowns", default: true, requires: "canReadUserCooldowns" },
  { id: "energy_nerve", label: "Energy / Nerve full", default: false, requires: "canReadUserBars" },
] as const;

export type NotificationCategoryId = (typeof NOTIFICATION_CATEGORIES)[number]["id"];

export const DEFAULT_CATEGORY_STATE: Record<string, boolean> = Object.fromEntries(
  NOTIFICATION_CATEGORIES.map((c) => [c.id, c.default])
);

export const NOTIFICATION_IMPORTANCES = ["critical", "important", "activity", "low"] as const;
export type NotificationImportance = (typeof NOTIFICATION_IMPORTANCES)[number];

/** Importance for each category (drives quiet-hours handling). */
export const CATEGORY_IMPORTANCE: Record<string, NotificationImportance> = {
  attention: "important",
  mail: "activity",
  items: "activity",
  money: "activity",
  trades: "important",
  rentals: "important",
  faction_oc: "important",
  travel: "important",
  hospital_jail: "important",
  education: "important",
  bank: "important",
  cooldowns: "important",
  energy_nerve: "low",
};

export interface AttentionClassification {
  /** Canonical category this event belongs to. */
  category: NotificationCategoryId;
  importance: NotificationImportance;
  /** Notification title (always safe — no sensitive detail). */
  title: string;
  /** Default body — privacy-first: no amounts, senders or item names. */
  body: string;
  /** Richer body used only when sensitiveDetails is enabled. */
  sensitiveBody: string | null;
  /** Stable event key component: type + parsed identity (idempotent). */
  eventKey: string;
  /** In-app destination for notification click / attention card. */
  clickPath: string;
}

/**
 * Classify a normalized Timeline title into an attention notification, or
 * null when the event is not attention-worthy. Patterns are grounded in
 * real stored Torn titles (verified against production data).
 */
export function classifyAttentionEvent(title: string): AttentionClassification | null {
  const t = title.trim();

  // ---- Rental offers / extensions (attention-worthy, high value) ----------
  const rentalExt = /^(.+?) has offered you a (\d+) day extension on the rental of their (.+?) for \$([\d,]+)(?:\.\d+)?/i.exec(t);
  if (rentalExt) {
    const [, player, days, property, amount] = rentalExt as unknown as [string, string, string, string, string, string];
    const pretty = Number(amount.replace(/,/g, "")).toLocaleString("en-US");
    return {
      category: "rentals",
      importance: "important",
      title: "Rental offer",
      body: `${player} offered a ${days}-day ${property} rental extension.`,
      sensitiveBody: `${player} offered a ${days}-day ${property} rental extension for $${pretty}.`,
      eventKey: `rental:${player}:${days}:${property}:${amount}`,
      clickPath: "/timeline",
    };
  }
  if (/^Property rental market (extension )?rent(er)?/i.test(t) && /extension/i.test(t)) {
    return {
      category: "rentals",
      importance: "important",
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
      category: "rentals",
      importance: "important",
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
      category: "trades",
      importance: "important",
      title: "Trade updated",
      body: `${player} accepted a trade — your confirmation is required.`,
      sensitiveBody: `${player} accepted the trade titled "${tradeTitle}" — your confirmation is required.`,
      eventKey: `trade-accept:${player}:${tradeTitle}`,
      clickPath: "/timeline",
    };
  }
  if (/^Trade (accepted|completed)$/i.test(t)) {
    return {
      category: "trades",
      importance: "important",
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
      category: "mail",
      importance: "activity",
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
      category: "items",
      importance: "activity",
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
      category: "money",
      importance: "activity",
      title: "Money received",
      body: "New incoming money detected.",
      sensitiveBody: null,
      eventKey: `money:${t}`,
      clickPath: "/timeline",
    };
  }

  // ---- Faction payouts ----------------------------------------------------
  if (/^Faction payout money (balance )?receive$/i.test(t) || /^Faction give money receive$/i.test(t)) {
    const oc = /balance/i.test(t);
    return {
      category: "faction_oc",
      importance: "activity",
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
      category: "faction_oc",
      importance: "important",
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
      category: "education",
      importance: "important",
      title: "Education completed",
      body: "Your education course has ended.",
      sensitiveBody: null,
      eventKey: `education:${t}`,
      clickPath: "/today",
    };
  }
  if (/your bank investment has ended/i.test(t)) {
    return {
      category: "bank",
      importance: "important",
      title: "Bank investment matured",
      body: "Your bank investment has ended — collect your funds.",
      sensitiveBody: null,
      eventKey: `bank:${t}`,
      clickPath: "/today",
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
/* Timer transitions (live-state diffing)                                      */
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

export interface TimerRule {
  key: keyof LiveTimerState;
  category: NotificationCategoryId;
  label: string;
  landedLabel: string;
}

/** The tracked live timers, in priority order. */
export const TIMER_RULES: TimerRule[] = [
  { key: "travelLandsAt", category: "travel", label: "Traveling", landedLabel: "Travel landed — welcome home." },
  { key: "hospitalizedUntil", category: "hospital_jail", label: "Hospital", landedLabel: "You have been released from hospital." },
  { key: "jailedUntil", category: "hospital_jail", label: "Jail", landedLabel: "You have been released from jail." },
  { key: "cooldownDrugEndsAt", category: "cooldowns", label: "Drug cooldown", landedLabel: "Your drug cooldown is ready." },
  { key: "cooldownMedicalEndsAt", category: "cooldowns", label: "Medical cooldown", landedLabel: "Your medical cooldown is ready." },
  { key: "cooldownBoosterEndsAt", category: "cooldowns", label: "Booster cooldown", landedLabel: "Your booster cooldown is ready." },
  { key: "educationEndsAt", category: "education", label: "Education", landedLabel: "Your education course has completed." },
  { key: "bankMaturesAt", category: "bank", label: "Bank investment", landedLabel: "Your bank investment has matured." },
  { key: "energyFullAt", category: "energy_nerve", label: "Energy", landedLabel: "Your energy is full." },
  { key: "nerveFullAt", category: "energy_nerve", label: "Nerve", landedLabel: "Your nerve is full." },
];

export interface TimerTransitionEvent {
  category: NotificationCategoryId;
  importance: NotificationImportance;
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
      const clickPath = rule.category === "travel" ? "/travel" : rule.category === "bank" ? "/economy" : "/today";
      events.push({
        category: rule.category,
        importance: CATEGORY_IMPORTANCE[rule.category] ?? "important",
        title: rule.label,
        body: rule.landedLabel,
        eventKey: `${rule.key}:ended:${prevEnd}`,
        clickPath,
      });
    }
    if (curEnd !== null && curEnd > nowSec) {
      const eligible = curEnd + graceSeconds;
      if (nextEligibleAt === null || eligible < nextEligibleAt) nextEligibleAt = eligible;
    }
  }
  return { events, nextEligibleAt };
}
