/**
 * Torn domain constants shared across frontend, API and workers.
 * Values are based on the official Torn API v2 OpenAPI spec (CountryEnum)
 * and long-stable Torn game concepts. Anything that cannot be sourced
 * statically is resolved at runtime from the API instead.
 */

/** Travel destinations from Torn API v2 `CountryEnum` (swagger openapi.json). */
export const TRAVEL_DESTINATIONS = [
  "Argentina",
  "Canada",
  "Cayman Islands",
  "China",
  "Hawaii",
  "Japan",
  "Mexico",
  "South Africa",
  "Switzerland",
  "UAE",
  "United Kingdom",
] as const;

export type TravelDestination = (typeof TRAVEL_DESTINATIONS)[number];
export const TORN_HOME = "Torn" as const;

/** Item classes we track for travel profitability. */
export const TRAVEL_ITEM_CATEGORIES = ["plushie", "flower", "other"] as const;
export type TravelItemCategory = (typeof TRAVEL_ITEM_CATEGORIES)[number];

/**
 * Well-known Torn drug item names (stable item catalog names).
 * Used to classify drug log entries; the authoritative id->name mapping is
 * resolved from /torn/items at runtime and cached.
 */
export const TORN_DRUG_NAMES = [
  "Cannabis",
  "Ecstasy",
  "Ketamine",
  "LSD",
  "Opium",
  "PCP",
  "Shrooms",
  "Speed",
  "Vicodin",
  "Xanax",
  "Love Juice",
] as const;

export type TornDrugName = (typeof TORN_DRUG_NAMES)[number];

/**
 * External Torn links used across the UI — audited 2026-09.
 * travel.php was removed by Torn (404 "Page Not Found"); the travel hub now
 * lives at page.php?sid=travel. Drugs/medical/boosters are all used from the
 * inventory page (item.php); Torn exposes no stable per-category anchor, so
 * no fake deep links are invented here.
 */
export const TORN_URLS = {
  travel: "https://www.torn.com/page.php?sid=travel",
  items: "https://www.torn.com/item.php",
  bank: "https://www.torn.com/bank.php",
  education: "https://www.torn.com/education.php",
  /** Live-bar quick links (audited 2026-09): gym + crimes hubs are stable. */
  gym: "https://www.torn.com/gym.php",
  crimes: "https://www.torn.com/page.php?sid=crimes",
} as const;

/* -------------------------------------------------------------------------- */
/* Combat feed semantics (user-perspective verb + outcome)                     */
/* -------------------------------------------------------------------------- */

export type CombatOutcome = "won" | "lost" | "neutral";

/**
 * User-perspective semantics for one attack record.
 *
 * Torn's `result` is written from the ATTACKER's point of view, so the feed
 * verb must follow DIRECTION, not the raw result string:
 *   outgoing -> "Attacked"   (did my attack succeed?)
 *   incoming -> "Defended"   (did my defense hold?)
 * Color/status carries the outcome; the raw result (Mugged, Hospitalized,
 * Lost, Stalemate, ...) stays as context.
 */
export function combatEventSemantics(
  direction: "outgoing" | "incoming",
  result: string
): { verb: string; outcome: CombatOutcome; context: string | null } {
  const win = new Set(["Attacked", "Mugged", "Hospitalized", "Arrested", "Special"]);
  const attackerLost = new Set(["Lost", "Defended"]);
  const outgoing = direction === "outgoing";
  let outcome: CombatOutcome;
  if (outgoing) {
    outcome = win.has(result) ? "won" : attackerLost.has(result) ? "lost" : "neutral";
  } else {
    // Incoming: attacker success = my loss; Lost/Defended = my defense held.
    outcome = win.has(result) ? "lost" : attackerLost.has(result) ? "won" : "neutral";
  }
  // Context chip only when the result adds information beyond the verb.
  const context = result && !/^(attacked|defended)$/i.test(result) ? result : null;
  return { verb: outgoing ? "Attacked" : "Defended", outcome, context };
}

/** Central money ledger categories. */
export const MONEY_CATEGORIES = [
  "crime",
  "mugging",
  "ranked_war",
  "faction",
  "travel",
  "plushie",
  "flower",
  "stock",
  "rehab",
  "drugs",
  "items",
  "casino",
  "points",
  "trading",
  "bazaar",
  "city_bank",
  "cayman_bank",
  "salary",
  "education",
  "hospital",
  "jail",
  "housing",
  "auction",
  "missions",
  "other",
] as const;

export type MoneyCategory = (typeof MONEY_CATEGORIES)[number];

export const MONEY_DIRECTIONS = ["income", "expense", "neutral", "unknown"] as const;
export type MoneyDirection = (typeof MONEY_DIRECTIONS)[number];

/**
 * Sync resources tracked in sync_state.
 * Frequencies are defaults (seconds) and configurable via env in the worker.
 */
export const SYNC_RESOURCES = [
  "profile",
  "personal_stats",
  "networth",
  "drugs",
  "travel",
  "rehab",
  "money_logs",
  "events",
  "faction_basic",
  "faction",
  "ranked_wars",
  "chains",
  "organized_crimes",
  "attacks",
  "torn_catalog",
] as const;

export type SyncResource = (typeof SYNC_RESOURCES)[number];

export const DEFAULT_SYNC_FREQUENCIES_SECONDS: Record<SyncResource, number> = {
  profile: 300,
  personal_stats: 3600,
  networth: 3600,
  drugs: 600,
  travel: 600,
  rehab: 3600,
  money_logs: 600,
  events: 300,
  faction_basic: 21600,
  faction: 3600,
  ranked_wars: 21600,
  chains: 21600,
  organized_crimes: 3600,
  attacks: 1800,
  torn_catalog: 86400,
};

/** Dedicated demo account — demo data is always scoped to this user only. */
export const DEMO_USER_EMAIL = "demo@tornscope.local";

/**
 * Keyword router used to classify Torn log entries by their category title.
 * Order matters: more specific routes are checked first (e.g. "Drug
 * rehabilitation" must match rehab, not drugs).
 */
export const LOG_CATEGORY_ROUTES = {
  rehab: ["rehab", "rehabilitation"],
  drugs: ["drug"],
  travel: ["travel", "abroad", "fly", "flight"],
  money: ["trade", "money", "bazaar", "bank", "casino", "stock", "salary", "points", "auction", "crime", "mug", "payout", "faction", "job"],
} as const satisfies Record<string, readonly string[]>;

/* -------------------------------------------------------------------------- */
/* API key capability model                                                    */
/* -------------------------------------------------------------------------- */

export interface KeyCapabilities {
  canReadUserBasic: boolean;
  canReadUserBars: boolean;
  canReadUserMoney: boolean;
  canReadUserLogs: boolean;
  canReadUserAttacks: boolean;
  canReadUserNetworth: boolean;
  canReadFactionBasic: boolean;
  canReadFactionMembers: boolean;
  canReadFactionRankedWars: boolean;
  canReadFactionCrimes: boolean;
  canReadFactionArmoryNews: boolean;
  canReadFactionBalance: boolean;
  canReadFactionLogs: boolean;
}

export interface KeySelections {
  user?: string[] | null;
  faction?: string[] | null;
}

/**
 * Derive what a Torn key can actually read from /key/info. The API's
 * selections listing is authoritative when present; otherwise the numeric
 * access level gives a conservative fallback (public=1, minimal=2,
 * limited=3, full=4). Never assumes more than the key grants.
 */
export function deriveKeyCapabilities(selections: KeySelections | null | undefined, accessLevel: number | null | undefined): KeyCapabilities {
  const level = typeof accessLevel === 'number' ? accessLevel : 0;
  const user: string[] | null = Array.isArray(selections?.user) ? selections.user.map(String) : null;
  const faction: string[] | null = Array.isArray(selections?.faction) ? selections.faction.map(String) : null;
  const fromUser = (name: string, fallbackLevel: number): boolean => (user ? user.includes(name) : level >= fallbackLevel);
  const fromFaction = (name: string): boolean => (faction ? faction.includes(name) : false);
  return {
    canReadUserBasic: fromUser('profile', 1),
    canReadUserBars: fromUser('bars', 2),
    canReadUserMoney: fromUser('money', 3),
    canReadUserLogs: fromUser('log', 3),
    canReadUserAttacks: fromUser('attacks', 3),
    canReadUserNetworth: fromUser('networth', 3),
    canReadFactionBasic: fromFaction('basic'),
    canReadFactionMembers: fromFaction('members'),
    canReadFactionRankedWars: fromFaction('rankedwars'),
    canReadFactionCrimes: fromFaction('crimes'),
    canReadFactionArmoryNews: fromFaction('armorynews'),
    canReadFactionBalance: fromFaction('balance'),
    canReadFactionLogs: fromFaction('log'),
  };
}

/* -------------------------------------------------------------------------- */
/* Capability level + module availability (user-friendly degradation)          */
/* -------------------------------------------------------------------------- */

/**
 * Friendly access level derived from ACTUAL capabilities — never a manually
 * selected label. The highest satisfied tier wins.
 */
export function capabilityLevel(caps: KeyCapabilities): string {
  if (caps.canReadFactionLogs && caps.canReadFactionArmoryNews && caps.canReadFactionBalance && caps.canReadUserLogs) {
    return "Full available access";
  }
  if (caps.canReadUserLogs && caps.canReadUserMoney && caps.canReadUserAttacks) {
    return caps.canReadFactionBasic || caps.canReadFactionMembers || caps.canReadFactionCrimes ? "Faction-enabled" : "Extended";
  }
  if (caps.canReadUserBasic || caps.canReadUserBars) return "Basic";
  return "Very limited";
}

export type TornScopeModule = "today" | "drugs" | "money" | "travel" | "crimes" | "combat" | "faction" | "timeline" | "wallet";

export interface ModuleAvailability {
  module: TornScopeModule;
  available: boolean;
  /** Short reason shown in the UI when unavailable. */
  reason: string | null;
}

/**
 * Which analytics modules a key can actually power. Unavailable modules must
 * hide or explain — never show misleading zeros.
 */
export function moduleAvailability(caps: KeyCapabilities): ModuleAvailability[] {
  const no = (reason: string): { available: boolean; reason: string } => ({ available: false, reason });
  const yes = (): { available: boolean; reason: null } => ({ available: true, reason: null });
  return [
    { module: "today", ...caps.canReadUserBasic ? yes() : no("Needs basic account access") },
    {
      module: "drugs",
      ...(caps.canReadUserLogs ? yes() : no("Needs personal log access (Limited API access)")),
    },
    { module: "money", ...(caps.canReadUserLogs ? yes() : no("Needs personal log access (Limited API access)")) },
    { module: "travel", ...(caps.canReadUserLogs ? yes() : no("Needs personal log access (Limited API access)")) },
    { module: "crimes", ...(caps.canReadUserLogs ? yes() : no("Needs personal log access (Limited API access)")) },
    { module: "combat", ...(caps.canReadUserAttacks ? yes() : no("Needs attacks access (Limited API access)")) },
    {
      module: "faction",
      ...(caps.canReadFactionBasic ? yes() : no("Needs a key with faction access — ask your faction leader to grant it")),
    },
    { module: "timeline", ...(caps.canReadUserLogs ? yes() : no("Needs personal log access (Limited API access)")) },
    { module: "wallet", ...(caps.canReadUserMoney ? yes() : no("Needs money access (Limited API access)")) },
  ];
}
