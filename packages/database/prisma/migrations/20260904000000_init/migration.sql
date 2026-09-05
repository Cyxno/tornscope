-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MoneyDirection" AS ENUM ('income', 'expense', 'neutral');

-- CreateEnum
CREATE TYPE "DrugOutcome" AS ENUM ('success', 'overdose');

-- CreateEnum
CREATE TYPE "TravelItemCategory" AS ENUM ('plushie', 'flower', 'other');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TornAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tornId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "rank" TEXT,
    "donatorStatus" INTEGER,
    "gender" TEXT,
    "property" TEXT,
    "factionId" INTEGER,
    "status" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TornAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyPreview" TEXT NOT NULL,
    "accessLevel" INTEGER,
    "accessType" TEXT,
    "logAccessAvailable" BOOLEAN NOT NULL DEFAULT false,
    "validatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "frequencySeconds" INTEGER NOT NULL DEFAULT 600,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastAttemptAt" TIMESTAMP(3),
    "lastStartedAt" TIMESTAMP(3),
    "lastCompletedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "lastTimestamp" BIGINT,
    "cursor" TEXT,
    "recordsCollected" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "recordsCollected" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "level" INTEGER NOT NULL,
    "rank" TEXT,
    "factionId" INTEGER,
    "status" JSONB,
    "raw" JSONB,

    CONSTRAINT "UserSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalStatSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "networthTotal" BIGINT,
    "stats" JSONB NOT NULL,

    CONSTRAINT "PersonalStatSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworthSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "total" BIGINT NOT NULL,
    "pending" BIGINT NOT NULL DEFAULT 0,
    "wallet" BIGINT NOT NULL DEFAULT 0,
    "vault" BIGINT NOT NULL DEFAULT 0,
    "bookie" BIGINT NOT NULL DEFAULT 0,
    "cityBank" BIGINT NOT NULL DEFAULT 0,
    "caymanBank" BIGINT NOT NULL DEFAULT 0,
    "piggyBank" BIGINT NOT NULL DEFAULT 0,
    "loans" BIGINT NOT NULL DEFAULT 0,
    "unpaidFees" BIGINT NOT NULL DEFAULT 0,
    "inventory" BIGINT NOT NULL DEFAULT 0,
    "displayCase" BIGINT NOT NULL DEFAULT 0,
    "bazaar" BIGINT NOT NULL DEFAULT 0,
    "trades" BIGINT NOT NULL DEFAULT 0,
    "itemMarket" BIGINT NOT NULL DEFAULT 0,
    "auctionHouse" BIGINT NOT NULL DEFAULT 0,
    "enlistedCars" BIGINT NOT NULL DEFAULT 0,
    "property" BIGINT NOT NULL DEFAULT 0,
    "stockMarket" BIGINT NOT NULL DEFAULT 0,
    "company" BIGINT NOT NULL DEFAULT 0,
    "points" BIGINT NOT NULL DEFAULT 0,
    "raw" JSONB,

    CONSTRAINT "NetworthSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DrugEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "drugItemId" INTEGER,
    "drugName" TEXT,
    "outcome" "DrugOutcome" NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'torn_log',
    "sourceRef" TEXT NOT NULL,
    "raw" JSONB,

    CONSTRAINT "DrugEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RehabEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "rehabPercent" INTEGER,
    "cost" BIGINT,
    "addictionPointsRemoved" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'torn_log',
    "sourceRef" TEXT NOT NULL,
    "raw" JSONB,

    CONSTRAINT "RehabEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TravelEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "departedAt" TIMESTAMP(3) NOT NULL,
    "arrivedAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "source" TEXT NOT NULL DEFAULT 'torn_log',
    "sourceRef" TEXT NOT NULL,
    "raw" JSONB,

    CONSTRAINT "TravelEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TravelItemEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "travelEventId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "destination" TEXT,
    "category" "TravelItemCategory" NOT NULL,
    "itemId" INTEGER NOT NULL,
    "itemName" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitCost" BIGINT NOT NULL,
    "totalCost" BIGINT NOT NULL,
    "estimatedUnitValue" BIGINT,
    "estimatedTotalValue" BIGINT,
    "realizedUnitValue" BIGINT,
    "realizedTotalValue" BIGINT,
    "source" TEXT NOT NULL DEFAULT 'torn_log',
    "sourceRef" TEXT NOT NULL,
    "raw" JSONB,

    CONSTRAINT "TravelItemEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoneyEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "direction" "MoneyDirection" NOT NULL,
    "amount" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB,

    CONSTRAINT "MoneyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimelineEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amount" BIGINT,
    "metadata" JSONB,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,

    CONSTRAINT "TimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Faction" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "tag" TEXT,
    "leaderId" INTEGER,
    "coLeaderId" INTEGER,
    "respect" INTEGER,
    "daysOld" INTEGER,
    "capacity" INTEGER,
    "members" INTEGER,
    "bestChain" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Faction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactionMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "factionId" INTEGER NOT NULL,
    "joinedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactionMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactionSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "factionId" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "members" INTEGER,
    "respect" INTEGER,
    "raw" JSONB,

    CONSTRAINT "FactionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TornItemCatalog" (
    "itemId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "marketPrice" BIGINT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TornItemCatalog_pkey" PRIMARY KEY ("itemId")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL DEFAULT '',
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankedWar" (
    "id" TEXT NOT NULL,
    "tornWarId" INTEGER NOT NULL,
    "factionId" INTEGER NOT NULL,
    "opponentFactionId" INTEGER,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "winnerFactionId" INTEGER,
    "targetScore" INTEGER,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RankedWar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankedWarMember" (
    "id" TEXT NOT NULL,
    "warId" TEXT NOT NULL,
    "userId" TEXT,
    "tornId" INTEGER NOT NULL,
    "score" INTEGER,
    "hits" INTEGER,
    "respect" INTEGER,
    "joinedAt" TIMESTAMP(3),

    CONSTRAINT "RankedWarMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankedWarAttack" (
    "id" TEXT NOT NULL,
    "warId" TEXT NOT NULL,
    "attackerTornId" INTEGER NOT NULL,
    "defenderTornId" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "result" TEXT,
    "respectGained" INTEGER,
    "raw" JSONB,

    CONSTRAINT "RankedWarAttack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankedWarPayout" (
    "id" TEXT NOT NULL,
    "warId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "sourceRef" TEXT NOT NULL,

    CONSTRAINT "RankedWarPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "TornAccount_userId_key" ON "TornAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TornAccount_tornId_key" ON "TornAccount"("tornId");

-- CreateIndex
CREATE INDEX "TornAccount_factionId_idx" ON "TornAccount"("factionId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_userId_key" ON "ApiCredential"("userId");

-- CreateIndex
CREATE INDEX "SyncState_status_idx" ON "SyncState"("status");

-- CreateIndex
CREATE INDEX "SyncState_nextRunAt_idx" ON "SyncState"("nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_userId_resource_key" ON "SyncState"("userId", "resource");

-- CreateIndex
CREATE INDEX "SyncRun_userId_resource_startedAt_idx" ON "SyncRun"("userId", "resource", "startedAt");

-- CreateIndex
CREATE INDEX "UserSnapshot_userId_capturedAt_idx" ON "UserSnapshot"("userId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSnapshot_userId_capturedAt_key" ON "UserSnapshot"("userId", "capturedAt");

-- CreateIndex
CREATE INDEX "PersonalStatSnapshot_userId_capturedAt_idx" ON "PersonalStatSnapshot"("userId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalStatSnapshot_userId_capturedAt_key" ON "PersonalStatSnapshot"("userId", "capturedAt");

-- CreateIndex
CREATE INDEX "NetworthSnapshot_userId_capturedAt_idx" ON "NetworthSnapshot"("userId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NetworthSnapshot_userId_capturedAt_key" ON "NetworthSnapshot"("userId", "capturedAt");

-- CreateIndex
CREATE INDEX "DrugEvent_userId_occurredAt_idx" ON "DrugEvent"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "DrugEvent_userId_drugItemId_idx" ON "DrugEvent"("userId", "drugItemId");

-- CreateIndex
CREATE UNIQUE INDEX "DrugEvent_userId_source_sourceRef_key" ON "DrugEvent"("userId", "source", "sourceRef");

-- CreateIndex
CREATE INDEX "RehabEvent_userId_occurredAt_idx" ON "RehabEvent"("userId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "RehabEvent_userId_source_sourceRef_key" ON "RehabEvent"("userId", "source", "sourceRef");

-- CreateIndex
CREATE INDEX "TravelEvent_userId_departedAt_idx" ON "TravelEvent"("userId", "departedAt");

-- CreateIndex
CREATE INDEX "TravelEvent_userId_destination_idx" ON "TravelEvent"("userId", "destination");

-- CreateIndex
CREATE UNIQUE INDEX "TravelEvent_userId_source_sourceRef_key" ON "TravelEvent"("userId", "source", "sourceRef");

-- CreateIndex
CREATE INDEX "TravelItemEvent_userId_occurredAt_idx" ON "TravelItemEvent"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "TravelItemEvent_userId_category_idx" ON "TravelItemEvent"("userId", "category");

-- CreateIndex
CREATE INDEX "TravelItemEvent_itemId_idx" ON "TravelItemEvent"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "TravelItemEvent_userId_source_sourceRef_key" ON "TravelItemEvent"("userId", "source", "sourceRef");

-- CreateIndex
CREATE INDEX "MoneyEvent_userId_occurredAt_idx" ON "MoneyEvent"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "MoneyEvent_userId_category_idx" ON "MoneyEvent"("userId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "MoneyEvent_userId_source_sourceRef_key" ON "MoneyEvent"("userId", "source", "sourceRef");

-- CreateIndex
CREATE INDEX "TimelineEvent_userId_occurredAt_idx" ON "TimelineEvent"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "TimelineEvent_userId_type_idx" ON "TimelineEvent"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "TimelineEvent_userId_source_sourceRef_key" ON "TimelineEvent"("userId", "source", "sourceRef");

-- CreateIndex
CREATE INDEX "FactionMembership_userId_isActive_idx" ON "FactionMembership"("userId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "FactionMembership_userId_factionId_sourceRef_key" ON "FactionMembership"("userId", "factionId", "sourceRef");

-- CreateIndex
CREATE INDEX "FactionSnapshot_factionId_capturedAt_idx" ON "FactionSnapshot"("factionId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FactionSnapshot_userId_capturedAt_key" ON "FactionSnapshot"("userId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppSetting_userId_key_key" ON "AppSetting"("userId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "RankedWar_tornWarId_key" ON "RankedWar"("tornWarId");

-- CreateIndex
CREATE UNIQUE INDEX "RankedWarMember_userId_key" ON "RankedWarMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RankedWarMember_warId_tornId_key" ON "RankedWarMember"("warId", "tornId");

-- CreateIndex
CREATE INDEX "RankedWarAttack_warId_occurredAt_idx" ON "RankedWarAttack"("warId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "RankedWarPayout_userId_sourceRef_key" ON "RankedWarPayout"("userId", "sourceRef");

-- AddForeignKey
ALTER TABLE "TornAccount" ADD CONSTRAINT "TornAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSnapshot" ADD CONSTRAINT "UserSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalStatSnapshot" ADD CONSTRAINT "PersonalStatSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetworthSnapshot" ADD CONSTRAINT "NetworthSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrugEvent" ADD CONSTRAINT "DrugEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RehabEvent" ADD CONSTRAINT "RehabEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelEvent" ADD CONSTRAINT "TravelEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelItemEvent" ADD CONSTRAINT "TravelItemEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelItemEvent" ADD CONSTRAINT "TravelItemEvent_travelEventId_fkey" FOREIGN KEY ("travelEventId") REFERENCES "TravelEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoneyEvent" ADD CONSTRAINT "MoneyEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactionMembership" ADD CONSTRAINT "FactionMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactionMembership" ADD CONSTRAINT "FactionMembership_factionId_fkey" FOREIGN KEY ("factionId") REFERENCES "Faction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactionSnapshot" ADD CONSTRAINT "FactionSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactionSnapshot" ADD CONSTRAINT "FactionSnapshot_factionId_fkey" FOREIGN KEY ("factionId") REFERENCES "Faction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSetting" ADD CONSTRAINT "AppSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankedWar" ADD CONSTRAINT "RankedWar_factionId_fkey" FOREIGN KEY ("factionId") REFERENCES "Faction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankedWarMember" ADD CONSTRAINT "RankedWarMember_warId_fkey" FOREIGN KEY ("warId") REFERENCES "RankedWar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankedWarMember" ADD CONSTRAINT "RankedWarMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankedWarAttack" ADD CONSTRAINT "RankedWarAttack_warId_fkey" FOREIGN KEY ("warId") REFERENCES "RankedWar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankedWarPayout" ADD CONSTRAINT "RankedWarPayout_warId_fkey" FOREIGN KEY ("warId") REFERENCES "RankedWar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankedWarPayout" ADD CONSTRAINT "RankedWarPayout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

