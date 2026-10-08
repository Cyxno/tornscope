-- Additive: generic non-cash reward components on ActivityEvent (2.7.0).
-- JSON array of { kind, label, itemId?, quantity } — semantic shapes only;
-- monetary value is resolved at read time from the item catalog and stays
-- null ("unpriced") whenever the catalog cannot price a component. Cash
-- columns are untouched: cash results never move into otherRewards.
ALTER TABLE "ActivityEvent" ADD COLUMN "otherRewards" JSONB;
