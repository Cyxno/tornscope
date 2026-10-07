import { execFileSync } from "node:child_process";

/**
 * Deterministic test-database lifecycle (2.5.4).
 *
 * Every vitest run that has TEST_DATABASE_URL set starts from the same
 * baseline: empty schema -> all migrations -> demo seed. This is the ONE
 * lifecycle shared by local `pnpm test`, scripts/release-preflight.sh and
 * GitHub Actions — repeated runs can never observe state left behind by
 * earlier runs (the 2.5.3 release gate hit exactly that).
 *
 * Without TEST_DATABASE_URL this is a no-op: unit-only runs need no database.
 * The reset deliberately happens BEFORE the suite, not after: keeping the
 * last state around makes post-run debugging possible.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.log("[global-setup] TEST_DATABASE_URL not set — skipping database reset (unit-only run)");
    return;
  }
  console.log("[global-setup] resetting test database to the deterministic baseline…");
  execFileSync("pnpm", ["exec", "tsx", "scripts/ci/reset-test-db.ts"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
