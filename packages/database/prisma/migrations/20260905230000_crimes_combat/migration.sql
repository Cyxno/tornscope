-- CrimeEvent + CombatEvent: normalized crimes and combat analytics.
-- Additive only.

-- CreateTable
CREATE TABLE "CrimeEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "crimeId" INTEGER,
    "crimeName" TEXT,
    "crimeCategory" TEXT,
    "success" BOOLEAN NOT NULL,
    "nerveUsed" INTEGER,
    "moneyDelta" BIGINT,
    "itemsValue" BIGINT,
    "jailSeconds" INTEGER,
    "hospitalSeconds" INTEGER,
    "skillGain" INTEGER,
    "metadata" JSONB,
    CONSTRAINT "CrimeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CombatEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "direction" TEXT NOT NULL,
    "opponentId" INTEGER,
    "opponentName" TEXT,
    "result" TEXT NOT NULL,
    "attackType" TEXT,
    "moneyDelta" BIGINT,
    "respectDelta" DOUBLE PRECISION,
    "hospitalSeconds" INTEGER,
    "modifiers" JSONB,
    "metadata" JSONB,
    CONSTRAINT "CombatEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrimeEvent_userId_sourceRef_key" ON "CrimeEvent"("userId", "sourceRef");
CREATE INDEX "CrimeEvent_userId_occurredAt_idx" ON "CrimeEvent"("userId", "occurredAt");
CREATE INDEX "CrimeEvent_userId_success_idx" ON "CrimeEvent"("userId", "success");

CREATE UNIQUE INDEX "CombatEvent_userId_sourceRef_key" ON "CombatEvent"("userId", "sourceRef");
CREATE INDEX "CombatEvent_userId_occurredAt_idx" ON "CombatEvent"("userId", "occurredAt");
CREATE INDEX "CombatEvent_userId_direction_idx" ON "CombatEvent"("userId", "direction");

-- AddForeignKey
ALTER TABLE "CrimeEvent" ADD CONSTRAINT "CrimeEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CombatEvent" ADD CONSTRAINT "CombatEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
