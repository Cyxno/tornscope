-- Proactive Alerts engine MVP (2.9.0): user-configurable alert rules,
-- Discord webhook channels and an in-app inbox. Fully additive — no
-- existing table is touched.
--
-- Dedupe design: AlertDelivery is BOTH the logical alert and the in-app
-- inbox row; (userId, dedupeKey) is the account-level idempotency constraint
-- (worker crashes / concurrent ticks can never duplicate an episode).
-- External channel fan-out lives in AlertChannelDelivery with its own
-- (channelId, deliveryId) idempotency and bounded-retry ledger.

CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "config" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "quietHours" JSONB,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 0,
    "lastFiredAt" TIMESTAMP(3),
    "lastState" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AlertRule_userId_triggerType_key" ON "AlertRule"("userId", "triggerType");
CREATE INDEX "AlertRule_userId_enabled_idx" ON "AlertRule"("userId", "enabled");

CREATE TABLE "AlertChannel" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'discord',
    "encryptedKey" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "targetPreview" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertChannel_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AlertChannel_userId_idx" ON "AlertChannel"("userId");

CREATE TABLE "AlertDelivery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AlertDelivery_userId_dedupeKey_key" ON "AlertDelivery"("userId", "dedupeKey");
CREATE INDEX "AlertDelivery_userId_occurredAt_idx" ON "AlertDelivery"("userId", "occurredAt");
CREATE INDEX "AlertDelivery_userId_readAt_idx" ON "AlertDelivery"("userId", "readAt");
CREATE INDEX "AlertDelivery_ruleId_idx" ON "AlertDelivery"("ruleId");

CREATE TABLE "AlertChannelDelivery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "errorKind" TEXT,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertChannelDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AlertChannelDelivery_channelId_deliveryId_key" ON "AlertChannelDelivery"("channelId", "deliveryId");
CREATE INDEX "AlertChannelDelivery_status_nextAttemptAt_idx" ON "AlertChannelDelivery"("status", "nextAttemptAt");
CREATE INDEX "AlertChannelDelivery_userId_createdAt_idx" ON "AlertChannelDelivery"("userId", "createdAt");

-- Profile deletion cascades everything (mirror of every other user-scoped
-- table); rule deletion cascades its deliveries, channel deletion cascades
-- its channel deliveries — no orphans in any deletion path.
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertChannel" ADD CONSTRAINT "AlertChannel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertDelivery" ADD CONSTRAINT "AlertDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertDelivery" ADD CONSTRAINT "AlertDelivery_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertChannelDelivery" ADD CONSTRAINT "AlertChannelDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertChannelDelivery" ADD CONSTRAINT "AlertChannelDelivery_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "AlertDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AlertChannelDelivery" ADD CONSTRAINT "AlertChannelDelivery_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "AlertChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
