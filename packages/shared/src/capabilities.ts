import type { KeyCapabilities, CapabilityKey } from "./torn.js";
import { SYNC_RESOURCES, CAPABILITY_KEYS } from "./torn.js";
import { accessLevelName } from "./today.js";
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
  | "faction_balance"
  | "progression_battlestats"
  | "progression_energy"
  | "progression_training"
  | "progression_happy_jumps"
  | "progression_education"
  | "merits_overview"
  | "stocks_holdings"
  | "stocks_benefits";

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
  {
    feature: "progression_battlestats",
    label: "Battlestat history",
    requires: ["canReadUserPersonalStats"],
    partial: false,
  },
  {
    feature: "progression_energy",
    label: "Energy analytics",
    requires: ["canReadUserBars"],
    optional: ["canReadUserLogs"],
    partial: true,
  },
  {
    feature: "progression_training",
    label: "Training sessions",
    requires: ["canReadUserBars", "canReadUserPersonalStats"],
    optional: ["canReadUserLogs"],
    partial: true,
  },
  {
    feature: "progression_happy_jumps",
    label: "Happy-jump analysis",
    requires: ["canReadUserLogs"],
    optional: ["canReadUserBars"],
    partial: true,
  },
  {
    feature: "progression_education",
    label: "Education progress",
    requires: ["canReadUserEducation"],
    partial: false,
  },
  {
    feature: "merits_overview",
    label: "Merits",
    requires: ["canReadUserMerits"],
    partial: false,
  },
  {
    feature: "stocks_holdings",
    label: "Stock holdings",
    requires: ["canReadUserStocks"],
    partial: false,
  },
  {
    feature: "stocks_benefits",
    label: "Stock benefits",
    // Benefits ride on the same minimal-access stocks selection as
    // holdings; reward valuation uses the public item catalog, not User
    // Money — so there is no partial tier here.
    requires: ["canReadUserStocks"],
    partial: false,
  },
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
  canReadUserMerits: { label: "User Merits", selections: ["user: merits"], access: "Minimal" },
  canReadUserStocks: { label: "User Stocks", selections: ["user: stocks"], access: "Minimal" },
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
 * How often a capability-blocked resource re-checks whether the key's
 * permissions changed. Shared by the worker runner, the scheduler and the
 * API's initial-backfill marking so every layer parks denied resources for
 * exactly as long.
 */
export const CAPABILITY_RECHECK_SECONDS = 6 * 3600;

/**
 * The capability each sync resource genuinely needs. Null = public/no key
 * capability required. The worker refuses to enqueue/run resources whose
 * requirement is missing and marks them capability-blocked instead of
 * hammering endpoints known to be unavailable.
 */
export const RESOURCE_REQUIREMENTS: Record<SyncResource, CapabilityKey | null> = {
  profile: "canReadUserBasic",
  bars: "canReadUserBars",
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

/* -------------------------------------------------------------------------- */
/* First-run access detection summary                                          */
/* -------------------------------------------------------------------------- */

/** User-facing label per sync resource (onboarding detection screen). */
export const RESOURCE_LABELS: Record<SyncResource, string> = {
  profile: "Basic profile data",
  bars: "Energy & happy bars",
  personal_stats: "Live stats",
  networth: "Net worth snapshots",
  drugs: "Drug history",
  travel: "Flight & travel history",
  rehab: "Rehab history",
  money_logs: "Economy & money logs",
  events: "Event history",
  faction_basic: "Faction overview",
  faction: "Faction detail (members, armory, balance)",
  ranked_wars: "Ranked wars",
  chains: "Faction chains",
  organized_crimes: "Organized crimes",
  attacks: "Combat & attack history",
  torn_catalog: "Item catalog (public)",
};

export interface OnboardingAccessSummary {
  /** Numeric Torn access level from /key/info (nullable when unknown). */
  level: number | null;
  /** "Limited" / "Full" / "Minimal" / "Public" / "unknown". */
  levelName: string;
  accessType: string | null;
  /** Resources this key CAN collect, with user-facing labels. */
  available: string[];
  /** Resources this key can NEVER collect, with the missing permission. */
  unavailable: Array<{ label: string; reason: string }>;
  /** Honest non-error copy describing what TornScope will do with this key. */
  note: string;
}

/**
 * Summarize what a detected key can and cannot do — pure, shared by the
 * welcome flow (first run) and the settings key-replace preview. Limited
 * access is a normal, workable state here, never an error: TornScope simply
 * syncs only what the key permits.
 */
export function summarizeKeyAccess(
  capabilities: KeyCapabilities | null | undefined,
  accessLevel: number | null | undefined,
  accessType: string | null | undefined
): OnboardingAccessSummary {
  const levelName = accessLevelName(accessLevel);
  const available: string[] = [];
  const unavailable: Array<{ label: string; reason: string }> = [];
  for (const resource of SYNC_RESOURCES) {
    if (resourceAllowed(capabilities, resource)) {
      available.push(RESOURCE_LABELS[resource]!);
    } else {
      unavailable.push({ label: RESOURCE_LABELS[resource]!, reason: resourceRequirementLabel(resource) });
    }
  }
  const note =
    levelName === "Full"
      ? "Full Access unlocks TornScope's complete supported historical analytics."
      : "You can continue with this key. TornScope will only sync data your key permits — unavailable areas are marked instead of shown as zeros.";
  return { level: accessLevel ?? null, levelName, accessType: accessType ?? null, available, unavailable, note };
}

/* -------------------------------------------------------------------------- */
/* Capability presets + the Limited-vs-Full consequence matrix (roadmap #4)    */
/* -------------------------------------------------------------------------- */

/**
 * Canonical USER-key capability presets used ONLY for the pre-choice
 * consequence matrix. They describe what a privacy-first "Limited" key and a
 * "Full" key mean for TornScope's features, derived from FEATURE_REQUIREMENTS
 * — never rendered as guarantees: Torn's own access levels decide what a key
 * can actually answer, and custom selections are detected per key.
 *
 * - LIMITED_PRESET ("privacy-first"): live state + identity + net worth +
 *   combat — deliberately NO User Logs / User Money (the broadest,
 *   most sensitive history).
 * - FULL_PRESET: every user selection granted. Faction capabilities are
 *   separate Torn key selections and are part of NEITHER preset — the matrix
 *   labels faction features "requires faction selections".
 */
export const LIMITED_PRESET: KeyCapabilities = {
  canReadUserMerits: true,
  canReadUserStocks: true,
  canReadUserBasic: true,
  canReadUserBars: true,
  canReadUserCooldowns: true,
  canReadUserEducation: true,
  canReadUserTravel: true,
  canReadUserMoney: false,
  canReadUserLogs: false,
  canReadUserAttacks: true,
  canReadUserNetworth: true,
  canReadUserEvents: true,
  canReadUserPersonalStats: true,
  canReadFactionBasic: false,
  canReadFactionMembers: false,
  canReadFactionRankedWars: false,
  canReadFactionChains: false,
  canReadFactionCrimes: false,
  canReadFactionArmoryNews: false,
  canReadFactionBalance: false,
  canReadFactionLogs: false,
};

export const FULL_PRESET: KeyCapabilities = {
  canReadUserMerits: true,
  canReadUserStocks: true,
  canReadUserBasic: true,
  canReadUserBars: true,
  canReadUserCooldowns: true,
  canReadUserEducation: true,
  canReadUserTravel: true,
  canReadUserMoney: true,
  canReadUserLogs: true,
  canReadUserAttacks: true,
  canReadUserNetworth: true,
  canReadUserEvents: true,
  canReadUserPersonalStats: true,
  canReadFactionBasic: false,
  canReadFactionMembers: false,
  canReadFactionRankedWars: false,
  canReadFactionChains: false,
  canReadFactionCrimes: false,
  canReadFactionArmoryNews: false,
  canReadFactionBalance: false,
  canReadFactionLogs: false,
};

/** The user-selection slice of a capability set (faction keys excluded). */
const USER_CAPABILITY_KEYS = CAPABILITY_KEYS.filter((k) => k.startsWith("canReadUser"));

function sameUserSelections(a: KeyCapabilities, b: KeyCapabilities): boolean {
  return USER_CAPABILITY_KEYS.every((k) => a[k] === b[k]);
}

/**
 * Name the key's capability set against the presets. Faction selections are
 * ignored for the comparison (they are separate Torn selections); a set that
 * matches neither preset is honestly labelled custom.
 */
export function capabilitySetName(caps: KeyCapabilities | null | undefined): "Full" | "Limited" | "Custom" {
  if (!caps) return "Custom";
  if (sameUserSelections(caps, FULL_PRESET)) return "Full";
  if (sameUserSelections(caps, LIMITED_PRESET)) return "Limited";
  return "Custom";
}

/** Per-feature state in a consequence matrix cell. */
export type MatrixState = "enabled" | "partial" | "unavailable";

export interface ConsequenceRow {
  feature: TornScopeFeature;
  label: string;
  limited: MatrixState;
  full: MatrixState;
  /** Missing capability label in the LIMITED preset (details view). */
  limitedMissing: string | null;
  /** True when the feature needs separate faction key selections. */
  factionSelection: boolean;
}

function matrixStateFor(caps: KeyCapabilities, feature: TornScopeFeature): MatrixState {
  const req = featureRequirement(feature);
  const missingRequired = req.requires.some((key) => !caps[key]);
  if (missingRequired) return "unavailable";
  const missingOptional = (req.optional ?? []).filter((key) => !caps[key]);
  return missingOptional.length > 0 && req.partial ? "partial" : "enabled";
}

/**
 * The Limited-vs-Full feature consequence matrix, generated from the SAME
 * FEATURE_REQUIREMENTS the running app enforces — never hardcoded guesses.
 * Faction features are flagged so the UI can explain the separate key
 * selections instead of implying either preset grants them.
 */
export function featureConsequenceMatrix(): ConsequenceRow[] {
  return FEATURE_REQUIREMENTS.map((req) => ({
    feature: req.feature,
    label: req.label,
    limited: matrixStateFor(LIMITED_PRESET, req.feature),
    full: matrixStateFor(FULL_PRESET, req.feature),
    limitedMissing: missingRequirementLabel(LIMITED_PRESET, req.feature)?.label ?? null,
    factionSelection: req.requires.some((key) => key.startsWith("canReadFaction")),
  }));
}

/* -------------------------------------------------------------------------- */
/* Historical recoverability (the "what can be recovered later?" model)        */
/* -------------------------------------------------------------------------- */

/**
 * Honest per-resource recoverability semantics for onboarding. Three honest
 * classes — never promise a backfill Torn cannot serve:
 *
 * - "current"    reflects live state; always (re)collectable.
 * - "window"     Torn keeps a limited-time log window (roughly the last 180
 *                days); anything not collected before it ages out is gone.
 * - "from_start" accrues only from when syncing begins; the past cannot be
 *                reconstructed.
 * - "source"     public/shared data Torn still exposes.
 */
export type Recoverability = "current" | "window" | "from_start" | "source";

export const RESOURCE_RECOVERABILITY: Record<SyncResource, Recoverability> = {
  profile: "current",
  bars: "from_start",
  personal_stats: "from_start",
  networth: "from_start",
  drugs: "window",
  travel: "window",
  rehab: "window",
  money_logs: "window",
  events: "window",
  attacks: "window",
  faction_basic: "source",
  faction: "source",
  ranked_wars: "source",
  chains: "source",
  organized_crimes: "source",
  torn_catalog: "source",
};

/** Short user-facing recoverability sentence per class (details view). */
export const RECOVERABILITY_COPY: Record<Recoverability, string> = {
  current: "Reflects your current Torn state — always collectable, nothing to miss.",
  window: "Torn keeps a limited-time log window (about the last 180 days). History not collected before it ages out can never be recovered.",
  from_start: "Accumulates from the moment syncing starts — the past cannot be reconstructed, so earlier is genuinely better.",
  source: "Collected from data Torn still exposes; depth depends on what Torn serves, and it accrues while stored.",
};

/** Which resources a capability key gates, for warning copy. */
export function unrecoverableWhileSkipping(caps: KeyCapabilities | null | undefined): Array<{ label: string; recoverability: Recoverability }> {
  return SYNC_RESOURCES.filter((resource) => !resourceAllowed(caps, resource)).map((resource) => ({
    label: RESOURCE_LABELS[resource]!,
    recoverability: RESOURCE_RECOVERABILITY[resource],
  }));
}
