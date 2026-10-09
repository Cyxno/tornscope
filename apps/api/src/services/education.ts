import type { EducationProgress, FeatureAvailability as FeatureAvailabilityDto } from "@tornscope/shared";
import { buildEducationProgress, type EducationCatalogCategory } from "@tornscope/analytics";
import { getApiContext } from "../context.js";
import { liveAvailability, loadAvailabilityContext, type AvailabilityContext } from "./availability.js";

/**
 * Education progress service (2.8.2) — live-requested, merits-service
 * precedent. Read-time derivation over two PROVEN sources:
 *
 * - `/v2/user/education` (MINIMAL access): `{ complete: number[], current:
 *   {id, until} | null }` — the ONLY completion state Torn publishes. The
 *   stored log archive has "Education start" rows and NO completion events,
 *   so completion history is not derivable and is never fabricated.
 * - `/v2/torn/education` (public catalog): categories/courses/rewards —
 *   already used by the Today service; cached a day.
 *
 * Education state changes at most daily; the fetch is cached and never
 * polled: at most one Torn request per window, zero at rest.
 */

const STATE_CACHE_TTL_MS = 5 * 60_000;
const CATALOG_TTL_MS = 24 * 60 * 60_000;

const stateCache = new Map<string, { expiresAt: number; promise: Promise<{ complete: number[] | null; current: { id: number; until: number } | null }> }>();
let catalogCache: { fetchedAt: number; promise: Promise<EducationCatalogCategory[] | null> } | null = null;

/** Test seam: drop in-process caches. */
export function clearEducationProgressCaches(): void {
  stateCache.clear();
  catalogCache = null;
}

export async function getEducationProgress(
  user: { id: string; isDemo: boolean }
): Promise<{ education: EducationProgress | null; availability: FeatureAvailabilityDto }> {
  const availabilityCtx = await loadAvailabilityContext(user.id);
  const availability = availabilityOf(availabilityCtx);
  if (user.isDemo || (availabilityCtx.caps && !availabilityCtx.caps.canReadUserEducation)) {
    return { education: null, availability };
  }

  const ctx = getApiContext();
  const credential = await ctx.db.apiCredential.findUnique({ where: { userId: user.id } });
  if (!credential || credential.revokedAt) return { education: null, availability };

  const torn = ctx.torn(ctx.decryptCredential(credential));
  const nowSec = Math.floor(Date.now() / 1000);
  const [state, catalog] = await Promise.all([loadState(torn, user.id), loadCatalog(torn)]);
  const education = buildEducationProgress(catalog, state.complete, state.current, nowSec, nowSec);
  return { education, availability: { ...availability, state: education ? "available_live" : availability.state, lastRefreshedAt: nowSec } };
}

function loadState(torn: ReturnType<ReturnType<typeof getApiContext>["torn"]>, userId: string): Promise<{ complete: number[] | null; current: { id: number; until: number } | null }> {
  const now = Date.now();
  const entry = stateCache.get(userId);
  if (entry && entry.expiresAt > now) return entry.promise;
  const promise = torn
    .userEducation()
    .then((r) => ({ complete: Array.isArray(r.education.complete) ? r.education.complete : null, current: r.education.current ?? null }))
    .catch(() => ({ complete: null, current: null }));
  stateCache.set(userId, { expiresAt: now + STATE_CACHE_TTL_MS, promise });
  return promise;
}

/** Official catalog, cached a day. Null on failure — the section degrades to
 *  null (never a partial fabrication). */
function loadCatalog(torn: ReturnType<ReturnType<typeof getApiContext>["torn"]>): Promise<EducationCatalogCategory[] | null> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) return catalogCache.promise;
  const promise = torn
    .tornEducationCatalog()
    .then((categories) => categories as EducationCatalogCategory[])
    .catch(() => null);
  catalogCache = { fetchedAt: Date.now(), promise };
  return promise;
}

function availabilityOf(ctx: AvailabilityContext): FeatureAvailabilityDto {
  return liveAvailability(ctx, "progression_education");
}
