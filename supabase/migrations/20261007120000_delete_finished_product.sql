-- Delete a wrongly created finished product.
--
-- A product can't be removed outright: production batches, sales, stock
-- movements and reports all point at it. Instead a product goes through the
-- usual delete request -> admin approval -> recycle bin flow as a soft delete:
--
--   - request_delete('products', ...): needs finished-goods delete permission;
--   - approve_delete(): the product is deactivated (hidden from every list,
--     the Stock Movement Summary included) and any stock left in it is
--     written off with an 'adjusted' movement, so stock history adds up;
--   - restore_from_recycle_bin(): reactivates it and puts that stock back;
--   - after 30 days the bin entry is purged and the product just stays
--     inactive with its history (the generic purge path already does that).
--
-- Refused while a sales rep still holds it as van stock, or a sale awaiting
-- approval includes it.
--
-- Functions below are their latest versions (request_delete and
-- restore_from_recycle_bin: 20260930090000; approve_delete: 20261001090000;
-- the low-stock trigger: 20260913131000) with only the product parts added.
-- The low-stock trigger now skips inactive products, so writing a deleted
-- product's stock to zero doesn't raise an automatic production request.

ALTER TABLE public.delete_requests DROP CONSTRAINT IF EXISTS delete_requests_table_name_check;
ALTER TABLE public.delete_requests ADD CONSTRAINT delete_requests_table_name_check CHECK (table_name IN (
  'employees','employee_documents','sales_reps','vehicles','drivers',
  'expenses','cash_transactions','product_units','suppliers','sales','customers','products'
));

CREATE OR REPLACE FUNCTION public._product_delete_check(p_product uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM rep_stock WHERE product_id = p_product AND quantity <> 0) THEN
    RAISE EXCEPTION 'A sales rep still holds this product as van stock; return it first';
  END IF;
  IF EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
              WHERE si.product_id = p_product AND s.status = 'pending_approval' AND s.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'A sale awaiting approval includes this product; approve or reject it first';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._product_delete_check(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.request_delete(p_table_name text, p_entity_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_module public.module_key;
  v_factory uuid;
  v_label text;
  v_payload jsonb;
  v_id uuid;
  v_admin_id uuid;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to request a deletion';
  END IF;

  IF EXISTS (
    SELECT 1 FROM delete_requests
    WHERE table_name = p_table_name AND entity_id = p_entity_id AND review_status = 'pending'
  ) THEN
    RAISE EXCEPTION 'A deletion request for this record is already pending';
  END IF;

  IF p_table_name = 'employees' THEN
    v_module := 'employees'::module_key;
    SELECT factory_id, full_name, jsonb_build_object('photo_url', photo_url)
      INTO v_factory, v_label, v_payload
      FROM employees WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;

  ELSIF p_table_name = 'employee_documents' THEN
    v_module := 'employees'::module_key;
    SELECT factory_id, file_name, jsonb_build_object('file_path', file_path)
      INTO v_factory, v_label, v_payload
      FROM employee_documents WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Document not found'; END IF;

  ELSIF p_table_name = 'sales_reps' THEN
    v_module := 'distribution'::module_key;
    SELECT factory_id, full_name INTO v_factory, v_label
      FROM sales_reps WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sales rep not found'; END IF;

  ELSIF p_table_name = 'vehicles' THEN
    v_module := 'logistics'::module_key;
    SELECT factory_id, plate_number INTO v_factory, v_label
      FROM vehicles WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found'; END IF;

  ELSIF p_table_name = 'drivers' THEN
    v_module := 'logistics'::module_key;
    SELECT factory_id, full_name INTO v_factory, v_label
      FROM drivers WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Driver not found'; END IF;

  ELSIF p_table_name = 'expenses' THEN
    v_module := 'expenses'::module_key;
    SELECT factory_id, COALESCE(description, 'Expense'), jsonb_build_object('attachment_url', attachment_url)
      INTO v_factory, v_label, v_payload
      FROM expenses WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;

  ELSIF p_table_name = 'cash_transactions' THEN
    v_module := 'receipts-payments'::module_key;
    SELECT factory_id, COALESCE(description, transaction_number) INTO v_factory, v_label
      FROM cash_transactions WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cash transaction not found'; END IF;

  ELSIF p_table_name = 'product_units' THEN
    v_module := 'finished-goods'::module_key;
    SELECT p.factory_id, pu.packaging_unit || ' (' || pu.base_unit || ')'
      INTO v_factory, v_label
      FROM product_units pu JOIN products p ON p.id = pu.product_id
      WHERE pu.id = p_entity_id FOR UPDATE OF pu;
    IF NOT FOUND THEN RAISE EXCEPTION 'Packaging rule not found'; END IF;

  ELSIF p_table_name = 'suppliers' THEN
    v_module := 'suppliers'::module_key;
    SELECT factory_id, name INTO v_factory, v_label
      FROM suppliers WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found'; END IF;

  ELSIF p_table_name = 'sales' THEN
    v_module := 'sales'::module_key;
    SELECT factory_id, invoice_number INTO v_factory, v_label
      FROM sales WHERE id = p_entity_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;

  ELSIF p_table_name = 'customers' THEN
    v_module := 'customers'::module_key;
    SELECT factory_id, name INTO v_factory, v_label
      FROM customers WHERE id = p_entity_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;

  ELSIF p_table_name = 'products' THEN
    v_module := 'finished-goods'::module_key;
    SELECT factory_id, name INTO v_factory, v_label
      FROM products WHERE id = p_entity_id AND active FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found (or already deleted)'; END IF;
    PERFORM public._product_delete_check(p_entity_id);

  ELSE
    RAISE EXCEPTION 'Unsupported table for delete requests: %', p_table_name;
  END IF;

  IF NOT public.has_permission(v_uid, v_module, 'delete'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  INSERT INTO delete_requests(factory_id, table_name, entity_id, entity_label, module, payload, reason, requested_by)
  VALUES (v_factory, p_table_name, p_entity_id, v_label, v_module, v_payload, p_reason, v_uid)
  RETURNING id INTO v_id;

  FOR v_admin_id IN SELECT user_id FROM user_roles WHERE role IN ('super_admin', 'chairman') LOOP
    INSERT INTO notifications(user_id, factory_id, title, body)
    VALUES (v_admin_id, v_factory, 'Deletion requested',
            initcap(replace(p_table_name, '_', ' ')) || ' "' || v_label || '" — reason: ' || p_reason);
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'request_delete', p_table_name, p_entity_id::text,
          NULL, jsonb_build_object('reason', p_reason, 'label', v_label));

  RETURN jsonb_build_object('id', v_id);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.request_delete(text, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_delete(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_req delete_requests%ROWTYPE;
  v_sale sales%ROWTYPE;
  v_product products%ROWTYPE;
  v_debt debts%ROWTYPE;
  v_found_debt boolean;
  v_total_collected numeric;
  v_refund numeric;
  v_orig uuid;
  v_snap jsonb;
  v_bin uuid;
  v_files jsonb := '[]'::jsonb;
  v_path text;
  v_details jsonb := '{}'::jsonb;
  v_ret RECORD;
  v_n_sales int := 0;
  v_n_payments int := 0;
  v_n_debts int := 0;
  v_n_returns int := 0;
  v_n_deliveries int := 0;
BEGIN
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only an admin can approve a deletion request';
  END IF;

  SELECT * INTO v_req FROM delete_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.review_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_req.review_status; END IF;

  IF v_req.table_name IN ('employees','employee_documents','sales_reps','vehicles','drivers',
                          'expenses','cash_transactions','product_units','suppliers') THEN
    -- Snapshot, then remove. Files stay in Storage until the purge so a
    -- restore gets them back too.
    EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id = $1', v_req.table_name)
      INTO v_snap USING v_req.entity_id;
    IF v_snap IS NULL THEN RAISE EXCEPTION 'This record no longer exists'; END IF;
    EXECUTE format('DELETE FROM public.%I WHERE id = $1', v_req.table_name) USING v_req.entity_id;

    v_path := NULLIF(COALESCE(v_req.payload->>'photo_url', v_req.payload->>'file_path', v_req.payload->>'attachment_url'), '');
    IF v_path IS NOT NULL THEN
      v_files := jsonb_build_array(jsonb_build_object(
        'bucket', CASE WHEN v_req.table_name = 'expenses' THEN 'expense-attachments' ELSE 'employee-files' END,
        'path', v_path));
    END IF;

    INSERT INTO recycle_bin(factory_id, table_name, entity_id, entity_label, reason, delete_request_id,
                            mode, snapshot, files, deleted_by)
    VALUES (v_req.factory_id, v_req.table_name, v_req.entity_id, v_req.entity_label, v_req.reason, v_req.id,
            'snapshot', v_snap, v_files, v_uid)
    RETURNING id INTO v_bin;

  ELSIF v_req.table_name = 'sales' THEN
    SELECT * INTO v_sale FROM sales WHERE id = v_req.entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
    IF v_sale.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'This sale is already in the recycle bin'; END IF;

    INSERT INTO recycle_bin(factory_id, table_name, entity_id, entity_label, reason, delete_request_id, mode, deleted_by)
    VALUES (v_req.factory_id, 'sales', v_sale.id, v_req.entity_label, v_req.reason, v_req.id, 'soft', v_uid)
    RETURNING id INTO v_bin;

    IF v_sale.status = 'posted' THEN
      -- Undo the stock effect applied at approve_sale() time.
      PERFORM public._sale_stock_effect(v_sale.id, true, v_uid, 'Sale deleted');

      -- Refund what was actually collected for this sale plus any credit
      -- applied to it, back to the customer's credit. Rejected / reversed
      -- payments were never kept, and anything above what the sale could
      -- absorb was already put on credit when it was received.
      SELECT COALESCE(SUM(amount), 0) INTO v_total_collected FROM payments_received
       WHERE sale_id = v_sale.id AND status NOT IN ('rejected', 'reversed') AND deleted_at IS NULL;
      v_total_collected := LEAST(v_total_collected, GREATEST(v_sale.grand_total - v_sale.credit_applied, 0));
      v_refund := v_total_collected + v_sale.credit_applied;

      IF v_sale.customer_id IS NOT NULL THEN
        PERFORM 1 FROM customers WHERE id = v_sale.customer_id FOR UPDATE;
      END IF;

      SELECT * INTO v_debt FROM debts WHERE sale_id = v_sale.id FOR UPDATE;
      v_found_debt := FOUND;
      IF v_found_debt THEN
        DELETE FROM debts WHERE id = v_debt.id;
      END IF;

      IF v_sale.customer_id IS NOT NULL THEN
        UPDATE customers SET
          total_purchases = GREATEST(total_purchases - v_sale.grand_total, 0),
          outstanding_balance = GREATEST(outstanding_balance - COALESCE(v_debt.outstanding, 0), 0),
          total_transactions = GREATEST(total_transactions - 1, 0),
          credit_balance = credit_balance + v_refund,
          updated_at = now()
        WHERE id = v_sale.customer_id;

        SELECT id INTO v_orig FROM customer_account_transactions
         WHERE txn_type = 'SALE' AND reference_type = 'sale' AND reference_id = v_sale.id;

        PERFORM public._customer_ledger_post(
          v_sale.factory_id, v_sale.customer_id, 'REVERSAL', 'sale', v_sale.id, v_sale.id, NULL, v_debt.id,
          v_sale.grand_total, 0, 0, 0, -COALESCE(v_debt.outstanding, 0),
          NULL, 'Reversal of sale ' || v_sale.invoice_number, v_req.reason, v_orig, NULL, v_uid);
        IF v_sale.credit_applied > 0 THEN
          PERFORM public._customer_ledger_post(
            v_sale.factory_id, v_sale.customer_id, 'ADVANCE_RESTORED', 'sale', v_sale.id, v_sale.id, NULL, NULL,
            0, 0, v_sale.credit_applied, v_sale.credit_applied, 0,
            NULL, 'Advance restored from reversed sale ' || v_sale.invoice_number, v_req.reason, NULL, NULL, v_uid);
        END IF;
        IF v_total_collected > 0 THEN
          PERFORM public._customer_ledger_post(
            v_sale.factory_id, v_sale.customer_id, 'REVERSAL', 'sale_payments', v_sale.id, v_sale.id, NULL, NULL,
            0, v_total_collected, 0, v_total_collected, 0,
            NULL, 'Payments on reversed sale ' || v_sale.invoice_number || ' returned to account credit', v_req.reason, NULL, NULL, v_uid);
        END IF;
      END IF;

      v_details := jsonb_build_object('reversed', true, 'refund', v_refund,
                                      'debt', CASE WHEN v_found_debt THEN to_jsonb(v_debt) END);
    ELSE
      v_details := jsonb_build_object('reversed', false);
    END IF;

    UPDATE sales SET deleted_at = now(), deleted_bin_id = v_bin WHERE id = v_sale.id;
    UPDATE recycle_bin SET details = v_details WHERE id = v_bin;

  ELSIF v_req.table_name = 'customers' THEN
    PERFORM 1 FROM customers WHERE id = v_req.entity_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found (or already in the recycle bin)'; END IF;

    INSERT INTO recycle_bin(factory_id, table_name, entity_id, entity_label, reason, delete_request_id, mode, deleted_by)
    VALUES (v_req.factory_id, 'customers', v_req.entity_id, v_req.entity_label, v_req.reason, v_req.id, 'soft', v_uid)
    RETURNING id INTO v_bin;

    -- Goods from their posted sales go back into stock.
    FOR v_sale IN
      SELECT * FROM sales WHERE customer_id = v_req.entity_id AND deleted_at IS NULL ORDER BY created_at FOR UPDATE
    LOOP
      IF v_sale.status = 'posted' THEN
        PERFORM public._sale_stock_effect(v_sale.id, true, v_uid, 'Customer deleted');
      END IF;
    END LOOP;
    UPDATE sales SET deleted_at = now(), deleted_bin_id = v_bin
     WHERE customer_id = v_req.entity_id AND deleted_at IS NULL;
    GET DIAGNOSTICS v_n_sales = ROW_COUNT;

    -- Returns they made had put stock back in; take that out again.
    FOR v_ret IN
      SELECT id FROM sales_returns
       WHERE deleted_at IS NULL
         AND (customer_id = v_req.entity_id OR sale_id IN (SELECT id FROM sales WHERE deleted_bin_id = v_bin))
       FOR UPDATE
    LOOP
      PERFORM public._sales_return_stock_effect(v_ret.id, false, v_uid, 'Customer deleted: sales return reversed');
    END LOOP;
    UPDATE sales_returns SET deleted_at = now(), deleted_bin_id = v_bin
     WHERE deleted_at IS NULL
       AND (customer_id = v_req.entity_id OR sale_id IN (SELECT id FROM sales WHERE deleted_bin_id = v_bin));
    GET DIAGNOSTICS v_n_returns = ROW_COUNT;

    UPDATE payments_received SET deleted_at = now(), deleted_bin_id = v_bin
     WHERE deleted_at IS NULL
       AND (customer_id = v_req.entity_id OR sale_id IN (SELECT id FROM sales WHERE deleted_bin_id = v_bin));
    GET DIAGNOSTICS v_n_payments = ROW_COUNT;

    UPDATE debts SET deleted_at = now(), deleted_bin_id = v_bin
     WHERE deleted_at IS NULL
       AND (customer_id = v_req.entity_id OR sale_id IN (SELECT id FROM sales WHERE deleted_bin_id = v_bin));
    GET DIAGNOSTICS v_n_debts = ROW_COUNT;

    UPDATE deliveries SET deleted_at = now(), deleted_bin_id = v_bin
     WHERE deleted_at IS NULL AND sale_id IN (SELECT id FROM sales WHERE deleted_bin_id = v_bin);
    GET DIAGNOSTICS v_n_deliveries = ROW_COUNT;

    UPDATE customers SET deleted_at = now(), deleted_bin_id = v_bin WHERE id = v_req.entity_id;

    -- Pending delete requests for records that just went with the customer.
    UPDATE delete_requests SET review_status = 'rejected', reviewed_by = v_uid, reviewed_at = now(),
           review_reason = 'Deleted together with customer ' || v_req.entity_label
     WHERE review_status = 'pending' AND id <> v_req.id
       AND table_name = 'sales' AND entity_id IN (SELECT id FROM sales WHERE deleted_bin_id = v_bin);

    UPDATE recycle_bin SET details = jsonb_build_object(
      'sales', v_n_sales, 'payments', v_n_payments, 'debts', v_n_debts,
      'sales_returns', v_n_returns, 'deliveries', v_n_deliveries)
     WHERE id = v_bin;

  ELSIF v_req.table_name = 'products' THEN
    SELECT * INTO v_product FROM products WHERE id = v_req.entity_id FOR UPDATE;
    IF NOT FOUND OR NOT v_product.active THEN RAISE EXCEPTION 'Product not found (or already deleted)'; END IF;
    PERFORM public._product_delete_check(v_product.id);

    INSERT INTO recycle_bin(factory_id, table_name, entity_id, entity_label, reason, delete_request_id, mode, deleted_by, details)
    VALUES (v_req.factory_id, 'products', v_product.id, v_req.entity_label, v_req.reason, v_req.id, 'soft', v_uid,
            jsonb_build_object('stock_written_off', v_product.current_stock, 'unit', v_product.unit))
    RETURNING id INTO v_bin;

    -- Its remaining stock is written off; restoring puts it back.
    IF v_product.current_stock <> 0 THEN
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_product.factory_id, v_product.id, 'adjusted', -v_product.current_stock, 'Product deleted', v_req.reason, v_uid,
              v_product.current_stock, 0);
    END IF;
    UPDATE products SET active = false, current_stock = 0, updated_at = now() WHERE id = v_product.id;

  ELSE
    RAISE EXCEPTION 'Unsupported table for delete requests: %', v_req.table_name;
  END IF;

  UPDATE delete_requests SET review_status = 'approved', reviewed_by = v_uid, reviewed_at = now()
  WHERE id = p_id;

  INSERT INTO notifications(user_id, factory_id, title, body)
  VALUES (v_req.requested_by, v_req.factory_id, 'Deletion approved',
          initcap(replace(v_req.table_name, '_', ' ')) || ' "' || v_req.entity_label || '" was moved to the recycle bin.');

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'approve_delete', v_req.table_name, v_req.entity_id::text,
          jsonb_build_object('label', v_req.entity_label, 'reason', v_req.reason, 'requested_by', v_req.requested_by),
          jsonb_build_object('deleted', true, 'recycle_bin_id', v_bin));

  RETURN jsonb_build_object('approved', true, 'recycle_bin_id', v_bin);
END;
$function$;

CREATE OR REPLACE FUNCTION public.restore_from_recycle_bin(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_bin recycle_bin%ROWTYPE;
  v_sale sales%ROWTYPE;
  v_ret RECORD;
  v_refund numeric;
  v_credit numeric;
  v_debt_out numeric := 0;
  v_debt_id uuid;
  v_product products%ROWTYPE;
  v_qty numeric;
BEGIN
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only an admin can restore from the recycle bin';
  END IF;
  SELECT * INTO v_bin FROM recycle_bin WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recycle bin entry not found'; END IF;

  IF v_bin.mode = 'snapshot' THEN
    PERFORM public._recycle_reinsert(v_bin.table_name, v_bin.snapshot);

  ELSIF v_bin.table_name = 'sales' THEN
    SELECT * INTO v_sale FROM sales WHERE id = v_bin.entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The deleted sale no longer exists'; END IF;
    IF v_sale.customer_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM customers WHERE id = v_sale.customer_id AND deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'This sale''s customer is in the recycle bin; restore the customer first';
    END IF;

    IF COALESCE((v_bin.details->>'reversed')::boolean, false) THEN
      v_refund := COALESCE((v_bin.details->>'refund')::numeric,
                           (SELECT COALESCE(SUM(amount), 0) FROM payments_received WHERE sale_id = v_sale.id) + v_sale.credit_applied);

      IF v_sale.customer_id IS NOT NULL THEN
        SELECT credit_balance INTO v_credit FROM customers WHERE id = v_sale.customer_id FOR UPDATE;
        IF COALESCE(v_credit, 0) < v_refund THEN
          RAISE EXCEPTION 'Deleting this sale gave the customer % credit, but only % is left (the rest has been used). It can''t be restored.',
            v_refund, COALESCE(v_credit, 0);
        END IF;
      END IF;

      PERFORM public._sale_stock_effect(v_sale.id, false, v_uid, 'Sale restored');

      IF v_bin.details ? 'debt' AND jsonb_typeof(v_bin.details->'debt') = 'object' THEN
        PERFORM public._recycle_reinsert('debts', v_bin.details->'debt');
        v_debt_out := COALESCE((v_bin.details->'debt'->>'outstanding')::numeric, 0);
        v_debt_id := (v_bin.details->'debt'->>'id')::uuid;
      ELSIF COALESCE(v_sale.balance, 0) > 0 THEN
        -- Deleted before the debt was recorded in the bin: rebuild it from
        -- the sale's remaining balance.
        INSERT INTO debts(factory_id, customer_id, sale_id, sales_rep_id, total_amount, amount_paid, outstanding, status)
        VALUES (v_sale.factory_id, v_sale.customer_id, v_sale.id, v_sale.sales_rep_id, v_sale.balance, 0, v_sale.balance, 'unpaid')
        RETURNING id INTO v_debt_id;
        v_debt_out := v_sale.balance;
      END IF;

      IF v_sale.customer_id IS NOT NULL THEN
        UPDATE customers SET
          total_purchases = total_purchases + v_sale.grand_total,
          outstanding_balance = outstanding_balance + v_debt_out,
          total_transactions = total_transactions + 1,
          credit_balance = credit_balance - v_refund,
          updated_at = now()
        WHERE id = v_sale.customer_id;

        PERFORM public._customer_ledger_post(
          v_sale.factory_id, v_sale.customer_id, 'SALE_RESTORED', 'recycle_bin', v_bin.id, v_sale.id, NULL, v_debt_id,
          v_sale.grand_total, 0, 0, -v_refund, v_debt_out,
          NULL, 'Sale ' || v_sale.invoice_number || ' restored from recycle bin', NULL, NULL, NULL, v_uid);
      END IF;
    END IF;

    UPDATE sales SET deleted_at = NULL, deleted_bin_id = NULL WHERE id = v_sale.id;

  ELSIF v_bin.table_name = 'customers' THEN
    -- Re-apply stock in the reverse order of the delete.
    FOR v_sale IN SELECT * FROM sales WHERE deleted_bin_id = v_bin.id AND status = 'posted' ORDER BY created_at LOOP
      PERFORM public._sale_stock_effect(v_sale.id, false, v_uid, 'Customer restored');
    END LOOP;
    FOR v_ret IN SELECT id FROM sales_returns WHERE deleted_bin_id = v_bin.id LOOP
      PERFORM public._sales_return_stock_effect(v_ret.id, true, v_uid, 'Customer restored: sales return re-applied');
    END LOOP;

    UPDATE sales             SET deleted_at = NULL, deleted_bin_id = NULL WHERE deleted_bin_id = v_bin.id;
    UPDATE sales_returns     SET deleted_at = NULL, deleted_bin_id = NULL WHERE deleted_bin_id = v_bin.id;
    UPDATE payments_received SET deleted_at = NULL, deleted_bin_id = NULL WHERE deleted_bin_id = v_bin.id;
    UPDATE debts             SET deleted_at = NULL, deleted_bin_id = NULL WHERE deleted_bin_id = v_bin.id;
    UPDATE deliveries        SET deleted_at = NULL, deleted_bin_id = NULL WHERE deleted_bin_id = v_bin.id;
    UPDATE customers         SET deleted_at = NULL, deleted_bin_id = NULL WHERE id = v_bin.entity_id;

  ELSIF v_bin.table_name = 'products' THEN
    SELECT * INTO v_product FROM products WHERE id = v_bin.entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The deleted product no longer exists'; END IF;
    v_qty := COALESCE((v_bin.details->>'stock_written_off')::numeric, 0);
    IF v_qty <> 0 THEN
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_product.factory_id, v_product.id, 'adjusted', v_qty, 'Product restored', 'Restored from recycle bin', v_uid,
              v_product.current_stock, v_product.current_stock + v_qty);
    END IF;
    UPDATE products SET active = true, current_stock = current_stock + v_qty, updated_at = now() WHERE id = v_product.id;

  ELSE
    RAISE EXCEPTION 'Don''t know how to restore %', v_bin.table_name;
  END IF;

  DELETE FROM recycle_bin WHERE id = v_bin.id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_bin.factory_id, 'restore_from_recycle_bin', v_bin.table_name, v_bin.entity_id::text,
          jsonb_build_object('label', v_bin.entity_label, 'deleted_at', v_bin.deleted_at),
          jsonb_build_object('restored', true));

  RETURN jsonb_build_object('restored', true, 'table_name', v_bin.table_name);
END;
$function$;
REVOKE ALL ON FUNCTION public.restore_from_recycle_bin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_from_recycle_bin(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.auto_create_production_request_on_low_finished_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sheet costing_sheets%ROWTYPE;
  v_shortfall numeric;
  v_scale numeric;
  v_number text;
  v_id uuid;
  v_existing uuid;
  v_item costing_sheet_items%ROWTYPE;
BEGIN
  IF NOT NEW.active THEN
    RETURN NEW;
  END IF;
  IF NEW.reorder_level IS NULL OR NEW.reorder_level <= 0 THEN
    RETURN NEW;
  END IF;
  IF NEW.current_stock > NEW.reorder_level THEN
    RETURN NEW;
  END IF;
  IF OLD.current_stock IS NOT DISTINCT FROM NEW.current_stock THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_existing
  FROM production_requests
  WHERE product_id = NEW.id
    AND request_type = 'production_material'
    AND materials_issued = false
    AND approval_status IN ('pending', 'approved')
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_sheet
  FROM costing_sheets
  WHERE product_id = NEW.id AND status = 'posted'
  ORDER BY is_applied DESC, created_at DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_shortfall := GREATEST(NEW.reorder_level * 2 - NEW.current_stock, NEW.reorder_level, 1);
  v_scale := v_shortfall / v_sheet.yield_quantity;

  v_number := 'PR-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');

  INSERT INTO production_requests(
    factory_id, request_number, requested_by_name, requested_by, department,
    request_type, product_id, quantity_requested, unit, remarks, auto_generated
  ) VALUES (
    NEW.factory_id, v_number, 'System (Auto Reorder)', NULL, NULL,
    'production_material', NEW.id, v_shortfall, NEW.unit,
    format('Auto-generated: stock (%s %s) at or below reorder level (%s %s). Materials scaled from costing sheet %s.',
           NEW.current_stock, NEW.unit, NEW.reorder_level, NEW.unit, v_sheet.sheet_number),
    true
  ) RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM costing_sheet_items WHERE sheet_id = v_sheet.id LOOP
    INSERT INTO production_request_items(request_id, material_id, quantity_requested, unit)
    SELECT v_id, v_item.material_id, round(v_item.quantity * v_scale, 3), rm.unit
    FROM raw_materials rm WHERE rm.id = v_item.material_id;
  END LOOP;

  RETURN NEW;
END;
$$;
