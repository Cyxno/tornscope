/**
 * Command Center view derivation (2.0) — the pure logic behind the Overview
 * attention feed, extracted from CommandCenter.svelte so the ordering and
 * mapping rules are unit-testable (sibling of live-now.ts).
 *
 * The server already sorts and caps the feed (deriveActionItems); this view
 * re-sorts defensively (priority → soonest deadline → newest) and maps the
 * machine vocabulary to presentation: a priority tone (accent classes plus
 * a screen-reader label — priority is never conveyed by color alone), a
 * category icon from the Icon set, and the remaining deadline window.
 *
 * Kept free of runes and .svelte imports so the root vitest suite (no
 * Svelte plugin) can unit test it directly — icon names are plain strings
 * that the component passes through to <Icon>.
 */
import type { ActionCategory, ActionItem, ActionPriority } from "@tornscope/shared";
import { formatCountdownCompact } from "@tornscope/shared";

/** Icon names (subset of the Icon set) as plain strings. */
export type CommandIcon =
  | "today"
  | "clock"
  | "wallet"
  | "faction"
  | "travel"
  | "progression"
  | "goal"
  | "insight"
  | "alert";

/** Priority accent: dot/text classes plus the accessible label ("High
 *  priority") that carries the meaning as text, never color alone. */
export interface PriorityTone {
  label: string;
  dot: string;
  text: string;
}

export const PRIORITY_TONES: Record<ActionPriority, PriorityTone> = {
  critical: { label: "Critical priority", dot: "bg-negative", text: "text-negative" },
  high: { label: "High priority", dot: "bg-warning", text: "text-warning" },
  normal: { label: "Normal priority", dot: "bg-accent", text: "text-accent" },
  low: { label: "Low priority", dot: "bg-fg-faint", text: "text-fg-faint" },
};

/** Category → icon (the Icon set's vocabulary, one icon per category). */
const CATEGORY_ICONS: Record<ActionCategory, CommandIcon> = {
  bars: "today",
  cooldown: "clock",
  finance: "wallet",
  faction: "faction",
  travel: "travel",
  progression: "progression",
  goal: "goal",
  insight: "insight",
  health: "alert",
};

const PRIORITY_RANK: Record<ActionPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

export interface CommandItem {
  key: string;
  icon: CommandIcon;
  title: string;
  explanation: string;
  /** Seconds until the deadline; null when absent or already past. */
  deadlineSeconds: number | null;
  /** Human deadline label ("in 2h 05m"); null when absent or past. */
  deadline: string | null;
  /** Internal analytics route; null = the row is not a link. */
  analyticsUrl: string | null;
  tone: PriorityTone;
}

/**
 * Deadline label for a FUTURE deadline — a passed deadline stops being a
 * countdown (the item's own title/state wording carries what happened).
 */
export function deadlineLabel(deadlineAt: number | null, nowSec: number): string | null {
  if (deadlineAt === null) return null;
  const left = deadlineAt - nowSec;
  if (left <= 0) return null;
  return `in ${formatCountdownCompact(left)}`;
}

/**
 * Build the view feed: sorted by priority, then soonest deadline (no
 * deadline last), then newest first. Pure.
 */
export function deriveCommandCenter(items: readonly ActionItem[], nowSec: number): CommandItem[] {
  const sorted = [...items].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      deadlineKey(a.deadlineAt) - deadlineKey(b.deadlineAt) ||
      b.occurredAt - a.occurredAt
  );
  return sorted.map((item) => ({
    key: item.id,
    icon: CATEGORY_ICONS[item.category] ?? ("insight" as CommandIcon),
    title: item.title,
    explanation: item.explanation,
    deadlineSeconds: item.deadlineAt !== null && item.deadlineAt > nowSec ? item.deadlineAt - nowSec : null,
    deadline: deadlineLabel(item.deadlineAt, nowSec),
    analyticsUrl: item.analyticsUrl,
    tone: PRIORITY_TONES[item.priority] ?? PRIORITY_TONES.normal,
  }));
}

function deadlineKey(deadlineAt: number | null): number {
  return deadlineAt ?? Number.MAX_SAFE_INTEGER;
}
