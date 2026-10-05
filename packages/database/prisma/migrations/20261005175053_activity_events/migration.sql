-- AlterTable
ALTER TABLE "ApiCredential" ALTER COLUMN "logAccessAvailable" DROP DEFAULT;

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "activityType" TEXT NOT NULL,
    "activityLabel" TEXT NOT NULL,
    "subtype" TEXT,
    "outcome" TEXT,
    "game" TEXT,
    "wheel" TEXT,
    "opponentId" INTEGER,
    "cashInput" BIGINT,
    "cashReward" BIGINT,
    "pointsReward" INTEGER,
    "tokensReward" INTEGER,
    "inputValue" BIGINT,
    "rewardValue" BIGINT,
    "netValue" BIGINT,
    "valuation" TEXT NOT NULL DEFAULT 'unpriced',
    "provenance" TEXT NOT NULL DEFAULT 'exact',
    "metadata" JSONB,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityEvent_userId_occurredAt_idx" ON "ActivityEvent"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_userId_domain_activityType_occurredAt_idx" ON "ActivityEvent"("userId", "domain", "activityType", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityEvent_userId_source_sourceRef_key" ON "ActivityEvent"("userId", "source", "sourceRef");

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "PushSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "NotificationDelivery_subscriptionId_eventKey_notificationType_k" RENAME TO "NotificationDelivery_subscriptionId_eventKey_notificationTy_key";
