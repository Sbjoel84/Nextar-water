-- ============================================================================
-- Edit products from the Costing page, and no more duplicate products.
-- ----------------------------------------------------------------------------
-- 1. Duplicates: "Bottle Water 50cl x 12" and "Bottle Water 75cl" each existed
--    more than once (empty copies, removed by hand on 2026-10-24). An active
--    product's name is now unique per factory (case/space-insensitive), so the
--    same product can't be added or renamed into a duplicate again.
-- 2. update_product_details(): the pencil on Costing → Product Prices edits a
--    product's name, size/type (sku, e.g. "50cl x 12"), unit and selling
--    price. Costing officers (costing edit), accountant / chairman (costing
--    approve) and Store (finished-goods edit) may use it. Stock and cost
--    price are untouched; every change is audit-logged.
-- 3. quick_add_product() also accepts Costing users, so products can be added
--    from the same tab.
-- ============================================================================

-- ---------- 1. one active product per name ----------
CREATE UNIQUE INDEX IF NOT EXISTS products_factory_active_name_key
  ON public.products (factory_id, lower(btrim(name)))
  WHERE active;

-- ---------- 2. edit a product ----------
CREATE OR REPLACE FUNCTION public.update_product_details(
  p_id uuid,
  p_name text,
  p_sku text,
  p_unit text,
  p_price numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old products%ROWTYPE;
  v_name text := btrim(COALESCE(p_name, ''));
  v_sku text := NULLIF(btrim(COALESCE(p_sku, '')), '');
  v_unit text := btrim(COALESCE(p_unit, ''));
BEGIN
  IF NOT (public.has_permission(v_uid, 'costing'::module_key, 'edit'::action_key)
          OR public.has_permission(v_uid, 'costing'::module_key, 'approve'::action_key)
          OR public.has_permission(v_uid, 'finished-goods'::module_key, 'edit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'Product name is required'; END IF;
  IF v_unit = '' THEN RAISE EXCEPTION 'Unit is required'; END IF;
  IF p_price IS NULL OR p_price < 0 THEN RAISE EXCEPTION 'Enter a valid price'; END IF;

  SELECT * INTO v_old FROM products WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;

  IF EXISTS (
    SELECT 1 FROM products
     WHERE factory_id = v_old.factory_id AND active AND id <> p_id
       AND lower(btrim(name)) = lower(v_name)
  ) THEN
    RAISE EXCEPTION '"%" already exists — each product can only be listed once', v_name;
  END IF;

  UPDATE products SET
    name = v_name, sku = v_sku, unit = v_unit,
    unit_price = round(p_price, 2), updated_at = now()
  WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_old.factory_id, 'update_product_details', 'products', p_id::text,
          jsonb_build_object('name', v_old.name, 'sku', v_old.sku, 'unit', v_old.unit, 'unit_price', v_old.unit_price),
          jsonb_build_object('name', v_name, 'sku', v_sku, 'unit', v_unit, 'unit_price', round(p_price, 2)));

  RETURN jsonb_build_object('id', p_id, 'name', v_name);
END;
$$;
REVOKE ALL ON FUNCTION public.update_product_details(uuid, text, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_product_details(uuid, text, text, text, numeric) TO authenticated;

-- ---------- 3. quick_add_product(): Costing may add products too ----------
CREATE OR REPLACE FUNCTION public.quick_add_product(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_name text := btrim(COALESCE(payload->>'name', ''));
  v_sku text := NULLIF(btrim(COALESCE(payload->>'sku', '')), '');
  v_unit text := btrim(COALESCE(payload->>'unit', ''));
  v_type text := COALESCE(NULLIF(payload->>'product_type', ''), 'finished');
  v_category uuid := NULLIF(payload->>'category_id', '')::uuid;
  v_price numeric := COALESCE((payload->>'unit_price')::numeric, 0);
  v_cost numeric := COALESCE((payload->>'cost_price')::numeric, 0);
  v_opening numeric := COALESCE((payload->>'current_stock')::numeric, 0);
  v_id uuid;
  v_ok boolean := false;
  v_mod text;
  v_act text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  FOREACH v_mod IN ARRAY ARRAY['finished-goods','sales','sales-returns','production','distribution','purchase-orders','costing'] LOOP
    FOREACH v_act IN ARRAY ARRAY['write','submit'] LOOP
      IF public.has_permission(v_uid, v_mod::module_key, v_act::action_key) THEN v_ok := true; END IF;
    END LOOP;
  END LOOP;
  -- Costing approvers (accountant / chairman) keep the price list too.
  IF public.has_permission(v_uid, 'costing'::module_key, 'approve'::action_key) THEN v_ok := true; END IF;
  IF NOT v_ok THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;

  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'Product name is required'; END IF;
  IF v_unit = '' THEN RAISE EXCEPTION 'Unit is required'; END IF;
  IF v_type NOT IN ('finished', 'semi_finished') THEN RAISE EXCEPTION 'Invalid product type'; END IF;
  IF v_price < 0 OR v_cost < 0 OR v_opening < 0 THEN RAISE EXCEPTION 'Price, cost and stock must be zero or more'; END IF;

  IF EXISTS (SELECT 1 FROM products WHERE factory_id = v_factory AND active
               AND lower(btrim(name)) = lower(v_name)) THEN
    RAISE EXCEPTION '"%" already exists — select it from the list', v_name;
  END IF;

  INSERT INTO products(factory_id, category_id, name, sku, unit, unit_price, cost_price, current_stock, active, product_type)
  VALUES (v_factory, v_category, v_name, v_sku, v_unit, v_price, v_cost, v_opening, true, v_type)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'create_new_product', 'products', v_id::text, payload);

  RETURN jsonb_build_object('id', v_id);
END; $$;
REVOKE ALL ON FUNCTION public.quick_add_product(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quick_add_product(jsonb) TO authenticated;
