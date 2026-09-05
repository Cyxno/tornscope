import { getPrismaClient, bigintToNumber } from "../client.js";
import { routeLog, moneyPlanFor, travelTransitionFor } from "../normalizers/titles.js";

/**
 * Developer audit: data-health + domain-coverage report over the collected
 * history.
 *
 *   pnpm torn:audit [--user <id|email|tornId>]   (DATABASE_URL must point at
 *                                                 the instance)
 *
 * Per user (real vs demo kept apart):
 * - record counts per table
 * - sync run outcomes + last errors per resource
 * - DOMAIN COVERAGE: raw candidate logs vs structured events per domain
 *   (money / rehab / travel / drugs). Coverage is only computed when the
 *   candidate set is known from real stored logs — never invented.
 * - travel pipeline detail: transitions by type, assembled trips, unmatched
 * - money ledger direction split (neutral + unknown never enter P&L)
 * - unknown log review: top-20 timeline-only (category, title) pairs with a
 *   sanitized sample payload
 */

function parseArgs(argv: string[]): { user?: string } {
  const args: { user?: string } = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--user") args.user = argv[++i];
  }
  return args;
}

async function resolveUser(db: ReturnType<typeof getPrismaClient>, selector?: string) {
  const users = await db.user.findMany({
    select: { id: true, displayName: true, isDemo: true, tornAccount: { select: { tornId: true } } },
    orderBy: [{ isDemo: "asc" }, { createdAt: "asc" }],
  });
  if (!selector) return users;
  const match = users.find(
    (u) =>
      u.id === selector ||
      u.displayName.toLowerCase() === selector.toLowerCase() ||
      u.tornAccount?.tornId === Number(selector)
  );
  if (!match) throw new Error(`no user matches "${selector}"`);
  return [match];
}

function sanitizePayload(data: unknown): string {
  if (data === null || data === undefined) return "(no payload)";
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return "(unserializable payload)";
  }
  return json.length > 160 ? `${json.slice(0, 157)}...` : json;
}

async function main(): Promise<void> {
  const { user: userSelector } = parseArgs(process.argv);
  const db = getPrismaClient();

  const users = await resolveUser(db, userSelector);

  console.log("\n=== TornScope data audit ===\n");

  for (const user of users) {
    const label = user.isDemo ? "DEMO" : "REAL";
    console.log(`--- user ${user.id} [${label}] "${user.displayName}" ---`);

    const [
      tornAccount, credentials, syncStates, syncRuns, userSnapshots, networth,
      personalStats, drugs, rehab, travel, travelItems, transitions, money, timeline,
    ] = await Promise.all([
      db.tornAccount.count({ where: { userId: user.id } }),
      db.apiCredential.count({ where: { userId: user.id } }),
      db.syncState.count({ where: { userId: user.id } }),
      db.syncRun.count({ where: { userId: user.id } }),
      db.userSnapshot.count({ where: { userId: user.id } }),
      db.networthSnapshot.count({ where: { userId: user.id } }),
      db.personalStatSnapshot.count({ where: { userId: user.id } }),
      db.drugEvent.count({ where: { userId: user.id } }),
      db.rehabEvent.count({ where: { userId: user.id } }),
      db.travelEvent.count({ where: { userId: user.id } }),
      db.travelItemEvent.count({ where: { userId: user.id } }),
      db.travelTransition.count({ where: { userId: user.id } }),
      db.moneyEvent.count({ where: { userId: user.id } }),
      db.timelineEvent.count({ where: { userId: user.id } }),
    ]);

    const rows: Array<[string, number]> = [
      ["TornAccount", tornAccount],
      ["ApiCredential", credentials],
      ["SyncState", syncStates],
      ["SyncRun", syncRuns],
      ["UserSnapshot", userSnapshots],
      ["NetworthSnapshot", networth],
      ["PersonalStatSnapshot", personalStats],
      ["DrugEvent", drugs],
      ["RehabEvent", rehab],
      ["TravelEvent", travel],
      ["TravelItemEvent", travelItems],
      ["TravelTransition", transitions],
      ["MoneyEvent", money],
      ["TimelineEvent", timeline],
    ];
    for (const [table, count] of rows) console.log(`${table.padEnd(22)} ${String(count).padStart(8)}`);

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
      select: { resource: true, errorMessage: true },
    });
    for (const f of failed) {
      console.log(`    ! ${f.resource}: ${f.errorMessage?.slice(0, 120)}`);
    }

    /* ------------------------------------------------------------------ */
    /* Domain coverage: candidate raw logs vs structured events            */
    /* ------------------------------------------------------------------ */

    const logRows = await db.timelineEvent.findMany({
      where: { userId: user.id, type: "log" },
      select: { category: true, title: true, metadata: true },
    });

    interface TitleStat {
      category: string;
      title: string;
      count: number;
      route: string;
      classified: boolean;
      sample: string;
      rawData: unknown;
    }
    const byTitle = new Map<string, TitleStat>();
    for (const row of logRows) {
      const category = row.category ?? "(none)";
      const raw = row.metadata as { title?: string; data?: unknown } | null;
      const title = raw?.title ?? row.title ?? "(unknown)";
      const key = `${category}||${title}`;
      const stat = byTitle.get(key) ?? { category, title, count: 0, route: routeLog(category, title), classified: false, sample: sanitizePayload(raw?.data), rawData: raw?.data ?? {} };
      stat.count += 1;
      byTitle.set(key, stat);
    }
    const stats = [...byTitle.values()].sort((a, b) => b.count - a.count);

    // Money plan classification per title (skip = definitively not a movement).
    for (const stat of stats) {
      if (stat.route === "money") {
        const plan = moneyPlanFor(stat.category, stat.title);
        stat.classified = !!plan && !plan.skip;
      }
    }

    const candidates = {
      money: stats.filter((s) => s.route === "money" && s.classified).reduce((n, s) => n + s.count, 0),
      rehab: stats.filter((s) => s.route === "rehab").reduce((n, s) => n + s.count, 0),
      drugs: stats.filter((s) => s.route === "drugs").reduce((n, s) => n + s.count, 0),
      travelTransitions: stats
        .filter((s) => s.route === "travel" && travelTransitionFor(s.title, (s.rawData ?? {}) as Record<string, unknown>) !== null)
        .reduce((n, s) => n + s.count, 0),
    };

    const pct = (part: number, whole: number): string =>
      whole === 0 ? "n/a (no candidate logs)" : `${Math.min(100, Math.round((part / whole) * 100))}%`;

    const moneyClassified = await db.moneyEvent.groupBy({
      by: ["direction"],
      where: { userId: user.id },
      _count: { _all: true },
      _sum: { amount: true },
    });
    const moneyMapped = moneyClassified.filter((d) => d.direction !== "unknown").reduce((n, d) => n + d._count._all, 0);
    const tripsCompleted = await db.travelEvent.count({ where: { userId: user.id, source: "trip" } });
    const transitionsByType = await db.travelTransition.groupBy({
      by: ["type"],
      where: { userId: user.id },
      _count: { _all: true },
    });

    console.log("\n  domain coverage:");
    console.log(`    Money   candidates=${String(candidates.money).padStart(6)}  structured=${String(moneyMapped).padStart(6)}  coverage=${pct(moneyMapped, candidates.money)}  (unknown-direction rows excluded from coverage)`);
    console.log(`    Rehab   candidates=${String(candidates.rehab).padStart(6)}  structured=${String(rehab).padStart(6)}  coverage=${pct(rehab, candidates.rehab)}`);
    console.log(`    Drugs   candidates=${String(candidates.drugs).padStart(6)}  structured=${String(drugs).padStart(6)}  coverage=${pct(drugs, candidates.drugs)}`);
    console.log(`    Travel  transitionLogs=${String(candidates.travelTransitions).padStart(6)}  transitions=${String(transitions).padStart(6)}  trips=${tripsCompleted}  coverage=${pct(transitions, candidates.travelTransitions)}`);

    if (transitionsByType.length > 0) {
      console.log("    transitions by type:");
      for (const t of transitionsByType.sort((a, b) => a.type.localeCompare(b.type))) {
        console.log(`      ${t.type.padEnd(16)} ${String(t._count._all).padStart(6)}`);
      }
    }

    /* ------------------------------------------------------------------ */
    /* Money ledger by direction                                           */
    /* ------------------------------------------------------------------ */

    if (moneyClassified.length > 0) {
      console.log("\n  money ledger by direction (neutral/unknown never enter P&L):");
      for (const m of moneyClassified.sort((a, b) => a.direction.localeCompare(b.direction))) {
        console.log(`    ${m.direction.padEnd(8)} n=${String(m._count._all).padStart(6)} sum=${bigintToNumber(m._sum.amount ?? 0n)}`);
      }
    }

    /* ------------------------------------------------------------------ */
    /* Unmapped / timeline-only log review (top 20)                        */
    /* ------------------------------------------------------------------ */

    const unmapped = stats.filter((s) => s.route === "timeline").slice(0, 20);
    if (unmapped.length > 0) {
      console.log("\n  unmapped log titles (timeline-only, top 20 by frequency):");
      for (const u of unmapped) {
        console.log(`    ${String(u.count).padStart(6)}  [${u.category}] ${u.title}`);
        console.log(`           ${u.sample}`);
      }
    }

    const malformed = logRows.filter((r) => r.metadata === null || r.metadata === undefined).length;
    if (malformed > 0) console.log(`\n  malformed timeline rows (raw payload missing): ${malformed}`);
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
