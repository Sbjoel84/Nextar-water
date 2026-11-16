-- Turn an existing customer into a marketer, keeping their history.
--
-- Orders are sometimes posted for a marketer under an ordinary customer record
-- (e.g. JOHN, JAPHET), so their sales and debts never reach the marketer list.
-- make_customer_marketer() makes that customer record THE marketer's account:
--
--   * a marketer (sales_reps row) with the same name exists ->
--       link it to this customer. The account the marketer had until now is
--       removed if it has no history; if it does have history, both accounts
--       are kept (this one becomes a marketer account too) and the result says
--       so, since ledgers can't be merged safely.
--   * no such marketer -> create one, linked to this customer.
--
-- Sales, payments, debts and ledger lines stay on the customer they were
-- recorded against; nothing is moved or rewritten.

CREATE OR REPLACE FUNCTION public._customer_has_activity(p_customer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM sales WHERE customer_id = p_customer_id)
      OR EXISTS (SELECT 1 FROM payments_received WHERE customer_id = p_customer_id)
      OR EXISTS (SELECT 1 FROM debts WHERE customer_id = p_customer_id)
      OR EXISTS (SELECT 1 FROM customer_account_transactions WHERE customer_id = p_customer_id)
      OR EXISTS (SELECT 1 FROM sales_returns WHERE customer_id = p_customer_id);
$$;
REVOKE ALL ON FUNCTION public._customer_has_activity(uuid) FROM PUBLIC, anon, authenticated;

-- Drop an auto-created, unused marketer account. Hard delete when nothing
-- points at it; otherwise unlink and soft-delete.
CREATE OR REPLACE FUNCTION public._discard_empty_customer(p_customer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE customers SET sales_rep_id = NULL WHERE id = p_customer_id;
  BEGIN
    DELETE FROM customers WHERE id = p_customer_id;
  EXCEPTION WHEN foreign_key_violation THEN
    UPDATE customers SET deleted_at = now() WHERE id = p_customer_id;
  END;
END;
$$;
REVOKE ALL ON FUNCTION public._discard_empty_customer(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.make_customer_marketer(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_c customers%ROWTYPE;
  v_rep sales_reps%ROWTYPE;
  v_other uuid;
  v_rep_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  SELECT * INTO v_c FROM customers WHERE id = p_customer_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;

  -- Already linked to a marketer: just make sure it's typed as one.
  IF v_c.sales_rep_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM sales_reps WHERE id = v_c.sales_rep_id) THEN
    UPDATE customers SET customer_type = 'marketer', registered = true, updated_at = now()
     WHERE id = v_c.id;
    RETURN jsonb_build_object('result', 'already', 'sales_rep_id', v_c.sales_rep_id, 'name', v_c.name);
  END IF;

  SELECT * INTO v_rep FROM sales_reps
   WHERE factory_id = v_c.factory_id
     AND lower(btrim(full_name)) = lower(btrim(v_c.name))
   ORDER BY created_at
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    SELECT id INTO v_other FROM customers
     WHERE sales_rep_id = v_rep.id AND id <> v_c.id AND deleted_at IS NULL
     LIMIT 1;

    IF v_other IS NOT NULL AND public._customer_has_activity(v_other) THEN
      -- Both accounts carry history: keep both, mark this one a marketer.
      UPDATE customers SET customer_type = 'marketer', registered = true, updated_at = now()
       WHERE id = v_c.id;
      RETURN jsonb_build_object('result', 'second_account', 'sales_rep_id', v_rep.id, 'name', v_c.name);
    END IF;

    IF v_other IS NOT NULL THEN
      PERFORM public._discard_empty_customer(v_other);
    END IF;
    UPDATE customers
       SET sales_rep_id = v_rep.id, customer_type = 'marketer', registered = true,
           phone = COALESCE(phone, v_rep.phone), updated_at = now()
     WHERE id = v_c.id;
    RETURN jsonb_build_object('result', 'linked', 'sales_rep_id', v_rep.id, 'name', v_c.name);
  END IF;

  -- No marketer by that name: create one. trg_sync_sales_rep_customer makes
  -- a fresh empty account for it, which is swapped for this customer.
  v_rep_id := gen_random_uuid();
  INSERT INTO sales_reps (id, factory_id, full_name, phone, status)
  VALUES (v_rep_id, v_c.factory_id, btrim(v_c.name), v_c.phone, 'active');

  FOR v_other IN SELECT id FROM customers WHERE sales_rep_id = v_rep_id AND id <> v_c.id LOOP
    PERFORM public._discard_empty_customer(v_other);
  END LOOP;
  UPDATE customers
     SET sales_rep_id = v_rep_id, customer_type = 'marketer', registered = true, updated_at = now()
   WHERE id = v_c.id;
  RETURN jsonb_build_object('result', 'created', 'sales_rep_id', v_rep_id, 'name', v_c.name);
END;
$$;
REVOKE ALL ON FUNCTION public.make_customer_marketer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.make_customer_marketer(uuid) TO authenticated;
