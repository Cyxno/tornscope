import {
  featureAvailability,
  normalizeCapabilitiesWithFallback,
  resourceAllowed,
  type FeatureAvailability as FeatureAvailabilityDto,
  type KeyCapabilities,
  type SyncResource,
  type TornScopeFeature,
} from "@tornscope/shared";
import { getPrismaClient, type SyncStateRow } from "@tornscope/database";

/**
 * Permission-aware availability blocks for module responses.
 *
 * The source of truth is the central feature matrix (@tornscope/shared).
 * These helpers combine the profile's detected key capabilities with the
 * per-resource sync state so a feature that lost its backing permission is
 * reported as stale/unavailable instead of silently rendering zeros.
 *
 * The loaded context (caps + full sync-state rows + demo flag) is also the
 * input of the data-confidence derivation (services/confidence.ts) — one
 * batched read serves both, so endpoints never query per card.
 */

export interface AvailabilityContext {
  caps: KeyCapabilities | null;
  states: Map<string, SyncStateRow>;
  /**
   * Demo profiles present synthetic seed data with no API credential. Their
   * availability must read as "demo data", never as permission/stale states
   * caused by the missing key.
   */
  isDemo: boolean;
}

export async function loadAvailabilityContext(userId: string): Promise<AvailabilityContext> {
  const db = getPrismaClient();
  const [credential, states, user] = await Promise.all([
    db.apiCredential.findUnique({ where: { userId }, select: { capabilities: true, accessLevel: true, revokedAt: true } }),
    db.syncState.findMany({ where: { userId } }),
    db.user.findUnique({ where: { id: userId }, select: { isDemo: true } }),
  ]);
  const caps = credential && !credential.revokedAt
    ? normalizeCapabilitiesWithFallback(credential.capabilities, credential.accessLevel)
    : null;
  return { caps, states: new Map(states.map((s) => [s.resource, s])), isDemo: Boolean(user?.isDemo) };
}

/**
 * Availability for a feature backed by a sync resource. `refreshResource`
 * overrides which resource decides refresh permission (defaults to the
 * feature's own requirement via the matrix).
 *
 * Demo override: stored demo data reports as plain historical availability;
 * missing demo sections report as an empty source — never as a permission
 * problem, because in Demo there IS no key to lack one.
 */
export function sectionAvailability(
  ctx: AvailabilityContext,
  feature: TornScopeFeature,
  backingResource: SyncResource,
  opts: { live?: boolean } = {}
): FeatureAvailabilityDto {
  if (ctx.isDemo) {
    const state = ctx.states.get(backingResource);
    const hasStoredData = (state?.recordsCollected ?? 0) > 0;
    return {
      state: hasStoredData ? "available_historical" : "unavailable_source",
      requiresLabel: null,
      requiresSelections: [],
      hasHistoricalData: hasStoredData,
      lastRefreshedAt: null,
    };
  }
  const state = opts.live ? undefined : ctx.states.get(backingResource);
  return featureAvailability(ctx.caps, feature, {
    hasStoredData: (state?.recordsCollected ?? 0) > 0,
    lastSuccessAt: state?.lastSuccessAt ? Math.floor(state.lastSuccessAt.getTime() / 1000) : null,
    canRefresh: resourceAllowed(ctx.caps, backingResource),
  });
}

/**
 * Live (non-synced) feature: the key can either read it right now or it
 * lacks the permission — no stored history exists for live-only sections.
 * Demo reports these as a plain missing source (the demo dataset carries no
 * live state), never as a permission complaint.
 */
export function liveAvailability(ctx: AvailabilityContext, feature: TornScopeFeature): FeatureAvailabilityDto {
  if (ctx.isDemo) {
    return { state: "unavailable_source", requiresLabel: null, requiresSelections: [], hasHistoricalData: false, lastRefreshedAt: null };
  }
  return featureAvailability(ctx.caps, feature, { hasStoredData: false, lastSuccessAt: null });
}
