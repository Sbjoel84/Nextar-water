-- ============================================================================
-- Record Advance Payment moves from the Sales page to Finance -> Payments
-- ----------------------------------------------------------------------------
-- Taking a customer's money is the accountant's job, not the sales person's.
-- record_customer_advance() used to require sales:write (which the accountant
-- doesn't hold); it now uses the same guard as record_payment() --
-- payments:write or debts:write. Body otherwise identical to
-- 20260924110000_customer_account_ledger.sql.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_customer_advance(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_customer uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_amount numeric := COALESCE((payload->>'amount')::numeric, 0);
  v_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'cash');
  v_remarks text := NULLIF(btrim(COALESCE(payload->>'remarks','')), '');
  v_reference text := NULLIF(btrim(COALESCE(payload->>'reference','')), '');
  v_idem text := NULLIF(btrim(COALESCE(payload->>'idempotency_key','')), '');
  v_receipt text;
  v_payment_id uuid;
  v_existing uuid;
  v_res jsonb;
BEGIN
  IF NOT (public.has_permission(v_uid, 'payments'::module_key, 'write'::action_key) OR public.has_permission(v_uid, 'debts'::module_key, 'write'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_customer IS NULL THEN RAISE EXCEPTION 'A registered customer is required for an advance payment'; END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Amount must be > 0'; END IF;

  -- Serialises everything for this customer, including a double-submit.
  PERFORM 1 FROM customers WHERE id = v_customer AND factory_id = v_factory FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found for this factory'; END IF;

  IF v_idem IS NOT NULL THEN
    SELECT payment_id INTO v_existing FROM customer_account_transactions WHERE idempotency_key = v_idem;
    IF FOUND THEN
      RETURN jsonb_build_object('duplicate', true, 'payment_id', v_existing,
        'receipt_number', (SELECT receipt_number FROM payments_received WHERE id = v_existing));
    END IF;
  END IF;

  v_receipt := public._next_receipt_number(v_factory);
  INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
  VALUES (v_factory, v_receipt, v_customer, NULL, v_amount, v_method, CURRENT_DATE, v_uid,
          COALESCE(v_remarks, 'Advance payment') || CASE WHEN v_reference IS NOT NULL THEN ' (Ref: ' || v_reference || ')' ELSE '' END)
  RETURNING id INTO v_payment_id;

  v_res := public._customer_receive_money(v_factory, v_customer, v_amount, v_method, CURRENT_DATE, v_uid,
                                          v_remarks, v_payment_id, v_receipt, NULL, 'advance', v_idem);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'record_customer_advance', 'customers', v_customer::text, NULL,
          jsonb_build_object('amount', v_amount, 'payment_method', v_method, 'receipt_number', v_receipt,
                             'settled_debt', v_res->'settled_debt', 'credit_added', v_res->'credit_added'));

  RETURN jsonb_build_object('payment_id', v_payment_id, 'receipt_number', v_receipt, 'amount', v_amount,
                            'settled_debt', v_res->'settled_debt', 'credit_added', v_res->'credit_added',
                            'allocations', v_res->'allocations');
END;
$$;

REVOKE ALL ON FUNCTION public.record_customer_advance(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_customer_advance(jsonb) TO authenticated;
