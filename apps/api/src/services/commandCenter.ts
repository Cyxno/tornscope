import {
  buildDataFreshness,
  deriveActionItems,
  alertTrigger,
  ACTION_POLICY,
  type ActionAlertFact,
  type ActionFacts,
  type ActionOcFact,
  type CommandCenterResponse,
  type DataFreshnessEntry,
  type Insight,
} from "@tornscope/shared";
import { getPrismaClient } from "@tornscope/database";
import { getToday } from "./today.js";
import { getActiveGoalActionFacts } from "./goals.js";
import { getInsights } from "./insights.js";
import { getSyncStates } from "@tornscope/database";
import { TtlMap } from "@tornscope/shared";
import type { SessionUser } from "../auth.js";

/**
 * Command Center (2.0) — composes ONE prioritized attention feed from data
 * TornScope already has: the cached live-today payload, active goals,
 * derived insights, stored OC state and per-resource freshness. Zero extra
 * Torn API calls: /api/today's 30s cache (and its persisted last-known
 * fallback) already owns live-state freshness.
 */

const CACHE_TTL_MS = 20_000;
const cache = new TtlMap<CommandCenterResponse>({ ttlMs: CACHE_TTL_MS });

async function buildCommandCenter(user: SessionUser): Promise<CommandCenterResponse> {
  const db = getPrismaClient();
  const nowSec = Math.floor(Date.now() / 1000);

  const [today, insights, states] = await Promise.all([
    getToday(user),
    getInsights(user.id),
    getSyncStates(db, user.id),
  ]);
  const [goals, credential, account, networthRows, unreadAlertRows] = await Promise.all([
    getActiveGoalActionFacts(db, user.id, nowSec),
    db.apiCredential.findUnique({ where: { userId: user.id }, select: { revokedAt: true } }),
    db.tornAccount.findUnique({ where: { userId: user.id }, select: { tornId: true } }),
    db.networthSnapshot.findMany({
      where: { userId: user.id, capturedAt: { gte: new Date((nowSec - 9 * 86400) * 1000) } },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, total: true },
    }),
    db.alertDelivery.findMany({
      where: { userId: user.id, readAt: null },
      orderBy: { occurredAt: "desc" },
      take: ACTION_POLICY.MAX_ALERT_ITEMS,
      select: { id: true, triggerType: true, title: true, occurredAt: true },
    }),
  ]);

  // Unread proactive alerts → attention-feed facts (severity from the registry,
  // defaulting to "info" for trigger types no longer registered).
  const unreadAlerts: ActionAlertFact[] = unreadAlertRows.map((row) => ({
    id: row.id,
    triggerType: row.triggerType,
    title: row.title,
    severity: alertTrigger(row.triggerType)?.severity ?? "info",
    occurredAt: Math.floor(row.occurredAt.getTime() / 1000),
    clickPath: "/alerts",
  }));

  // Freshness (worst domains only — the feed is an attention surface, not a
  // full table; /system owns the complete view).
  const freshness: DataFreshnessEntry[] = buildDataFreshness(
    states.map((s) => ({
      resource: s.resource,
      status: s.status,
      lastAttemptAt: s.lastAttemptAt ? Math.floor(s.lastAttemptAt.getTime() / 1000) : null,
      lastSuccessAt: s.lastSuccessAt ? Math.floor(s.lastSuccessAt.getTime() / 1000) : null,
      nextRunAt: s.nextRunAt ? Math.floor(s.nextRunAt.getTime() / 1000) : null,
      frequencySeconds: s.frequencySeconds,
      errorCount: s.errorCount,
      lastErrorKind: s.lastErrorKind,
    })),
    nowSec
  );
  const freshnessIssues = freshness.filter((f) => !f.live && f.status !== "fresh").map(({ domain, label, status }) => ({ domain, label, status }));

  // Live-fact age: how old is the today payload we are reasoning about.
  const liveFactsAgeSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(today.fetchedAt / 1000));

  // Stored OC state → my joined, still-recruiting crimes.
  const ocFacts: ActionOcFact[] = account?.tornId != null
    ? (
        await db.organizedCrime.findMany({
          // Torn's API reports OC status capitalized ("Recruiting"); the
          // sync stores it verbatim — tolerate both casings (Postgres = is
          // case-sensitive). The DTO below keeps the hardcoded lowercase
          // "recruiting" contract the shared Command Center logic expects.
          where: { userId: user.id, status: { in: ["recruiting", "Recruiting"] } },
          select: { ocId: true, name: true, readyAt: true, slots: true, status: true },
        })
      )
        .filter((oc) => {
          const slots = (oc.slots ?? []) as Array<{ user?: { id?: number } | null }>;
          return slots.some((s) => s.user?.id === account.tornId);
        })
        .map((oc) => ({ id: String(oc.ocId), name: oc.name, joined: true, readyAt: oc.readyAt ? Math.floor(oc.readyAt.getTime() / 1000) : null, status: "recruiting" }))
    : [];

  const changePct7d = (() => {
    if (networthRows.length < 2) return null;
    const first = networthRows[0]!;
    const last = networthRows[networthRows.length - 1]!;
    if (first.total <= 0n) return null;
    return Number(((last.total - first.total) * 10000n) / first.total) / 100;
  })();

  const energyBar = today.bars.energy;
  const facts: ActionFacts = {
    now: nowSec,
    hasCredential: Boolean(credential && !credential.revokedAt),
    liveFactsAgeSeconds: liveFactsAgeSeconds,
    bars: energyBar ? { energy: { current: energyBar.current, maximum: energyBar.max, fullAt: energyBar.fullAt } } : null,
    cooldowns: (["drug", "medical", "booster"] as const).map((kind) => ({ kind, endsAt: today.cooldowns[kind]?.endsAt ?? null })),
    bank: { endsAt: today.bank.maturesAt, ready: today.bank.state === "mature" },
    education: { endsAt: today.education.completesAt },
    travel: { endsAt: today.travel.state === "traveling" ? today.travel.landsAt : null },
    hospitalUntil: today.hospital?.releasedAt ?? null,
    jailedUntil: today.jail?.releasedAt ?? null,
    oc: ocFacts,
    goals: goals.map((g) => ({ id: g.id, metric: g.metric, label: g.label, target: g.target, progress: g.progress, etaAt: g.etaAt, targetDate: g.targetDate, achievedAt: g.achievedAt ? Math.floor(g.achievedAt.getTime() / 1000) : null, createdAt: Math.floor(g.createdAt.getTime() / 1000) })),
    insights: insights.insights.slice(0, 3) as Insight[],
    freshnessIssues,
    networth: networthRows.length > 0 ? { current: Number(networthRows[networthRows.length - 1]!.total), changePct7d } : null,
    unreadAlerts,
  };

  const items = deriveActionItems(facts);
  return { items, truncated: false, generatedAt: Date.now() };
}

/** Cached command-center feed for a profile. */
export async function getCommandCenter(user: SessionUser): Promise<CommandCenterResponse> {
  const cached = cache.get(user.id);
  if (cached) return cached;
  const response = await buildCommandCenter(user);
  cache.set(user.id, response);
  return response;
}

export function invalidateCommandCenterCache(userId: string): void {
  cache.delete(userId);
}
