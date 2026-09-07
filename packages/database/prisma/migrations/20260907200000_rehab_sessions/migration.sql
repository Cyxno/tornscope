-- Rehab visits: Torn's "Rehab" log row is ONE visit and carries
-- `rehab_times` — the explicit number of rehab sessions purchased during
-- that visit. Store it instead of inferring 1 row = 1 session.
ALTER TABLE "RehabEvent" ADD COLUMN "sessions" INTEGER;

-- Backfill from preserved raw payloads (lossless: raw is never dropped).
UPDATE "RehabEvent" SET "sessions" = ("raw"->'data'->>'rehab_times')::int
WHERE "sessions" IS NULL AND "raw"->'data'->>'rehab_times' IS NOT NULL;
