/**
 * Command Center action model (2.0).
 *
 * Turns live state + goals + insights + data health into ONE prioritized,
 * deduplicated attention feed. Deterministic rules only — no LLM decides
 * anything here. The engine's core discipline is RESTRAINT:
 *
 * - an item exists only when acting on it (or knowing it) is useful NOW —
 *   every rule has an explicit activation threshold and many have an expiry
 *   (e.g. a cooldown ready for more than a day stops being news);
 * - at most one item per identity (stable `id`), so nothing can spam;
 * - the feed is capped and sorted; the UI renders the top slice.
 *
 * Pure function: same facts in, same feed out. The API gathers facts (today
 * cache, stored goals/insights/freshness); the UI renders — and maps the
 * few machine states to copy where wording matters.
 */
import type { Insight, InsightPriority } from "./insights.js";
import type { DataFreshnessEntry } from "./freshness.js";
import type { Provenance } from "./provenance.js";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

export const ACTION_PRIORITIES = ["critical", "high", "normal", "low"] as const;
export type ActionPriority = (typeof ACTION_PRIORITIES)[number];

export const ACTION_CATEGORIES = ["bars", "cooldown", "finance", "faction", "travel", "progression", "goal", "insight", "health"] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

/**
 * Stable item types. The UI maps these to icons/labels; the id contract is
 * append-only (never repurpose a type).
 */
export type ActionType =
  | "energy_capped"
  | "cooldown_ready"
  | "bank_matured"
  | "education_finishing"
  | "travel_landing"
  | "hospital_jail"
  | "oc_ready"
  | "oc_starting_soon"
  | "goal_at_risk"
  | "goal_eta_soon"
  | "goal_achieved_pending"
  | "insight"
  | "data_health"
  | "notable_trend";

export interface ActionItem {
  /** Stable identity — one item per identity, ever. */
  id: string;
  type: ActionType;
  category: ActionCategory;
  priority: ActionPriority;
  title: string;
  /** Machine state for icon/copy selection ("ready" | "capped" | "warning" | …). */
  state: string;
  /** One-sentence evidence-based explanation. */
  explanation: string;
  /** When the window closes/opens (unix seconds); null = no deadline. */
  deadlineAt: number | null;
  /** Deep link into Torn (when acting happens there). */
  actionUrl: string | null;
  /** Deep link into TornScope analytics (when context helps). */
  analyticsUrl: string | null;
  /** How the underlying fact is known ("inferred" for session-derived facts). */
  confidence: Provenance | "inferred";
  /** Feed time (unix seconds) — secondary sort key. */
  occurredAt: number;
}

/* -------------------------------------------------------------------------- */
/* Policy (all thresholds in one place)                                        */
/* -------------------------------------------------------------------------- */

export const ACTION_POLICY = {
  /** Feed cap after sorting. */
  MAX_ITEMS: 10,
  /** Max items per priority tier (stops one tier from flooding the feed). */
  MAX_PER_PRIORITY: { critical: 2, high: 4, normal: 6, low: 2 } as Record<ActionPriority, number>,
  /** Energy: item appears once the bar has been full this long. */
  ENERGY_CAPPED_AFTER_SECONDS: 30 * 60,
  /** Energy: stop claiming "capped" after this long (likely intentional idle). */
  ENERGY_CAPPED_STOP_AFTER_SECONDS: 8 * 3600,
  /** Ready cooldowns stay in the feed this long after becoming ready. */
  COOLDOWN_READY_WINDOW_SECONDS: 12 * 3600,
  /** Education: notify this close to completion. */
  EDUCATION_SOON_SECONDS: 6 * 3600,
  /** Travel: pre-landing and post-landing attention windows. */
  TRAVEL_LANDING_SOON_SECONDS: 2 * 3600,
  TRAVEL_LANDED_WINDOW_SECONDS: 6 * 3600,
  /** OC: attention window before start (uses stored OC data). */
  OC_STARTING_SOON_SECONDS: 24 * 3600,
  /** Goal: projected ETA inside this window is "soon". */
  GOAL_ETA_SOON_SECONDS: 3 * 3600 * 24,
  /** Goal: projected ETA this far past the target date is "at risk". */
  GOAL_AT_RISK_FACTOR: 1,
  /** Net worth: |7d change| at or above this percentage is a notable trend. */
  NOTABLE_TREND_PCT: 8,
  /** A cooldown/timer fact older than this is not trustworthy as "now". */
  MAX_FACT_AGE_SECONDS: 15 * 60,
} as const;

const PRIORITY_ORDER: Record<ActionPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

/* -------------------------------------------------------------------------- */
/* Facts (API-composed, all optional — missing facts yield no items)           */
/* -------------------------------------------------------------------------- */

export interface ActionBarsFact {
  energy: { current: number; maximum: number; /** When the bar reaches full (unix sec). */ fullAt: number | null };
}

export interface ActionCooldownFact {
  kind: "drug" | "medical" | "booster";
  endsAt: number | null;
}

export interface ActionTimerFact {
  /** Bank investment matures at / education ends at / travel lands at. */
  endsAt: number | null;
  /** Bank only: an investment has matured and is ready to collect. */
  ready?: boolean;
}

export interface ActionOcFact {
  id: string;
  name: string;
  /** The user participates in this OC. */
  joined: boolean;
  /** When the OC is ready to start / starts (unix sec). */
  readyAt: number | null;
  status: string;
}

export interface ActionGoalFact {
  id: string;
  metric: string;
  label: string;
  target: number;
  progress: number | null;
  /** Projected ETA (unix sec) — null when withheld. */
  etaAt: number | null;
  targetDate: number | null;
  achievedAt: number | null;
  createdAt: number;
}

/** Facts are grouped per source so callers can pass only what they have. */
export interface ActionFacts {
  now: number;
  /** True when the profile has a real credential (else skip health items). */
  hasCredential: boolean;
  /** Age of the live facts below (unix seconds since fetched). */
  liveFactsAgeSeconds: number | null;
  bars: ActionBarsFact | null;
  cooldowns: ActionCooldownFact[];
  bank: ActionTimerFact | null;
  education: ActionTimerFact | null;
  travel: ActionTimerFact | null;
  hospitalUntil: number | null;
  jailedUntil: number | null;
  oc: ActionOcFact[];
  goals: ActionGoalFact[];
  insights: Insight[];
  /** Only non-fresh domains need to be passed in. */
  freshnessIssues: Array<Pick<DataFreshnessEntry, "domain" | "label" | "status">>;
  networth: { current: number; changePct7d: number | null } | null;
}

/* -------------------------------------------------------------------------- */
/* Derivation                                                                  */
/* -------------------------------------------------------------------------- */

function item(partial: Omit<ActionItem, "occurredAt"> & { occurredAt?: number }): ActionItem {
  return { occurredAt: partial.deadlineAt ?? 0, ...partial };
}

function inWindow(ts: number | null, now: number, maxAgeSeconds: number): boolean {
  return ts !== null && ts <= now && now - ts <= maxAgeSeconds;
}

/** Build the attention feed. Sorted by priority, then soonest deadline. */
export function deriveActionItems(facts: ActionFacts): ActionItem[] {
  const items: ActionItem[] = [];
  const { now } = facts;
  const liveUsable = facts.liveFactsAgeSeconds === null || facts.liveFactsAgeSeconds <= ACTION_POLICY.MAX_FACT_AGE_SECONDS;

  // ---- Bars ---------------------------------------------------------------
  if (facts.bars && liveUsable) {
    const { current, maximum, fullAt } = facts.bars.energy;
    const cappedSince = maximum > 0 && current >= maximum ? (fullAt !== null && fullAt <= now ? fullAt : now) : null;
    if (cappedSince !== null && now - cappedSince >= ACTION_POLICY.ENERGY_CAPPED_AFTER_SECONDS && now - cappedSince <= ACTION_POLICY.ENERGY_CAPPED_STOP_AFTER_SECONDS) {
      const hours = Math.floor((now - cappedSince) / 3600);
      items.push(
        item({
          id: "energy_capped",
          type: "energy_capped",
          category: "bars",
          priority: "high",
          title: "Energy is capped",
          state: "capped",
          explanation: hours >= 1 ? `Your energy has been full for ${hours}h — every point regenerated past the cap is lost.` : "Your energy is full and still regenerating — spend it before points are wasted.",
          deadlineAt: null,
          actionUrl: null,
          analyticsUrl: "/today",
          confidence: "exact",
        })
      );
    }
  }

  // ---- Cooldowns ------------------------------------------------------------
  for (const cd of facts.cooldowns) {
    if (liveUsable && inWindow(cd.endsAt, now, ACTION_POLICY.COOLDOWN_READY_WINDOW_SECONDS)) {
      items.push(
        item({
          id: `cooldown_ready:${cd.kind}`,
          type: "cooldown_ready",
          category: "cooldown",
          priority: "normal",
          title: `${cd.kind === "drug" ? "Drug" : cd.kind === "medical" ? "Medical" : "Booster"} cooldown ready`,
          state: "ready",
          explanation: `Your ${cd.kind} cooldown finished — you can use it again.`,
          deadlineAt: null,
          actionUrl: null,
          analyticsUrl: "/today",
          confidence: "exact",
        })
      );
    }
  }

  // ---- Bank -----------------------------------------------------------------
  if (facts.bank && liveUsable) {
    if (facts.bank.ready || inWindow(facts.bank.endsAt, now, 24 * 3600)) {
      items.push(
        item({
          id: `bank_matured:${facts.bank.endsAt ?? "ready"}`,
          type: "bank_matured",
          category: "finance",
          priority: "high",
          title: "Bank investment matured",
          state: "ready",
          explanation: "An investment has matured — collect it so the money starts working again.",
          deadlineAt: null,
          actionUrl: null,
          analyticsUrl: "/money",
          confidence: "exact",
        })
      );
    }
  }

  // ---- Education --------------------------------------------------------------
  if (facts.education?.endsAt !== null && facts.education && liveUsable) {
    const endsAt = facts.education.endsAt;
    if (endsAt !== null && endsAt > now && endsAt - now <= ACTION_POLICY.EDUCATION_SOON_SECONDS) {
      items.push(
        item({
          id: `education_finishing:${endsAt}`,
          type: "education_finishing",
          category: "progression",
          priority: "normal",
          title: "Education finishing soon",
          state: "almost",
          explanation: "Your course completes soon — plan the next one so no time is lost.",
          deadlineAt: endsAt,
          actionUrl: null,
          analyticsUrl: "/today",
          confidence: "exact",
        })
      );
    }
  }

  // ---- Travel -----------------------------------------------------------------
  if (facts.travel?.endsAt !== null && facts.travel && liveUsable) {
    const landsAt = facts.travel.endsAt;
    if (landsAt !== null) {
      const untilLanding = landsAt - now;
      if (untilLanding > 0 && untilLanding <= ACTION_POLICY.TRAVEL_LANDING_SOON_SECONDS) {
        items.push(
          item({
            id: `travel_landing:${landsAt}`,
            type: "travel_landing",
            category: "travel",
            priority: "high",
            title: "Travel landing soon",
            state: "almost",
            explanation: "Your trip lands soon — decide what's next while you're still flying.",
            deadlineAt: landsAt,
            actionUrl: null,
            analyticsUrl: "/travel",
            confidence: "exact",
          })
        );
      } else if (untilLanding <= 0 && -untilLanding <= ACTION_POLICY.TRAVEL_LANDED_WINDOW_SECONDS) {
        items.push(
          item({
            id: `travel_landed:${landsAt}`,
            type: "travel_landing",
            category: "travel",
            priority: "high",
            title: "Travel landed",
            state: "ready",
            explanation: "You're back in Torn — time to act on whatever you brought home.",
            deadlineAt: null,
            actionUrl: null,
            analyticsUrl: "/travel",
            confidence: "exact",
          })
        );
      }
    }
  }

  // ---- Hospital / jail ----------------------------------------------------------
  const status = facts.hospitalUntil !== null && facts.hospitalUntil > now ? "hospital" : facts.jailedUntil !== null && facts.jailedUntil > now ? "jail" : null;
  if (status && liveUsable) {
    const until = status === "hospital" ? facts.hospitalUntil : facts.jailedUntil;
    items.push(
      item({
        id: `hospital_jail:${status}:${until}`,
        type: "hospital_jail",
        category: "progression",
        priority: "normal",
        title: status === "hospital" ? "In hospital" : "In jail",
        state: status,
        explanation: status === "hospital" ? "You're in hospital — activity is limited until release." : "You're in jail — activity is limited until release.",
        deadlineAt: until,
        actionUrl: null,
        analyticsUrl: "/today",
        confidence: "exact",
      })
    );
  }

  // ---- Organized crime ------------------------------------------------------------
  for (const oc of facts.oc) {
    if (!oc.joined || oc.readyAt === null || oc.status !== "recruiting") continue;
    const untilReady = oc.readyAt - now;
    if (untilReady <= 0) {
      items.push(
        item({
          id: `oc_ready:${oc.id}`,
          type: "oc_ready",
          category: "faction",
          priority: "high",
          title: `OC ready: ${oc.name}`,
          state: "ready",
          explanation: "Your organized crime is ready to start.",
          deadlineAt: null,
          actionUrl: null,
          analyticsUrl: "/faction",
          confidence: "derived",
        })
      );
    } else if (untilReady <= ACTION_POLICY.OC_STARTING_SOON_SECONDS) {
      items.push(
        item({
          id: `oc_starting_soon:${oc.id}`,
          type: "oc_starting_soon",
          category: "faction",
          priority: "normal",
          title: `OC starting soon: ${oc.name}`,
          state: "almost",
          explanation: "Your organized crime becomes ready within a day — plan your slot.",
          deadlineAt: oc.readyAt,
          actionUrl: null,
          analyticsUrl: "/faction",
          confidence: "derived",
        })
      );
    }
  }

  // ---- Goals ----------------------------------------------------------------------
  for (const goal of facts.goals) {
    if (goal.achievedAt !== null) continue;
    if (goal.progress !== null && goal.progress >= 1) {
      items.push(
        item({
          id: `goal_achieved_pending:${goal.id}`,
          type: "goal_achieved_pending",
          category: "goal",
          priority: "high",
          title: `Goal reached: ${goal.label}`,
          state: "ready",
          explanation: "Your target has been reached — mark it done or raise the bar.",
          deadlineAt: null,
          actionUrl: null,
          analyticsUrl: "/goals",
          confidence: "derived",
        })
      );
      continue;
    }
    if (goal.targetDate !== null && goal.etaAt !== null && goal.etaAt > goal.targetDate) {
      items.push(
        item({
          id: `goal_at_risk:${goal.id}`,
          type: "goal_at_risk",
          category: "goal",
          priority: "high",
          title: `Goal behind pace: ${goal.label}`,
          state: "warning",
          explanation: "The projected ETA is past your target date — adjust the goal or the pace.",
          deadlineAt: goal.targetDate,
          actionUrl: null,
          analyticsUrl: "/goals",
          confidence: "derived",
        })
      );
      continue;
    }
    if (goal.etaAt !== null && goal.etaAt - now <= ACTION_POLICY.GOAL_ETA_SOON_SECONDS) {
      items.push(
        item({
          id: `goal_eta_soon:${goal.id}`,
          type: "goal_eta_soon",
          category: "goal",
          priority: "normal",
          title: `Goal almost there: ${goal.label}`,
          state: "almost",
          explanation: "Your projection puts this goal within reach in the next few days.",
          deadlineAt: goal.etaAt,
          actionUrl: null,
          analyticsUrl: "/goals",
          confidence: "derived",
        })
      );
    }
  }

  // ---- Insights (top of an already-prioritized list) --------------------------------
  const topInsights = [...facts.insights].sort((a, b) => INSIGHT_PRIORITY_WEIGHT[a.priority] - INSIGHT_PRIORITY_WEIGHT[b.priority] || b.occurredAt - a.occurredAt).slice(0, 2);
  for (const insight of topInsights) {
    if (insight.confidence === "low") continue;
    items.push(
      item({
        id: `insight:${insight.id}`,
        type: "insight",
        category: "insight",
        priority: insight.priority === "high" ? "normal" : "low",
        title: insight.title,
        state: "info",
        explanation: insight.detail,
        deadlineAt: null,
        actionUrl: null,
        analyticsUrl: "/insights",
        confidence: insight.provenance,
        occurredAt: insight.occurredAt,
      })
    );
  }

  // ---- Data health -------------------------------------------------------------------
  if (facts.hasCredential) {
    const failed = facts.freshnessIssues.filter((f) => f.status === "failed");
    const degraded = facts.freshnessIssues.filter((f) => f.status === "stale" || f.status === "delayed" || f.status === "unavailable");
    if (failed.length > 0) {
      items.push(
        item({
          id: `data_health:failed:${failed.map((f) => f.domain).sort().join(",")}`,
          type: "data_health",
          category: "health",
          priority: "high",
          title: "Data sync failing",
          state: "failed",
          explanation: `${failed.map((f) => f.label).join(", ")} stopped updating — history stays intact, new data is not coming in.`,
          deadlineAt: null,
          actionUrl: null,
          analyticsUrl: "/system",
          confidence: "exact",
        })
      );
    }
    if (degraded.length > 0) {
      items.push(
        item({
          id: `data_health:degraded:${degraded.map((f) => f.domain).sort().join(",")}`,
          type: "data_health",
          category: "health",
          priority: "low",
          title: degraded.length === 1 ? `${degraded[0]!.label} is behind` : `${degraded.length} data sources behind`,
          state: degraded[0]!.status,
          explanation: "Syncing is slower than usual for some sources — they should recover on their own.",
          deadlineAt: null,
          actionUrl: null,
          analyticsUrl: "/system",
          confidence: "exact",
        })
      );
    }
  }

  // ---- Notable trend -------------------------------------------------------------------
  if (facts.networth?.changePct7d != null && Math.abs(facts.networth.changePct7d) >= ACTION_POLICY.NOTABLE_TREND_PCT) {
    const up = facts.networth.changePct7d > 0;
    items.push(
      item({
        id: `notable_trend:networth7d`,
        type: "notable_trend",
        category: "finance",
        priority: "low",
        title: up ? "Wealth is climbing" : "Wealth is declining",
        state: up ? "trend_up" : "trend_down",
        explanation: `Your net worth moved ${up ? "+" : ""}${facts.networth.changePct7d.toFixed(1)}% over the last 7 days.`,
        deadlineAt: null,
        actionUrl: null,
        analyticsUrl: "/money",
        confidence: "exact",
        occurredAt: now,
      })
    );
  }

  // ---- Sort, then enforce per-priority caps -----------------------------------------
  const sorted = items.sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      deadlineKey(a.deadlineAt) - deadlineKey(b.deadlineAt) ||
      b.occurredAt - a.occurredAt
  );
  const perPriority = new Map<ActionPriority, number>();
  const capped: ActionItem[] = [];
  for (const it of sorted) {
    const used = perPriority.get(it.priority) ?? 0;
    if (used >= ACTION_POLICY.MAX_PER_PRIORITY[it.priority]) continue;
    perPriority.set(it.priority, used + 1);
    capped.push(it);
    if (capped.length >= ACTION_POLICY.MAX_ITEMS) break;
  }
  return capped;
}

const INSIGHT_PRIORITY_WEIGHT: Record<InsightPriority, number> = { high: 0, normal: 1, low: 2 };

function deadlineKey(deadlineAt: number | null): number {
  return deadlineAt ?? Number.MAX_SAFE_INTEGER;
}

/* -------------------------------------------------------------------------- */
/* Response shape                                                              */
/* -------------------------------------------------------------------------- */

export interface CommandCenterResponse {
  items: ActionItem[];
  /** Feed was truncated to MAX_ITEMS (UI hint, not an error). */
  truncated: boolean;
  generatedAt: number;
}

/* -------------------------------------------------------------------------- */
/* Zod contract (mirrors the types above)                                      */
/* -------------------------------------------------------------------------- */

import { z } from "zod";

export const ActionItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  category: z.enum(ACTION_CATEGORIES),
  priority: z.enum(ACTION_PRIORITIES),
  title: z.string(),
  state: z.string(),
  explanation: z.string(),
  deadlineAt: z.number().nullable(),
  actionUrl: z.string().nullable(),
  analyticsUrl: z.string().nullable(),
  confidence: z.enum(["exact", "derived", "estimated", "inferred"]),
  occurredAt: z.number(),
});

export const CommandCenterResponseSchema = z.object({
  items: z.array(ActionItemSchema),
  truncated: z.boolean(),
  generatedAt: z.number(),
});
