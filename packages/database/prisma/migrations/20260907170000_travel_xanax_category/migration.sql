-- Xanax is a major travel-income commodity for many players; it must not
-- disappear inside "other". Additive enum value — no data is touched.
ALTER TYPE "TravelItemCategory" ADD VALUE IF NOT EXISTS 'xanax';
