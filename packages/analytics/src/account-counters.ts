/**
 * Account progression counters (2.6.0) — productizing the underused
 * PersonalStatSnapshot.stats history.
 *
 * The catalog contains ONLY paths proven to exist and change in the stored
 * production archive (JSON-path fingerprint, 2.6.0 audit) and whose semantics
 * are cumulative counters ("done X in total"). Gauges/objects without proven
 * semantics are deliberately excluded — the audit tool reports them as
 * retained-raw instead of inventing numbers.
 *
 * Provenance of every delta below: "exact" (Torn's own cumulative counters,
 * snapshot-sampled), coverage derived from the snapshot series itself.
 */

import { computeCounterDelta, type CounterDelta, type CounterPoint } from "./counter-series.js";

export interface AccountCounterDef {
  /** Stable key used in API responses and tests. */
  key: string;
  label: string;
  /** UI grouping (progression section). */
  group: "Combat" | "Crime" | "Hospital" | "Jail" | "Jobs" | "Racing" | "Travel" | "Items" | "Missions" | "Other";
  /** Nested path into the personalstats JSON blob. */
  path: string[];
  /** Primary rows render collapsed; the rest live in the expandable section. */
  primary: boolean;
}

/**
 * 2.8.0 additions — the Combat / Racing / bounty families, previously
 * retained-raw. Every path below is proven to exist AND move in the stored
 * production archive (JSON-path fingerprint 2026-10-08: 1,322/2,259
 * snapshots carry personalstats; each path min ≠ max across the series).
 * Attacking paths are Torn's own cumulative counters; `combat_elo`,
 * `killstreak_best`, `largest_mug` and `racing_skill` are high-water/gauge
 * stats — their deltas are honest range changes, and the shared reset
 * detector (drop ≥ 50% + stability) provably never mistakes ordinary gauge
 * swings for counter resets.
 */
export const ACCOUNT_COUNTERS: AccountCounterDef[] = [
  { key: "awards", label: "Awards gained", group: "Other", path: ["other", "awards"], primary: true },
  { key: "trains_received", label: "Trains received", group: "Jobs", path: ["jobs", "trains_received"], primary: true },
  { key: "refills_energy", label: "Energy refills", group: "Other", path: ["other", "refills", "energy"], primary: true },
  { key: "crimes", label: "Crimes committed", group: "Crime", path: ["crimes", "total"], primary: true },
  { key: "times_hospitalized", label: "Times hospitalized", group: "Hospital", path: ["hospital", "times_hospitalized"], primary: true },
  { key: "trips", label: "Trips abroad", group: "Travel", path: ["travel", "total"], primary: true },
  { key: "donator_days", label: "Donator days", group: "Other", path: ["other", "donator_days"], primary: true },
  { key: "job_points_used", label: "Job points used", group: "Jobs", path: ["jobs", "job_points_used"], primary: true },
  { key: "missions_credits", label: "Mission credits", group: "Missions", path: ["missions", "credits"], primary: true },
  { key: "mails_sent", label: "Mails sent", group: "Other", path: ["communication", "mails_sent"], primary: true },
  { key: "attacks_won", label: "Attacks won", group: "Combat", path: ["attacking", "attacks", "won"], primary: true },
  { key: "money_mugged", label: "Cash mugged (total)", group: "Combat", path: ["attacking", "networth", "money_mugged"], primary: true },
  // Secondary (expandable section):
  { key: "attacks_lost", label: "Attacks lost", group: "Combat", path: ["attacking", "attacks", "lost"], primary: false },
  { key: "attacks_stealth", label: "Stealthed attacks", group: "Combat", path: ["attacking", "attacks", "stealth"], primary: false },
  { key: "hits_critical", label: "Critical hits", group: "Combat", path: ["attacking", "hits", "critical"], primary: false },
  { key: "defends_total", label: "Defends fought", group: "Combat", path: ["attacking", "defends", "total"], primary: false },
  { key: "combat_elo", label: "Combat ELO", group: "Combat", path: ["attacking", "elo"], primary: false },
  { key: "killstreak_best", label: "Best killstreak", group: "Combat", path: ["attacking", "killstreak", "best"], primary: false },
  { key: "largest_mug", label: "Largest mug", group: "Combat", path: ["attacking", "networth", "largest_mug"], primary: false },
  { key: "faction_respect", label: "Faction respect earned", group: "Combat", path: ["attacking", "faction", "respect"], primary: false },
  { key: "ranked_war_hits", label: "Ranked war hits", group: "Combat", path: ["attacking", "faction", "ranked_war_hits"], primary: false },
  { key: "races_entered", label: "Races entered", group: "Racing", path: ["racing", "races", "entered"], primary: false },
  { key: "races_won", label: "Races won", group: "Racing", path: ["racing", "races", "won"], primary: false },
  { key: "racing_points", label: "Racing points", group: "Racing", path: ["racing", "points"], primary: false },
  { key: "racing_skill", label: "Racing skill", group: "Racing", path: ["racing", "skill"], primary: false },
  { key: "bounty_placed_value", label: "Bounties placed ($)", group: "Other", path: ["bounties", "placed", "value"], primary: false },
  { key: "bounty_received_value", label: "Bounties received ($)", group: "Other", path: ["bounties", "received", "value"], primary: false },
  { key: "bounty_collected_value", label: "Bounty collections ($)", group: "Other", path: ["bounties", "collected", "value"], primary: false },
  { key: "medical_items_used", label: "Medical items used", group: "Hospital", path: ["hospital", "medical_items_used"], primary: false },
  { key: "blood_withdrawn", label: "Blood withdrawn", group: "Hospital", path: ["hospital", "blood_withdrawn"], primary: false },
  { key: "revives_received", label: "Revives received", group: "Hospital", path: ["hospital", "reviving", "revives_received"], primary: false },
  { key: "times_jailed", label: "Times jailed", group: "Jail", path: ["jail", "times_jailed"], primary: false },
  { key: "jail_busts_success", label: "Busts succeeded", group: "Jail", path: ["jail", "busts", "success"], primary: false },
  { key: "jail_busts_fails", label: "Busts failed", group: "Jail", path: ["jail", "busts", "fails"], primary: false },
  { key: "bounty_collected_amount", label: "Bounties collected", group: "Other", path: ["bounties", "collected", "amount"], primary: false },
  { key: "travel_time_spent", label: "Time abroad", group: "Travel", path: ["travel", "time_spent"], primary: false },
  { key: "travel_items_bought", label: "Items bought abroad", group: "Travel", path: ["travel", "items_bought"], primary: false },
  { key: "items_trashed", label: "Items trashed", group: "Items", path: ["items", "trashed"], primary: false },
  { key: "viruses_coded", label: "Viruses coded", group: "Items", path: ["items", "viruses_coded"], primary: false },
  { key: "candy_used", label: "Candy used", group: "Items", path: ["items", "used", "candy"], primary: false },
  { key: "energy_drinks_used", label: "Energy drinks used", group: "Items", path: ["items", "used", "energy_drinks"], primary: false },
  { key: "merits_bought", label: "Merits bought", group: "Other", path: ["other", "merits_bought"], primary: false },
  { key: "ranked_war_wins", label: "Ranked war wins", group: "Other", path: ["other", "ranked_war_wins"], primary: false },
  { key: "trades", label: "Trades", group: "Other", path: ["trading", "trades"], primary: false },
  { key: "drugs_total", label: "Drugs taken (all time)", group: "Other", path: ["drugs", "total"], primary: false },
];

type UnknownRecord = Record<string, unknown>;

function readPath(stats: UnknownRecord, path: string[]): number | null {
  let node: unknown = stats;
  for (const key of path) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return null;
    node = (node as UnknownRecord)[key];
  }
  return typeof node === "number" && Number.isFinite(node) ? node : null;
}

/** Extract every known counter from one personalstats blob (null when absent). */
export function extractAccountCounters(stats: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const root = stats !== null && typeof stats === "object" && !Array.isArray(stats) ? (stats as UnknownRecord) : {};
  for (const def of ACCOUNT_COUNTERS) out[def.key] = readPath(root, def.path);
  return out;
}

export interface AccountCounterResult extends CounterDelta {
  key: string;
  label: string;
  group: AccountCounterDef["group"];
  /** Last observed value (same as closing, kept for explicit display). */
  current: number | null;
}

/**
 * Build counter deltas for a user's PersonalStatSnapshot series over a range.
 * Rows: (capturedAt-seconds, stats-json) pairs, any order.
 */
export function buildAccountCounters(
  rows: Array<{ t: number; stats: unknown }>,
  range?: { from?: number; to?: number }
): { primary: AccountCounterResult[]; secondary: AccountCounterResult[]; trackingSince: number | null } {
  const byKey = new Map<string, CounterPoint[]>();
  for (const row of rows) {
    if (row.stats === null || typeof row.stats !== "object") continue;
    const extracted = extractAccountCounters(row.stats);
    for (const [key, value] of Object.entries(extracted)) {
      if (value === null) continue;
      let list = byKey.get(key);
      if (!list) {
        list = [];
        byKey.set(key, list);
      }
      list.push({ t: row.t, value });
    }
  }

  const build = (def: AccountCounterDef): AccountCounterResult | null => {
    const series = byKey.get(def.key);
    if (!series || series.length === 0) return null;
    const delta = computeCounterDelta(series, range);
    return {
      ...delta,
      key: def.key,
      label: def.label,
      group: def.group,
      current: delta.closing,
    };
  };

  const primary: AccountCounterResult[] = [];
  const secondary: AccountCounterResult[] = [];
  for (const def of ACCOUNT_COUNTERS) {
    const result = build(def);
    if (result) (def.primary ? primary : secondary).push(result);
  }
  const tracked = [...primary, ...secondary].filter((c) => c.trackingSince !== null).map((c) => c.trackingSince!);
  return { primary, secondary, trackingSince: tracked.length > 0 ? Math.min(...tracked) : null };
}
