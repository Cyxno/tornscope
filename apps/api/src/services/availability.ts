import {
  featureAvailability,
  normalizeCapabilitiesWithFallback,
  resourceAllowed,
  type FeatureAvailability as FeatureAvailabilityDto,
  type KeyCapabilities,
  type SyncResource,
  type TornScopeFeature,
} from "@tornscope/shared";
import { getPrismaClient } from "@tornscope/database";

/**
 * Permission-aware availability blocks for module responses.
 *
 * The source of truth is the central feature matrix (@tornscope/shared).
 * These helpers combine the profile's detected key capabilities with the
 * per-resource sync state so a feature that lost its backing permission is
 * reported as stale/unavailable instead of silently rendering zeros.
 */

interface SyncStateLite {
  lastSuccessAt: Date | null;
  recordsCollected: number;
  status: string;
}

export interface AvailabilityContext {
  caps: KeyCapabilities | null;
  states: Map<string, SyncStateLite>;
}

export async function loadAvailabilityContext(userId: string): Promise<AvailabilityContext> {
  const db = getPrismaClient();
  const [credential, states] = await Promise.all([
    db.apiCredential.findUnique({ where: { userId }, select: { capabilities: true, accessLevel: true, revokedAt: true } }),
    db.syncState.findMany({ where: { userId }, select: { resource: true, lastSuccessAt: true, recordsCollected: true, status: true } }),
  ]);
  const caps = credential && !credential.revokedAt
    ? normalizeCapabilitiesWithFallback(credential.capabilities, credential.accessLevel)
    : null;
  return { caps, states: new Map(states.map((s) => [s.resource, s])) };
}

/**
 * Availability for a feature backed by a sync resource. `refreshResource`
 * overrides which resource decides refresh permission (defaults to the
 * feature's own requirement via the matrix).
 */
export function sectionAvailability(
  ctx: AvailabilityContext,
  feature: TornScopeFeature,
  backingResource: SyncResource,
  opts: { live?: boolean } = {}
): FeatureAvailabilityDto {
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
 */
export function liveAvailability(ctx: AvailabilityContext, feature: TornScopeFeature): FeatureAvailabilityDto {
  return featureAvailability(ctx.caps, feature, { hasStoredData: false, lastSuccessAt: null });
}
