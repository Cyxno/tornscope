-- Additive index for the 2.1.0 Log Explorer: filter+range scans over the
-- raw log archive (TimelineEvent type="log") by user, type and time.
-- No data is read, rewritten or dropped — safe to apply on production size.
CREATE INDEX "TimelineEvent_userId_type_occurredAt_idx" ON "TimelineEvent"("userId", "type", "occurredAt");
