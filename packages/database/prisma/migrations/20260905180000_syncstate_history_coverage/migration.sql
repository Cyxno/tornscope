-- SyncState: historical coverage bookkeeping (why backward pagination
-- stopped + oldest source data observed). Additive only.

-- AlterTable
ALTER TABLE "SyncState" ADD COLUMN "stopReason" TEXT;
ALTER TABLE "SyncState" ADD COLUMN "sourceEarliestAt" BIGINT;
