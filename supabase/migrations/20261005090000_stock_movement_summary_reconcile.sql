-- ============================================================================
-- STOCK MOVEMENT SUMMARY — make every row reconcile:
--   Opening + Production - Sold - PR - Damages + Returned + Adjustments = Closing
-- ----------------------------------------------------------------------------
-- The original version (20260921090000) only surfaced produced/sold/PR/damaged,
-- but closing stock is the real balance after *every* movement. Movements of
-- any other type — notably 'returned' rows written when a sale is deleted
-- ("Sale deleted") or a sales return is accepted — changed Closing without
-- appearing in any column, so the row didn't add up (e.g. +100 bags of sachet
-- put back by a deleted sale on 2026-10-02).
--
-- Now:
--   * RETURNED  = 'returned' + 'return_from_rep' movements (stock coming back).
--   * ADJUSTMENTS = the net of everything else (stock adjustments, corrections,
--     rep dispatches, ...), computed as the residual so the row always balances.
--   * Opening/Closing are the true balance at p_start / p_end: last movement
--     before the boundary, else the quantity_before of the first movement after
--     it, else products.current_stock. Previously a product with no movement
--     inside the range fell straight back to current_stock, which is wrong for
--     past ranges when the product moved afterwards.
-- ============================================================================
DROP FUNCTION IF EXISTS public.get_stock_movement_summary(uuid, timestamptz, timestamptz);

CREATE FUNCTION public.get_stock_movement_summary(
  p_factory_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
RETURNS TABLE(
  product_id uuid,
  product_name text,
  unit text,
  opening_stock numeric,
  new_production numeric,
  quantity_sold numeric,
  pr numeric,
  damages numeric,
  returned numeric,
  adjustments numeric,
  closing_stock numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'sales-returns'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_factory_id IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      p.id,
      p.name,
      p.unit,
      COALESCE(
        (SELECT im.quantity_after FROM inventory_movements im
          WHERE im.product_id = p.id AND im.created_at < p_start
          ORDER BY im.created_at DESC, im.id DESC LIMIT 1),
        (SELECT im.quantity_before FROM inventory_movements im
          WHERE im.product_id = p.id AND im.created_at >= p_start
          ORDER BY im.created_at ASC, im.id ASC LIMIT 1),
        p.current_stock
      )::numeric AS opening,
      COALESCE(
        (SELECT im.quantity_after FROM inventory_movements im
          WHERE im.product_id = p.id AND im.created_at <= p_end
          ORDER BY im.created_at DESC, im.id DESC LIMIT 1),
        (SELECT im.quantity_before FROM inventory_movements im
          WHERE im.product_id = p.id AND im.created_at > p_end
          ORDER BY im.created_at ASC, im.id ASC LIMIT 1),
        p.current_stock
      )::numeric AS closing,
      COALESCE(m.prod, 0)::numeric AS prod,
      COALESCE(m.sold, 0)::numeric AS sold,
      COALESCE(m.pr, 0)::numeric AS pr,
      COALESCE(m.dmg, 0)::numeric AS dmg,
      COALESCE(m.ret, 0)::numeric AS ret
    FROM products p
    LEFT JOIN LATERAL (
      SELECT
        SUM(ABS(im.quantity)) FILTER (WHERE im.movement_type = 'produced') AS prod,
        SUM(ABS(im.quantity)) FILTER (WHERE im.movement_type = 'sold'
          AND COALESCE(im.reason, '') <> 'PR - complimentary, no charge') AS sold,
        SUM(ABS(im.quantity)) FILTER (WHERE im.movement_type = 'sold'
          AND im.reason = 'PR - complimentary, no charge') AS pr,
        SUM(ABS(im.quantity)) FILTER (WHERE im.movement_type = 'damaged') AS dmg,
        SUM(ABS(im.quantity)) FILTER (WHERE im.movement_type IN ('returned', 'return_from_rep')) AS ret
      FROM inventory_movements im
      WHERE im.product_id = p.id AND im.created_at >= p_start AND im.created_at <= p_end
    ) m ON true
    WHERE p.factory_id = p_factory_id AND p.active = true
  )
  SELECT
    b.id, b.name, b.unit,
    b.opening, b.prod, b.sold, b.pr, b.dmg, b.ret,
    (b.closing - b.opening - b.prod + b.sold + b.pr + b.dmg - b.ret) AS adjustments,
    b.closing
  FROM base b
  ORDER BY b.name;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_stock_movement_summary(uuid, timestamptz, timestamptz) TO authenticated;
