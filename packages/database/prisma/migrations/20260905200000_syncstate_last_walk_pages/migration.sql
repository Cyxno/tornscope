-- SyncState: record Torn API pages used by the last sync so scheduled
-- incremental syncs are verifiably lightweight. Additive only.

-- AlterTable
ALTER TABLE "SyncState" ADD COLUMN "lastWalkPages" INTEGER;
