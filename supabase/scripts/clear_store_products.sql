-- ============================================================================
-- CLEAR THE STORE — remove every finished product from the Store page
-- ----------------------------------------------------------------------------
-- THIS CANNOT BE UNDONE. All-or-nothing: if anything fails, NOTHING changes.
--
-- What it does, in every factory:
--
--   * DELETES every product that has no history (never sold, produced,
--     moved, dispatched or returned). Its packaging rules and price history go
--     with it.
--
--   * DEACTIVATES every product that does have history. Sales, invoices,
--     production and stock records must keep naming the product, so it can't
--     be deleted -- instead it is set inactive with 0 stock, which removes it
--     from the Store page, Sales & POS and every product dropdown. Reports
--     and old invoices still show it.
--
--   * Raw materials (Inventory page) are NOT touched.
--
-- Tip: running go_live_reset.sql first clears the transaction history, so
-- this script can then delete every product outright.
--
-- Run the whole file in the Supabase SQL Editor. The result at the bottom
-- shows what happened.
-- ============================================================================

BEGIN;

-- Zeroing stock would otherwise fire the automatic re-order trigger.
ALTER TABLE public.products DISABLE TRIGGER trg_auto_reorder_production_request;

CREATE TEMP TABLE _store_clear (product_id uuid, name text, outcome text) ON COMMIT DROP;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id, name FROM public.products ORDER BY name LOOP
    BEGIN
      DELETE FROM public.products WHERE id = r.id;
      INSERT INTO _store_clear VALUES (r.id, r.name, 'deleted');
    EXCEPTION WHEN foreign_key_violation THEN
      -- Referenced by sales / production / stock history: keep, but retire.
      UPDATE public.products
         SET active = false, current_stock = 0, updated_at = now()
       WHERE id = r.id;
      INSERT INTO _store_clear VALUES (r.id, r.name, 'deactivated (has history)');
    END;
  END LOOP;
END $$;

ALTER TABLE public.products ENABLE TRIGGER trg_auto_reorder_production_request;

SELECT outcome, count(*) AS products, string_agg(name, ', ' ORDER BY name) AS names
  FROM _store_clear
 GROUP BY outcome
UNION ALL
SELECT 'still on the Store page', count(*), NULL FROM public.products WHERE active;

COMMIT;
