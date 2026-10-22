-- ============================================================================
-- Store page "Return Product": what each Sales-Rep (marketer) can still bring
-- back, across every day -- not just the date picked in Sales-Rep Activity.
-- ----------------------------------------------------------------------------
-- Per rep and product: units supplied to them (posted sales to the rep's
-- customer account), minus units already returned (sales returns, any status
-- but cancelled). sale_id is the rep's latest supply sale for the product, so
-- the return is logged against it and inspection credits them at the price
-- they were charged (inspect_sales_return()).
--
-- SECURITY DEFINER for the same reason as store_rep_activity(): store users
-- read neither sales nor customers directly under RLS.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.store_rep_returnables(p_factory_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
          OR public.has_permission(auth.uid(), 'sales-returns'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'sales_rep_id', r.id,
             'customer_id', c.id,
             'name', r.full_name,
             'products', COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'product_id', x.product_id, 'product_name', x.name, 'unit', x.unit,
                        'supplied', x.supplied, 'returned', x.returned, 'sale_id', x.sale_id)
                      ORDER BY x.name)
                 FROM (
                   SELECT si.product_id, p.name, p.unit,
                          sum(si.quantity) AS supplied,
                          COALESCE((
                            SELECT sum(sr.quantity_returned) FROM sales_returns sr
                             WHERE sr.customer_id = c.id AND sr.product_id = si.product_id
                               AND sr.status <> 'cancelled'
                          ), 0) AS returned,
                          (array_agg(s.id ORDER BY s.created_at DESC))[1] AS sale_id
                     FROM sales s
                     JOIN sale_items si ON si.sale_id = s.id
                     JOIN products p ON p.id = si.product_id
                    WHERE s.customer_id = c.id AND s.factory_id = p_factory_id
                      AND s.status = 'posted' AND s.deleted_at IS NULL
                    GROUP BY si.product_id, p.name, p.unit
                 ) x
             ), '[]'::jsonb)
           ) ORDER BY r.full_name)
      FROM sales_reps r
      JOIN customers c ON c.sales_rep_id = r.id
     WHERE r.factory_id = p_factory_id
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.store_rep_returnables(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_rep_returnables(uuid) TO authenticated;
