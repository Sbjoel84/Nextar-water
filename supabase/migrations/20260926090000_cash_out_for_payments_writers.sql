-- Let users with 'payments' write (e.g. the payments desk) use the Cash Out
-- button on the Cash & Receivables ledger. Cash Out logs a sales-cash hand-over
-- as a receipt / other_inflow tagged related_reference = 'sales_cash_out', which
-- the Expenses page then shows as Cash In. Everything else create_cash_transaction
-- can do still requires 'receipts-payments' write.
CREATE OR REPLACE FUNCTION public.create_cash_transaction(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_type text := payload->>'transaction_type';
  v_category text := payload->>'category';
  v_amount numeric := (payload->>'amount')::numeric;
  v_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'cash');
  v_date date := COALESCE((payload->>'transaction_date')::date, CURRENT_DATE);
  v_description text := payload->>'description';
  v_payer_payee text := payload->>'payer_payee';
  v_reference text := payload->>'related_reference';
  v_recorded_by text := payload->>'recorded_by_name';
  v_prefix text;
  v_number text;
  v_id uuid;
BEGIN
  IF NOT (
    public.has_permission(v_uid, 'receipts-payments'::module_key, 'write'::action_key)
    OR (
      public.has_permission(v_uid, 'payments'::module_key, 'write'::action_key)
      AND v_type = 'receipt'
      AND v_category = 'other_inflow'
      AND v_reference = 'sales_cash_out'
    )
  ) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_type NOT IN ('receipt','payment') THEN RAISE EXCEPTION 'transaction_type must be receipt or payment'; END IF;
  IF v_category NOT IN ('other_income','donation_endowment','other_inflow','other_outflow') THEN
    RAISE EXCEPTION 'Invalid category';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'Amount must be > 0'; END IF;
  IF v_recorded_by IS NULL OR btrim(v_recorded_by) = '' THEN RAISE EXCEPTION 'Recorded by name is required'; END IF;

  v_prefix := CASE WHEN v_type = 'receipt' THEN 'RCT-' ELSE 'PMT-' END;
  v_number := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO cash_transactions(factory_id, transaction_number, transaction_date, transaction_type, category,
                                 description, amount, payment_method, payer_payee, related_reference,
                                 recorded_by_name, recorded_by)
  VALUES (v_factory, v_number, v_date, v_type, v_category, v_description, v_amount, v_method,
          v_payer_payee, v_reference, v_recorded_by, v_uid)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'transaction_number', v_number);
END;
$$;
