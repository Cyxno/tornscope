import { INSIGHT_KIND_META, TtlMap, type InsightKindMeta, type InsightsResponse } from "@tornscope/shared";
import { deriveInsights } from "@tornscope/analytics";
import { gatherInsightFacts, getPrismaClient } from "@tornscope/database";

/**
 * Personal insights (2.0). Fact gathering lives in @tornscope/database
 * (ONE implementation, also used by the worker's notification producer);
 * this service runs the pure rules over them and caches briefly — insights
 * move at day/week granularity, never per second.
 */

const CACHE_TTL_MS = 120_000;
const cache = new TtlMap<InsightsResponse>({ ttlMs: CACHE_TTL_MS });

/** Build the insights response for a profile (uncached). */
async function buildInsights(userId: string): Promise<InsightsResponse> {
  const db = getPrismaClient();
  const facts = await gatherInsightFacts(db, userId, Math.floor(Date.now() / 1000));
  const result = deriveInsights(facts);
  return {
    insights: result.insights,
    kinds: Object.values(INSIGHT_KIND_META).map((k: InsightKindMeta) => ({ kind: k.kind, label: k.label, category: k.category, typicalWindowDays: k.typicalWindowDays })),
    insufficientHistory: result.insufficientHistory,
  };
}

/** Cached insights for a profile. Demo and real profiles share the path. */
export async function getInsights(userId: string): Promise<InsightsResponse> {
  const cached = cache.get(userId);
  if (cached) return cached;
  const response = await buildInsights(userId);
  cache.set(userId, response);
  return response;
}

/** Invalidate a profile's insight cache (used after data-changing writes). */
export function invalidateInsightsCache(userId: string): void {
  cache.delete(userId);
}
