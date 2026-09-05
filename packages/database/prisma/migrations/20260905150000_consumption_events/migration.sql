-- ConsumptionEvent: economic value of consumed (used-up) items.
-- Additive only — no existing tables or rows are touched.

-- CreateTable
CREATE TABLE "ConsumptionEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "itemId" INTEGER,
    "itemName" TEXT,
    "category" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitValue" BIGINT,
    "totalValue" BIGINT,
    "valuationMethod" TEXT NOT NULL DEFAULT 'unknown',
    "provenance" TEXT NOT NULL DEFAULT 'unknown',
    "source" TEXT NOT NULL DEFAULT 'torn_log',
    "sourceRef" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "ConsumptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConsumptionEvent_userId_source_sourceRef_key" ON "ConsumptionEvent"("userId", "source", "sourceRef");

-- CreateIndex
CREATE INDEX "ConsumptionEvent_userId_occurredAt_idx" ON "ConsumptionEvent"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "ConsumptionEvent_userId_category_idx" ON "ConsumptionEvent"("userId", "category");

-- AddForeignKey
ALTER TABLE "ConsumptionEvent" ADD CONSTRAINT "ConsumptionEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
