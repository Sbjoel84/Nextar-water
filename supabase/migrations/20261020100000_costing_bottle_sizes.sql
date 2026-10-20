-- ============================================================================
-- Costing per bottle size
-- ----------------------------------------------------------------------------
-- The Costing page now costs each product on the Store Requisition Note
-- separately: 33CL, 50CL and 75CL bottles, Dispenser and Sachet Water. Bottles
-- get one product_type per size; plain 'bottle' stays valid for sheets saved
-- before the split.
--
-- Material lines are tagged in costing_sheet_items.role with the requisition
-- item they came from (e.g. 'preform_33cl', 'cap_bottle'). role is free text,
-- so that needs no schema change.
-- ============================================================================

ALTER TABLE public.costing_sheets
  DROP CONSTRAINT IF EXISTS costing_sheets_product_type_check;

ALTER TABLE public.costing_sheets
  ADD CONSTRAINT costing_sheets_product_type_check
  CHECK (product_type IS NULL OR product_type IN
    ('bottle', 'bottle_33cl', 'bottle_50cl', 'bottle_75cl', 'dispenser', 'sachet'));
