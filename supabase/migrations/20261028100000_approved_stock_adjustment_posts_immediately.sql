-- ============================================================================
-- Approving a stock adjustment now updates stock straight away.
-- ----------------------------------------------------------------------------
-- Adjust Stock (old quantity -> new quantity) was a three-step flow: submit,
-- approve, then a separate "Post" by someone other than the submitter. Only
-- Post changed current_stock, so approved entries sat at "approved" and every
-- material kept showing its old (zero / low) stock.
--
-- 1. _apply_stock_adjustment(): the stock-changing body of
--    post_stock_adjustment(), unchanged, without the permission checks.
-- 2. post_stock_adjustment(): same checks as before, then step 1. Still used
--    for anything left at "approved".
-- 3. approve_stock_adjustment(): once the required approvals are in, applies
--    the adjustment in the same transaction (approve = post). Dual control is
--    kept: the submitter still cannot approve their own entry.
-- 4. Every adjustment already sitting at "approved" is applied now.
--
-- Safe to run in the Supabase SQL Editor.
-- ============================================================================

BEGIN;

-- ---------- 1. apply an approved adjustment ----------
CREATE OR REPLACE FUNCTION public._apply_stock_adjustment(p_id uuid, p_uid uuid, p_comment text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key;
  v_before numeric; v_before_value numeric; v_unit_cost numeric; v_unit text; v_move_cost numeric;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  PERFORM public.assert_valid_transition(v_req.status, 'posted');

  IF v_req.entity_type = 'raw_material' THEN
    SELECT current_stock, current_value, unit_cost, unit INTO v_before, v_before_value, v_unit_cost, v_unit FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
    IF v_req.quantity_delta >= 0 THEN
      v_move_cost := v_unit_cost;
    ELSE
      v_move_cost := public.avg_unit_cost(v_before_value, v_before, v_unit_cost);
    END IF;
    UPDATE raw_materials SET
      current_stock = current_stock + v_req.quantity_delta,
      current_value = v_before_value + v_req.quantity_delta * v_move_cost,
      updated_at = now()
    WHERE id = v_req.material_id;
    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.material_id, v_req.movement_type::movement_type, v_req.quantity_delta, v_move_cost, 'Stock adjustment',
            COALESCE(v_req.reason, 'Stock adjustment'), p_uid, v_before, v_before + v_req.quantity_delta);
  ELSE
    SELECT current_stock, cost_price, unit INTO v_before, v_unit_cost, v_unit FROM products WHERE id = v_req.product_id FOR UPDATE;
    v_move_cost := v_unit_cost;
    UPDATE products SET current_stock = current_stock + v_req.quantity_delta, updated_at = now() WHERE id = v_req.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.product_id, v_req.movement_type::movement_type, v_req.quantity_delta, 'Stock adjustment',
            COALESCE(v_req.reason, 'Stock adjustment'), p_uid, v_before, v_before + v_req.quantity_delta);
  END IF;

  IF v_req.movement_type = 'damaged' THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, material_id, quantity, unit, unit_cost, reason, reported_by, approved_by, status)
    VALUES (v_req.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            CASE WHEN v_req.entity_type = 'finished_good' THEN 'STORE' ELSE 'INVENTORY' END,
            p_id::text, v_req.product_id, v_req.material_id, abs(v_req.quantity_delta), v_unit, v_move_cost,
            v_req.reason, v_req.submitted_by, p_uid, 'posted');
  END IF;

  UPDATE stock_adjustment_requests SET status = 'posted', reviewed_by = p_uid, reviewed_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action(v_module, p_id, 'post', v_req.status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (p_uid, v_req.factory_id, 'post_stock_adjustment', v_req.entity_type, COALESCE(v_req.material_id, v_req.product_id)::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_req.quantity_delta));
  RETURN jsonb_build_object('posted', true, 'current_stock', v_before + v_req.quantity_delta);
END; $function$;
REVOKE ALL ON FUNCTION public._apply_stock_adjustment(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- ---------- 2. post (for anything left at "approved") ----------
CREATE OR REPLACE FUNCTION public.post_stock_adjustment(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot post a stock adjustment you submitted yourself';
  END IF;
  RETURN public._apply_stock_adjustment(p_id, v_uid, p_comment);
END; $function$;

-- ---------- 3. approve = post ----------
CREATE OR REPLACE FUNCTION public.approve_stock_adjustment(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key; v_progress record;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot approve a stock adjustment you submitted yourself';
  END IF;

  PERFORM public.record_workflow_action(v_module, p_id, 'approve', v_req.status, v_req.status, p_comment);
  SELECT * INTO v_progress FROM public.workflow_approval_progress(v_module, p_id);
  IF NOT v_progress.satisfied THEN
    RETURN jsonb_build_object('approved', false, 'partial', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
  END IF;

  PERFORM public.assert_valid_transition(v_req.status, 'approved');
  UPDATE stock_adjustment_requests SET status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  PERFORM public._apply_stock_adjustment(p_id, v_uid, p_comment);
  RETURN jsonb_build_object('approved', true, 'posted', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
END; $function$;

-- ---------- 4. apply everything already approved ----------
DO $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT id, reviewed_by FROM stock_adjustment_requests WHERE status = 'approved' ORDER BY reviewed_at, submitted_at LOOP
    PERFORM public._apply_stock_adjustment(r.id, r.reviewed_by, 'Applied on approval (backfill)');
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'Applied % approved stock adjustment(s)', n;
END $$;

COMMIT;

-- Stock now on hand, raw materials (check the entries you made appear here).
SELECT name, current_stock, unit FROM public.raw_materials WHERE active ORDER BY name;
