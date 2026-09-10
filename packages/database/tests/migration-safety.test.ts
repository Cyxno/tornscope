import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * Roadmap #5 regression coverage — migration upgrade safety.
 *
 * 1. INVENTORY GUARD (always runs): every migration introduced AFTER the
 *    production 0.1.x baseline is classified. Anything matching destructive
 *    patterns fails unless explicitly allow-listed here with a written
 *    compatibility plan — "zero unexplained destructive operations".
 *
 * 2. LIVE DEPLOY CHECK (runs when TEST_DATABASE_URL points at a throwaway
 *    database): `prisma migrate deploy` must succeed against an empty DB
 *    (clean install) and a second run must be a no-op (idempotence).
 *
 * The production baseline below is the migration set applied to the live
 * production database (verified read-only via _prisma_migrations).
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../prisma/migrations", import.meta.url));

/** Migrations already applied to production 0.1.x (read-only verified). */
const PROD_BASELINE = new Set([
  "20260904000000_init",
  "20260905000000_appsetting_drop_user_fk",
  "20260905120000_travel_transitions_unknown_money",
  "20260905150000_consumption_events",
  "20260905180000_syncstate_history_coverage",
  "20260905200000_syncstate_last_walk_pages",
  "20260905210000_sync_category_state",
  "20260905223000_adaptive_category_scheduling",
  "20260905230000_crimes_combat",
  "20260906010000_faction_analytics",
  "20260906080000_faction_member_identity",
  "20260906200000_faction_armory_events",
  "20260906220000_multi_user_sessions",
  "20260907090000_torn_identity_uniqueness",
  "20260907170000_travel_xanax_category",
  "20260907200000_rehab_sessions",
  "20260907200001_container_consumption",
  "20260907213000_push_notifications",
  "20260907220000_timeline_seq",
  "20260909120000_sync_state_last_heartbeat_at",
]);

/**
 * Migrations allowed to contain destructive SQL, each with its documented
 * compatibility plan (docs/DATABASE-MIGRATIONS.md). v0.2 needs none — this
 * list exists so a FUTURE destructive migration must be explained here or
 * the suite fails.
 */
const DESTRUCTIVE_ALLOWLIST: Record<string, string> = {};

/** Destructive / compatibility-sensitive SQL patterns. */
const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\bDROP\s+TABLE\b/i, why: "drops a table" },
  { re: /\bDROP\s+COLUMN\b/i, why: "drops a column" },
  { re: /\bRENAME\s+(TABLE|COLUMN)\b/i, why: "renames a table or column" },
  { re: /\bALTER\s+COLUMN\b[^;]*\bSET\s+NOT\s+NULL\b/i, why: "tightens a column to NOT NULL (locks + old-row risk)" },
  { re: /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i, why: "rewrites a column type (full-table rewrite risk)" },
  { re: /\bTRUNCATE\b/i, why: "truncates a table" },
  { re: /\bDELETE\s+FROM\b/i, why: "deletes rows" },
];

function migrationSql(name: string): string {
  return readFileSync(`${MIGRATIONS_DIR}/${name}/migration.sql`, "utf8");
}

describe("migration upgrade safety (roadmap #5)", () => {
  const all = readdirSync(MIGRATIONS_DIR).filter((n) => /^\d{14}_/.test(n)).sort();
  const pendingSinceProd = all.filter((n) => !PROD_BASELINE.has(n));

  it("knows the production baseline — every baseline migration exists on this branch", () => {
    for (const name of PROD_BASELINE) {
      expect(all, `production has ${name} but this branch does not`).toContain(name);
    }
  });

  it("every migration after the production baseline is expand-only (or explicitly allow-listed)", () => {
    expect(pendingSinceProd.length).toBeGreaterThan(0);
    for (const name of pendingSinceProd) {
      const sql = migrationSql(name);
      for (const { re, why } of DESTRUCTIVE_PATTERNS) {
        if (re.test(sql)) {
          expect(
            DESTRUCTIVE_ALLOWLIST[name],
            `${name} ${why} — add it to DESTRUCTIVE_ALLOWLIST with a written compatibility plan, or make the migration additive`
          ).toBeTruthy();
        }
      }
    }
  });

  it("new columns since the baseline are nullable or have defaults (old rows stay safe)", () => {
    for (const name of pendingSinceProd) {
      const sql = migrationSql(name);
      const adds = [...sql.matchAll(/ALTER\s+TABLE\s+"[^"]+"\s+ADD\s+COLUMN\s+"[^"]+"\s+([A-Za-z(\s]+)(NOT NULL)?/gi)];
      for (const add of adds) {
        const hasDefault = /DEFAULT/.test(add[0]);
        const notNull = /NOT NULL/i.test(add[1] ?? "") || /NOT NULL/i.test(add[2] ?? "");
        expect(hasDefault || !notNull, `${name}: added column must be nullable or defaulted for old rows`).toBe(true);
      }
    }
  });

  it("pending migrations are documented in the inventory doc", () => {
    const doc = readFileSync(fileURLToPath(new URL("../../../docs/DATABASE-MIGRATIONS.md", import.meta.url)), "utf8");
    for (const name of pendingSinceProd) {
      expect(doc.includes(name.slice(0, 14)), `${name} should be listed in docs/DATABASE-MIGRATIONS.md`).toBe(true);
    }
  });

  describe("live deploy check (TEST_DATABASE_URL)", () => {
    const dbUrl = process.env.TEST_DATABASE_URL ?? "";
    const suite = dbUrl ? describe : describe.skip;

    suite("against a throwaway database", () => {
      const prisma = (args: string[]): string =>
        execFileSync("pnpm", ["exec", "prisma", ...args, "--schema", "packages/database/prisma/schema.prisma"], {
          env: { ...process.env, DATABASE_URL: dbUrl },
          encoding: "utf8",
        });

      it("migrate deploy succeeds (clean install when the DB is empty)", () => {
        const out = prisma(["migrate", "deploy"]);
        expect(out).toMatch(/migrations? (have|has) been (successfully )?applied|No pending migrations/i);
      });

      it("a second migrate deploy is a no-op (idempotence)", () => {
        const out = prisma(["migrate", "deploy"]);
        expect(out).toMatch(/No pending migrations|already in sync/i);
      });

      it("prisma validate accepts the resulting schema", () => {
        const out = prisma(["validate"]);
        expect(out).toMatch(/valid/i);
      });
    });
  });
});
