-- Monotonic insertion sequence for TimelineEvent: the notification engine's
-- "newly inserted" cursor. Backfills get fresh seq values but historical
-- occurredAt keeps them behind the activation boundary (no floods).
ALTER TABLE "TimelineEvent" ADD COLUMN "seq" BIGSERIAL UNIQUE;
