-- Dedicated liveness heartbeat for stale-run recovery. Backfill from the
-- last real run start so rows currently marked "running" (e.g. after a
-- worker crash) are immediately recognized as stale and recoverable.
ALTER TABLE "SyncState" ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3);
UPDATE "SyncState" SET "lastHeartbeatAt" = COALESCE("lastStartedAt", "updatedAt");
