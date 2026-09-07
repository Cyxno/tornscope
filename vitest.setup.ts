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
  process.env.API_KEY_ENCRYPTION_KEY ??= "a".repeat(64);
  process.env.TORN_API_MIN_REQUEST_INTERVAL_MS ??= "0";
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379/15";
}
