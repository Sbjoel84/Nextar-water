-- Take a payment from any customer's account, not only marketers and credit
-- accounts. record_marketer_payment() as in 20261024190000_credit_accounts.sql
-- with the customer check widened; the payment is applied the same way
-- (oldest debts first, anything extra kept as the customer's advance).

CREATE OR REPLACE FUNCTION public.record_marketer_payment(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_customer uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_date date := COALESCE(NULLIF(payload->>'payment_date','')::date, CURRENT_DATE);
  v_remarks text := NULLIF(btrim(COALESCE(payload->>'remarks','')), '');
  v_lines jsonb := payload->'payments';
  v_line jsonb;
  v_amount numeric;
  v_method payment_method;
  v_receipt text;
  v_payment_id uuid;
  v_res jsonb;
  v_total numeric := 0;
  v_settled numeric := 0;
  v_credit numeric := 0;
  v_results jsonb := '[]'::jsonb;
  v_first_receipt text;
BEGIN
  IF NOT (public.has_permission(v_uid, 'sales'::module_key, 'create'::action_key)
          OR public.has_permission(v_uid, 'payments'::module_key, 'create'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Select the account'; END IF;
  IF v_date > CURRENT_DATE THEN RAISE EXCEPTION 'Payment date cannot be in the future'; END IF;
  IF v_lines IS NULL OR jsonb_typeof(v_lines) <> 'array' OR jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'Enter the amount paid';
  END IF;

  -- Any customer account in this factory (was: marketers and credit
  -- accounts only), so the accountant can take a payment from any account.
  PERFORM 1 FROM customers
   WHERE id = v_customer AND factory_id = v_factory AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer account not found for this factory'; END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    v_amount := COALESCE((v_line->>'amount')::numeric, 0);
    v_method := COALESCE((v_line->>'method')::payment_method, 'cash');
    IF v_amount <= 0 THEN CONTINUE; END IF;

    v_receipt := public._next_receipt_number(v_factory);
    INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
    VALUES (v_factory, v_receipt, v_customer, NULL, v_amount, v_method, v_date, v_uid,
            COALESCE(v_remarks, 'Account payment'))
    RETURNING id INTO v_payment_id;

    v_res := public._customer_receive_money(v_factory, v_customer, v_amount, v_method, v_date, v_uid,
                                            COALESCE(v_remarks, 'Account payment'), v_payment_id, v_receipt,
                                            NULL, 'payment', NULL);

    v_total := v_total + v_amount;
    v_settled := v_settled + COALESCE((v_res->>'settled_debt')::numeric, 0);
    v_credit := v_credit + COALESCE((v_res->>'credit_added')::numeric, 0);
    v_first_receipt := COALESCE(v_first_receipt, v_receipt);
    v_results := v_results || jsonb_build_object('payment_id', v_payment_id, 'receipt_number', v_receipt,
                                                 'amount', v_amount, 'payment_method', v_method);
  END LOOP;
  IF v_total <= 0 THEN RAISE EXCEPTION 'Enter the amount paid'; END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'record_account_payment', 'customers', v_customer::text, NULL,
          jsonb_build_object('total', v_total, 'settled_debt', v_settled, 'credit_added', v_credit,
                             'receipt_number', v_first_receipt));

  RETURN jsonb_build_object('payments', v_results, 'total_amount', v_total,
                            'settled_debt', v_settled, 'credit_added', v_credit,
                            'receipt_number', v_first_receipt);
END;
$$;
REVOKE ALL ON FUNCTION public.record_marketer_payment(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_marketer_payment(jsonb) TO authenticated;
