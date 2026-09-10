-- Additive: BarsSnapshot stores the energy/happy bar history that Torn only
-- exposes live (see docs/PROGRESSION-ENERGY.md). No existing table is touched.
CREATE TABLE "BarsSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "energyCurrent" INTEGER NOT NULL,
    "energyMaximum" INTEGER NOT NULL,
    "happyCurrent" INTEGER NOT NULL,
    "happyMaximum" INTEGER NOT NULL,

    CONSTRAINT "BarsSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BarsSnapshot_userId_capturedAt_key" ON "BarsSnapshot"("userId", "capturedAt");
CREATE INDEX "BarsSnapshot_userId_capturedAt_idx" ON "BarsSnapshot"("userId", "capturedAt");

ALTER TABLE "BarsSnapshot" ADD CONSTRAINT "BarsSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
