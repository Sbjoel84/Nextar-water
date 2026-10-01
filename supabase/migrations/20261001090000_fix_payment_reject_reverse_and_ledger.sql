-- ============================================================================
-- PAYMENT REJECT / REVERSE FIXES + CUSTOMER ACCOUNT HISTORY RE-SYNC
-- ----------------------------------------------------------------------------
-- Reported: Maitama Hopital, INV20260928-01965 (N139,000). The cash payment
-- taken at the point of sale was reversed (wrong method), the transfer that
-- replaced it was confirmed, and a duplicate transfer was rejected -- yet the
-- sale still showed UNPAID and the customer showed N281,000 of advance.
--
-- Three defects combined:
--
-- 1. reject_payment() only changed the payment's status. record_payment()
--    applies money the moment it is recorded (settles debt / adds credit),
--    so a rejected payment kept paying. (Also hit Kamal: a rejected N22,450
--    cash line still counts toward INV20260930-28575.)
--
-- 2. The live reverse_payment() / approve_sale() / debt write-off functions
--    are the pre-ledger versions from 20260923190000_chairman_full_admin_parity
--    (applied to the database after 20260924110000_customer_account_ledger,
--    so it overwrote the ledger-aware versions). Consequences:
--      - reversing a point-of-sale payment pushed the sale balance up by the
--        full payment (140,000 on a 139,000 sale) but created no debt row, so
--        the next payment found nothing to settle and became "advance";
--        the 1,000 over-payment credit was never taken back either;
--      - no SALE / ADVANCE_APPLIED rows have been written since 21 Sep, so the
--        customer account history is wrong for 25 customers (cached balances
--        and per-invoice debts are still right -- only the history drifted).
--
-- 3. Deleting a posted sale refunded the sum of ALL its payments to credit,
--    rejected and reversed ones included.
--
-- This migration:
--   a. _payment_undo(): one routine that takes a payment's effect off the
--      account, used by both reverse_payment() and reject_payment(). Payments
--      with ledger allocations are undone allocation by allocation; payments
--      taken at the point of sale (no allocation rows) are undone against the
--      sale itself -- re-opening a debt row when there is none and removing
--      any over-payment credit they created.
--   b. Re-installs the ledger-aware approve_sale(), post_debt_writeoff(),
--      reverse_debt_writeoff() (identical to 20260924110000 -- they are strict
--      supersets of the parity versions).
--   c. approve_delete(): sale refunds count only payments that stood, capped
--      at what the sale could absorb (identical to 20260930090000 otherwise).
--   d. Data repair: undoes every rejected payment that is still applied,
--      settles INV20260928-01965 with the confirmed transfer, then re-syncs
--      the account history to the cached balances.
--
-- Do NOT re-run 20260923190000_chairman_full_admin_parity.sql after this --
-- it would put the pre-ledger functions back again.
-- ============================================================================

-- ============ a. _payment_undo ============
CREATE OR REPLACE FUNCTION public._payment_undo(p_id uuid, p_reason text, p_uid uuid, p_verb text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row payments_received%ROWTYPE;
  v_sale sales%ROWTYPE;
  v_debt debts%ROWTYPE;
  v_led customer_account_transactions%ROWTYPE;
  v_has_ledger boolean;
  v_applied numeric;
  v_credit_cache numeric;
  v_old_paid numeric;
  v_new_paid numeric;
  v_old_bal numeric;
  v_new_bal numeric;
  v_debt_up numeric := 0;
  v_credit_down numeric := 0;
  v_debt_id uuid;
  v_debt_restored numeric := 0;
  v_credit_removed numeric := 0;
  v_label text := initcap(p_verb);
BEGIN
  SELECT * INTO v_row FROM payments_received WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;

  -- Allocation rows not already undone (a repair may have re-allocated one).
  SELECT EXISTS (
    SELECT 1 FROM customer_account_transactions a
     WHERE a.payment_id = p_id AND a.txn_type IN ('DEBT_SETTLEMENT','ADVANCE_PAYMENT','CUSTOMER_PAYMENT')
       AND NOT EXISTS (SELECT 1 FROM customer_account_transactions r WHERE r.reverses_id = a.id)
  ) INTO v_has_ledger;

  IF v_has_ledger AND v_row.customer_id IS NOT NULL THEN
    -- Recorded through record_payment()/record_customer_advance(): undo each
    -- allocation it made, newest first.
    PERFORM 1 FROM customers WHERE id = v_row.customer_id FOR UPDATE;

    FOR v_led IN
      SELECT a.* FROM customer_account_transactions a
       WHERE a.payment_id = p_id AND a.txn_type IN ('DEBT_SETTLEMENT','ADVANCE_PAYMENT','CUSTOMER_PAYMENT')
         AND NOT EXISTS (SELECT 1 FROM customer_account_transactions r WHERE r.reverses_id = a.id)
       ORDER BY a.seq DESC
    LOOP
      IF v_led.txn_type = 'DEBT_SETTLEMENT' THEN
        v_applied := v_led.cash_paid;
        SELECT * INTO v_debt FROM debts WHERE id = v_led.debt_id FOR UPDATE;
        -- A debt that is gone (sale deleted) has nothing left to re-open.
        IF FOUND AND v_debt.deleted_at IS NULL THEN
          UPDATE debts SET
            amount_paid = GREATEST(amount_paid - v_applied, 0),
            outstanding = LEAST(outstanding + v_applied, total_amount),
            status = CASE WHEN amount_paid - v_applied <= 0 THEN 'unpaid'::debt_status ELSE 'partial'::debt_status END,
            updated_at = now()
          WHERE id = v_debt.id;
          IF v_debt.sale_id IS NOT NULL THEN
            UPDATE sales SET amount_paid = GREATEST(amount_paid - v_applied, 0), balance = balance + v_applied
             WHERE id = v_debt.sale_id;
          END IF;
          UPDATE customers SET outstanding_balance = outstanding_balance + v_applied, updated_at = now()
           WHERE id = v_row.customer_id;
          v_debt_restored := v_debt_restored + v_applied;
          PERFORM public._customer_ledger_post(
            v_row.factory_id, v_row.customer_id, 'REVERSAL', 'payment_reversal', p_id, v_led.sale_id, p_id, v_led.debt_id,
            0, 0, 0, 0, v_applied,
            v_row.payment_method, v_label || ' of ' || v_row.receipt_number || ' (debt settlement)', p_reason, v_led.id, NULL, p_uid);
        END IF;
      ELSE
        SELECT credit_balance INTO v_credit_cache FROM customers WHERE id = v_row.customer_id;
        IF COALESCE(v_credit_cache, 0) < v_led.credit_delta THEN
          RAISE EXCEPTION 'Cannot undo: part of this payment (%) has already been used by the customer', v_led.credit_delta;
        END IF;
        UPDATE customers SET credit_balance = credit_balance - v_led.credit_delta, updated_at = now()
         WHERE id = v_row.customer_id;
        v_credit_removed := v_credit_removed + v_led.credit_delta;
        PERFORM public._customer_ledger_post(
          v_row.factory_id, v_row.customer_id, 'REVERSAL', 'payment_reversal', p_id, NULL, p_id, NULL,
          0, 0, 0, -v_led.credit_delta, 0,
          v_row.payment_method, v_label || ' of ' || v_row.receipt_number || ' (credit removed)', p_reason, v_led.id, NULL, p_uid);
      END IF;
    END LOOP;

  ELSIF v_row.sale_id IS NOT NULL THEN
    -- Taken at the point of sale by approve_sale() (no allocation rows): work
    -- out what this payment covered on the sale and put exactly that back.
    -- Lock order: sale -> customer -> debt.
    SELECT * INTO v_sale FROM sales WHERE id = v_row.sale_id FOR UPDATE;
    IF FOUND AND v_sale.status = 'posted' AND v_sale.deleted_at IS NULL THEN
      IF v_row.customer_id IS NOT NULL THEN
        PERFORM 1 FROM customers WHERE id = v_row.customer_id FOR UPDATE;
      END IF;

      v_old_paid := v_sale.amount_paid;
      v_new_paid := GREATEST(v_old_paid - v_row.amount, 0);
      v_old_bal := GREATEST(v_sale.grand_total - v_sale.credit_applied - v_old_paid, 0);
      v_new_bal := GREATEST(v_sale.grand_total - v_sale.credit_applied - v_new_paid, 0);
      v_debt_up := v_new_bal - v_old_bal;
      -- Any part of the payment above the sale total was put on credit by
      -- approve_sale(); that part comes back off.
      v_credit_down := GREATEST(v_old_paid + v_sale.credit_applied - v_sale.grand_total, 0)
                     - GREATEST(v_new_paid + v_sale.credit_applied - v_sale.grand_total, 0);
      IF v_row.customer_id IS NULL THEN v_credit_down := 0; END IF;

      IF v_credit_down > 0 THEN
        SELECT credit_balance INTO v_credit_cache FROM customers WHERE id = v_row.customer_id;
        IF COALESCE(v_credit_cache, 0) < v_credit_down THEN
          RAISE EXCEPTION 'Cannot undo: the over-payment credit from this payment (%) has already been used by the customer', v_credit_down;
        END IF;
      END IF;

      UPDATE sales SET amount_paid = v_new_paid, balance = balance + v_debt_up WHERE id = v_sale.id;

      IF v_debt_up > 0 THEN
        SELECT * INTO v_debt FROM debts WHERE sale_id = v_sale.id AND deleted_at IS NULL FOR UPDATE;
        IF FOUND THEN
          UPDATE debts SET
            amount_paid = GREATEST(amount_paid - v_debt_up, 0),
            outstanding = outstanding + v_debt_up,
            status = CASE WHEN amount_paid - v_debt_up <= 0 THEN 'unpaid'::debt_status ELSE 'partial'::debt_status END,
            updated_at = now()
          WHERE id = v_debt.id;
          v_debt_id := v_debt.id;
        ELSE
          -- Fully paid at the till, so approve_sale() never opened a debt.
          INSERT INTO debts(factory_id, customer_id, sale_id, sales_rep_id, total_amount, amount_paid, outstanding, status)
          VALUES (v_sale.factory_id, v_sale.customer_id, v_sale.id, v_sale.sales_rep_id, v_sale.grand_total,
                  GREATEST(v_sale.grand_total - v_debt_up, 0), v_debt_up,
                  CASE WHEN v_sale.grand_total - v_debt_up > 0 THEN 'partial'::debt_status ELSE 'unpaid'::debt_status END)
          RETURNING id INTO v_debt_id;
        END IF;
      END IF;

      IF v_row.customer_id IS NOT NULL THEN
        UPDATE customers SET
          outstanding_balance = outstanding_balance + v_debt_up,
          credit_balance = credit_balance - v_credit_down,
          updated_at = now()
        WHERE id = v_row.customer_id;
        PERFORM public._customer_ledger_post(
          v_row.factory_id, v_row.customer_id, 'REVERSAL', 'payment_reversal', p_id, v_sale.id, p_id, v_debt_id,
          0, 0, 0, -v_credit_down, v_debt_up,
          v_row.payment_method, v_label || ' of ' || v_row.receipt_number || ' (payment on ' || v_sale.invoice_number || ')',
          p_reason, NULL, NULL, p_uid);
      END IF;
      v_debt_restored := v_debt_up;
      v_credit_removed := v_credit_down;
    END IF;

  ELSIF v_row.customer_id IS NOT NULL THEN
    -- Old advance with no allocation rows: it can only have become credit.
    PERFORM 1 FROM customers WHERE id = v_row.customer_id FOR UPDATE;
    SELECT LEAST(credit_balance, v_row.amount) INTO v_credit_down FROM customers WHERE id = v_row.customer_id;
    v_credit_down := GREATEST(COALESCE(v_credit_down, 0), 0);
    UPDATE customers SET credit_balance = credit_balance - v_credit_down, updated_at = now()
     WHERE id = v_row.customer_id;
    PERFORM public._customer_ledger_post(
      v_row.factory_id, v_row.customer_id, 'REVERSAL', 'payment_reversal', p_id, NULL, p_id, NULL,
      0, 0, 0, -v_credit_down, 0,
      v_row.payment_method, v_label || ' of ' || v_row.receipt_number || ' (credit removed)', p_reason, NULL, NULL, p_uid);
    v_credit_removed := v_credit_down;
  END IF;

  RETURN jsonb_build_object('debt_restored', v_debt_restored, 'credit_removed', v_credit_removed);
END;
$$;
REVOKE ALL ON FUNCTION public._payment_undo(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;

-- ============ reverse_payment / reject_payment ============
CREATE OR REPLACE FUNCTION public.reverse_payment(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row payments_received%ROWTYPE;
  v_uid uuid := auth.uid();
  v_res jsonb;
BEGIN
  IF NOT public.has_permission(v_uid, 'payments'::module_key, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a payment'; END IF;
  SELECT * INTO v_row FROM payments_received WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_row.received_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reverse a payment you recorded yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'reversed');

  v_res := public._payment_undo(p_id, p_reason, v_uid, 'reversal');

  UPDATE payments_received SET status = 'reversed', reviewed_by = v_uid, reviewed_at = now(), review_note = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('payments', p_id, 'reverse', v_row.status, 'reversed', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reverse_payment', 'payments_received', p_id::text,
          jsonb_build_object('status', v_row.status, 'amount', v_row.amount),
          jsonb_build_object('status', 'reversed', 'reason', p_reason) || v_res);
  RETURN jsonb_build_object('reversed', true) || v_res;
END; $function$;

-- Money is applied when a payment is recorded, so rejecting it has to take
-- that back off the account exactly like a reversal does.
CREATE OR REPLACE FUNCTION public.reject_payment(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row payments_received%ROWTYPE;
  v_uid uuid := auth.uid();
  v_res jsonb;
BEGIN
  IF NOT public.has_permission(v_uid, 'payments'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to flag/reject a payment'; END IF;
  SELECT * INTO v_row FROM payments_received WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_row.received_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject a payment you recorded yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  v_res := public._payment_undo(p_id, p_reason, v_uid, 'rejection');

  UPDATE payments_received SET status = 'rejected', review_status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_note = p_reason
  WHERE id = p_id;
  PERFORM public.record_workflow_action('payments', p_id, 'reject', v_row.status, 'rejected', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reject_payment', 'payments_received', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'rejected', 'reason', p_reason) || v_res);
  RETURN jsonb_build_object('rejected', true) || v_res;
END; $function$;

-- ============ b. ledger-aware approve_sale / debt write-offs (from 20260924110000) ============
CREATE OR REPLACE FUNCTION public.approve_sale(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales%ROWTYPE;
  v_item RECORD;
  v_receipt_prefix text;
  v_receipt text;
  v_pay_line jsonb;
  v_line_amount numeric;
  v_line_method payment_method;
  v_move_reason text;
  v_before numeric;
  v_customer_credit numeric;
  v_credit_to_apply numeric := 0;
  v_final_balance numeric;
  v_excess numeric := 0;
BEGIN
  SELECT * INTO v_row FROM sales WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Approval must be done by someone other than who recorded the sale';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  -- The authoritative credit draw-down: however much the customer has
  -- available right now, automatically applied to whatever cash didn't
  -- cover. Locks the customer row so a concurrent sale for the same
  -- customer can't double-spend the same credit.
  IF v_row.customer_id IS NOT NULL AND NOT v_row.is_pr THEN
    SELECT credit_balance INTO v_customer_credit FROM customers WHERE id = v_row.customer_id FOR UPDATE;
    v_customer_credit := COALESCE(v_customer_credit, 0);
    v_credit_to_apply := LEAST(GREATEST(v_row.grand_total - v_row.amount_paid, 0), v_customer_credit);
  END IF;
  v_final_balance := GREATEST(v_row.grand_total - v_row.amount_paid - v_credit_to_apply, 0);

  v_move_reason := CASE WHEN v_row.is_pr THEN 'PR - complimentary, no charge' ELSE 'Sale' END;

  -- Re-validate and apply stock now, at approval time -- availability may
  -- have moved since the sale was submitted.
  FOR v_item IN SELECT si.product_id, si.quantity FROM sale_items si WHERE si.sale_id = p_id LOOP
    IF v_row.sales_rep_id IS NOT NULL THEN
      SELECT quantity INTO v_before FROM rep_stock WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id FOR UPDATE;
      IF COALESCE(v_before,0) < v_item.quantity THEN
        RAISE EXCEPTION 'Insufficient van stock for a line on this sale (product %)', v_item.product_id;
      END IF;
      UPDATE rep_stock SET quantity = quantity - v_item.quantity, updated_at = now()
       WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_row.factory_id, v_row.sales_rep_id, v_item.product_id, 'sold', -v_item.quantity, v_row.invoice_number, v_move_reason, v_uid, v_before, v_before - v_item.quantity);
    ELSE
      SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
      IF v_before IS NULL OR v_before < v_item.quantity THEN
        RAISE EXCEPTION 'Insufficient stock for a line on this sale (product %): have %, need %', v_item.product_id, COALESCE(v_before,0), v_item.quantity;
      END IF;
      UPDATE products SET current_stock = current_stock - v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_row.factory_id, v_item.product_id, 'sold', v_item.quantity, v_row.invoice_number, v_move_reason, v_uid, v_before, v_before - v_item.quantity);
    END IF;
  END LOOP;

  IF v_row.pending_payments IS NOT NULL AND jsonb_array_length(v_row.pending_payments) > 0 THEN
    FOR v_pay_line IN SELECT * FROM jsonb_array_elements(v_row.pending_payments) LOOP
      v_line_amount := (v_pay_line->>'amount')::numeric;
      v_line_method := COALESCE((v_pay_line->>'method')::payment_method, 'cash');
      IF v_line_amount IS NULL OR v_line_amount <= 0 THEN CONTINUE; END IF;

      v_receipt := public._next_receipt_number(v_row.factory_id);

      INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
      VALUES (v_row.factory_id, v_receipt, v_row.customer_id, p_id, v_line_amount, v_line_method, v_row.sale_date, v_uid, 'Payment at point of sale');
    END LOOP;
  END IF;

  IF v_final_balance > 0 THEN
    INSERT INTO debts(factory_id, customer_id, sale_id, sales_rep_id, total_amount, amount_paid, outstanding, status)
    VALUES (v_row.factory_id, v_row.customer_id, p_id, v_row.sales_rep_id, v_row.grand_total, v_row.amount_paid, v_final_balance,
            CASE WHEN v_row.amount_paid > 0 OR v_credit_to_apply > 0 THEN 'partial'::debt_status ELSE 'unpaid'::debt_status END);
  END IF;

  -- Cash alone paying more than the grand total (credit draw-down is
  -- already capped so it can never itself cause this) becomes new credit.
  v_excess := GREATEST(v_row.amount_paid - v_row.grand_total, 0);

  IF v_row.customer_id IS NOT NULL THEN
    UPDATE customers
       SET total_purchases = total_purchases + v_row.grand_total,
           outstanding_balance = outstanding_balance + v_final_balance,
           total_transactions = total_transactions + 1,
           credit_balance = credit_balance - v_credit_to_apply + v_excess,
           updated_at = now()
     WHERE id = v_row.customer_id;

    -- Ledger: what was sold and how it was funded, in the same transaction.
    PERFORM public._customer_ledger_post(
      v_row.factory_id, v_row.customer_id, 'SALE', 'sale', p_id, p_id, NULL, NULL,
      v_row.grand_total, v_row.amount_paid, 0, 0, v_final_balance,
      v_row.payment_method, 'Sale ' || v_row.invoice_number, NULL, NULL, NULL, v_uid);
    IF v_credit_to_apply > 0 THEN
      PERFORM public._customer_ledger_post(
        v_row.factory_id, v_row.customer_id, 'ADVANCE_APPLIED', 'sale', p_id, p_id, NULL, NULL,
        0, 0, v_credit_to_apply, -v_credit_to_apply, 0,
        NULL, 'Advance applied to ' || v_row.invoice_number, NULL, NULL, NULL, v_uid);
    END IF;
    IF v_excess > 0 THEN
      PERFORM public._customer_ledger_post(
        v_row.factory_id, v_row.customer_id, 'ADVANCE_PAYMENT', 'sale', p_id, p_id, NULL, NULL,
        0, 0, 0, v_excess, 0,
        v_row.payment_method, 'Overpayment on ' || v_row.invoice_number || ' held as credit', NULL, NULL, NULL, v_uid);
    END IF;
  END IF;

  UPDATE sales SET
    status = 'posted', approved_by = v_uid, approved_at = now(),
    credit_applied = v_credit_to_apply, balance = v_final_balance
  WHERE id = p_id;
  PERFORM public.record_workflow_action('sales', p_id, 'approve', v_row.status, 'posted', p_comment);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_sale', 'sales', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'posted', 'credit_applied', v_credit_to_apply, 'balance', v_final_balance));

  RETURN jsonb_build_object('sale_id', p_id, 'status', 'posted', 'credit_applied', v_credit_to_apply, 'balance', v_final_balance);
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_debt_writeoff(p_debt_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE; v_written_off numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts'::module_key, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  -- Lock order: customer before debt (same as payments and sales).
  PERFORM 1 FROM customers WHERE id = (SELECT customer_id FROM debts WHERE id = p_debt_id) FOR UPDATE;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot post a write-off you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'posted');

  v_written_off := v_debt.outstanding;
  UPDATE debts SET amount_paid = total_amount, outstanding = 0, status = 'paid', updated_at = now(),
    writeoff_status = 'posted', writeoff_amount = v_written_off
  WHERE id = p_debt_id;
  IF v_debt.customer_id IS NOT NULL THEN
    PERFORM 1 FROM customers WHERE id = v_debt.customer_id FOR UPDATE;
    UPDATE customers SET outstanding_balance = GREATEST(outstanding_balance - v_written_off, 0), updated_at = now() WHERE id = v_debt.customer_id;
    PERFORM public._customer_ledger_post(
      v_debt.factory_id, v_debt.customer_id, 'CREDIT_ADJUSTMENT', 'debt_writeoff', p_debt_id, v_debt.sale_id, NULL, p_debt_id,
      0, 0, 0, 0, -v_written_off,
      NULL, 'Debt written off', p_comment, NULL, NULL, v_uid);
  END IF;
  PERFORM public.record_workflow_action('debts', p_debt_id, 'post', v_debt.writeoff_status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_debt.factory_id, 'post_debt_writeoff', 'debts', p_debt_id::text,
          jsonb_build_object('outstanding', v_debt.outstanding, 'status', v_debt.status),
          jsonb_build_object('outstanding', 0, 'status', 'paid', 'written_off', v_written_off));
  RETURN jsonb_build_object('closed', true, 'written_off', v_written_off);
END; $function$;

CREATE OR REPLACE FUNCTION public.reverse_debt_writeoff(p_debt_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE; v_orig uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts'::module_key, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a write-off'; END IF;
  PERFORM 1 FROM customers WHERE id = (SELECT customer_id FROM debts WHERE id = p_debt_id) FOR UPDATE;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reverse a write-off you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'reversed');
  IF v_debt.writeoff_amount IS NULL THEN RAISE EXCEPTION 'No recorded write-off amount to reverse'; END IF;

  UPDATE debts SET
    amount_paid = GREATEST(amount_paid - v_debt.writeoff_amount, 0),
    outstanding = outstanding + v_debt.writeoff_amount,
    status = CASE WHEN amount_paid - v_debt.writeoff_amount <= 0 THEN 'unpaid'::debt_status ELSE 'partial'::debt_status END,
    updated_at = now(), writeoff_status = 'reversed'
  WHERE id = p_debt_id;
  IF v_debt.customer_id IS NOT NULL THEN
    PERFORM 1 FROM customers WHERE id = v_debt.customer_id FOR UPDATE;
    UPDATE customers SET outstanding_balance = outstanding_balance + v_debt.writeoff_amount, updated_at = now() WHERE id = v_debt.customer_id;
    SELECT id INTO v_orig FROM customer_account_transactions
     WHERE txn_type = 'CREDIT_ADJUSTMENT' AND reference_type = 'debt_writeoff' AND reference_id = p_debt_id;
    PERFORM public._customer_ledger_post(
      v_debt.factory_id, v_debt.customer_id, 'REVERSAL', 'debt_writeoff_reversal', p_debt_id, v_debt.sale_id, NULL, p_debt_id,
      0, 0, 0, 0, v_debt.writeoff_amount,
      NULL, 'Debt write-off reversed', p_reason, v_orig, NULL, v_uid);
  END IF;
  PERFORM public.record_workflow_action('debts', p_debt_id, 'reverse', v_debt.writeoff_status, 'reversed', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_debt.factory_id, 'reverse_debt_writeoff', 'debts', p_debt_id::text,
          jsonb_build_object('status', 'paid', 'outstanding', 0),
          jsonb_build_object('status', 'reversed', 'restored', v_debt.writeoff_amount, 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true, 'restored', v_debt.writeoff_amount);
END; $function$;

-- ============ c. approve_delete: sale refund counts only payments that stood (else = 20260930090000) ============
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

-- ============ d. Data repair ============
DO $$
DECLARE
  v_p record;
  v_c record;
  v_undone int := 0;
  v_resynced int := 0;
  v_maitama_fixed boolean := false;
  -- Maitama Hopital / INV20260928-01965
  c_customer uuid := '14de5afb-3185-46c9-8af9-cf0b55c4e4f1';
  c_sale uuid := 'c18fbb5a-9fad-4eb2-abbe-dfadc4c95392';
  c_transfer uuid := 'b6cefcbd-afcc-4f60-a516-4d51c99409f0';  -- RCP20260928-67505, confirmed
  v_sale sales%ROWTYPE;
  v_alloc uuid;
BEGIN
  -- 1. Rejected payments that are still applied to an account.
  FOR v_p IN
    SELECT p.id FROM payments_received p
     WHERE p.status = 'rejected'
       AND EXISTS (
         SELECT 1 FROM customer_account_transactions a
          WHERE a.payment_id = p.id AND a.txn_type IN ('DEBT_SETTLEMENT','ADVANCE_PAYMENT','CUSTOMER_PAYMENT')
            AND NOT EXISTS (SELECT 1 FROM customer_account_transactions r WHERE r.reverses_id = a.id))
     ORDER BY p.created_at
  LOOP
    PERFORM public._payment_undo(v_p.id, 'Rejected payment was still counted on the account (repair 2026-10-01)', NULL, 'rejection');
    v_undone := v_undone + 1;
  END LOOP;

  -- 2. INV20260928-01965: the confirmed transfer paid this sale but, with the
  --    reversed cash entry having left no debt behind, was held as advance.
  SELECT * INTO v_sale FROM sales WHERE id = c_sale FOR UPDATE;
  IF FOUND AND v_sale.deleted_at IS NULL AND v_sale.status = 'posted'
     AND v_sale.amount_paid = 0 AND v_sale.balance > 0
     AND NOT EXISTS (SELECT 1 FROM debts WHERE sale_id = c_sale)
     AND EXISTS (SELECT 1 FROM payments_received WHERE id = c_transfer AND status = 'confirmed' AND amount = 140000)
  THEN
    PERFORM 1 FROM customers WHERE id = c_customer FOR UPDATE;
    SELECT id INTO v_alloc FROM customer_account_transactions
     WHERE payment_id = c_transfer AND txn_type = 'CUSTOMER_PAYMENT';

    UPDATE sales SET amount_paid = 140000, balance = 0 WHERE id = c_sale;
    -- Takes off the wrongly re-opened 140,000 and the 140,000 advance; the
    -- 1,000 paid over the 139,000 total stays as credit.
    UPDATE customers SET
      outstanding_balance = GREATEST(outstanding_balance - 140000, 0),
      credit_balance = GREATEST(credit_balance - 140000, 0),
      updated_at = now()
    WHERE id = c_customer;

    PERFORM public._customer_ledger_post(
      v_sale.factory_id, c_customer, 'SALE', 'sale', c_sale, c_sale, NULL, NULL,
      v_sale.grand_total, 140000, 0, 0, 0,
      'transfer', 'Sale ' || v_sale.invoice_number, 'Posted by repair 2026-10-01', NULL, NULL, NULL);
    -- reference_id = the sale, so a later reversal of the payment itself
    -- (reference_id = payment) can still be recorded.
    PERFORM public._customer_ledger_post(
      v_sale.factory_id, c_customer, 'REVERSAL', 'payment_reversal', c_sale, c_sale, c_transfer, NULL,
      0, 0, 0, -140000, 0,
      'transfer', 'RCP20260928-67505 re-allocated: it paid ' || v_sale.invoice_number || ', not an advance',
      'Repair 2026-10-01', v_alloc, NULL, NULL);
    PERFORM public._customer_ledger_post(
      v_sale.factory_id, c_customer, 'ADVANCE_PAYMENT', 'sale', c_sale, c_sale, NULL, NULL,
      0, 0, 0, 140000 - v_sale.grand_total, 0,
      'transfer', 'Overpayment on ' || v_sale.invoice_number || ' held as credit', 'Repair 2026-10-01', NULL, NULL, NULL);
    v_maitama_fixed := true;
  END IF;

  -- 3. Bring the account history back in line with the cached balances,
  --    which (unlike the history) were kept right by the pre-ledger functions.
  FOR v_c IN
    SELECT c.id, c.factory_id, c.credit_balance, c.outstanding_balance,
           COALESCE(l.credit_after, 0) AS l_credit, COALESCE(l.debt_after, 0) AS l_debt
      FROM customers c
      LEFT JOIN LATERAL (
        SELECT credit_after, debt_after FROM customer_account_transactions t
         WHERE t.customer_id = c.id ORDER BY t.seq DESC LIMIT 1
      ) l ON true
     WHERE c.deleted_at IS NULL
       AND (c.credit_balance <> COALESCE(l.credit_after, 0) OR c.outstanding_balance <> COALESCE(l.debt_after, 0))
  LOOP
    PERFORM public._customer_ledger_post(
      v_c.factory_id, v_c.id,
      CASE WHEN (v_c.credit_balance - v_c.l_credit) - (v_c.outstanding_balance - v_c.l_debt) >= 0
           THEN 'CREDIT_ADJUSTMENT' ELSE 'DEBIT_ADJUSTMENT' END,
      'ledger_resync', NULL, NULL, NULL, NULL,
      0, 0, 0, v_c.credit_balance - v_c.l_credit, v_c.outstanding_balance - v_c.l_debt,
      NULL, 'Account history re-synced to the stored balances',
      'Sales and advance draw-downs approved from 21 Sep to 1 Oct 2026 were not written to the history. '
      || 'Per-invoice detail for that period is on the Sales page.',
      NULL, NULL, NULL);
    v_resynced := v_resynced + 1;
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (NULL, NULL, 'repair_payment_ledger_20261001', 'customers', NULL, NULL,
          jsonb_build_object('rejected_payments_undone', v_undone,
                             'maitama_inv20260928_01965_fixed', v_maitama_fixed,
                             'customers_resynced', v_resynced));
END $$;
