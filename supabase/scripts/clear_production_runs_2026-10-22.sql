-- ============================================================================
-- Clear the three production runs of 2026-10-22
-- ----------------------------------------------------------------------------
--   #74AFCEA8  PRD20261022-22144  500 Sachet Water 50cl  Posted (delete awaiting Store)
--   #49F2772F  PRD20261022-10949  500 Sachet Water       Reversed
--   #7A040148  PRD20261022-30053  500 Sachet Water (Bag) Posted
--
-- THIS CANNOT BE UNDONE. All-or-nothing: if anything fails, NOTHING changes.
-- Supersedes clear_production_batch_74AFCEA8.sql (that batch is included here).
--
-- Stock effect:
--   * Sachet Water 50cl -- already deleted, stock 0. Its +500 / -500 movements
--     cancel out; its recycle-bin entry is set to put back 0 units if restored.
--   * Sachet Water -- the reversed run's +500 / -500 cancel out. The posted
--     500 Bag run is the only stock it holds (500, none sold), so stock goes
--     500 -> 0. The guard below stops the script if that is no longer true.
--
-- Also removes the runs' approval history and correction requests (cascade).
-- Audit-log entries are kept as the record that these runs existed.
--
-- Run the whole file in the Supabase SQL Editor.
-- ============================================================================

BEGIN;

-- Stop if Sachet Water's stock has moved since this script was written
-- (e.g. some of the 500 was sold or transferred).
DO $$
BEGIN
  IF (SELECT current_stock FROM public.products
       WHERE id = 'f9f7ecb2-3c5e-4254-964e-22727d152227') <> 500 THEN
    RAISE EXCEPTION 'Sachet Water stock is no longer 500 -- nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_movements
              WHERE product_id = 'f9f7ecb2-3c5e-4254-964e-22727d152227'
                AND id NOT IN ('7d977d87-9811-4ac2-a20c-51556897e77b',
                               '53888f82-a18c-4fa5-a833-0a7b9f5e65e4',
                               '222d3526-4d57-435e-94c2-496c6c2b620c')) THEN
    RAISE EXCEPTION 'Sachet Water has newer stock movements -- nothing was changed';
  END IF;
END $$;

DELETE FROM public.workflow_approval_history
 WHERE entity_id IN ('74afcea8-5dd8-4d79-a4fb-85f6915fb509',
                     '49f2772f-3e43-4297-977c-f678d47f3ee3',
                     '7a040148-563a-4d45-920d-cd4efb9f3078');

DELETE FROM public.inventory_movements
 WHERE id IN ('af1a2d47-cb84-4feb-8e02-8c60d09e21f4',  -- 50cl  +500 (22144)
              '671a5d53-251f-4eb2-b227-95ad8cf00fc9',  -- 50cl  -500 (product deleted)
              '7d977d87-9811-4ac2-a20c-51556897e77b',  -- Sachet +500 (10949)
              '53888f82-a18c-4fa5-a833-0a7b9f5e65e4',  -- Sachet -500 (10949 reversed)
              '222d3526-4d57-435e-94c2-496c6c2b620c'); -- Sachet +500 (30053)

-- production_corrections rows go with their batch (ON DELETE CASCADE).
DELETE FROM public.production
 WHERE id IN ('74afcea8-5dd8-4d79-a4fb-85f6915fb509',
              '49f2772f-3e43-4297-977c-f678d47f3ee3',
              '7a040148-563a-4d45-920d-cd4efb9f3078');

-- Dropping to 0 would otherwise auto-raise a production request.
ALTER TABLE public.products DISABLE TRIGGER trg_auto_reorder_production_request;
UPDATE public.products
   SET current_stock = 0, updated_at = now()
 WHERE id = 'f9f7ecb2-3c5e-4254-964e-22727d152227';
ALTER TABLE public.products ENABLE TRIGGER trg_auto_reorder_production_request;

UPDATE public.recycle_bin
   SET details = details || '{"stock_written_off": 0}'::jsonb
 WHERE id = 'af216048-6d3d-498e-96f8-2efaefbc0812';

COMMIT;

SELECT
  (SELECT count(*) FROM public.production
    WHERE production_number IN ('PRD20261022-22144', 'PRD20261022-10949',
                                'PRD20261022-30053'))                     AS runs_left,
  (SELECT count(*) FROM public.production_corrections
    WHERE production_id IN ('74afcea8-5dd8-4d79-a4fb-85f6915fb509',
                            '49f2772f-3e43-4297-977c-f678d47f3ee3',
                            '7a040148-563a-4d45-920d-cd4efb9f3078'))      AS corrections_left,
  (SELECT current_stock FROM public.products
    WHERE id = 'f9f7ecb2-3c5e-4254-964e-22727d152227')                    AS sachet_water_stock,
  'RUNS CLEARED'                                                           AS result;
