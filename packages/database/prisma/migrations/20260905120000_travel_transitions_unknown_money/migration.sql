-- Travel rebuild, step A: individual travel transitions from which trips are
-- assembled, plus an explicit "unknown" money direction so unclassified money
-- movements never silently inflate income/expense.
ALTER TYPE "MoneyDirection" ADD VALUE IF NOT EXISTS 'unknown';

-- CreateTable
CREATE TABLE "TravelTransition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "country" TEXT,
    "countryId" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'torn_log',
    "sourceRef" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "TravelTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TravelTransition_userId_source_sourceRef_key" ON "TravelTransition"("userId", "source", "sourceRef");

-- CreateIndex
CREATE INDEX "TravelTransition_userId_occurredAt_idx" ON "TravelTransition"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "TravelTransition_userId_type_idx" ON "TravelTransition"("userId", "type");

-- AddForeignKey
ALTER TABLE "TravelTransition" ADD CONSTRAINT "TravelTransition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
