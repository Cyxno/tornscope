-- One real Torn identity maps to ONE TornScope profile (profile reuse).
--
-- Additive + one deliberate re-tightening: the multi-user migration relaxed
-- the global unique on TornAccount.tornId so two browser profiles could
-- connect the same Torn account. With the linking flow replacing duplicate
-- imports, real tornIds become unique across NON-DEMO profiles again:
--
-- 1. An isDemo flag on TornAccount keeps the synthetic demo identity outside
--    the invariant (the demo TornAccount row is recreated by seed:demo).
-- 2. A PARTIAL unique index enforces one row per real tornId.
--
-- Safety: production was audited before this migration (2026-09-07). The only
-- duplicate (a re-imported guest profile for tornId 1816206) was removed after
-- copying its 15 genuinely-unique rows onto the canonical owner profile, so
-- this index cannot violate on current data.

ALTER TABLE "TornAccount" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

UPDATE "TornAccount" SET "isDemo" = true
WHERE "userId" IN (SELECT id FROM "User" WHERE "isDemo" = true);

CREATE UNIQUE INDEX "TornAccount_tornId_real_key" ON "TornAccount"("tornId") WHERE "isDemo" = false;
