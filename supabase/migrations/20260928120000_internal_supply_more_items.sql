-- ============================================================================
-- INTERNAL SUPPLY — more Nylon items feeding Water's raw materials
-- ----------------------------------------------------------------------------
-- 20260928090000 linked Nylon's Malula pure water rolls to a Water raw
-- material so every confirmed batch goes straight into raw materials. This
-- extends the same mechanism to more items and adds a second mode for items
-- the business both SELLS and USES:
--
--   products.supply_mode
--     'auto'      — produced only to be used: every batch Store confirms
--                   bypasses finished goods and lands in the linked raw
--                   material (the existing Malula behaviour).
--     'on_demand' — produced to be sold AND used: confirmed batches enter
--                   finished-goods stock as normal (so Sales can sell them),
--                   and Store moves what's needed into the linked raw
--                   material with transfer_product_to_material() (Finished
--                   Goods > Transfer). Both pages stay balanced: finished
--                   goods goes down by exactly what raw materials goes up.
--
-- Links seeded here (Nylon product -> Water raw material):
--   Printed Pure Water Rolls -> MALULA PURE WATER ROLL  auto   (re-pointed:
--       the earlier '%malula%' match wrongly picked MALULA CAP)
--   PACKING BAG NYLON        -> PURE WATER PACKING BAG  auto
--   DISPENSER PACKING BAG    -> DISPENSER PACKING BAG   auto   (product created)
--   Shrink                   -> SHRINK WRAP             on_demand
-- Any other product can be linked from Finished Goods > Edit via
-- set_product_supply_link() (e.g. the bottle-water printed roll).
-- ============================================================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS supply_mode text NOT NULL DEFAULT 'auto';
DO $$ BEGIN
  ALTER TABLE public.products
    ADD CONSTRAINT products_supply_mode_check CHECK (supply_mode IN ('auto', 'on_demand'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============ seed links ============
DO $$
DECLARE
  v_nylon uuid;
  v_water uuid;
  v_product uuid;
  v_unit text;
  v_material uuid;
  r record;
BEGIN
  SELECT id INTO v_nylon FROM public.factories WHERE code = 'nylon';
  SELECT id INTO v_water FROM public.factories WHERE code = 'water';
  IF v_nylon IS NULL OR v_water IS NULL THEN RAISE EXCEPTION 'Water/Nylon factory not found'; END IF;

  -- Dispenser packing bag doesn't exist as a Nylon product yet.
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE factory_id = v_nylon AND name ILIKE '%dispenser%packing%') THEN
    INSERT INTO public.products (factory_id, name, unit, product_type)
    VALUES (v_nylon, 'DISPENSER PACKING BAG', 'BUNDLE', 'finished');
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      -- product match,            material match,        material exclude, new material name,        mode
      ('printed pure water roll%', '%malula%roll%',       NULL,             'MALULA PURE WATER ROLL', 'auto'),
      ('packing bag nylon',        '%packing bag%',       '%dispenser%',    'PURE WATER PACKING BAG', 'auto'),
      ('%dispenser%packing%',      '%dispenser%packing%', NULL,             'DISPENSER PACKING BAG',  'auto'),
      ('shrink%',                  '%shrink%',            NULL,             'SHRINK WRAP',            'on_demand')
    ) AS t(p_match, m_match, m_excl, m_name, mode)
  LOOP
    SELECT id, unit INTO v_product, v_unit FROM public.products
      WHERE factory_id = v_nylon AND name ILIKE r.p_match
      ORDER BY created_at LIMIT 1;
    IF v_product IS NULL THEN
      RAISE NOTICE 'internal supply: no Nylon product matching %, skipped', r.p_match;
      CONTINUE;
    END IF;

    SELECT id INTO v_material FROM public.raw_materials
      WHERE factory_id = v_water AND name ILIKE r.m_match
        AND (r.m_excl IS NULL OR name NOT ILIKE r.m_excl)
      ORDER BY active DESC, created_at LIMIT 1;
    IF v_material IS NULL THEN
      INSERT INTO public.raw_materials (factory_id, name, category, unit, opening_stock, current_stock, unit_cost, current_value,
                                        reorder_level, remarks, approval_status, active)
      VALUES (v_water, r.m_name, 'Packaging', v_unit, 0, 0, 0, 0, 0,
              'Supplied internally by the Nylon factory', 'approved', true)
      RETURNING id INTO v_material;
    END IF;

    UPDATE public.products SET transfer_to_material_id = v_material, supply_mode = r.mode WHERE id = v_product;
  END LOOP;
END $$;

-- ============ confirm_production_batch(): only 'auto' links bypass finished goods ============
CREATE OR REPLACE FUNCTION public.confirm_production_batch(p_id uuid, p_actual_received numeric, p_damaged numeric, p_rejected numeric, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_row production%ROWTYPE; v_accepted numeric; v_before numeric; v_cost_price numeric;
  v_transfer_to uuid; v_material raw_materials%ROWTYPE; v_move_cost numeric;
  v_from_name text; v_to_name text; v_supply_mode text;
BEGIN
  SELECT * INTO v_row FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production batch not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::public.module_key, 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Store confirmation must be done by someone other than who recorded the batch';
  END IF;
  IF p_actual_received IS NULL OR p_actual_received < 0 THEN RAISE EXCEPTION 'Actual quantity received must be >= 0'; END IF;
  IF COALESCE(p_damaged,0) < 0 OR COALESCE(p_rejected,0) < 0 THEN RAISE EXCEPTION 'Damaged/rejected quantities cannot be negative'; END IF;
  IF COALESCE(p_damaged,0) + COALESCE(p_rejected,0) > p_actual_received THEN
    RAISE EXCEPTION 'Damaged + rejected cannot exceed actual quantity received';
  END IF;
  v_accepted := p_actual_received - COALESCE(p_damaged,0) - COALESCE(p_rejected,0);

  PERFORM public.assert_valid_transition(v_row.status, 'confirmed');
  UPDATE production SET
    actual_quantity_received = p_actual_received, damaged_quantity = COALESCE(p_damaged,0),
    rejected_quantity = COALESCE(p_rejected,0), accepted_quantity = v_accepted,
    confirmed_by = v_uid, confirmed_at = now(), status = 'confirmed'
  WHERE id = p_id;
  PERFORM public.record_workflow_action('production', p_id, 'confirm', v_row.status, 'confirmed', p_comment);

  PERFORM public.assert_valid_transition('confirmed', 'posted');
  SELECT current_stock, cost_price, transfer_to_material_id, supply_mode INTO v_before, v_cost_price, v_transfer_to, v_supply_mode
    FROM products WHERE id = v_row.product_id FOR UPDATE;
  -- on_demand products are also sold: they enter finished goods like any other
  -- product and are moved to the raw material later via transfer_product_to_material().
  IF v_supply_mode IS DISTINCT FROM 'auto' THEN v_transfer_to := NULL; END IF;

  IF v_transfer_to IS NOT NULL THEN
    -- Internal supply: the batch goes straight into the other factory's raw
    -- material; finished-goods stock is left untouched.
    SELECT * INTO v_material FROM raw_materials WHERE id = v_transfer_to FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Linked raw material for this product no longer exists'; END IF;
    v_move_cost := CASE
      WHEN COALESCE(v_row.production_cost,0) > 0 AND v_accepted > 0 THEN v_row.production_cost / v_accepted
      WHEN COALESCE(v_cost_price,0) > 0 THEN v_cost_price
      ELSE COALESCE(v_material.unit_cost,0) END;
    SELECT name INTO v_from_name FROM factories WHERE id = v_row.factory_id;
    SELECT name INTO v_to_name FROM factories WHERE id = v_material.factory_id;

    IF v_accepted > 0 THEN
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_row.factory_id, v_row.product_id, 'produced', v_accepted, v_row.production_number,
              'Production batch confirmed by Store', v_uid, v_before, v_before + v_accepted),
             (v_row.factory_id, v_row.product_id, 'transferred', -v_accepted, v_row.production_number,
              'Sent to ' || COALESCE(v_to_name,'other factory') || ' raw materials: ' || v_material.name, v_uid, v_before + v_accepted, v_before);

      UPDATE raw_materials SET
        current_stock = current_stock + v_accepted,
        current_value = current_value + v_accepted * v_move_cost,
        updated_at = now()
      WHERE id = v_material.id;
      INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_material.factory_id, v_material.id, 'transferred', v_accepted, v_move_cost,
              'From ' || COALESCE(v_from_name,'other factory') || ' · ' || v_row.production_number,
              'Internal supply — production batch confirmed by Store', v_uid,
              v_material.current_stock, v_material.current_stock + v_accepted);
    END IF;
    UPDATE production SET status = 'posted', transferred_material_id = v_material.id WHERE id = p_id;
  ELSE
    UPDATE products SET current_stock = current_stock + v_accepted, updated_at = now() WHERE id = v_row.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.product_id, 'produced', v_accepted, v_row.production_number,
            'Production batch confirmed by Store', v_uid, v_before, v_before + v_accepted);
    UPDATE production SET status = 'posted' WHERE id = p_id;
  END IF;
  PERFORM public.record_workflow_action('production', p_id, 'post', 'confirmed', 'posted', p_comment);

  IF COALESCE(p_damaged,0) > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.production_number, v_row.product_id, p_damaged, v_row.unit, v_cost_price, 'Damaged during Store confirmation', v_uid, 'posted');
  END IF;
  IF COALESCE(p_rejected,0) > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.production_number, v_row.product_id, p_rejected, v_row.unit, v_cost_price, 'Rejected during Store confirmation', v_uid, 'posted');
  END IF;

  IF v_transfer_to IS NOT NULL THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_row.factory_id, 'confirm_production_batch', 'production', p_id::text,
            jsonb_build_object('material_stock', v_material.current_stock),
            jsonb_build_object('transferred_to_material', v_material.id, 'material_stock', v_material.current_stock + v_accepted,
                               'accepted_quantity', v_accepted, 'unit_cost', v_move_cost));
    RETURN jsonb_build_object('confirmed', true, 'posted', true, 'accepted_quantity', v_accepted,
                              'transferred_to', v_material.name, 'transferred_to_factory', v_to_name);
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'confirm_production_batch', 'production', p_id::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_accepted, 'accepted_quantity', v_accepted));

  RETURN jsonb_build_object('confirmed', true, 'posted', true, 'accepted_quantity', v_accepted);
END; $function$;

-- ============ transfer_product_to_material(): move sellable stock into the linked raw material ============
CREATE OR REPLACE FUNCTION public.transfer_product_to_material(p_product_id uuid, p_quantity numeric, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_product products%ROWTYPE;
  v_material raw_materials%ROWTYPE;
  v_cost numeric;
  v_from_name text;
  v_to_name text;
  v_ref text;
BEGIN
  IF NOT public.has_permission(v_uid, 'finished-goods'::public.module_key, 'write'::public.action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  SELECT * INTO v_product FROM products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.transfer_to_material_id IS NULL THEN
    RAISE EXCEPTION '% is not linked to a raw material', v_product.name;
  END IF;
  IF v_product.current_stock < p_quantity THEN
    RAISE EXCEPTION 'Insufficient stock: have %, need %', v_product.current_stock, p_quantity;
  END IF;

  SELECT * INTO v_material FROM raw_materials WHERE id = v_product.transfer_to_material_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Linked raw material for this product no longer exists'; END IF;

  v_cost := CASE WHEN COALESCE(v_product.cost_price, 0) > 0 THEN v_product.cost_price
                 ELSE public.avg_unit_cost(v_material.current_value, v_material.current_stock, v_material.unit_cost) END;
  SELECT name INTO v_from_name FROM factories WHERE id = v_product.factory_id;
  SELECT name INTO v_to_name FROM factories WHERE id = v_material.factory_id;
  v_ref := 'TRM-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  UPDATE products SET current_stock = current_stock - p_quantity, updated_at = now() WHERE id = v_product.id;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_product.factory_id, v_product.id, 'transferred', -p_quantity, v_ref,
          'Sent to ' || COALESCE(v_to_name, 'other factory') || ' raw materials: ' || v_material.name
            || COALESCE(' — ' || NULLIF(trim(p_reason), ''), ''),
          v_uid, v_product.current_stock, v_product.current_stock - p_quantity);

  UPDATE raw_materials SET
    current_stock = current_stock + p_quantity,
    current_value = current_value + p_quantity * v_cost,
    updated_at = now()
  WHERE id = v_material.id;
  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_material.factory_id, v_material.id, 'transferred', p_quantity, v_cost,
          'From ' || COALESCE(v_from_name, 'other factory') || ' · ' || v_ref,
          'Internal supply — transferred from finished goods: ' || v_product.name
            || COALESCE(' — ' || NULLIF(trim(p_reason), ''), ''),
          v_uid, v_material.current_stock, v_material.current_stock + p_quantity);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_product.factory_id, 'transfer_product_to_material', 'products', v_product.id::text,
          jsonb_build_object('current_stock', v_product.current_stock, 'material_stock', v_material.current_stock),
          jsonb_build_object('current_stock', v_product.current_stock - p_quantity,
                             'material_id', v_material.id, 'material_stock', v_material.current_stock + p_quantity,
                             'quantity', p_quantity, 'unit_cost', v_cost, 'reference', v_ref));

  RETURN jsonb_build_object('reference', v_ref, 'material', v_material.name, 'factory', v_to_name, 'unit_cost', v_cost);
END;
$$;
REVOKE ALL ON FUNCTION public.transfer_product_to_material(uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_product_to_material(uuid, numeric, text) TO authenticated;

-- ============ set_product_supply_link(): link/unlink a product from Finished Goods > Edit ============
-- transfer_to_material_id / supply_mode are not in the products column grant,
-- so changes go through this audited RPC.
CREATE OR REPLACE FUNCTION public.set_product_supply_link(p_product_id uuid, p_material_id uuid, p_mode text DEFAULT 'auto')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row products%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'finished-goods'::public.module_key, 'write'::public.action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_mode NOT IN ('auto', 'on_demand') THEN RAISE EXCEPTION 'Invalid supply mode: %', p_mode; END IF;
  SELECT * INTO v_row FROM products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF p_material_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM raw_materials WHERE id = p_material_id) THEN
    RAISE EXCEPTION 'Raw material not found';
  END IF;
  IF v_row.transfer_to_material_id IS NOT DISTINCT FROM p_material_id AND v_row.supply_mode = p_mode THEN RETURN; END IF;

  UPDATE products SET transfer_to_material_id = p_material_id, supply_mode = p_mode, updated_at = now() WHERE id = p_product_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'set_product_supply_link', 'products', p_product_id::text,
          jsonb_build_object('transfer_to_material_id', v_row.transfer_to_material_id, 'supply_mode', v_row.supply_mode),
          jsonb_build_object('transfer_to_material_id', p_material_id, 'supply_mode', p_mode));
END;
$$;
REVOKE ALL ON FUNCTION public.set_product_supply_link(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_product_supply_link(uuid, uuid, text) TO authenticated;
