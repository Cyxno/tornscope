import { readFileSync } from "node:fs";
import { Queue } from "bullmq";
import { buildSyncJobId, SYNC_JOB_NAME, SYNC_QUEUE, type SyncResource } from "../packages/shared/src/index.js";
import { getPrismaClient } from "../packages/database/src/index.js";

/**
 * Analytics backfill runner (2.1.0) — status & (re)start of the historical
 * log walk, operator-side. Runs against DATABASE_URL + REDIS_URL like every
 * other repo CLI (inside the compose network that is the default .env; from
 * the host, point DATABASE_URL at the published Postgres port first).
 *
 *   pnpm backfill status [--user <id|email|tornId>]
 *   pnpm backfill start  [--user <id|email|tornId>] [--deep]
 *
 * - status: read-only per-resource coverage report (cursor window, deepest
 *   observed source row, stop reason, per-category detail for log walks).
 * - start:  enqueue the historical resources for the existing worker — the
 *   SAME rate-limited, resumable, dedupe-safe pipeline the scheduler uses.
 *   No Torn calls happen in this process and no second worker is started.
 * - --deep: additionally reset the cursors of non-running historical
 *   resources so the next walk re-runs the initial-window path
 *   (TORN_SYNC_INITIAL_HISTORY_DAYS) instead of stopping at the old
 *   watermark. Re-walking is idempotent: unique (user, source, source_ref)
 *   upserts make duplicate ingestion impossible.
 *
 * The runner is NOT meant to be babysat: `start` returns after enqueueing,
 * the worker continues on its own, and `status` reports progress afterwards.
 * Depth is ultimately bounded by Torn's own log retention — rows Torn has
 * pruned are unrecoverable (docs/ANALYTICS.md).
 */

/** Resources whose history feeds deep analytics (log walks + feeds). */
const BACKFILL_RESOURCES: SyncResource[] = ["drugs", "travel", "rehab", "money_logs", "events", "attacks"];

const STOP_LABELS: Record<string, string> = {
  history_boundary_reached: "complete — reached the oldest history Torn still serves",
  source_exhausted: "complete — source fully walked",
  max_pages: "incomplete — page budget hit this run (resumes automatically)",
  cursor_stalled: "incomplete — cursor stalled (will retry)",
  api_error: "incomplete — last walk errored (will retry)",
};

function parseArgs(argv: string[]): { command: string; user?: string; deep: boolean } {
  const args = { command: "status", deep: false } as { command: string; user?: string; deep: boolean };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "status" || argv[i] === "start") args.command = argv[i];
    else if (argv[i] === "--user") args.user = argv[++i];
    else if (argv[i] === "--deep") args.deep = true;
  }
  return args;
}

/**
 * Operator convenience only: when the shell has no DATABASE_URL (host-side
 * run), fall back to the repo .env the same way the compose stack defines
 * it. Inside a container the real env always wins — nothing here overrides
 * an existing value.
 */
function loadRepoEnvFallback(): void {
  if (process.env.DATABASE_URL && process.env.REDIS_URL) return;
  try {
    const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      if (key && value && !process.env[key]) process.env[key] = value;
    }
  } catch {
    // No .env — the Prisma error will tell the operator what is missing.
  }
}

async function resolveUser(db: ReturnType<typeof getPrismaClient>, selector?: string) {
  if (selector) {
    const byId = await db.user.findUnique({ where: { id: selector } });
    if (byId) return byId;
    const all = await db.user.findMany({ include: { tornAccount: true } });
    const byName = all.find((u) => u.tornAccount?.tornId === Number(selector) || (u.email === selector));
    if (byName) return byName;
    throw new Error(`no user matches "${selector}"`);
  }
  const owners = await db.user.findMany({
    where: { isDemo: false, apiCredential: { is: { revokedAt: null } } },
    include: { tornAccount: true },
    orderBy: { createdAt: "asc" },
  });
  if (owners.length === 0) throw new Error("no real (non-demo) user with an active API key exists");
  if (owners.length > 1) {
    console.log("Multiple real users with active keys; pick one with --user <id|email|tornId>:");
    for (const u of owners) console.log(`  ${u.id}  ${u.displayName}  tornId=${u.tornAccount?.tornId ?? "?"}`);
    process.exit(1);
  }
  return owners[0]!;
}

function iso(ts: bigint | null | undefined): string {
  if (ts === null || ts === undefined) return "—";
  return new Date(Number(ts) * 1000).toISOString().slice(0, 16) + "Z";
}

function dateOnly(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 16) + "Z" : "—";
}

async function statusForUser(userId: string): Promise<void> {
  const db = getPrismaClient();
  const [states, categories] = await Promise.all([
    db.syncState.findMany({ where: { userId }, orderBy: { resource: "asc" } }),
    db.syncCategoryState.findMany({ where: { userId }, orderBy: [{ resource: "asc" }, { categoryId: "asc" }] }),
  ]);
  const archive = await db.timelineEvent.groupBy({
    by: ["type"],
    where: { userId },
    _count: { _all: true },
  });
  const logRows = archive.find((a) => a.type === "log")?._count._all ?? 0;

  console.log(`\nArchive: ${logRows.toLocaleString()} raw log rows stored`);
  console.log("".padEnd(104, "-"));
  console.log(
    "resource".padEnd(14),
    "status".padEnd(18),
    "cursor window (oldest observed → watermark)".padEnd(48),
    "stop reason"
  );
  console.log("".padEnd(104, "-"));
  for (const state of states) {
    const backfillResource = BACKFILL_RESOURCES.includes(state.resource as SyncResource);
    const marker = backfillResource ? "*" : " ";
    const window = `${iso(state.sourceEarliestAt)} → ${iso(state.lastTimestamp)}`;
    const label = STOP_LABELS[state.stopReason ?? ""] ?? state.stopReason ?? "—";
    console.log(
      `${state.resource}${marker}`.padEnd(14),
      state.status.padEnd(18),
      window.padEnd(48),
      state.status === "idle" ? label : "—"
    );
  }
  const logStates = states.filter((s) => BACKFILL_RESOURCES.includes(s.resource as SyncResource));
  const withCategories = logStates.filter((s) => categories.some((c) => c.resource === s.resource));
  if (withCategories.length > 0) {
    console.log("\nPer-category walk detail (* = historical analytics resource):");
    for (const resource of ["drugs", "travel", "rehab", "money_logs"] as const) {
      const rows = categories.filter((c) => c.resource === resource);
      const active = rows.filter((c) => c.lastTimestamp !== null);
      const deepest = rows.filter((c) => c.sourceEarliestAt !== null);
      if (rows.length === 0) continue;
      console.log(
        `  ${resource.padEnd(12)} categories=${String(rows.length).padEnd(4)} walked=${String(active.length).padEnd(4)}` +
          ` deepest=${deepest.length > 0 ? iso(deepest.reduce((acc, c) => (Number(c.sourceEarliestAt) < Number(acc) ? c.sourceEarliestAt : acc), deepest[0]!.sourceEarliestAt)) : "—"}`
      );
    }
  }
  console.log(`\n${"*"} = deep-analytics historical resource. "start" enqueues these; depth is bounded by Torn's log retention.`);
}

async function startForUser(userId: string, deep: boolean): Promise<void> {
  const db = getPrismaClient();
  const credential = await db.apiCredential.findUnique({ where: { userId } });
  if (!credential || credential.revokedAt) {
    throw new Error("this user has no active API key — nothing to backfill");
  }
  const states = await db.syncState.findMany({
    where: { userId, resource: { in: BACKFILL_RESOURCES } },
  });
  const running = states.filter((s) => s.status === "running").map((s) => s.resource);
  if (running.length > 0) {
    throw new Error(`already running: ${running.join(", ")} — wait for the walk to finish (claim lock is authoritative)`);
  }

  if (deep) {
    const result = await db.syncState.updateMany({
      where: { userId, resource: { in: BACKFILL_RESOURCES }, status: { not: "running" } },
      data: { lastTimestamp: null, cursor: null, nextRunAt: new Date(), stopReason: null },
    });
    // Category cursors reset too: the category walk plan seeds from them.
    await db.syncCategoryState.updateMany({
      where: { userId, resource: { in: BACKFILL_RESOURCES } },
      data: { lastTimestamp: null, nextRunAt: new Date() },
    });
    console.log(`deep reset: ${result.count} resource cursors cleared — the next walk re-enters initial-window mode`);
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required to enqueue sync jobs");
  const queue = new Queue(SYNC_QUEUE, { connection: { url: redisUrl } });
  try {
    for (const resource of BACKFILL_RESOURCES) {
      await queue.add(
        SYNC_JOB_NAME,
        { userId, resource, manual: true },
        { jobId: buildSyncJobId(userId, resource, `backfill${Date.now()}`) }
      );
      console.log(`queued: ${resource}`);
    }
  } finally {
    await queue.close();
  }
  console.log("\nAll historical resources queued. The existing worker walks them serially under its rate limiter");
  console.log("and page budget — check progress later with: pnpm backfill status");
}

async function main(): Promise<void> {
  loadRepoEnvFallback();
  const args = parseArgs(process.argv);
  const db = getPrismaClient();
  try {
    const user = await resolveUser(db, args.user);
    console.log(`TornScope analytics backfill — ${args.command} for ${user.displayName} (${user.id}${user.isDemo ? ", demo" : ""})`);
    if (user.isDemo) throw new Error("the shared demo profile has no Torn history to backfill");
    if (args.command === "status") await statusForUser(user.id);
    else await startForUser(user.id, args.deep);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(`backfill ${process.argv[2] ?? "status"} failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
