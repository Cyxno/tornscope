-- SyncCategoryState: per-category incremental cursors for log resources.
-- Additive only — no existing rows are touched.

-- CreateTable
CREATE TABLE "SyncCategoryState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "categoryTitle" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastTimestamp" BIGINT,
    "lastSuccessAt" TIMESTAMP(3),
    "lastWalkPages" INTEGER,
    "lastRecordsInserted" INTEGER,
    "sourceEarliestAt" BIGINT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncCategoryState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncCategoryState_userId_resource_categoryId_key" ON "SyncCategoryState"("userId", "resource", "categoryId");

-- CreateIndex
CREATE INDEX "SyncCategoryState_userId_resource_idx" ON "SyncCategoryState"("userId", "resource");

-- AddForeignKey
ALTER TABLE "SyncCategoryState" ADD CONSTRAINT "SyncCategoryState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
