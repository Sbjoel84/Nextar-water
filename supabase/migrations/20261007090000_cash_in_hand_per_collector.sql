-- Cash in hand belongs to a person, not to a factory, and a Cash Out can hand
-- over cash that someone else collected.
--
-- Two gaps in 20261006090000 showed up on Princess's account (-80,700 shown,
-- actually holding 3,400):
--
--   1. cash_in_hand only counted payments in the Cash Out's factory. Cash she
--      collected for the Nylon Factory (50,000 on 2026-10-05) and handed over
--      through a Water Factory Cash Out was never credited to her.
--   2. Cash Outs were always charged to whoever recorded them. Princess also
--      hands over cash Vivian collected (34,100 so far), so her balance went
--      down by cash she never collected while Vivian's never went down.
--
-- Now:
--   - cash in hand sums a person's cash across every factory;
--   - cash_transactions.cash_holder names whose collected cash a Cash Out
--     moves (NULL = the recorder, as before), and the guard checks that person;
--   - the three past Cash Outs that carried Vivian's cash are re-attributed.

ALTER TABLE public.cash_transactions
  ADD COLUMN IF NOT EXISTS cash_holder uuid REFERENCES public.profiles(id);

COMMENT ON COLUMN public.cash_transactions.cash_holder IS
  'Whose collected cash this transaction moves; NULL means recorded_by.';

-- p_factory is kept so existing callers still work; cash is counted across all
-- factories.
CREATE OR REPLACE FUNCTION public.cash_in_hand(p_factory uuid, p_user uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE((SELECT sum(amount) FROM payments_received
               WHERE received_by = p_user
                 AND payment_method = 'cash' AND deleted_at IS NULL
                 AND status::text NOT IN ('rejected', 'reversed')), 0)
    + COALESCE((SELECT sum(public._cash_book_effect(transaction_type, category, related_reference, amount, 'payments'))
                  FROM cash_transactions
                 WHERE COALESCE(cash_holder, recorded_by) = p_user
                   AND payment_method = 'cash'), 0);
$$;
REVOKE ALL ON FUNCTION public.cash_in_hand(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- What the Cash Out dialog shows for the person whose cash is being moved.
CREATE OR REPLACE FUNCTION public.staff_cash_in_hand(p_factory uuid, p_user uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user IS DISTINCT FROM auth.uid()
     AND NOT public.has_permission(auth.uid(), 'receipts-payments'::module_key, 'write'::action_key)
     AND NOT public.has_permission(auth.uid(), 'payments'::module_key, 'write'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN public.cash_in_hand(p_factory, p_user);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_cash_in_hand(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_cash_in_hand(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_cash_in_hand()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_factory uuid := COALESCE(NEW.factory_id, OLD.factory_id);
  v_new_holder uuid;
  v_old_holder uuid;
  v_holder uuid;
  v_old numeric;
  v_new numeric;
  v_bal numeric;
  v_name text;
BEGIN
  IF TG_OP <> 'DELETE' THEN v_new_holder := COALESCE(NEW.cash_holder, NEW.recorded_by); END IF;
  IF TG_OP <> 'INSERT' THEN v_old_holder := COALESCE(OLD.cash_holder, OLD.recorded_by); END IF;

  FOREACH v_holder IN ARRAY ARRAY[v_new_holder, v_old_holder] LOOP
    CONTINUE WHEN v_holder IS NULL;
    v_old := 0; v_new := 0;
    IF TG_OP <> 'INSERT' AND v_old_holder = v_holder AND OLD.payment_method = 'cash' THEN
      v_old := public._cash_book_effect(OLD.transaction_type, OLD.category, OLD.related_reference, OLD.amount, 'payments');
    END IF;
    IF TG_OP <> 'DELETE' AND v_new_holder = v_holder AND NEW.payment_method = 'cash' THEN
      v_new := public._cash_book_effect(NEW.transaction_type, NEW.category, NEW.related_reference, NEW.amount, 'payments');
    END IF;
    CONTINUE WHEN v_new >= v_old;

    PERFORM pg_advisory_xact_lock(hashtextextended('cash_in_hand:' || v_holder::text, 0));
    v_bal := public.cash_in_hand(v_factory, v_holder);
    IF v_bal < 0 THEN
      SELECT full_name INTO v_name FROM profiles WHERE id = v_holder;
      IF v_bal + (v_old - v_new) < 0 THEN
        RAISE EXCEPTION 'Not enough cash in hand for this Cash Out. % has already moved % more cash than collected; it is taken from the next cash collections.',
          COALESCE(v_name, 'This user'),
          public._fmt_money(-(v_bal + (v_old - v_new)));
      END IF;
      RAISE EXCEPTION 'Not enough cash in hand for this Cash Out. % has % in cash collected from sales.',
        COALESCE(v_name, 'This user'),
        public._fmt_money(v_bal + (v_old - v_new));
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- Same as 20260926090000, plus payload.cash_holder (defaults to the caller).
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
  v_holder uuid := NULLIF(payload->>'cash_holder', '')::uuid;
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
  IF v_holder = v_uid THEN v_holder := NULL; END IF;
  IF v_holder IS NOT NULL THEN
    IF v_reference IS DISTINCT FROM 'sales_cash_out' THEN
      RAISE EXCEPTION 'Only a Cash Out can move cash collected by someone else';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_holder) THEN
      RAISE EXCEPTION 'Unknown cash collector';
    END IF;
  END IF;

  v_prefix := CASE WHEN v_type = 'receipt' THEN 'RCT-' ELSE 'PMT-' END;
  v_number := v_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO cash_transactions(factory_id, transaction_number, transaction_date, transaction_type, category,
                                 description, amount, payment_method, payer_payee, related_reference,
                                 recorded_by_name, recorded_by, cash_holder)
  VALUES (v_factory, v_number, v_date, v_type, v_category, v_description, v_amount, v_method,
          v_payer_payee, v_reference, v_recorded_by, v_uid, v_holder)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'transaction_number', v_number);
END;
$$;

-- ---------- one-off: Vivian's cash that Princess handed over ----------
-- Vivian (6787213d…) collected 21,000 + 2,800 (21–22 Sep), 3,500 (30 Sep) and
-- 3,400 (2 Oct) in cash; Princess (4450cc1d…) handed it to Expenses inside her
-- own Cash Outs. The 3,500 and 3,400 Cash Outs were Vivian's cash alone; the
-- 23 Sep Cash Out of 50,800 was Princess's 27,000 + Vivian's 23,800, so it is
-- split in two. Totals on every book stay the same. Re-running is a no-op.
DO $$
DECLARE
  v_vivian uuid := '6787213d-d519-429d-bf9a-3aa484d35c54';
  v_mixed cash_transactions%ROWTYPE;
BEGIN
  UPDATE cash_transactions SET cash_holder = v_vivian
   WHERE transaction_number IN ('RCT-20260930-71929', 'RCT-20261002-49707')
     AND related_reference = 'sales_cash_out'
     AND cash_holder IS NULL;

  SELECT * INTO v_mixed FROM cash_transactions
   WHERE transaction_number = 'RCT-20260923-08369' AND amount = 50800 AND cash_holder IS NULL;
  IF FOUND THEN
    -- Insert Vivian's part first so Expenses' cash never dips in between.
    INSERT INTO cash_transactions(factory_id, transaction_number, transaction_date, transaction_type, category,
                                   description, amount, payment_method, payer_payee, related_reference,
                                   recorded_by_name, recorded_by, cash_holder, created_at)
    VALUES (v_mixed.factory_id, v_mixed.transaction_number || '-V', v_mixed.transaction_date,
            v_mixed.transaction_type, v_mixed.category,
            'Cash remitted from sales (collected by Vivian; split from ' || v_mixed.transaction_number || ')',
            23800, v_mixed.payment_method, v_mixed.payer_payee, v_mixed.related_reference,
            v_mixed.recorded_by_name, v_mixed.recorded_by, v_vivian, v_mixed.created_at);
    UPDATE cash_transactions SET amount = 27000 WHERE id = v_mixed.id;
  END IF;
END $$;
