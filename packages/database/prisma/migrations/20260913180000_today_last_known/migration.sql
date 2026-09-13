-- Real-user remediation (cold loads): persist the last successful live-status
-- payload per user so cold page loads can be served immediately (stale-
-- while-revalidate) instead of blocking on a fresh upstream Torn fetch.
-- Expand-phase change: a new standalone table; nothing existing is touched.
CREATE TABLE "TodayLastKnown" (
    "userId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TodayLastKnown_pkey" PRIMARY KEY ("userId")
);

-- Profile deletion cascades to the cached payload.
ALTER TABLE "TodayLastKnown" ADD CONSTRAINT "TodayLastKnown_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
