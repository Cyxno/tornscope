/**
 * Reset the TEST database to the deterministic baseline:
 *   empty schema -> all migrations -> demo seed.
 *
 * Runs against DATABASE_URL. Invoked by vitest.global-setup so that `pnpm
 * test` locally, scripts/release-preflight.sh and GitHub Actions all share
 * ONE lifecycle: every full-suite run starts from the exact same state and
 * run-to-run state leakage is impossible by construction.
 *
 * Safety rail: the target database name must contain "test" — this script
 * is never allowed to touch a non-test database.
 */
import { execFileSync } from "node:child_process";
import { PrismaClient } from "../../packages/database/src/generated/client/client.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("reset-test-db: DATABASE_URL is required");

const dbName = (() => {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
})();
if (!dbName.includes("test")) {
  throw new Error(`reset-test-db: refusing to reset "${dbName}" — the target database name must contain "test"`);
}

const db = new PrismaClient({ datasourceUrl: url });
await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS public CASCADE`);
await db.$executeRawUnsafe(`CREATE SCHEMA public`);
await db.$disconnect();

execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy", "--schema", "packages/database/prisma/schema.prisma"], {
  stdio: "inherit",
});
execFileSync("pnpm", ["exec", "tsx", "packages/database/src/seed/demo.ts"], { stdio: "inherit" });

console.log("reset-test-db: schema reset + migrations + demo seed complete");
