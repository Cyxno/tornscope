-- Faction analytics: ranked war enrichment, chains, OCs, faction balance.
-- Additive; RankedWar gains columns (nullable / defaulted) safely.

-- AlterTable
ALTER TABLE "RankedWar" ADD COLUMN "opponentName" TEXT;
ALTER TABLE "RankedWar" ADD COLUMN "ourScore" INTEGER;
ALTER TABLE "RankedWar" ADD COLUMN "opponentScore" INTEGER;
ALTER TABLE "RankedWar" ADD COLUMN "ourChain" INTEGER;
ALTER TABLE "RankedWar" ADD COLUMN "opponentChain" INTEGER;
ALTER TABLE "RankedWar" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'torn_api';

-- CreateTable FactionChain
CREATE TABLE "FactionChain" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "factionId" INTEGER NOT NULL,
    "chainId" INTEGER NOT NULL,
    "chain" INTEGER NOT NULL,
    "respect" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FactionChain_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FactionChain_userId_chainId_key" ON "FactionChain"("userId", "chainId");
CREATE INDEX "FactionChain_userId_factionId_idx" ON "FactionChain"("userId", "factionId");
CREATE INDEX "FactionChain_userId_startedAt_idx" ON "FactionChain"("userId", "startedAt");
ALTER TABLE "FactionChain" ADD CONSTRAINT "FactionChain_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable OrganizedCrime
CREATE TABLE "OrganizedCrime" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "factionId" INTEGER NOT NULL,
    "ocId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "difficulty" INTEGER,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3),
    "planningAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "rewards" JSONB,
    "slots" JSONB,
    CONSTRAINT "OrganizedCrime_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrganizedCrime_userId_ocId_key" ON "OrganizedCrime"("userId", "ocId");
CREATE INDEX "OrganizedCrime_userId_factionId_idx" ON "OrganizedCrime"("userId", "factionId");
CREATE INDEX "OrganizedCrime_userId_status_idx" ON "OrganizedCrime"("userId", "status");
ALTER TABLE "OrganizedCrime" ADD CONSTRAINT "OrganizedCrime_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable FactionBalanceSnapshot
CREATE TABLE "FactionBalanceSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "factionId" INTEGER NOT NULL,
    "money" BIGINT,
    "points" INTEGER,
    "scope" INTEGER,
    "members" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    CONSTRAINT "FactionBalanceSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FactionBalanceSnapshot_userId_factionId_capturedAt_idx" ON "FactionBalanceSnapshot"("userId", "factionId", "capturedAt");
ALTER TABLE "FactionBalanceSnapshot" ADD CONSTRAINT "FactionBalanceSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
