-- ============================================================================
-- Product price list on the Costing page.
-- ----------------------------------------------------------------------------
-- Selling prices could only be set by approving a costing sheet, so every
-- product sat at 0 and sales persons typed prices into Sales & POS by hand.
-- The Costing page now has a "Product Prices" tab where the price list is
-- kept; Sales & POS fills each line's unit price from it and the sales person
-- only enters the quantity.
--
-- set_product_price() is the only way to change a price from that tab:
-- costing officers (costing edit) and the accountant / chairman (costing
-- approve) may use it. Every change is audit-logged, and the existing
-- products_price_history trigger keeps the price history.
-- Anyone with Costing access may also read the product list it edits.
-- ============================================================================

DROP POLICY IF EXISTS "costing read products" ON public.products;
CREATE POLICY "costing read products" ON public.products FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'costing'::module_key, 'read'::action_key));

CREATE OR REPLACE FUNCTION public.set_product_price(p_product_id uuid, p_price numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_product products%ROWTYPE;
BEGIN
  IF NOT (public.has_permission(v_uid, 'costing'::module_key, 'edit'::action_key)
          OR public.has_permission(v_uid, 'costing'::module_key, 'approve'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_price IS NULL OR p_price < 0 THEN RAISE EXCEPTION 'Enter a valid price'; END IF;

  SELECT * INTO v_product FROM products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.unit_price = p_price THEN
    RETURN jsonb_build_object('product_id', p_product_id, 'unit_price', p_price, 'changed', false);
  END IF;

  UPDATE products SET unit_price = round(p_price, 2), updated_at = now() WHERE id = p_product_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_product.factory_id, 'set_product_price', 'products', p_product_id::text,
          jsonb_build_object('unit_price', v_product.unit_price),
          jsonb_build_object('unit_price', round(p_price, 2)));

  RETURN jsonb_build_object('product_id', p_product_id, 'unit_price', round(p_price, 2), 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.set_product_price(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_product_price(uuid, numeric) TO authenticated;
