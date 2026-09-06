-- Faction armory events: first-class provenance source parsed from the
-- faction armory news feed (/v2/faction/news?cat=armoryAction). Used to
-- determine whether consumed items (e.g. Xanax) were faction-sponsored.

-- CreateTable FactionArmoryEvent
CREATE TABLE "FactionArmoryEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "factionId" INTEGER NOT NULL,
    "memberId" INTEGER,
    "memberName" TEXT,
    "itemId" INTEGER,
    "itemName" TEXT,
    "action" TEXT NOT NULL DEFAULT 'used',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "value" BIGINT,
    "source" TEXT NOT NULL DEFAULT 'torn_faction_news',
    "sourceRef" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB,
    CONSTRAINT "FactionArmoryEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FactionArmoryEvent_userId_source_sourceRef_key" ON "FactionArmoryEvent"("userId", "source", "sourceRef");
CREATE INDEX "FactionArmoryEvent_userId_memberId_occurredAt_idx" ON "FactionArmoryEvent"("userId", "memberId", "occurredAt");
CREATE INDEX "FactionArmoryEvent_userId_itemId_idx" ON "FactionArmoryEvent"("userId", "itemId");
ALTER TABLE "FactionArmoryEvent" ADD CONSTRAINT "FactionArmoryEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
