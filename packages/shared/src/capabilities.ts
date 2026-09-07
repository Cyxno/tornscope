import type { KeyCapabilities, CapabilityKey } from "./torn.js";
import type { SyncResource } from "./torn.js";

/**
 * Central feature-to-permission matrix (single source of truth).
 *
 * Every user-facing feature maps to the Torn API capabilities it genuinely
 * needs. Friendly access levels ("Limited", "Full") are summaries only —
 * these per-capability booleans decide what actually renders. Never assume
 * Full Access unless every lower-selection path is provably insufficient.
 *
 * `requires` = ALL of these capabilities are needed for the feature to work.
 * `optional` = capabilities that enrich the feature when present (partial mode).
 * `partial`  = the feature can render something useful when only some
 *              optional capabilities exist.
 */

export type TornScopeFeature =
  | "overview_current_stats"
  | "overview_financial_history"
  | "today_live_bars"
  | "today_cooldowns"
  | "today_education"
  | "today_bank"
  | "travel_current"
  | "travel_history"
  | "travel_purchases"
  | "travel_profit"
  | "drugs_cooldown"
  | "drugs_history"
  | "drugs_xanax_provenance"
  | "rehab_history"
  | "money_cash_flow"
  | "wallet_bridge"
  | "networth_history"
  | "crimes_history"
  | "combat_history"
  | "timeline_history"
  | "faction_basic"
  | "faction_members"
  | "faction_ranked_wars"
  | "faction_organized_crimes"
  | "faction_armory_history"
  | "faction_balance";

export interface FeatureRequirement {
  feature: TornScopeFeature;
  /** User-facing label (Settings matrix, unavailable states). */
  label: string;
  /** All of these capabilities are required for the feature to be available. */
  requires: CapabilityKey[];
  /** Capabilities that enrich the feature but are not strictly required. */
  optional?: CapabilityKey[];
  /** True when a usable subset can render (partial mode). */
  partial: boolean;
}

export const FEATURE_REQUIREMENTS: FeatureRequirement[] = [
  { feature: "overview_current_stats", label: "Current stats", requires: ["canReadUserBasic"], partial: false },
  {
    feature: "overview_financial_history",
    label: "Historical financial analytics",
    requires: ["canReadUserLogs"],
    optional: ["canReadUserNetworth"],
    partial: true,
  },
  { feature: "today_live_bars", label: "Live bars", requires: ["canReadUserBars"], partial: false },
  { feature: "today_cooldowns", label: "Cooldowns", requires: ["canReadUserCooldowns"], partial: false },
  { feature: "today_education", label: "Education", requires: ["canReadUserEducation"], partial: false },
  { feature: "today_bank", label: "Bank investment", requires: ["canReadUserMoney"], partial: false },
  { feature: "travel_current", label: "Current travel status", requires: ["canReadUserTravel"], partial: false },
  { feature: "travel_history", label: "Flight history", requires: ["canReadUserLogs"], partial: false },
  { feature: "travel_purchases", label: "Travel purchases", requires: ["canReadUserLogs"], partial: false },
  {
    feature: "travel_profit",
    label: "Travel profit",
    requires: ["canReadUserLogs"],
    optional: ["canReadUserTravel"],
    partial: true,
  },
  { feature: "drugs_cooldown", label: "Drug cooldown", requires: ["canReadUserCooldowns"], partial: false },
  { feature: "drugs_history", label: "Drug history", requires: ["canReadUserLogs"], partial: false },
  {
    feature: "drugs_xanax_provenance",
    label: "Xanax funding provenance",
    requires: ["canReadUserLogs"],
    optional: ["canReadFactionArmoryNews"],
    partial: true,
  },
  { feature: "rehab_history", label: "Rehab history", requires: ["canReadUserLogs"], partial: false },
  { feature: "money_cash_flow", label: "Cash flow", requires: ["canReadUserLogs"], partial: false },
  {
    feature: "wallet_bridge",
    label: "Wallet bridge",
    requires: ["canReadUserLogs"],
    optional: ["canReadUserNetworth", "canReadUserMoney"],
    partial: true,
  },
  { feature: "networth_history", label: "Net worth history", requires: ["canReadUserNetworth"], partial: false },
  { feature: "crimes_history", label: "Crimes history", requires: ["canReadUserLogs"], partial: false },
  { feature: "combat_history", label: "Combat history", requires: ["canReadUserAttacks"], partial: false },
  { feature: "timeline_history", label: "Timeline", requires: ["canReadUserLogs"], optional: ["canReadUserEvents"], partial: true },
  { feature: "faction_basic", label: "Faction overview", requires: ["canReadFactionBasic"], partial: false },
  { feature: "faction_members", label: "Faction members", requires: ["canReadFactionMembers"], partial: false },
  { feature: "faction_ranked_wars", label: "Ranked wars", requires: ["canReadFactionRankedWars"], partial: false },
  { feature: "faction_organized_crimes", label: "Organized crimes", requires: ["canReadFactionCrimes"], partial: false },
  { feature: "faction_armory_history", label: "Faction armory history", requires: ["canReadFactionArmoryNews"], partial: false },
  { feature: "faction_balance", label: "Faction balance", requires: ["canReadFactionBalance"], partial: false },
];

export function featureRequirement(feature: TornScopeFeature): FeatureRequirement {
  const found = FEATURE_REQUIREMENTS.find((f) => f.feature === feature);
  if (!found) throw new Error(`Unknown feature: ${feature}`);
  return found;
}

/** True only when EVERY required capability is granted. */
export function featureAvailable(caps: KeyCapabilities | null | undefined, feature: TornScopeFeature): boolean {
  if (!caps) return false;
  return featureRequirement(feature).requires.every((key) => caps[key]);
}

/* -------------------------------------------------------------------------- */
/* Per-feature availability states (stale-history aware)                       */
/* -------------------------------------------------------------------------- */

/**
 * Why/how a feature's data is (not) shown. Permission problems must NEVER be
 * rendered as zeros — the UI maps these states to explicit explanations.
 *
 * - available_live        the key can refresh this dataset right now
 * - available_historical  stored history is shown; the key can still refresh
 * - partial               part of the module renders; the rest is explained
 * - stale_permission      stored history is shown but the CURRENT key can no
 *                         longer refresh it (e.g. logs revoked after a
 *                         downgrade) — never presented as fully live
 * - unavailable_permission nothing to show because the key lacks permissions
 * - unavailable_source    permissions are fine; the source has no data
 */
export type FeatureState =
  | "available_live"
  | "available_historical"
  | "partial"
  | "stale_permission"
  | "unavailable_permission"
  | "unavailable_source";

export interface FeatureAvailability {
  state: FeatureState;
  /** Human label of the minimum permission missing, e.g. "User Logs". */
  requiresLabel: string | null;
  /** The specific Torn selections to grant (details view). */
  requiresSelections: string[];
  /** True when previously collected history still exists for this feature. */
  hasHistoricalData: boolean;
  /** Unix seconds — when the stored dataset was last refreshed successfully. */
  lastRefreshedAt: number | null;
}

export interface FeatureDataInfo {
  /** Does the profile hold stored history for this feature? */
  hasStoredData: boolean;
  /** Last successful sync of the backing resource (unix seconds, nullable). */
  lastSuccessAt?: number | null;
}

/** Friendly names for capability keys (used in every explanation). */
export const CAPABILITY_LABELS: Record<CapabilityKey, { label: string; selections: string[]; access: string }> = {
  canReadUserBasic: { label: "Basic account access", selections: ["user: basic/profile"], access: "Public" },
  canReadUserBars: { label: "User Bars", selections: ["user: bars"], access: "Minimal" },
  canReadUserCooldowns: { label: "User Cooldowns", selections: ["user: cooldowns"], access: "Minimal" },
  canReadUserEducation: { label: "User Education", selections: ["user: education"], access: "Minimal" },
  canReadUserTravel: { label: "User Travel", selections: ["user: travel"], access: "Minimal" },
  canReadUserMoney: { label: "User Money", selections: ["user: money"], access: "Limited" },
  canReadUserLogs: { label: "User Logs", selections: ["user: log"], access: "Limited" },
  canReadUserAttacks: { label: "User Attacks", selections: ["user: attacks"], access: "Limited" },
  canReadUserNetworth: { label: "User Networth", selections: ["user: networth"], access: "Limited" },
  canReadUserEvents: { label: "User Events", selections: ["user: events"], access: "Minimal" },
  canReadUserPersonalStats: { label: "User Personal Stats", selections: ["user: personalstats"], access: "Limited" },
  canReadFactionBasic: { label: "Faction Basic", selections: ["faction: basic"], access: "Faction access" },
  canReadFactionMembers: { label: "Faction Members", selections: ["faction: members"], access: "Faction access" },
  canReadFactionRankedWars: { label: "Faction Ranked Wars", selections: ["faction: rankedwars"], access: "Faction access" },
  canReadFactionChains: { label: "Faction Chains", selections: ["faction: chains"], access: "Faction access" },
  canReadFactionCrimes: { label: "Faction Crimes", selections: ["faction: crimes"], access: "Faction access" },
  canReadFactionArmoryNews: { label: "Faction Armory News", selections: ["faction: armorynews"], access: "Faction access" },
  canReadFactionBalance: { label: "Faction Balance", selections: ["faction: balance"], access: "Faction access" },
  canReadFactionLogs: { label: "Faction Logs", selections: ["faction: log"], access: "Faction access" },
};

/** The single most accurate missing requirement (never overstates "Full"). */
export function missingRequirementLabel(caps: KeyCapabilities | null | undefined, feature: TornScopeFeature): { label: string; selections: string[] } | null {
  if (!caps) return { label: "an API key", selections: [] };
  const req = featureRequirement(feature);
  const missing = req.requires.filter((key) => !caps[key]);
  if (missing.length === 0) return null;
  // Prefer the first missing capability's friendly name; list all selections.
  const primary = CAPABILITY_LABELS[missing[0]!];
  return {
    label: missing.length === 1 ? primary.label : missing.map((m) => CAPABILITY_LABELS[m]!.label).join(" + "),
    selections: missing.flatMap((m) => CAPABILITY_LABELS[m]!.selections),
  };
}

/**
 * Compute the honest availability state for one feature given the key's
 * capabilities and what the profile has stored. `canRefresh` flags features
 * whose backing resource the key can still fetch (permission-wise).
 */
export function featureAvailability(
  caps: KeyCapabilities | null | undefined,
  feature: TornScopeFeature,
  info: FeatureDataInfo & { canRefresh?: boolean }
): FeatureAvailability {
  const req = featureRequirement(feature);
  const missing = missingRequirementLabel(caps, feature);
  const canRefresh = info.canRefresh !== undefined ? info.canRefresh : missing === null;

  if (missing !== null && !info.hasStoredData) {
    return { state: "unavailable_permission", requiresLabel: missing.label, requiresSelections: missing.selections, hasHistoricalData: false, lastRefreshedAt: info.lastSuccessAt ?? null };
  }
  if (missing !== null && info.hasStoredData) {
    return { state: "stale_permission", requiresLabel: missing.label, requiresSelections: missing.selections, hasHistoricalData: true, lastRefreshedAt: info.lastSuccessAt ?? null };
  }
  if (missing === null && !info.hasStoredData) {
    return { state: "unavailable_source", requiresLabel: null, requiresSelections: [], hasHistoricalData: false, lastRefreshedAt: info.lastSuccessAt ?? null };
  }
  // Permission OK + data stored: live if the key can still refresh it.
  const optionalMissing = (req.optional ?? []).filter((key) => !caps![key]);
  const state: FeatureState = optionalMissing.length > 0 && req.partial ? "partial" : canRefresh ? "available_live" : "available_historical";
  const optionalMissingLabel = optionalMissing.length > 0 ? CAPABILITY_LABELS[optionalMissing[0]!]!.label : null;
  return {
    state,
    requiresLabel: state === "partial" ? optionalMissingLabel : null,
    requiresSelections: [],
    hasHistoricalData: true,
    lastRefreshedAt: info.lastSuccessAt ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Sync resource gating (worker + manual sync)                                 */
/* -------------------------------------------------------------------------- */

/**
 * The capability each sync resource genuinely needs. Null = public/no key
 * capability required. The worker refuses to enqueue/run resources whose
 * requirement is missing and marks them capability-blocked instead of
 * hammering endpoints known to be unavailable.
 */
export const RESOURCE_REQUIREMENTS: Record<SyncResource, CapabilityKey | null> = {
  profile: "canReadUserBasic",
  personal_stats: "canReadUserPersonalStats",
  networth: "canReadUserNetworth",
  drugs: "canReadUserLogs",
  travel: "canReadUserLogs",
  rehab: "canReadUserLogs",
  money_logs: "canReadUserLogs",
  events: "canReadUserEvents",
  attacks: "canReadUserAttacks",
  faction_basic: "canReadFactionBasic",
  faction: "canReadFactionBasic",
  ranked_wars: "canReadFactionRankedWars",
  chains: "canReadFactionChains",
  organized_crimes: "canReadFactionCrimes",
  torn_catalog: null,
};

export function resourceAllowed(caps: KeyCapabilities | null | undefined, resource: SyncResource): boolean {
  const required = RESOURCE_REQUIREMENTS[resource];
  if (required === null) return true;
  if (!caps) return false;
  return caps[required];
}

export function resourceRequirementLabel(resource: SyncResource): string {
  const required = RESOURCE_REQUIREMENTS[resource];
  if (required === null) return "public source";
  return CAPABILITY_LABELS[required]!.label;
}
