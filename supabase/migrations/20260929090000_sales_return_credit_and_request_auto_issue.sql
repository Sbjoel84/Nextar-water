-- ============================================================================
-- 1) Sales returns now reduce what the customer owes
-- ----------------------------------------------------------------------------
-- inspect_sales_return() put accepted goods back into stock but never touched
-- the customer's account, so a return left the debt exactly where it was.
-- It now credits the customer for everything the factory took back (accepted
-- + damaged; "rejected" is the part handed back to the customer, so it stays
-- billed), valued at the price on the original sale line (or the product's
-- current price when the return isn't tied to a sale; nothing for a PR sale).
-- The credit settles the returned sale's own debt first, then the customer's
-- oldest open debts; anything left over (the goods were already paid for)
-- becomes customer credit_balance. Posted to the customer ledger as a new
-- SALES_RETURN row, under the usual lock order: customer -> debts -> stock.
--
-- Also restores the 'sales-returns' permission check here: the chairman-parity
-- migration (20260923190000) rewrote this function with the old 'sales'
-- module, undoing 20260916090000.
--
-- And gives inventory_officer view/confirm on sales returns. Inspection needs
-- 'confirm' by someone other than who logged the return, and the only role
-- holding it (store_officer) has no users, so returns sat at "received".
--
-- 2) Approving a production-material request issues the materials straight
--    away again
-- ----------------------------------------------------------------------------
-- 20260925120000 split approval and issue into two clicks, and requests were
-- being approved and then left un-issued. Approval now releases the stock and
-- marks the request "materials issued" in one step, whoever approves.
-- confirm_production_request() stays for any request still approved-but-not-
-- issued, and the ones stranded since 20260925120000 are issued below.
-- ============================================================================

-- ============ 1a. ledger: allow SALES_RETURN rows ============
ALTER TABLE public.customer_account_transactions DROP CONSTRAINT IF EXISTS customer_account_transactions_txn_type_check;
ALTER TABLE public.customer_account_transactions ADD CONSTRAINT customer_account_transactions_txn_type_check
  CHECK (txn_type IN (
    'OPENING_BALANCE','ADVANCE_PAYMENT','SALE','ADVANCE_APPLIED','CUSTOMER_PAYMENT',
    'DEBT_SETTLEMENT','REFUND','CREDIT_ADJUSTMENT','DEBIT_ADJUSTMENT','REVERSAL','ADVANCE_RESTORED',
    'SALES_RETURN'
  ));

ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS credit_value numeric(14,2) NOT NULL DEFAULT 0;

-- ============ 1b. inspect_sales_return(): credit the customer ============
CREATE OR REPLACE FUNCTION public.inspect_sales_return(p_id uuid, p_accepted numeric, p_damaged numeric, p_rejected numeric, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales_returns%ROWTYPE;
  v_sale sales%ROWTYPE;
  v_debt debts%ROWTYPE;
  v_customer uuid;
  v_before numeric;
  v_cost_price numeric;
  v_price numeric;
  v_credit numeric := 0;
  v_remaining numeric := 0;
  v_take numeric;
  v_settled numeric := 0;
  v_excess numeric := 0;
BEGIN
  SELECT * INTO v_row FROM sales_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales return not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales-returns'::module_key, 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.received_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Inspection must be done by someone other than who logged the return';
  END IF;
  IF v_row.status <> 'received' THEN RAISE EXCEPTION 'This return has already been inspected'; END IF;
  IF COALESCE(p_accepted,0) < 0 OR COALESCE(p_damaged,0) < 0 OR COALESCE(p_rejected,0) < 0 THEN
    RAISE EXCEPTION 'Quantities cannot be negative';
  END IF;
  IF COALESCE(p_accepted,0) + COALESCE(p_damaged,0) + COALESCE(p_rejected,0) <> v_row.quantity_returned THEN
    RAISE EXCEPTION 'Accepted + damaged + rejected must equal the % returned', v_row.quantity_returned;
  END IF;

  -- Value of what the factory took back.
  v_customer := v_row.customer_id;
  IF v_row.sale_id IS NOT NULL THEN
    SELECT * INTO v_sale FROM sales WHERE id = v_row.sale_id;
    v_customer := COALESCE(v_customer, v_sale.customer_id);
    IF v_sale.is_pr THEN
      v_price := 0;
    ELSE
      SELECT SUM(line_total) / NULLIF(SUM(quantity), 0) INTO v_price
        FROM sale_items WHERE sale_id = v_row.sale_id AND product_id = v_row.product_id;
    END IF;
  END IF;
  IF v_price IS NULL THEN
    SELECT unit_price INTO v_price FROM products WHERE id = v_row.product_id;
  END IF;
  v_credit := round((COALESCE(p_accepted,0) + COALESCE(p_damaged,0)) * COALESCE(v_price,0), 2);

  UPDATE sales_returns SET
    accepted_quantity = p_accepted, damaged_quantity = COALESCE(p_damaged,0), rejected_quantity = COALESCE(p_rejected,0),
    inspected_by = v_uid, inspected_at = now(), status = 'completed', notes = p_notes,
    customer_id = v_customer, credit_value = CASE WHEN v_customer IS NULL THEN 0 ELSE v_credit END
  WHERE id = p_id;

  -- Customer account: settle debt (returned sale first, then oldest), rest = credit.
  IF v_customer IS NOT NULL AND v_credit > 0 THEN
    PERFORM 1 FROM customers WHERE id = v_customer FOR UPDATE;
    v_remaining := v_credit;
    FOR v_debt IN
      SELECT * FROM debts
       WHERE customer_id = v_customer AND factory_id = v_row.factory_id
         AND outstanding > 0 AND status <> 'paid'
       ORDER BY (v_row.sale_id IS NOT NULL AND sale_id = v_row.sale_id) DESC, created_at, id
       FOR UPDATE
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := LEAST(v_remaining, v_debt.outstanding);
      UPDATE debts SET amount_paid = amount_paid + v_take, outstanding = outstanding - v_take,
             status = CASE WHEN outstanding - v_take = 0 THEN 'paid'::debt_status ELSE 'partial'::debt_status END,
             updated_at = now()
       WHERE id = v_debt.id;
      IF v_debt.sale_id IS NOT NULL THEN
        UPDATE sales SET balance = GREATEST(balance - v_take, 0) WHERE id = v_debt.sale_id;
      END IF;
      v_remaining := v_remaining - v_take;
      v_settled := v_settled + v_take;
    END LOOP;
    v_excess := GREATEST(v_remaining, 0);

    UPDATE customers SET
      outstanding_balance = GREATEST(outstanding_balance - v_settled, 0),
      credit_balance = credit_balance + v_excess,
      updated_at = now()
    WHERE id = v_customer;

    PERFORM public._customer_ledger_post(
      v_row.factory_id, v_customer, 'SALES_RETURN', 'sales_return', v_row.id, v_row.sale_id, NULL, NULL,
      v_credit, 0, 0, v_excess, -v_settled, NULL,
      'Sales return ' || v_row.return_number, p_notes, NULL, NULL, v_uid);
  END IF;

  IF COALESCE(p_accepted,0) > 0 THEN
    SELECT current_stock INTO v_before FROM products WHERE id = v_row.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + p_accepted, updated_at = now() WHERE id = v_row.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.product_id, 'returned', p_accepted, v_row.return_number, 'Accepted sales return', v_uid, v_before, v_before + p_accepted);
  END IF;

  IF COALESCE(p_damaged,0) > 0 THEN
    SELECT cost_price INTO v_cost_price FROM products WHERE id = v_row.product_id;
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'SALES_RETURN', v_row.return_number, v_row.product_id, p_damaged, v_row.unit, v_cost_price, 'Damaged on sales return inspection', v_uid, 'posted');
  END IF;

  RETURN jsonb_build_object('completed', true, 'accepted', p_accepted, 'damaged', p_damaged, 'rejected', p_rejected,
                            'credit_value', CASE WHEN v_customer IS NULL THEN 0 ELSE v_credit END,
                            'debt_reduced', v_settled, 'credit_added', v_excess);
END; $function$;
REVOKE ALL ON FUNCTION public.inspect_sales_return(uuid, numeric, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspect_sales_return(uuid, numeric, numeric, numeric, text) TO authenticated;

-- ============ 1c. inventory officer can inspect returns ============
INSERT INTO public.role_permissions (role, module, action) VALUES
  ('inventory_officer', 'sales-returns', 'view'),
  ('inventory_officer', 'sales-returns', 'confirm')
ON CONFLICT (role, module, action) DO NOTHING;

-- ============ 2a. shared issue step for production-material requests ============
CREATE OR REPLACE FUNCTION public._issue_production_request(p_id uuid, p_issuer_name text, p_uid uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row production_requests%ROWTYPE;
  v_item production_request_items%ROWTYPE;
  v_material raw_materials%ROWTYPE;
  v_move_cost numeric;
BEGIN
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;

  FOR v_item IN SELECT * FROM production_request_items WHERE request_id = p_id LOOP
    SELECT * INTO v_material FROM raw_materials WHERE id = v_item.material_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found for this request'; END IF;
    IF v_material.current_stock < v_item.quantity_requested THEN
      RAISE EXCEPTION 'Insufficient stock for %: have %, need %', v_material.name, v_material.current_stock, v_item.quantity_requested;
    END IF;
    v_move_cost := public.avg_unit_cost(v_material.current_value, v_material.current_stock, v_material.unit_cost);

    UPDATE raw_materials SET
      current_stock = current_stock - v_item.quantity_requested,
      current_value = current_value - v_item.quantity_requested * v_move_cost,
      updated_at = now()
    WHERE id = v_item.material_id;

    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_item.material_id, 'used_for_production', v_item.quantity_requested, v_move_cost,
            v_row.request_number, 'Production Request ' || v_row.request_number, p_uid,
            v_material.current_stock, v_material.current_stock - v_item.quantity_requested);

    UPDATE production_request_items SET quantity_issued = quantity_requested WHERE id = v_item.id;
  END LOOP;

  UPDATE production_requests SET
    materials_issued = true, issued_by_name = p_issuer_name, issued_at = now(),
    production_status = 'materials_issued'
  WHERE id = p_id;
END;
$function$;
REVOKE ALL ON FUNCTION public._issue_production_request(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.confirm_production_request(p_id uuid, p_confirmer_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row production_requests%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests'::public.module_key, 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_confirmer_name IS NULL OR btrim(p_confirmer_name) = '' THEN RAISE EXCEPTION 'Confirmer name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.request_type <> 'production_material' THEN RAISE EXCEPTION 'Only production-material requests need confirmation'; END IF;
  IF v_row.approval_status <> 'approved' THEN RAISE EXCEPTION 'Request must be approved before it can be confirmed'; END IF;
  IF v_row.materials_issued THEN RAISE EXCEPTION 'Request already confirmed'; END IF;
  IF NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
  END IF;

  PERFORM public._issue_production_request(p_id, btrim(p_confirmer_name), v_uid);
  RETURN jsonb_build_object('confirmed', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.confirm_production_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_production_request(uuid, text) TO authenticated;

-- ============ 2b. approve_production_request(): issue immediately when allowed ============
CREATE OR REPLACE FUNCTION public.approve_production_request(p_id uuid, p_approver_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row production_requests%ROWTYPE; v_uid uuid := auth.uid();
  v_issued boolean := false;
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests'::public.module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_row.approval_status; END IF;
  IF v_row.requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot approve a request you submitted yourself';
  END IF;
  IF v_row.request_type = 'production_material' AND NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
  END IF;

  UPDATE production_requests SET
    approval_status = 'approved', approved_by_name = p_approver_name, approval_date = now(),
    production_status = 'approved'
  WHERE id = p_id;

  IF v_row.request_type = 'production_material' THEN
    PERFORM public._issue_production_request(p_id, btrim(p_approver_name), v_uid);
    v_issued := true;
  END IF;

  RETURN jsonb_build_object('approved', true, 'materials_issued', v_issued);
END;
$function$;

-- ============ 2c. issue the requests stranded by the two-step flow ============
-- Approved on/after 2026-09-25 (when 20260925120000 stopped approval from
-- issuing) but never confirmed. Issued under the approver's name, with the
-- approver's user id taken from the audit log. A request whose stock has since
-- run short is skipped with a NOTICE rather than failing the migration; it
-- keeps its "Confirm & issue" button.
DO $$
DECLARE
  r record;
  v_uid uuid;
BEGIN
  FOR r IN
    SELECT id, request_number, approved_by_name FROM production_requests
     WHERE request_type = 'production_material'
       AND approval_status = 'approved'
       AND NOT materials_issued
       AND approval_date >= '2026-09-25'
     ORDER BY approval_date
  LOOP
    SELECT user_id INTO v_uid FROM audit_logs
     WHERE entity = 'production_requests' AND entity_id = r.id::text
       AND new_value->>'approval_status' = 'approved'
     ORDER BY created_at DESC LIMIT 1;
    BEGIN
      PERFORM public._issue_production_request(r.id, COALESCE(r.approved_by_name, 'Approver'), v_uid);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Request % not issued: %', r.request_number, SQLERRM;
    END;
  END LOOP;
END $$;
