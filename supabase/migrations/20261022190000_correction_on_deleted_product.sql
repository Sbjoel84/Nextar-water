-- A production correction (edit or delete) on a batch whose product has since
-- been deleted failed with "Not enough stock to apply this correction": deleting
-- the product already wrote its stock off to 0 and parked the quantity in the
-- recycle bin (details.stock_written_off), so the batch's units are no longer in
-- products.current_stock to take out again.
--
-- For a deleted (inactive) product the correction now adjusts the recycle-bin
-- quantity instead, so restoring the product later puts back the right amount.
-- Everything else is unchanged from 20260928090000.

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
  v_active boolean;
  v_after numeric;
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

  SELECT current_stock, cost_price, active INTO v_before, v_cost_price, v_active FROM products WHERE id = v_row.product_id FOR UPDATE;
  v_after := v_before + v_delta;

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
    v_after := v_material.current_stock + v_delta;
  ELSIF v_delta <> 0 AND NOT COALESCE(v_active, true) THEN
    -- Product was deleted: its stock was written off into the recycle bin, so
    -- the batch's units are no longer on the shelf. Correct the quantity a
    -- restore would put back instead of the (already zero) store stock.
    UPDATE recycle_bin
       SET details = details || jsonb_build_object('stock_written_off',
             GREATEST(COALESCE((details->>'stock_written_off')::numeric, 0) + v_delta, 0))
     WHERE table_name = 'products' AND entity_id = v_row.product_id;
    v_after := v_before;
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
          jsonb_build_object('kind', v_req.kind, 'accepted_quantity', v_new_accepted, 'current_stock', v_after,
                             'transferred_material_id', v_row.transferred_material_id));

  RETURN jsonb_build_object('approved', true, 'stock_delta', v_delta);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_production_correction(uuid, text) TO authenticated;
