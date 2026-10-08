/**
 * Vitest global setup — runs before ANY test module loads.
 *
 * Database-backed suites gate themselves on TEST_DATABASE_URL, but the
 * modules they import (api/worker env, encryption service, Prisma client)
 * read their environment at module-load time, which happens BEFORE a test
 * file's own top-level statements. Setting the defaults here guarantees a
 * deterministic, hermetic configuration whenever the DB-backed suites run:
 * - a deterministic local-only AES key (test fixtures never leave the process);
 * - no rate-limit sleeping between stubbed Torn calls;
 * - queue traffic isolated from any live Redis by default (DB 15).
 */
process.env.TEST_DATABASE_URL ??= "";
if (process.env.TEST_DATABASE_URL) {
  // v2.6.1 hermetic guard: a DB-backed run may only ever address a database
  // whose name is unmistakably a test database (2.6.0 wrote fixtures into
  // production because a sourced .env leaked prod env through).
  const dbName = new URL(process.env.TEST_DATABASE_URL).pathname.replace(/^\//, "");
  if (!/test/i.test(dbName)) {
    throw new Error(`[vitest.setup] TEST_DATABASE_URL must point at a *test* database (got "${dbName}") — refusing to run`);
  }
  process.env.API_KEY_ENCRYPTION_KEY ??= "a".repeat(64);
  process.env.TORN_API_MIN_REQUEST_INTERVAL_MS ??= "0";
  // Queue traffic isolated from any live Redis by default (DB 15): FORCED,
  // not defaulted — an inherited prod REDIS_URL would receive test traffic.
  process.env.REDIS_URL = "redis://127.0.0.1:6379/15";
  // Web-push credentials are production secrets with no test consumer.
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  // Bound every Prisma pool so Vitest's default parallelism (one client per
  // test file, files running across many workers) can never exhaust the
  // server's max_connections — the exact failure that broke hosted CI
  // ("FATAL: sorry, too many clients already"). Files that never call
  // $disconnect leak their pool until the worker exits; small per-client
  // pools keep the worst case (all workers × all leaked clients) safely
  // under the PostgreSQL default of 100 connections while still serving
  // every suite sequentially within its own file.
  const boundPool = (url) => {
    if (!url) return url;
    const limit = 2;
    return /[?&]connection_limit=/.test(url) ? url : url + (url.includes("?") ? "&" : "?") + `connection_limit=${limit}`;
  };
  process.env.TEST_DATABASE_URL = boundPool(process.env.TEST_DATABASE_URL);
  // Fixtures use the Prisma client, which reads DATABASE_URL: force it to the
  // validated test URL instead of `??=`-defaulting — inheritance from a prod
  // environment can then never reach the fixtures.
  process.env.DATABASE_URL = boundPool(process.env.TEST_DATABASE_URL);
}
