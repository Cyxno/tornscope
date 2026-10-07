import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { bigintToNumber, getPrismaClient } from "../client.js";

/**
 * Storage-to-product utilization audit (2.6.0) — READ-ONLY.
 *
 *   pnpm --filter @tornscope/database audit:data-utilization [--json] [--matrix]
 *
 * Classifies every persistent dataset against the storage-to-product contract:
 *
 *   A = productively used (read by API/analytics/UI)
 *   B = intentionally retained raw/history only (documented purpose)
 *   C = recognized but not yet productized (value present, no consumer)
 *   D = ambiguous (no proven semantics; never guessed)
 *   E = obsolete/unnecessary (dead-data candidate — reported, never dropped here)
 *
 * Sources combined:
 *   1. SQL row counts + freshness + per-column fill rates (bounded aggregates)
 *   2. Structural fingerprints of the JSON snapshot blobs (paths/presence only
 *      — never values)
 *   3. A static consumer scan: how often each model/field is referenced by the
 *      API/analytics/worker/web source trees
 *
 * No values are logged — structural fingerprints only (2.6.0 FASE 1 rule).
 */

const JSON_MODE = process.argv.includes("--json");
const MATRIX = process.argv.includes("--matrix");

// Resolved from the REPO root: the script's cwd is the package directory.
const REPO_ROOT = join(import.meta.dirname ?? ".", "..", "..", "..", ".."); // src/audit -> src -> package -> packages -> repo
const SRC_ROOTS = ["apps/api/src", "apps/worker/src", "apps/web/src", "packages/analytics/src", "packages/shared/src"].map((p) => join(REPO_ROOT, p));

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) listFiles(full, out);
    else if (/\.(ts|svelte|js)$/.test(entry)) out.push(full);
  }
  return out;
}

let srcFiles: string[] | null = null;
function consumerScan(token: string): number {
  if (srcFiles === null) {
    srcFiles = [];
    for (const root of SRC_ROOTS) {
      try {
        srcFiles.push(...listFiles(root));
      } catch {
        // missing tree (e.g. web not present) — skip
      }
    }
  }
  let count = 0;
  for (const file of srcFiles) {
    const content = readFileSync(file, "utf8");
    let idx = content.indexOf(token);
    while (idx !== -1) {
      count += 1;
      idx = content.indexOf(token, idx + token.length);
    }
  }
  return count;
}

interface TableAudit {
  model: string;
  rows: number;
  oldest: string | null;
  newest: string | null;
  users: number;
  codeReferences: number;
  status: "A" | "B" | "C" | "D" | "E";
  note: string;
}

const TABLES: Array<{ model: string; timeColumn: string; note: string; status: TableAudit["status"]; hasUsers?: boolean }> = [
  { model: "MoneyEvent", timeColumn: "occurredAt", note: "cash ledger — canonical P/L source", status: "A" },
  { model: "TimelineEvent", timeColumn: "occurredAt", note: "raw log archive — history + repair source (B by design)", status: "A" },
  { model: "ActivityEvent", timeColumn: "occurredAt", note: "semantic activity view", status: "A" },
  { model: "CrimeEvent", timeColumn: "occurredAt", note: "crime attempts; skill bookkeeping stays timeline-only (B)", status: "A" },
  { model: "CombatEvent", timeColumn: "occurredAt", note: "combat ledger view", status: "A" },
  { model: "DrugEvent", timeColumn: "occurredAt", note: "drug use ledger", status: "A" },
  { model: "ConsumptionEvent", timeColumn: "occurredAt", note: "consumption economy", status: "A" },
  { model: "RehabEvent", timeColumn: "occurredAt", note: "rehab visits", status: "A" },
  { model: "TravelEvent", timeColumn: "departedAt", note: "trips", status: "A" },
  { model: "TravelItemEvent", timeColumn: "occurredAt", note: "abroad purchases", status: "A" },
  { model: "TravelTransition", timeColumn: "occurredAt", note: "travel transitions", status: "A" },
  { model: "PersonalStatSnapshot", timeColumn: "capturedAt", note: "personalstats history — counters productized 2.6.0", status: "A" },
  { model: "NetworthSnapshot", timeColumn: "capturedAt", note: "networth history — liabilities productized 2.6.0", status: "A" },
  { model: "BarsSnapshot", timeColumn: "capturedAt", note: "energy/happy series", status: "A" },
  { model: "UserSnapshot", timeColumn: "capturedAt", note: "level/rank/faction history — milestones 2.6.0", status: "A" },
  { model: "FactionSnapshot", timeColumn: "capturedAt", note: "faction history — trend 2.6.0", status: "A" },
  { model: "FactionBalanceSnapshot", timeColumn: "capturedAt", note: "faction balance history", status: "A" },
  { model: "FactionMembership", timeColumn: "joinedAt", note: "membership records", status: "A" },
  { model: "FactionArmoryEvent", timeColumn: "occurredAt", note: "xanax funding + sponsored-item provenance", status: "A" },
  { model: "FactionChain", timeColumn: "startedAt", note: "chain state", status: "A" },
  { model: "OrganizedCrime", timeColumn: "createdAt", note: "OC state", status: "A" },
  { model: "RankedWar", timeColumn: "startedAt", note: "ranked wars", status: "A", hasUsers: false },
  { model: "TornItemCatalog", timeColumn: "updatedAt", note: "catalog prices — valuation authority", status: "A", hasUsers: false },
  { model: "SyncState", timeColumn: "lastTimestamp", note: "sync cursors", status: "A", hasUsers: false },
  { model: "AppSetting", timeColumn: "updatedAt", note: "KV store (prefs, watermarks, decision state)", status: "A" },
];

/** Columns worth a fill-rate check — stored-but-possibly-unused candidates. */
const FIELD_CHECKS: Array<{ model: string; column: string; note: string; kind: "numeric" | "text" }> = [
  { model: "NetworthSnapshot", column: "loans", note: "liabilities — productized 2.6.0 (balance sheet)", kind: "numeric" },
  { model: "NetworthSnapshot", column: "unpaidFees", note: "liabilities — productized 2.6.0 (balance sheet)", kind: "numeric" },
  { model: "FactionSnapshot", column: "respect", note: "faction trend — productized 2.6.0", kind: "numeric" },
  { model: "FactionSnapshot", column: "members", note: "faction trend — productized 2.6.0", kind: "numeric" },
  { model: "UserSnapshot", column: "rank", note: "rank milestones — 2.6.0", kind: "text" },
  { model: "UserSnapshot", column: "factionId", note: "faction transitions — 2.6.0", kind: "numeric" },
  { model: "MoneyEvent", column: "subcategory", note: "transfer subtypes (vault deposit/withdraw, ammo type)", kind: "text" },
  { model: "CrimeEvent", column: "skillGain", note: "crime skill payloads live in TimelineEvent bookkeeping — column expected unused (B)", kind: "numeric" },
];

async function main(): Promise<void> {
  const db = getPrismaClient();

  const tables: TableAudit[] = [];
  for (const t of TABLES) {
    try {
      const userSelect = t.hasUsers === false ? "0" : 'count(DISTINCT "userId")';
      const rowsRes = (await db.$queryRawUnsafe<Array<{ n: bigint | number; users: bigint | number; oldest: unknown; newest: unknown }>>(
        `SELECT count(*)::bigint AS n, ${userSelect}::bigint AS users, min("${t.timeColumn}") AS oldest, max("${t.timeColumn}") AS newest FROM "${t.model}"`
      )) as Array<{ n: bigint | number; users: bigint | number; oldest: unknown; newest: unknown }>;
      const row = rowsRes[0];
      const refs = consumerScan(t.model);
      const asDay = (v: unknown): string | null => {
        if (v === null || v === undefined) return null;
        const d = v instanceof Date ? v : new Date(typeof v === "bigint" ? Number(v) : (v as string | number));
        return Number.isNaN(d.getTime()) || d.getFullYear() < 2001 ? null : d.toISOString().slice(0, 10);
      };
      tables.push({
        model: t.model,
        rows: Number(row?.n ?? 0),
        oldest: asDay(row?.oldest),
        newest: asDay(row?.newest),
        users: Number(row?.users ?? 0),
        codeReferences: refs,
        status: refs === 0 ? "D" : t.status,
        note: t.note,
      });
    } catch (err) {
      tables.push({ model: t.model, rows: -1, oldest: null, newest: null, users: -1, codeReferences: -1, status: "D", note: `audit error: ${(err as Error).message}` });
    }
  }

  // Field fill-rates (nonzero for numeric, non-empty for text columns).
  const fields: Array<{ model: string; column: string; nonZero: number; total: number; rate: number; codeReferences: number; note: string }> = [];
  for (const f of FIELD_CHECKS) {
    try {
      const nonzero = f.kind === "numeric" ? `"${f.column}" IS NOT NULL AND "${f.column}" <> 0` : `"${f.column}" IS NOT NULL AND "${f.column}" <> ''`;
      const res = (await db.$queryRawUnsafe<Array<{ nz: bigint | number; total: bigint | number }>>(
        `SELECT count(*) FILTER (WHERE ${nonzero})::bigint AS nz, count(*)::bigint AS total FROM "${f.model}"`
      )) as Array<{ nz: bigint | number; total: bigint | number }>;
      const nz = Number(res[0]?.nz ?? 0);
      const total = Number(res[0]?.total ?? 0);
      fields.push({
        model: f.model,
        column: f.column,
        nonZero: nz,
        total,
        rate: total > 0 ? nz / total : 0,
        codeReferences: consumerScan(`${f.model.replace(/([a-z])([A-Z])/g, "$1.$2").toLowerCase()}.${f.column.toLowerCase()}`) + consumerScan(f.column),
        note: f.note,
      });
    } catch (err) {
      fields.push({ model: f.model, column: f.column, nonZero: -1, total: -1, rate: -1, codeReferences: -1, note: `audit error: ${(err as Error).message}` });
    }
  }

  // JSON blob structural fingerprints (presence counts only).
  const jsonPaths: Array<{ model: string; path: string; presence: number; total: number; note: string }> = [];
  const pathChecks: Array<{ model: string; pathSql: string; path: string; note: string }> = [
    { model: "PersonalStatSnapshot", pathSql: "crimes.total", path: "crimes.total", note: "crime counter — productized 2.6.0" },
    { model: "PersonalStatSnapshot", pathSql: "other.awards", path: "other.awards", note: "awards counter — productized 2.6.0" },
    { model: "PersonalStatSnapshot", pathSql: "jobs.trains_received", path: "jobs.trains_received", note: "trains counter — productized 2.6.0" },
    { model: "PersonalStatSnapshot", pathSql: "networth.total", path: "networth.total", note: "REDUNDANT with NetworthSnapshot (B — retained raw)" },
    { model: "PersonalStatSnapshot", pathSql: "investments.bank.total", path: "investments.bank.total", note: "bank-investment gauges — not productized (C, gauge semantics)" },
    { model: "FactionSnapshot", pathSql: "raw.respect", path: "raw.respect", note: "raw mirror sparse/null — the respect COLUMN is the authority (productized 2.6.0)" },
    { model: "UserSnapshot", pathSql: "raw.rank.name", path: "raw.rank.name", note: "rank detail — level/rank columns productized (B)" },
  ];
  for (const p of pathChecks) {
    try {
      const parts = p.pathSql.split(".");
      let expr = `"stats"`;
      if (p.model !== "PersonalStatSnapshot") expr = `COALESCE(raw, '{}'::jsonb)`;
      const chain = [`jsonb_strip_nulls(COALESCE(${expr}, '{}'::jsonb))`];
      for (const part of parts.slice(0, -1)) chain.push(`-> '${part}'`);
      const res = (await db.$queryRawUnsafe<Array<{ n: bigint | number; total: bigint | number }>>(
        `SELECT count(*) FILTER (WHERE ${chain.join("")} ->> '${parts[parts.length - 1]}' IS NOT NULL)::bigint AS n, count(*)::bigint AS total FROM "${p.model}"`
      )) as Array<{ n: bigint | number; total: bigint | number }>;
      jsonPaths.push({ model: p.model, path: p.path, presence: Number(res[0]?.n ?? 0), total: Number(res[0]?.total ?? 0), note: p.note });
    } catch (err) {
      jsonPaths.push({ model: p.model, path: p.path, presence: -1, total: -1, note: `audit error: ${(err as Error).message}` });
    }
  }

  // Money transfer coverage (2.6.0): vault + ammo rows now in the ledger?
  let transfers = { vault: 0, ammo: 0, timelineOnly: 0 };
  try {
    const res = (await db.$queryRawUnsafe<Array<{ vault: bigint | number; ammo: bigint | number; timeline_only: bigint | number }>>(
      `SELECT
         (SELECT count(*) FROM "MoneyEvent" WHERE category = 'vault')::bigint AS vault,
         (SELECT count(*) FROM "MoneyEvent" WHERE category = 'ammo')::bigint AS ammo,
         (SELECT count(*) FROM "TimelineEvent" te WHERE te.category = 'Vault' AND te.type = 'log'
            AND NOT EXISTS (SELECT 1 FROM "MoneyEvent" me WHERE me."sourceRef" = te."sourceRef" AND me."userId" = te."userId"))::bigint AS timeline_only`
    )) as Array<{ vault: bigint | number; ammo: bigint | number; timeline_only: bigint | number }>;
    transfers = { vault: Number(res[0]?.vault ?? 0), ammo: Number(res[0]?.ammo ?? 0), timelineOnly: Number(res[0]?.timeline_only ?? 0) };
  } catch {
    // table missing on old DBs — leave zeros
  }

  const payload = {
    generatedAt: Math.floor(Date.now() / 1000),
    provenance: "read-only structural audit; JSON fingerprints carry paths/presence only, never values",
    tables,
    fields,
    jsonPaths,
    moneyTransfers: transfers,
    deadDataCandidates: fields.filter((f) => f.nonZero === 0).map((f) => ({ model: f.model, column: f.column, reason: "stored but always null/zero in this archive", safeToRemoveLater: false })),
  };

  if (JSON_MODE) {
    console.log(JSON.stringify(payload, null, 1));
  } else {
    console.log("=== Storage-to-product utilization audit (read-only) ===");
    console.log("\nTABLES (rows | users | span | code refs | status)");
    for (const t of tables) {
      console.log(
        `  ${t.model.padEnd(24)} ${String(t.rows).padStart(8)} | ${String(t.users).padStart(3)} | ${t.oldest ?? "?"}..${t.newest ?? "?"} | refs=${String(t.codeReferences).padStart(3)} | ${t.status}  ${t.note}`
      );
    }
    console.log("\nFIELD FILL RATES (nonzero/total | code refs)");
    for (const f of fields) {
      console.log(`  ${f.model}.${f.column.padEnd(14)} ${String(f.nonZero).padStart(6)}/${String(f.total).padEnd(8)} (${(f.rate * 100).toFixed(1)}%) | refs=${String(f.codeReferences).padStart(3)}  ${f.note}`);
    }
    console.log("\nJSON PATH PRESENCE (paths only — never values)");
    for (const p of jsonPaths) {
      console.log(`  ${p.model.padEnd(24)} ${p.path.padEnd(28)} ${String(p.presence).padStart(6)}/${String(p.total).padEnd(8)}  ${p.note}`);
    }
    console.log(`\nMONEY TRANSFER COVERAGE (2.6.0)`);
    console.log(`  vault rows in ledger: ${transfers.vault} · ammo rows in ledger: ${transfers.ammo} · vault logs still timeline-only: ${transfers.timelineOnly}`);
    const dead = payload.deadDataCandidates;
    if (dead.length > 0) {
      console.log("\nDEAD-DATA CANDIDATES (reported only — never auto-removed)");
      for (const d of dead) console.log(`  ${d.model}.${d.column}: ${d.reason}`);
    }
  }
  await db.$disconnect();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
