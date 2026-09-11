-- Notification platform v2 (roadmap #7): logical event model + delivery
-- lifecycle. Fully additive — no existing column is dropped or retyped.

-- One LOGICAL notification event per profile; (userId, dedupeKey) is the
-- profile-level dedupe constraint. Deferred (quiet-hours) events park here.
CREATE TABLE "NotificationEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "clickPath" TEXT NOT NULL DEFAULT '/today',
    "provenance" TEXT NOT NULL DEFAULT 'exact',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "deliverAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationEvent_userId_dedupeKey_key" ON "NotificationEvent"("userId", "dedupeKey");
CREATE INDEX "NotificationEvent_userId_createdAt_idx" ON "NotificationEvent"("userId", "createdAt");
CREATE INDEX "NotificationEvent_status_deliverAt_idx" ON "NotificationEvent"("status", "deliverAt");

-- Delivery lifecycle: real statuses, machine reasons, bounded-retry bookkeeping.
ALTER TABLE "NotificationDelivery" ADD COLUMN "eventId" TEXT;
ALTER TABLE "NotificationDelivery" ADD COLUMN "reason" TEXT;
ALTER TABLE "NotificationDelivery" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "NotificationDelivery" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "NotificationDelivery" ADD COLUMN "lastError" TEXT;
CREATE INDEX "NotificationDelivery_eventId_idx" ON "NotificationDelivery"("eventId");

-- Quiet-hours bypass preference for critical alerts + per-type config.
ALTER TABLE "NotificationPreference" ADD COLUMN "bypassCritical" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NotificationPreference" ADD COLUMN "typeConfig" JSONB;

-- Producer state for the non-timer evaluators (energy re-arm, sync incident
-- signature, milestone/economy cursors).
ALTER TABLE "NotificationState" ADD COLUMN "systemState" JSONB;

-- Foreign keys last (additive, cascade-on-delete mirrors the models).
ALTER TABLE "NotificationEvent" ADD CONSTRAINT "NotificationEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "NotificationEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
