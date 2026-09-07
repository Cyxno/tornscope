-- Push notification foundation: device subscriptions, per-profile
-- preferences (with activation boundary), delivery dedup ledger, and the
-- live-state snapshot used for timer transition detection.
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "categories" JSONB NOT NULL,
    "sensitiveDetails" BOOLEAN NOT NULL DEFAULT false,
    "quietStartMin" INTEGER,
    "quietEndMin" INTEGER,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "notificationType" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'sent',

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationState" (
    "userId" TEXT NOT NULL,
    "previousState" JSONB,
    "nextEligibleAt" TIMESTAMP(3),
    "lastTimelineSeq" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationState_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");
CREATE INDEX "NotificationDelivery_userId_sentAt_idx" ON "NotificationDelivery"("userId", "sentAt");
CREATE UNIQUE INDEX "NotificationDelivery_subscriptionId_eventKey_notificationType_key" ON "NotificationDelivery"("subscriptionId", "eventKey", "notificationType");

ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationState" ADD CONSTRAINT "NotificationState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
