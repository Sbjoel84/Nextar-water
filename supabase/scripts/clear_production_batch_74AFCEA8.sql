-- ============================================================================
-- Clear production batch #74AFCEA8 (PRD20261022-22144: 500 x Sachet Water 50cl)
-- ----------------------------------------------------------------------------
-- THIS CANNOT BE UNDONE. All-or-nothing: if anything fails, NOTHING changes.
--
-- The batch's product (Sachet Water 50cl) was already deleted -- its 500
-- units were written off and its stock is 0; none of it was ever sold. So
-- removing the batch changes no stock figure. This removes:
--   * the batch itself, and its pending delete-correction request (cascade)
--   * its approval history (submit / confirm / post)
--   * the product's two stock movements: +500 when the batch was confirmed
--     and -500 when the product was deleted -- they cancel out
-- and sets the product's recycle-bin entry to put back 0 units (not 500) if
-- Sachet Water 50cl is ever restored, since the batch that produced those
-- units no longer exists.
--
-- Run the whole file in the Supabase SQL Editor.
-- ============================================================================

BEGIN;

DELETE FROM public.workflow_approval_history
 WHERE entity_id = '74afcea8-5dd8-4d79-a4fb-85f6915fb509';

DELETE FROM public.inventory_movements
 WHERE id IN ('af1a2d47-cb84-4feb-8e02-8c60d09e21f4', '671a5d53-251f-4eb2-b227-95ad8cf00fc9');

DELETE FROM public.production
 WHERE id = '74afcea8-5dd8-4d79-a4fb-85f6915fb509';

UPDATE public.recycle_bin
   SET details = details || '{"stock_written_off": 0}'::jsonb
 WHERE id = 'af216048-6d3d-498e-96f8-2efaefbc0812';

COMMIT;

SELECT
  (SELECT count(*) FROM public.production
    WHERE id = '74afcea8-5dd8-4d79-a4fb-85f6915fb509')                    AS batch_left,
  (SELECT count(*) FROM public.production_corrections
    WHERE production_id = '74afcea8-5dd8-4d79-a4fb-85f6915fb509')         AS corrections_left,
  (SELECT current_stock FROM public.products
    WHERE id = '726921d1-3772-4bd3-903c-0caa064f822b')                    AS sachet_50cl_stock,
  'BATCH CLEARED'                                                          AS result;
