import { assembleMerits, buildMeritEffects } from "@tornscope/analytics";
import type { MeritsResponse, FeatureAvailability as FeatureAvailabilityDto } from "@tornscope/shared";
import { getApiContext } from "../context.js";
import { liveAvailability, loadAvailabilityContext, type AvailabilityContext } from "./availability.js";

/**
 * Merits service (live-requested, Today-service precedent).
 *
 * SOURCE AUDIT (Torn API v2, spec 6.13.5, verified live):
 * - `/v2/user/merits` → upgrades [{id, level}] + exact available/used/
 *   medals/honors counts. Requires MINIMAL access (`merits` selection).
 * - `/v2/torn/merits` (public) → official id → name/description catalog.
 * - The API publishes NO caps and NO categories; caps/categories come from
 *   the TornScope-maintained catalog in @tornscope/analytics (documented,
 *   with mismatch detection — see docs/MERITS.md).
 *
 * Merit ranks rarely change, so the fetch is cached briefly and never
 * polled: one Torn request per page view at most, zero at rest.
 */

const MERITS_CACHE_TTL_MS = 5 * 60_000;
const CATALOG_TTL_MS = 24 * 60 * 60_000;

interface CacheEntry {
  expiresAt: number;
  promise: Promise<MeritsResponse>;
}
const cache = new Map<string, CacheEntry>();

let catalogCache: { fetchedAt: number; promise: Promise<Map<number, { name: string; description: string }>> } | null = null;

/** Test seam: drop in-process caches. */
export function clearMeritsCaches(): void {
  cache.clear();
  catalogCache = null;
}

export function getMerits(user: { id: string; isDemo: boolean }): Promise<MeritsResponse> {
  if (user.isDemo) return Promise.resolve(buildDemoMerits());
  const now = Date.now();
  const entry = cache.get(user.id);
  if (entry && entry.expiresAt > now) return entry.promise;
  const promise = fetchMerits(user.id);
  cache.set(user.id, { expiresAt: now + MERITS_CACHE_TTL_MS, promise });
  return promise;
}

async function fetchMerits(userId: string): Promise<MeritsResponse> {
  const ctx = getApiContext();
  const availabilityCtx = await loadAvailabilityContext(userId);
  const availability = availabilityOf(availabilityCtx);

  if (availabilityCtx.caps && !availabilityCtx.caps.canReadUserMerits) {
    return emptyResponse(availability);
  }

  const credential = await ctx.db.apiCredential.findUnique({ where: { userId } });
  if (!credential || credential.revokedAt) return emptyResponse(availability);

  const torn = ctx.torn(ctx.decryptCredential(credential));
  const [raw, catalog] = await Promise.all([
    torn.userMerits(),
    loadCatalog(torn),
  ]);
  const { rows, summary } = assembleMerits({
    upgrades: raw.merits.upgrades,
    available: raw.merits.available ?? null,
    used: raw.merits.used ?? null,
    medals: raw.merits.medals ?? null,
    honors: raw.merits.honors ?? null,
    catalog,
  });
  return {
    summary,
    merits: rows,
    availability: { ...availability, state: "available_live", lastRefreshedAt: Math.floor(Date.now() / 1000) },
    catalogDegraded: catalog.size === 0,
    effects: buildMeritEffects(raw.merits.upgrades, catalog),
  };
}

/** Official catalog, cached a day. On failure: names render as null and the
 *  response carries catalogDegraded — ranks stay exact and visible. */
async function loadCatalog(torn: ReturnType<ReturnType<typeof getApiContext>["torn"]>): Promise<Map<number, { name: string; description: string }>> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) return catalogCache.promise;
  const promise = torn
    .tornMeritsCatalog()
    .then((entries) => new Map(entries.map((e) => [e.id, { name: e.name, description: e.description }])));
  catalogCache = { fetchedAt: Date.now(), promise };
  try {
    return await promise;
  } catch {
    catalogCache = null;
    return new Map();
  }
}

/** The availability block for a user who cannot read merits. */
function availabilityOf(ctx: AvailabilityContext): FeatureAvailabilityDto {
  return liveAvailability(ctx, "merits_overview");
}

function emptyResponse(availability: FeatureAvailabilityDto): MeritsResponse {
  const { rows, summary } = assembleMerits({ upgrades: [], available: null, used: null, medals: null, honors: null, catalog: new Map() });
  return { summary, merits: rows, availability, catalogDegraded: false, effects: [] };
}

/* -------------------------------------------------------------------------- */
/* Demo dataset                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic synthetic demo merits — pushed through the SAME assembly as
 * real data so summary/filter/progress behavior is guaranteed coherent.
 * Mirrors a mid-game account: several maxed "10-cap" merits, invested
 * stat/crime merits, and untouched rows.
 */
function buildDemoMerits(): MeritsResponse {
  const catalog = new Map<number, { name: string; description: string }>(DEMO_CATALOG.map((m) => [m.id, m]));
  const { rows, summary } = assembleMerits({
    upgrades: DEMO_UPGRADES,
    available: 3,
    used: 224,
    medals: 84,
    honors: 61,
    catalog,
  });
  return {
    summary,
    merits: rows,
    availability: {
      state: "available_historical",
      requiresLabel: null,
      requiresSelections: [],
      hasHistoricalData: true,
      lastRefreshedAt: Math.floor(Date.now() / 1000),
    },
    catalogDegraded: false,
    effects: buildMeritEffects(DEMO_UPGRADES, catalog),
  };
}

const DEMO_UPGRADES: Array<{ id: number; level: number }> = [
  { id: 1, level: 10 },
  { id: 3, level: 7 },
  { id: 4, level: 10 },
  { id: 5, level: 4 },
  { id: 6, level: 10 },
  { id: 7, level: 10 },
  { id: 9, level: 42 },
  { id: 10, level: 38 },
  { id: 11, level: 25 },
  { id: 12, level: 31 },
  { id: 13, level: 6 },
  { id: 14, level: 9 },
  { id: 16, level: 10 },
  { id: 21, level: 10 },
  { id: 25, level: 2 },
];

/** Subset of the official catalog for demo (real names/descriptions). */
const DEMO_CATALOG = [
  { id: 1, name: "Nerve Bar", description: "This upgrade will give you +1 extra nerve point on your maximum nerve." },
  { id: 3, name: "Critical Hit Rate", description: "This upgrade will give you an extra 0.5% chance at getting a critical hit during attacks." },
  { id: 4, name: "Awareness", description: "This upgrade will increase the amount of items you can find in the city by 20%." },
  { id: 5, name: "Masterful Looting", description: "This upgrade will give you a 5% boost in money that you mug from opponents." },
  { id: 6, name: "Stealth", description: "This upgrade will make you more likely to stay stealthed when beating an opponent." },
  { id: 7, name: "Bank Interest", description: "This upgrade will give you an increase of 5% to your investment bank interest." },
  { id: 8, name: "Hospitalizing", description: "This upgrade will increase the amount of time you hospitalize someone by 5%." },
  { id: 9, name: "Brawn", description: "This upgrade will give you a passive 3% bonus to your strength stat." },
  { id: 10, name: "Sharpness", description: "This upgrade will give you a passive 3% bonus to your speed stat." },
  { id: 11, name: "Evasion", description: "This upgrade will give you a passive 3% bonus to your dexterity stat." },
  { id: 12, name: "Protection", description: "This upgrade will give you a passive 3% bonus to your defense stat." },
  { id: 13, name: "Life Points", description: "This upgrade will increase your maximum life by 5%." },
  { id: 14, name: "Crime XP", description: "This upgrade will give you a passive boost of 3% (per upgrade) to your Crime XP." },
  { id: 15, name: "Education Length", description: "This upgrade will decrease the amount of time you have to wait to complete an education course by 2%." },
  { id: 16, name: "Heavy Artillery Mastery", description: "This upgrade will improve your proficiency with heavy artillery, increasing damage by 1% and accuracy by +0.2." },
  { id: 17, name: "Machine Gun Mastery", description: "This upgrade will improve your proficiency with machine guns, increasing damage by 1% and accuracy by +0.2." },
  { id: 18, name: "Rifle Mastery", description: "This upgrade will improve your proficiency with rifles, increasing damage by 1% and accuracy by +0.2." },
  { id: 19, name: "SMG Mastery", description: "This upgrade will improve your proficiency with SMGs, increasing damage by 1% and accuracy by +0.2." },
  { id: 20, name: "Shotgun Mastery", description: "This upgrade will improve your proficiency with shotguns, increasing damage by 1% and accuracy by +0.2." },
  { id: 21, name: "Pistol Mastery", description: "This upgrade will improve your proficiency with pistols, increasing damage by 1% and accuracy by +0.2." },
  { id: 22, name: "Club Mastery", description: "This upgrade will improve your proficiency with clubs, increasing damage by 1% and accuracy by +0.2." },
  { id: 23, name: "Piercing Mastery", description: "This upgrade will improve your proficiency with piercing weapons, increasing damage by 1% and accuracy by +0.2." },
  { id: 24, name: "Slashing Mastery", description: "This upgrade will improve your proficiency with slashing weapons, increasing damage by 1% and accuracy by +0.2." },
  { id: 25, name: "Mechanical Mastery", description: "This upgrade will improve your proficiency with mechanical weapons, increasing damage by 1% and accuracy by +0.2." },
  { id: 26, name: "Temporary Mastery", description: "This upgrade will improve your proficiency with temporary weapons, increasing damage by 1% and accuracy by +0.2." },
  { id: 27, name: "Addiction Mitigation", description: "This upgrade will reduce the negative effects that addiction causes by 2%." },
  { id: 28, name: "Employee Effectiveness", description: "This upgrade will provide an additional +1 bonus to employee effectiveness." },
];
