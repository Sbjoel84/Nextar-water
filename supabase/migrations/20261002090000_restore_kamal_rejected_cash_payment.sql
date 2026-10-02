-- ============================================================================
-- RESTORE KAMAL'S N22,450 CASH PAYMENT (RCP20261001-40706) -- REJECTED IN ERROR
-- ----------------------------------------------------------------------------
-- 1 Oct 2026: Princess recorded Kamal's payment for INV20260930-28575
-- (N37,500) as N22,450 cash + N15,050 POS. At 12:35 UTC the POS line was
-- approved and, four seconds later, the cash line was rejected ("Rejected").
-- The cash had been received: at 11:31 UTC Princess moved it to Expenses
-- (RCT-20261001-03334, "Cash to Blessing for expenses"), and Expenses has
-- since spent it (fuel, logistics).
--
-- The 2026-10-01 repair (14:39 local, shown as "Anonymous" in the audit log)
-- then applied that rejection to the account, so:
--   - Kamal shows N22,450 owing on INV20260930-28575 that he has paid;
--   - the Payments ledger drops the N22,450 from revenue but still deducts
--     the N22,450 moved to Expenses, leaving Princess N22,450 short.
--
-- Removing the transfer to Expenses would only move the shortage there (the
-- cash was really handed over and spent), so the payment itself is restored:
-- confirmed again and re-applied to the invoice. The cash transfer and the
-- expenses are left exactly as they are.
-- ============================================================================
DO $$
DECLARE
  c_payment  uuid := 'fee22b48-c59d-4ddb-b330-b1d82e8766db';  -- RCP20261001-40706
  c_customer uuid := '8009c644-de56-47fe-8c3b-6dc94e616029';  -- Kamal
  c_sale     uuid := '872d2bc8-fd78-462f-8c99-ea78ee631251';  -- INV20260930-28575
  c_debt     uuid := '27d22ee4-0f6a-42a0-b8b4-c010d01ba85d';
  c_amount   numeric := 22450;
  v_pay payments_received%ROWTYPE;
  v_debt debts%ROWTYPE;
BEGIN
  SELECT * INTO v_pay FROM payments_received WHERE id = c_payment FOR UPDATE;
  IF NOT FOUND OR v_pay.status <> 'rejected' OR v_pay.amount <> c_amount THEN
    RAISE NOTICE 'RCP20261001-40706 is not a rejected N22,450 payment any more; nothing done';
    RETURN;
  END IF;

  PERFORM 1 FROM sales WHERE id = c_sale FOR UPDATE;
  PERFORM 1 FROM customers WHERE id = c_customer FOR UPDATE;
  SELECT * INTO v_debt FROM debts WHERE id = c_debt FOR UPDATE;
  IF NOT FOUND OR v_debt.deleted_at IS NOT NULL OR v_debt.outstanding < c_amount THEN
    RAISE EXCEPTION 'INV20260930-28575 no longer has N22,450 outstanding; check it before restoring the payment';
  END IF;

  UPDATE payments_received SET
    status = 'confirmed', review_status = 'approved',
    reviewed_by = NULL, reviewed_at = now(),
    review_note = 'Rejected in error on 2026-10-01; cash was received and moved to Expenses (RCT-20261001-03334). Restored 2026-10-02.'
  WHERE id = c_payment;

  UPDATE debts SET
    amount_paid = amount_paid + c_amount,
    outstanding = outstanding - c_amount,
    status = CASE WHEN outstanding - c_amount <= 0 THEN 'paid'::debt_status ELSE 'partial'::debt_status END,
    updated_at = now()
  WHERE id = c_debt;

  UPDATE sales SET amount_paid = amount_paid + c_amount, balance = GREATEST(balance - c_amount, 0)
   WHERE id = c_sale;

  UPDATE customers SET outstanding_balance = GREATEST(outstanding_balance - c_amount, 0), updated_at = now()
   WHERE id = c_customer;

  -- New allocation row (the original one, seq 54, stays reversed by seq 57).
  -- reference_type 'payment_restore' keeps it clear of the original
  -- DEBT_SETTLEMENT/payment row in uq_cat_reference.
  PERFORM public._customer_ledger_post(
    v_pay.factory_id, c_customer, 'DEBT_SETTLEMENT', 'payment_restore', c_payment, c_sale, c_payment, c_debt,
    0, c_amount, 0, 0, -c_amount,
    'cash', 'Payment applied to INV20260930-28575 (restored)',
    'RCP20261001-40706 was rejected in error; restored 2026-10-02', NULL, NULL, NULL);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (NULL, v_pay.factory_id, 'restore_rejected_payment', 'payments_received', c_payment::text,
          jsonb_build_object('status', 'rejected', 'debt_outstanding', v_debt.outstanding),
          jsonb_build_object('status', 'confirmed', 'debt_outstanding', v_debt.outstanding - c_amount,
                             'reason', 'Rejected in error; cash already moved to Expenses (RCT-20261001-03334)'));
END $$;
