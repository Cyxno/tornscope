-- Container uses (payload carries `item2` = the yielded item): Torn's
-- `quantity` counts the YIELDED items, not containers used. The container
-- itself is consumed ONCE. Existing rows multiplied the container price by
-- the yield count (5 Drug Packs showed as ~$213M instead of ~$21M).
-- ConsumptionEvent.metadata holds the raw Torn log; it is preserved under
-- `rawLog` inside the new marker object.
UPDATE "ConsumptionEvent"
SET "quantity" = 1,
    "totalValue" = "unitValue",
    "metadata" = jsonb_build_object(
      'containerUse', true,
      'yieldQuantity', ("metadata"->'data'->>'quantity'),
      'note', 'quantity in the raw payload counts yielded items, not containers used',
      'rawLog', "metadata"
    )
WHERE "quantity" > 1 AND "metadata"->'data' ? 'item2';
