-- ============================================================================
-- PRODUCTION CORRECTIONS — edit/delete a posted batch via Store approval
-- ----------------------------------------------------------------------------
-- Once Store confirms a batch (confirm_production_batch) it is 'posted' and
-- its accepted quantity is already in products.current_stock, so Production
-- can no longer edit or cancel it directly. This adds a request/approve layer:
--   * Production (production:edit|create /production:delete|cancel) raises a correction
--     request — an edit (new quantity / damaged / cost / date / remarks) or a
--     delete — with a reason.
--   * Store (production:confirm, the same permission that confirms batches)
--     approves or rejects it on the Finished Goods page. Approval adjusts
--     finished-goods stock by the change in accepted quantity (an 'adjusted'
--     inventory movement, signed), rewrites the batch's damage record, and
--     for a delete moves the batch to 'reversed' (posted -> reversed is a
--     valid workflow transition) and reopens its production request.
-- Same segregation of duties as confirmation: the requester cannot approve
-- their own correction (super_admin / chairman excepted).
-- Batches still 'pending_confirmation' keep the direct edit/cancel path —
-- nothing has reached stock yet and Store still reviews them on confirmation.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.production_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  production_id uuid NOT NULL REFERENCES public.production(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('edit','delete')),
  old_values jsonb NOT NULL,
  new_quantity_produced numeric(14,3),
  new_damaged_quantity numeric(14,3),
  new_production_cost numeric(14,2),
  new_production_date date,
  new_remarks text,
  reason text NOT NULL,
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  requested_by_name text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  review_status public.review_status NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  review_reason text
);
GRANT SELECT ON public.production_corrections TO authenticated;
GRANT ALL ON public.production_corrections TO service_role;
ALTER TABLE public.production_corrections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "production corrections read" ON public.production_corrections;
CREATE POLICY "production corrections read" ON public.production_corrections FOR SELECT TO authenticated
  USING (
    requested_by = auth.uid()
    OR public.has_permission(auth.uid(), 'production'::public.module_key, 'confirm'::public.action_key)
    OR (
      public.has_permission(auth.uid(), 'production'::public.module_key, 'view'::public.action_key)
      AND public.has_production_scope_access(auth.uid(), factory_id)
    )
  );
-- INSERT/UPDATE are RPC-only (SECURITY DEFINER below).

DROP INDEX IF EXISTS production_corrections_one_pending;
CREATE UNIQUE INDEX production_corrections_one_pending ON public.production_corrections (production_id)
  WHERE review_status = 'pending';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'production_corrections') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.production_corrections;
  END IF;
END $$;

-- ============ request_production_correction(payload) ============
-- payload: { production_id, kind: 'edit'|'delete', reason,
--            quantity_produced?, damaged_quantity?, production_cost?,
--            production_date?, remarks? }   (edit fields in base unit)
CREATE OR REPLACE FUNCTION public.request_production_correction(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_prod_id uuid := (payload->>'production_id')::uuid;
  v_kind text := payload->>'kind';
  v_reason text := payload->>'reason';
  v_qty numeric := NULLIF(payload->>'quantity_produced','')::numeric;
  v_damaged numeric := COALESCE(NULLIF(payload->>'damaged_quantity','')::numeric, 0);
  v_cost numeric := NULLIF(payload->>'production_cost','')::numeric;
  v_date date := NULLIF(payload->>'production_date','')::date;
  v_remarks text := payload->>'remarks';
  v_row production%ROWTYPE;
  v_name text;
  v_id uuid;
BEGIN
  IF v_reason IS NULL OR btrim(v_reason) = '' THEN RAISE EXCEPTION 'A reason is required for a correction'; END IF;
  IF v_kind NOT IN ('edit','delete') THEN RAISE EXCEPTION 'kind must be edit or delete'; END IF;

  SELECT * INTO v_row FROM production WHERE id = v_prod_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production batch not found'; END IF;
  IF NOT (
       CASE WHEN v_kind = 'edit'
         THEN public.has_permission(v_uid, 'production'::public.module_key, 'edit'::public.action_key)
              OR public.has_permission(v_uid, 'production'::public.module_key, 'create'::public.action_key)
         ELSE public.has_permission(v_uid, 'production'::public.module_key, 'delete'::public.action_key)
              OR public.has_permission(v_uid, 'production'::public.module_key, 'cancel'::public.action_key)
       END)
     OR NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
    RAISE EXCEPTION 'Insufficient permissions for this factory';
  END IF;
  IF v_row.status <> 'posted' THEN
    RAISE EXCEPTION 'Only batches already posted to stock need a correction request (this one is %)', v_row.status;
  END IF;
  IF EXISTS (SELECT 1 FROM production_corrections WHERE production_id = v_prod_id AND review_status = 'pending') THEN
    RAISE EXCEPTION 'A correction for this batch is already awaiting Store approval';
  END IF;

  IF v_kind = 'edit' THEN
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    IF v_damaged < 0 THEN RAISE EXCEPTION 'Damaged quantity cannot be negative'; END IF;
    IF v_damaged + COALESCE(v_row.rejected_quantity,0) > v_qty THEN
      RAISE EXCEPTION 'Damaged + rejected cannot exceed quantity produced';
    END IF;
    IF v_cost IS NOT NULL AND v_cost < 0 THEN RAISE EXCEPTION 'Production cost cannot be negative'; END IF;
  END IF;

  SELECT full_name INTO v_name FROM profiles WHERE id = v_uid;

  INSERT INTO production_corrections(
    factory_id, production_id, kind, old_values,
    new_quantity_produced, new_damaged_quantity, new_production_cost, new_production_date, new_remarks,
    reason, requested_by, requested_by_name)
  VALUES (
    v_row.factory_id, v_prod_id, v_kind,
    jsonb_build_object(
      'quantity_produced', v_row.quantity_produced,
      'actual_quantity_received', v_row.actual_quantity_received,
      'damaged_quantity', v_row.damaged_quantity,
      'rejected_quantity', v_row.rejected_quantity,
      'accepted_quantity', v_row.accepted_quantity,
      'production_cost', v_row.production_cost,
      'production_date', v_row.production_date,
      'remarks', v_row.remarks),
    CASE WHEN v_kind = 'edit' THEN v_qty END,
    CASE WHEN v_kind = 'edit' THEN v_damaged END,
    CASE WHEN v_kind = 'edit' THEN COALESCE(v_cost, v_row.production_cost) END,
    CASE WHEN v_kind = 'edit' THEN COALESCE(v_date, v_row.production_date) END,
    CASE WHEN v_kind = 'edit' THEN v_remarks END,
    btrim(v_reason), v_uid, v_name)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'request_production_correction', 'production', v_prod_id::text,
          jsonb_build_object('correction_id', v_id, 'kind', v_kind, 'reason', v_reason));

  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_production_correction(jsonb) TO authenticated;

-- ============ approve_production_correction(id, comment) ============
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
  IF v_delta <> 0 THEN
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
    -- Replace the batch's "damaged" record with the corrected figure; the
    -- rejected-quantity record (Store's own count) is left as is.
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
          jsonb_build_object('kind', v_req.kind, 'accepted_quantity', v_new_accepted, 'current_stock', v_before + v_delta));

  RETURN jsonb_build_object('approved', true, 'stock_delta', v_delta);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_production_correction(uuid, text) TO authenticated;

-- ============ reject_production_correction(id, reason) ============
CREATE OR REPLACE FUNCTION public.reject_production_correction(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req production_corrections%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reject a correction'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::public.module_key, 'confirm'::public.action_key)
     AND NOT public.has_permission(v_uid, 'production'::public.module_key, 'reject'::public.action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_req FROM production_corrections WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Correction request not found'; END IF;
  IF v_req.review_status <> 'pending' THEN RAISE EXCEPTION 'Correction is already %', v_req.review_status; END IF;
  IF v_req.requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject a correction you requested yourself';
  END IF;

  UPDATE production_corrections SET
    review_status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_reason = btrim(p_reason)
  WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_req.factory_id, 'reject_production_correction', 'production', v_req.production_id::text,
          jsonb_build_object('correction_id', p_id, 'reason', p_reason));

  RETURN jsonb_build_object('rejected', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_production_correction(uuid, text) TO authenticated;
