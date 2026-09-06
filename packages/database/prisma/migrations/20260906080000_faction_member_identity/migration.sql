-- Faction member identity: store the real roster fields (Torn player id,
-- name, position, level, days in faction, last action) on FactionMembership
-- so the members tab resolves actual names instead of "Member <factionId>".
-- Additive and nullable; legacy rows are backfilled from their sourceRef.

ALTER TABLE "FactionMembership" ADD COLUMN "memberId" INTEGER;
ALTER TABLE "FactionMembership" ADD COLUMN "name" TEXT;
ALTER TABLE "FactionMembership" ADD COLUMN "position" TEXT;
ALTER TABLE "FactionMembership" ADD COLUMN "level" INTEGER;
ALTER TABLE "FactionMembership" ADD COLUMN "daysInFaction" INTEGER;
ALTER TABLE "FactionMembership" ADD COLUMN "lastActionAt" TIMESTAMP(3);
ALTER TABLE "FactionMembership" ADD COLUMN "lastActionStatus" TEXT;

-- Legacy rows carried the member id only inside sourceRef "faction-member:<id>".
UPDATE "FactionMembership"
SET "memberId" = CAST(substring("sourceRef" FROM 16) AS INTEGER)
WHERE "sourceRef" LIKE 'faction-member:%' AND "memberId" IS NULL;

CREATE INDEX "FactionMembership_userId_memberId_idx" ON "FactionMembership"("userId", "memberId");
