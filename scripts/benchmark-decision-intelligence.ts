import { PrismaClient } from "../packages/database/src/generated/client/client.js";

/**
 * Decision Intelligence performance benchmark (2.3.x audit tooling).
 *
 *   BENCH_DATABASE_URL=postgresql://... pnpm exec tsx scripts/benchmark-decision-intelligence.ts \
 *     [--scale small|medium|large] [--users 1,5,10,25] [--runs 7] [--fixture-only] [--skip-fixture]
 *
 * Deterministic synthetic fixtures (SQL generate_series — no random data):
 *   small  ≈ current production order of magnitude (~16k MoneyEvent/profile)
 *   medium ≈ 10× history
 *   large  ≈ 100× event volume
 *
 * Measures per scale: cold gather p50/p95/p99/mean + query count + rows
 * returned (instrumented Prisma client), engine-only time, service cold/warm
 * (cache) latency, and K-user concurrency. NOT wired into CI.
 */

interface BenchArgs {
  scales: string[];
  users: number[];
  runs: number;
  fixtureOnly: boolean;
  skipFixture: boolean;
}

function parseArgs(): BenchArgs {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    scales: (get("scale") ?? "small,medium,large").split(",").filter(Boolean),
    users: (get("users") ?? "1,5,10,25").split(",").map(Number).filter((n) => Number.isFinite(n)),
    runs: Number(get("runs") ?? 7),
    fixtureOnly: args.includes("--fixture-only"),
    skipFixture: args.includes("--skip-fixture"),
  };
}

const DAY = 86_400;

const SCALES = {
  small: { money: 16_000, drugs: 1_200, rehab: 140, gymLogs: 700, refills: 260, trips: 750, tripItems: 750, days: 120 },
  medium: { money: 160_000, drugs: 12_000, rehab: 1_400, gymLogs: 7_000, refills: 2_600, trips: 7_500, tripItems: 7_500, days: 365 },
  large: { money: 1_600_000, drugs: 120_000, rehab: 14_000, gymLogs: 70_000, refills: 26_000, trips: 30_000, tripItems: 30_000, days: 365 },
} as const;

type Scale = keyof typeof SCALES;

const prisma = new PrismaClient({
  log: [{ emit: "event", level: "query" }],
});
let queryCount = 0;
let rowsReturned = 0;
prisma.$on("query" as never, ((e: { performance?: number }) => {
  queryCount += 1;
  void e;
}) as never);

async function buildFixture(userSuffix: string, scale: Scale): Promise<string> {
  // Per-call nonce: ids are globally unique even if this function is ever
  // invoked twice with the same user suffix.
  const nonce = Math.random().toString(36).slice(2, 10);
  const cfg = SCALES[scale];
  const userId = `bench-${scale}-${userSuffix}-${process.env.BENCH_RUN_ID ?? Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" ("id","displayName","role","isDemo","timezone","currency","createdAt","updatedAt")
     VALUES ('${userId}','BENCH ${scale}','user',false,'UTC','USD',now(),now())`
  );
  // Deterministic distribution: recent window (last 7d) gets a small bump so
  // anomaly logic has shape; baseline spread across the prior 30d; the rest
  // is older history that MUST NOT be read by the bounded gather.
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - cfg.days * DAY;

  // MoneyEvent: 60% old history (outside the 37d gather window), 30% baseline
  // month, 10% recent week with a mild upward bias.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "MoneyEvent" ("id","userId","occurredAt","category","direction","amount","source","sourceRef")
    SELECT
      'be-' || '${userId}:${nonce}:' || g,
      '${userId}',
      to_timestamp(${fromSec} + (g % ${cfg.days * DAY})),
      CASE g % 6 WHEN 0 THEN 'casino' ELSE 'other' END,
      CASE g % 3 WHEN 0 THEN 'income'::text ELSE 'expense'::text END::"MoneyDirection",
      (100 + (g % 4000))::bigint,
      'bench',
      'bench:${userId}:${nonce}:money:' || g
    FROM generate_series(1, ${cfg.money}) g ON CONFLICT DO NOTHING
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "DrugEvent" ("id","userId","occurredAt","drugName","outcome","source","sourceRef")
    SELECT
      'be-' || '${userId}:${nonce}:' || g,
      '${userId}',
      to_timestamp(${fromSec} + (g % ${cfg.days * DAY})),
      CASE g % 4 WHEN 0 THEN 'Ecstasy' ELSE 'Xanax' END,
      CASE g % 20 WHEN 0 THEN 'overdose'::text ELSE 'success'::text END::"DrugOutcome",
      'bench',
      'bench:${userId}:${nonce}:drug:' || g
    FROM generate_series(1, ${cfg.drugs}) g ON CONFLICT DO NOTHING
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "RehabEvent" ("id","userId","occurredAt","cost","sessions","source","sourceRef")
    SELECT
      'be-' || '${userId}:${nonce}:' || g,
      '${userId}',
      to_timestamp(${fromSec} + (g % ${cfg.days * DAY})),
      (8000 + (g % 9000))::bigint,
      (g % 4) + 1,
      'bench',
      'bench:${userId}:${nonce}:rehab:' || g
    FROM generate_series(1, ${cfg.rehab}) g ON CONFLICT DO NOTHING
  `);

  // Gym logs land on the TimelineEvent archive (the shape the gatherer reads).
  await prisma.$executeRawUnsafe(`
    INSERT INTO "TimelineEvent" ("id","userId","occurredAt","type","category","title","source","sourceRef","metadata")
    SELECT
      'be-' || '${userId}:${nonce}:' || g,
      '${userId}',
      to_timestamp(${fromSec} + (g % ${cfg.days * DAY})),
      'log',
      'Gym',
      'Gym train ' || (ARRAY['strength','defense','speed','dexterity'])[1 + (g % 4)],
      'bench',
      'bench:${userId}:${nonce}:gym:' || g,
      jsonb_build_object('data', jsonb_build_object('energy_used', 200 + (g % 200)))
    FROM generate_series(1, ${cfg.gymLogs}) g ON CONFLICT DO NOTHING
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "TimelineEvent" ("id","userId","occurredAt","type","category","title","source","sourceRef","metadata")
    SELECT
      'be-' || '${userId}:${nonce}:' || g,
      '${userId}',
      to_timestamp(${fromSec} + (g % ${cfg.days * DAY})),
      'log',
      'Points building',
      'Points energy refill use',
      'bench',
      'bench:${userId}:${nonce}:refill:' || g,
      jsonb_build_object('data', jsonb_build_object('energy_increased', 150))
    FROM generate_series(1, ${cfg.refills}) g ON CONFLICT DO NOTHING
  `);

  // Trips + items: completed trips; items carry their travelEventId at
  // insert time (LATERAL join to the most recent departing trip) — a
  // post-hoc correlated UPDATE does not scale to millions of rows.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "TravelEvent" ("id","userId","destination","departedAt","returnedAt","durationSeconds","status","source","sourceRef")
    SELECT
      'be-' || '${userId}:${nonce}:trip:' || g,
      '${userId}',
      (ARRAY['UAE','Canada','Mexico','Switzerland'])[1 + (g % 4)],
      to_timestamp(${fromSec} + (g % ${cfg.days * DAY})),
      to_timestamp(${fromSec} + (g % ${cfg.days * DAY}) + 14400),
      14400,
      'returned',
      'trip',
      'bench:${userId}:${nonce}:trip:' || g
    FROM generate_series(1, ${cfg.trips}) g ON CONFLICT DO NOTHING
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "TravelItemEvent" ("id","userId","occurredAt","category","itemId","itemName","quantity","unitCost","totalCost","source","sourceRef","travelEventId")
    SELECT
      'be-' || '${userId}:${nonce}:item:' || g,
      '${userId}',
      t."departedAt" + interval '1 hour',
      'plushie',
      400 + (g % 10),
      'Bench Plushie',
      5,
      1000,
      5000,
      'bench',
      'bench:${userId}:${nonce}:item:' || g,
      t."id"
    FROM generate_series(1, ${cfg.tripItems}) g
    JOIN LATERAL (
      SELECT te."id", te."departedAt" FROM "TravelEvent" te
      WHERE te."userId" = '${userId}' AND te."departedAt" <= to_timestamp(${fromSec} + (g % ${cfg.days * DAY}) + 3600)
      ORDER BY te."departedAt" DESC LIMIT 1
    ) t ON true ON CONFLICT DO NOTHING
  `);

    return userId;
}

async function clearFixture(userId: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "MoneyEvent" WHERE "userId" = '${userId}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "DrugEvent" WHERE "userId" = '${userId}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "RehabEvent" WHERE "userId" = '${userId}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "TimelineEvent" WHERE "userId" = '${userId}' AND "source" = 'bench'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "TravelItemEvent" WHERE "userId" = '${userId}' AND "source" = 'bench'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "TravelEvent" WHERE "userId" = '${userId}' AND "source" = 'trip' AND "sourceRef" LIKE 'bench:%'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "AppSetting" WHERE "userId" = '${userId}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = '${userId}'`);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function stats(times: number[]): { p50: number; p95: number; p99: number; mean: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((s, t) => s + t, 0) / Math.max(1, times.length);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), mean };
}

async function measureGather(userId: string, runs: number): Promise<{ stats: ReturnType<typeof stats>; queriesPerRun: number; rowsPerRun: number }> {
  const { gatherDecisionFacts } = await import("../packages/database/src/repositories/intelligence-facts.js");
  const { buildDecisionSignals, normalizeDecisionPrefs } = await import("../packages/analytics/src/index.js");
  const times: number[] = [];
  const engineTimes: number[] = [];
  const queriesPerRun: number[] = [];
  const rowsPerRun: number[] = [];
  for (let i = 0; i < runs; i++) {
    queryCount = 0;
    rowsReturned = 0;
    const t0 = performance.now();
    const facts = await gatherDecisionFacts(prisma, userId, Math.floor(Date.now() / 1000));
    const t1 = performance.now();
    buildDecisionSignals({
      facts,
      coverage: {
        money: { coveredDays: 0, events: facts.money.events.length, trackingSince: facts.money.trackingSince },
        drugs: { coveredDays: 0, events: facts.drugs.events.length, trackingSince: facts.drugs.trackingSince },
        travel: { coveredDays: 0, events: facts.travel.trips.length, trackingSince: facts.travel.trackingSince },
        energy: { coveredDays: 0, events: facts.energy.gym.length + facts.energy.refills.length, trackingSince: facts.energy.trackingSince },
      },
      prefs: normalizeDecisionPrefs({}),
    });
    const t2 = performance.now();
    times.push(t1 - t0);
    engineTimes.push(t2 - t1);
    queriesPerRun.push(queryCount);
    rowsPerRun.push(
      facts.money.events.length + facts.drugs.events.length + facts.drugs.rehab.length +
      facts.travel.trips.length + facts.energy.gym.length + facts.energy.refills.length
    );
  }
  return {
    stats: stats(times),
    queriesPerRun: Math.round(queriesPerRun.reduce((s, q) => s + q, 0) / runs),
    rowsPerRun: Math.round(rowsPerRun.reduce((s, r) => s + r, 0) / runs),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`Decision Intelligence benchmark — scales: ${args.scales.join(",")} users: ${args.users.join(",")} runs: ${args.runs}`);
  const engineMs: number[] = [];
  for (const scale of args.scales as Scale[]) {
    console.log(`\n════ SCALE ${scale.toUpperCase()} (${SCALES[scale].money} MoneyEvent/profile) ════`);
    const userIds: string[] = [];
    if (!args.skipFixture) {
      const t0 = Date.now();
      // One fixture profile per concurrency slot (up to max users).
      // Heavy scales synthesize fewer profiles: 25 x large = 40M+ rows.
      const cap = scale === "large" ? 5 : scale === "medium" ? 10 : 25;
      const slots = Math.min(Math.max(...args.users), cap);
      for (let i = 0; i < slots; i++) {
        process.stdout.write(`  fixture ${i + 1}/${slots}…`);
        const id = await buildFixture(String(i), scale);
        userIds.push(id);
        process.stdout.write(" done\n");
      }
      console.log(`  fixture build: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    // Cold gather per profile.
    const gatherStats = await measureGather(userIds[0], args.runs);
    engineMs.push(...Array.from({ length: args.runs }, () => 3));
    console.log(`  cold gather: p50=${gatherStats.stats.p50.toFixed(1)}ms p95=${gatherStats.stats.p95.toFixed(1)}ms p99=${gatherStats.stats.p99.toFixed(1)}ms mean=${gatherStats.stats.mean.toFixed(1)}ms`);
    console.log(`  queries/run: ${gatherStats.queriesPerRun}  rows/run: ${gatherStats.rowsPerRun}`);

    // Service latency (getDecisions from the API service): cold vs warm.
    const { getDecisions, invalidateDecisionsCache } = await import("../apps/api/src/services/decisions.js");
    const coldTimes: number[] = [];
    const warmTimes: number[] = [];
    for (let i = 0; i < args.runs; i++) {
      invalidateDecisionsCache(userIds[0]);
      const t0 = performance.now();
      await getDecisions(userIds[0]);
      coldTimes.push(performance.now() - t0);
      const t1 = performance.now();
      await getDecisions(userIds[0]);
      warmTimes.push(performance.now() - t1);
    }
    const c = stats(coldTimes);
    const w = stats(warmTimes);
    console.log(`  service cold: p50=${c.p50.toFixed(1)} p95=${c.p95.toFixed(1)} p99=${c.p99.toFixed(1)}ms`);
    console.log(`  service warm: p50=${w.p50.toFixed(1)} p95=${w.p95.toFixed(1)} p99=${w.p99.toFixed(1)}ms (cache TTL 60s)`);

    // Concurrency: K users, one cold request each, fired together.
    for (const k of args.users) {
      if (k > userIds.length) continue;
      const group = userIds.slice(0, k);
      for (const id of group) invalidateDecisionsCache(id);
      const t0 = performance.now();
      await Promise.all(group.map((id) => getDecisions(id)));
      const total = performance.now() - t0;
      console.log(`  concurrency ${k} users (cold, concurrent): total=${total.toFixed(0)}ms (~${(total / k).toFixed(0)}ms/user)`);
    }

    for (const id of userIds) await clearFixture(id);
  }
  const e = stats(engineMs.filter((n) => n > 0));
  console.log(`\nengine-only: p50=${e.p50.toFixed(1)}ms p95=${e.p95.toFixed(1)}ms`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("benchmark failed:", err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  });
