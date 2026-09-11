-- Hosted hardening (roadmap #8): fail-safe role default.
-- Every runtime creation path passes an explicit role ("user"); the old
-- DEFAULT("owner") would silently mint an owner from any future
-- user.create that forgot the field. Existing rows are untouched (the
-- default only applies to inserts that omit the column).
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'user';
