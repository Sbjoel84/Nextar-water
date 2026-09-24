-- ============================================================================
-- INTERNAL SUPPLY — Nylon's Malula pure water rolls feed Water's raw materials
-- ----------------------------------------------------------------------------
-- The Nylon factory produces the printed Malula pure water rolls that the
-- Water factory uses to make sachet water. Until now a confirmed Nylon batch
-- landed in Nylon's finished-goods stock, and Water had to buy/receive the
-- same rolls separately as a raw material.
--
-- This links a finished product to a raw material in another factory
-- (products.transfer_to_material_id). When Store confirms a production batch
-- of a linked product (confirm_production_batch, Finished Goods page), the
-- accepted quantity BYPASSES the product's finished-goods stock and is
-- received straight into the linked raw material:
--   * products.current_stock is unchanged — Nylon's movement trail shows the
--     batch as 'produced' +qty then 'transferred' -qty so it still appears.
--   * raw_materials.current_stock / current_value increase ('transferred'
--     +qty in raw_material_movements, "From Nylon · PRD-…"), valued at the
--     batch's production cost per accepted unit (falls back to the product's
--     cost_price, then the material's unit_cost).
--   * production.transferred_material_id records where the batch went, so a
--     later correction (approve_production_correction) adjusts that raw
--     material instead of finished-goods stock — even if the link changes.
-- From there Water uses the rolls through the normal production request flow
-- (materials released on approval) to produce sachet water.
-- ============================================================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS transfer_to_material_id uuid REFERENCES public.raw_materials(id) ON DELETE SET NULL;
ALTER TABLE public.production
  ADD COLUMN IF NOT EXISTS transferred_material_id uuid REFERENCES public.raw_materials(id) ON DELETE SET NULL;

-- ============ seed the Malula roll link ============
DO $$
DECLARE
  v_nylon uuid;
  v_water uuid;
  v_product uuid;
  v_material uuid;
BEGIN
  SELECT id INTO v_nylon FROM public.factories WHERE code = 'nylon';
  SELECT id INTO v_water FROM public.factories WHERE code = 'water';
  IF v_nylon IS NULL OR v_water IS NULL THEN RAISE EXCEPTION 'Water/Nylon factory not found'; END IF;

  -- Nylon product: prefer one already named Malula, else the seeded
  -- "Printed Pure Water Rolls", else create it.
  SELECT id INTO v_product FROM public.products
    WHERE factory_id = v_nylon AND name ILIKE '%malula%' ORDER BY created_at LIMIT 1;
  IF v_product IS NULL THEN
    SELECT id INTO v_product FROM public.products
      WHERE factory_id = v_nylon AND name ILIKE '%pure water roll%' ORDER BY created_at LIMIT 1;
  END IF;
  IF v_product IS NULL THEN
    INSERT INTO public.products (factory_id, name, unit, product_type)
    VALUES (v_nylon, 'Malula Pure Water Rolls', 'rolls', 'finished')
    RETURNING id INTO v_product;
  END IF;

  -- Water raw material: reuse an existing Malula nylon material, else create it.
  SELECT id INTO v_material FROM public.raw_materials
    WHERE factory_id = v_water AND name ILIKE '%malula%' ORDER BY created_at LIMIT 1;
  IF v_material IS NULL THEN
    INSERT INTO public.raw_materials (factory_id, name, category, unit, opening_stock, current_stock, unit_cost, current_value,
                                      reorder_level, remarks, approval_status, active)
    VALUES (v_water, 'Malula Pure Water Nylon (Rolls)', 'Packaging', 'rolls', 0, 0, 0, 0,
            0, 'Supplied internally by the Nylon factory — received automatically when Store confirms a Nylon production batch',
            'approved', true)
    RETURNING id INTO v_material;
  END IF;

  UPDATE public.products SET transfer_to_material_id = v_material WHERE id = v_product;
END $$;

-- ============ confirm_production_batch(): route linked products to raw materials ============
CREATE OR REPLACE FUNCTION public.confirm_production_batch(p_id uuid, p_actual_received numeric, p_damaged numeric, p_rejected numeric, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_row production%ROWTYPE; v_accepted numeric; v_before numeric; v_cost_price numeric;
  v_transfer_to uuid; v_material raw_materials%ROWTYPE; v_move_cost numeric;
  v_from_name text; v_to_name text;
BEGIN
  SELECT * INTO v_row FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production batch not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production', 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
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
  SELECT current_stock, cost_price, transfer_to_material_id INTO v_before, v_cost_price, v_transfer_to
    FROM products WHERE id = v_row.product_id FOR UPDATE;

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

-- ============ approve_production_correction(): adjust the raw material for transferred batches ============
CREATE OR REPLACE FUNCTION public.approve_production_correction(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req production_corrections%ROWTYPE;
  v_row production%ROWTYPE;
  v_old_accepted numeric;
  v_new_accepted numeric;
  v_delta numeric;
  v_before numeric;
  v_cost_price numeric;
  v_material raw_materials%ROWTYPE;
  v_move_cost numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'production'::public.module_key, 'confirm'::public.action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_req FROM production_corrections WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Correction request not found'; END IF;
  IF v_req.review_status <> 'pending' THEN RAISE EXCEPTION 'Correction is already %', v_req.review_status; END IF;
  IF v_req.requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot approve a correction you requested yourself';
  END IF;

  SELECT * INTO v_row FROM production WHERE id = v_req.production_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production batch not found'; END IF;
  IF v_row.status <> 'posted' THEN RAISE EXCEPTION 'Batch is no longer posted (now %)', v_row.status; END IF;

  v_old_accepted := COALESCE(v_row.accepted_quantity, 0);
  IF v_req.kind = 'edit' THEN
    v_new_accepted := v_req.new_quantity_produced - COALESCE(v_req.new_damaged_quantity,0) - COALESCE(v_row.rejected_quantity,0);
    IF v_new_accepted < 0 THEN RAISE EXCEPTION 'Damaged + rejected cannot exceed quantity produced'; END IF;
  ELSE
    v_new_accepted := 0;
  END IF;
  v_delta := v_new_accepted - v_old_accepted;

  SELECT current_stock, cost_price INTO v_before, v_cost_price FROM products WHERE id = v_row.product_id FOR UPDATE;

  IF v_row.transferred_material_id IS NOT NULL THEN
    -- Batch went to another factory's raw material on confirmation — correct it there.
    SELECT * INTO v_material FROM raw_materials WHERE id = v_row.transferred_material_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The raw material this batch was sent to no longer exists'; END IF;
    v_before := v_material.current_stock;
    IF v_delta <> 0 THEN
      IF v_material.current_stock + v_delta < 0 THEN
        RAISE EXCEPTION 'Not enough % left to apply this correction: % in stock, correction removes %',
          v_material.name, v_material.current_stock, -v_delta;
      END IF;
      v_move_cost := public.avg_unit_cost(v_material.current_value, v_material.current_stock, v_material.unit_cost);
      UPDATE raw_materials SET
        current_stock = current_stock + v_delta,
        current_value = GREATEST(current_value + v_delta * v_move_cost, 0),
        updated_at = now()
      WHERE id = v_material.id;
      INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_material.factory_id, v_material.id, 'correction', v_delta, v_move_cost, v_row.production_number,
              CASE WHEN v_req.kind = 'edit' THEN 'Supplying batch corrected (approved by Store): ' ELSE 'Supplying batch deleted (approved by Store): ' END || v_req.reason,
              v_uid, v_material.current_stock, v_material.current_stock + v_delta);
    END IF;
  ELSIF v_delta <> 0 THEN
    IF v_before + v_delta < 0 THEN
      RAISE EXCEPTION 'Not enough stock to apply this correction: % in stock, correction removes %', v_before, -v_delta;
    END IF;
    UPDATE products SET current_stock = current_stock + v_delta, updated_at = now() WHERE id = v_row.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.product_id, 'adjusted', v_delta, v_row.production_number,
            CASE WHEN v_req.kind = 'edit' THEN 'Production correction approved by Store: ' ELSE 'Production batch deleted (approved by Store): ' END || v_req.reason,
            v_uid, v_before, v_before + v_delta);
  END IF;

  IF v_req.kind = 'edit' THEN
    DELETE FROM damage_records
      WHERE source_type = 'PRODUCTION' AND source_reference = v_row.production_number
        AND product_id = v_row.product_id AND reason LIKE 'Damaged%';
    IF COALESCE(v_req.new_damaged_quantity,0) > 0 THEN
      INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
      VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
              'PRODUCTION', v_row.production_number, v_row.product_id, v_req.new_damaged_quantity, v_row.unit, v_cost_price,
              'Damaged (production correction)', v_uid, 'posted');
    END IF;

    UPDATE production SET
      quantity_produced = v_req.new_quantity_produced,
      actual_quantity_received = v_req.new_quantity_produced,
      damaged_quantity = COALESCE(v_req.new_damaged_quantity,0),
      accepted_quantity = v_new_accepted,
      production_cost = COALESCE(v_req.new_production_cost, production_cost),
      production_date = COALESCE(v_req.new_production_date, production_date),
      remarks = v_req.new_remarks,
      packaging_unit = NULL,
      packaging_quantity = NULL
    WHERE id = v_row.id;
  ELSE
    DELETE FROM damage_records
      WHERE source_type = 'PRODUCTION' AND source_reference = v_row.production_number AND product_id = v_row.product_id;
    PERFORM public.assert_valid_transition(v_row.status, 'reversed');
    UPDATE production SET status = 'reversed', accepted_quantity = 0 WHERE id = v_row.id;
    IF v_row.production_request_id IS NOT NULL THEN
      UPDATE production_requests SET production_status = 'materials_issued'
      WHERE id = v_row.production_request_id AND production_status = 'completed';
    END IF;
    PERFORM public.record_workflow_action('production'::public.module_key, v_row.id, 'reverse'::public.action_key, 'posted', 'reversed', v_req.reason);
  END IF;

  UPDATE production_corrections SET
    review_status = 'approved', reviewed_by = v_uid, reviewed_at = now(), review_reason = p_comment
  WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_production_correction', 'production', v_row.id::text,
          v_req.old_values || jsonb_build_object('current_stock', v_before),
          jsonb_build_object('kind', v_req.kind, 'accepted_quantity', v_new_accepted, 'current_stock', v_before + v_delta,
                             'transferred_material_id', v_row.transferred_material_id));

  RETURN jsonb_build_object('approved', true, 'stock_delta', v_delta);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_production_correction(uuid, text) TO authenticated;
