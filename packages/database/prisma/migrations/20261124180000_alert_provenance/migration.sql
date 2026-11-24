-- 2.10.0: every committed alert carries its provenance (confidence, sources,
-- observed window, caveats). Nullable: rows committed before 2.10.0 have no
-- provenance and the UI renders that honestly as unavailable ("-"), never
-- as a fabricated empty object.
ALTER TABLE "AlertDelivery" ADD COLUMN "provenance" JSONB;
