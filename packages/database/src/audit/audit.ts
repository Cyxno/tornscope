import { getPrismaClient } from "../client.js";
import { LOG_CATEGORY_ROUTES } from "@tornscope/shared";

/**
 * Developer audit: data-health report over the collected history.
 *
 *   pnpm torn:audit   (DATABASE_URL must point at the instance)
 *
 * Reports, per user (real vs demo kept apart):
 * - record counts per table
 * - sync run outcomes + last errors per resource
 * - money ledger direction split (transfers must not inflate income/expense)
 * - unknown Torn log categories grouped by frequency (nothing is silently
 *   discarded — they all land on the timeline; this surfaces what we do not
 *   yet structure) and malformed rows (missing raw payloads).
 */

const TABLES = [
  ["TornAccount", "tornAccount"],
  ["ApiCredential", "apiCredential"],
  ["SyncState", "syncState"],
  ["SyncRun", "syncRun"],
  ["UserSnapshot", "userSnapshot"],
  ["NetworthSnapshot", "networthSnapshot"],
  ["PersonalStatSnapshot", "personalStatSnapshot"],
  ["DrugEvent", "drugEvent"],
  ["RehabEvent", "rehabEvent"],
  ["TravelEvent", "travelEvent"],
  ["TravelItemEvent", "travelItemEvent"],
  ["MoneyEvent", "moneyEvent"],
  ["TimelineEvent", "timelineEvent"],
] as const;

function routesFor(categoryTitle: string): string | null {
  const t = categoryTitle.toLowerCase();
  for (const [route, keywords] of Object.entries(LOG_CATEGORY_ROUTES)) {
    if (keywords.some((kw) => t.includes(kw))) return route;
  }
  return null;
}

async function main(): Promise<void> {
  const db = getPrismaClient();

  const users = await db.user.findMany({
    select: { id: true, displayName: true, isDemo: true },
    orderBy: [{ isDemo: "asc" }, { createdAt: "asc" }],
  });

  console.log("\n=== TornScope data audit ===\n");

  for (const user of users) {
    const label = user.isDemo ? "DEMO" : "REAL";
    console.log(`--- user ${user.id} [${label}] "${user.displayName}" ---`);

    for (const [table, model] of TABLES) {
      // @ts-expect-error dynamic model access on a closed delegate set
      const count = await db[model].count({ where: { userId: user.id } });
      console.log(`${table.padEnd(22)} ${String(count).padStart(8)}`);
    }

    // Sync run outcomes
    const runs = await db.syncRun.groupBy({
      by: ["resource", "status"],
      where: { userId: user.id },
      _count: { _all: true },
      _sum: { recordsCollected: true },
    });
    if (runs.length > 0) {
      console.log("\n  sync runs:");
      for (const r of runs.sort((a, b) => a.resource.localeCompare(b.resource))) {
        console.log(
          `    ${r.resource.padEnd(15)} ${r.status.padEnd(8)} runs=${String(r._count._all).padStart(5)} records=${String(r._sum.recordsCollected ?? 0)}`
        );
      }
    }

    const failed = await db.syncState.findMany({
      where: { userId: user.id, errorMessage: { not: null } },
      select: { resource: true, errorMessage: true, recordsCollected: true, lastSuccessAt: true },
    });
    for (const f of failed) {
      console.log(`    ! ${f.resource}: ${f.errorMessage?.slice(0, 120)}`);
    }

    // Money direction split (transfers excluded from income/expense totals)
    const money = await db.moneyEvent.groupBy({
      by: ["direction"],
      where: { userId: user.id },
      _count: { _all: true },
      _sum: { amount: true },
    });
    if (money.length > 0) {
      console.log("\n  money ledger by direction:");
      for (const m of money) {
        console.log(`    ${m.direction.padEnd(8)} n=${String(m._count._all).padStart(6)} sum=${m._sum.amount ?? 0n}`);
      }
    }

    // Unknown / unmapped log categories (frequency grouped)
    const timeline = await db.timelineEvent.findMany({
      where: { userId: user.id, type: "log" },
      select: { category: true, metadata: true },
    });
    const unknown = new Map<string, number>();
    let malformed = 0;
    for (const row of timeline) {
      if (row.metadata === null || row.metadata === undefined) malformed += 1;
      const cat = row.category ?? "(none)";
      if (!routesFor(cat)) unknown.set(cat, (unknown.get(cat) ?? 0) + 1);
    }
    if (unknown.size > 0) {
      console.log("\n  unstructured log categories (on timeline, not specialized):");
      for (const [cat, n] of [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
        console.log(`    ${n.toString().padStart(6)}  ${cat}`);
      }
    }
    if (malformed > 0) console.log(`  malformed timeline rows (raw missing): ${malformed}`);
    console.log("");
  }

  console.log("=== end audit ===\n");
  process.exit(0);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("audit failed:", err);
    process.exit(1);
  });
