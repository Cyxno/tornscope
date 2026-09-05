-- Adaptive per-category scheduling state + sync run metrics. Additive only.

-- AlterTable
ALTER TABLE "SyncCategoryState" ADD COLUMN "nextRunAt" TIMESTAMP(3);
ALTER TABLE "SyncCategoryState" ADD COLUMN "frequencySeconds" INTEGER;
ALTER TABLE "SyncCategoryState" ADD COLUMN "lastActivityAt" TIMESTAMP(3);
ALTER TABLE "SyncCategoryState" ADD COLUMN "consecutiveEmptyRuns" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "SyncRun" ADD COLUMN "stats" JSONB;

-- CreateIndex
CREATE INDEX "SyncCategoryState_nextRunAt_idx" ON "SyncCategoryState"("nextRunAt");
