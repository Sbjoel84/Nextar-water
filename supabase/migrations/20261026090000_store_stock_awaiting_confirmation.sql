-- ============================================================================
-- STORE — stock held by sales orders awaiting confirmation
-- ----------------------------------------------------------------------------
-- create_sale() only posts an order (status pending_approval); stock is
-- decremented later, when the cashier / accountant confirms it via
-- confirm_sale() -> approve_sale(). Goods usually leave the store as soon as
-- the order is posted, so products.current_stock overstates what is
-- physically there until every order is confirmed (e.g. 2,800 bags of sachet
-- water across 29 unconfirmed orders on 2026-10-26 while the store showed
-- 1,799).
--
-- Store users can't read sales / sale_items (sales module RLS), so this
-- returns, per product, the quantity sitting in unconfirmed orders. The store
-- page shows Available = current_stock - awaiting. Van sales (sales_rep_id
-- set) come out of rep_stock, not the store, so they are left out.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.store_stock_awaiting_confirmation(p_factory_id uuid)
RETURNS TABLE(product_id uuid, quantity numeric, orders bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
          OR public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN QUERY
  SELECT si.product_id, sum(si.quantity)::numeric, count(DISTINCT s.id)
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
   WHERE s.factory_id = p_factory_id
     AND s.status = 'pending_approval'
     AND s.deleted_at IS NULL
     AND s.sales_rep_id IS NULL
   GROUP BY si.product_id;
END;
$$;

REVOKE ALL ON FUNCTION public.store_stock_awaiting_confirmation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_stock_awaiting_confirmation(uuid) TO authenticated;
