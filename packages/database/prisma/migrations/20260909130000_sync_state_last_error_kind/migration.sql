-- Add lastErrorKind to SyncState: machine reason code of the last failure.
-- Expand-only and upgrade-safe: nullable column, no data is touched. Existing
-- rows keep NULL (= "unknown reason") until their next failed/successful run
-- writes a code.
ALTER TABLE "SyncState" ADD COLUMN "lastErrorKind" TEXT;
