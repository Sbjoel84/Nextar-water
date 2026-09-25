-- ============================================================================
-- RECYCLE BIN (every approved delete), CUSTOMER DELETE, QUICK-ADD CUSTOMER
-- ----------------------------------------------------------------------------
-- 1) quick_add_customer(): the Record Payment dialog can create a customer on
--    the spot (a customer paying in advance before buying anything). The
--    payment itself still goes through record_payment(), which already turns
--    money from a customer with no debt into credit_balance, and create_sale()
--    auto-applies that credit on their next purchase.
--
-- 2) Recycle bin. Until now approve_delete() hard-deleted everything except
--    sales. Now every approved delete lands in public.recycle_bin for 30 days,
--    restorable by an admin, then purged for good:
--      - simple records (employees, documents, reps, vehicles, drivers,
--        expenses, cash transactions, packaging rules, suppliers): the row is
--        snapshotted to jsonb and removed; restore re-inserts the snapshot.
--        Attached files stay in Storage until the purge.
--      - sales: soft-deleted as before (deleted_at), effects reversed as
--        before; what was reversed is recorded so restore can re-apply it.
--        (Previously restore_sale() only cleared deleted_at, leaving stock
--        inflated and the debt gone.)
--      - customers (new): the customer and everything linked to them -- sales,
--        payments, debts, sales returns, deliveries -- are soft-deleted
--        together under one bin entry. Posted sales give their stock back and
--        accepted returns take theirs out again, as if none of it happened;
--        restoring the customer re-applies both. Account balances are not
--        touched: the customer is hidden, not settled.
--    RLS hides soft-deleted rows from every page, same approach as sales.
--
-- 3) Purge: no scheduler exists in this project, so purge_recycle_bin() runs
--    whenever an admin opens the app (and the Recycle Bin tab). It returns the
--    Storage files of purged records so the client can remove them -- SQL
--    can't delete Storage objects.
-- ============================================================================

-- ============ 1. quick_add_customer ============
CREATE OR REPLACE FUNCTION public.quick_add_customer(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_name text := btrim(COALESCE(payload->>'name', ''));
  v_phone text := NULLIF(btrim(COALESCE(payload->>'phone', '')), '');
  v_address text := NULLIF(btrim(COALESCE(payload->>'address', '')), '');
  v_id uuid;
  v_ok boolean := false;
  v_mod text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  FOREACH v_mod IN ARRAY ARRAY['payments','debts','receipts-payments','customers','sales'] LOOP
    IF public.has_permission(v_uid, v_mod::module_key, 'write'::action_key) THEN v_ok := true; END IF;
  END LOOP;
  IF NOT v_ok THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'Customer name is required'; END IF;

  -- Same phone (or, with no phone, same name) = the customer already exists.
  IF v_phone IS NOT NULL THEN
    SELECT id INTO v_id FROM customers
     WHERE factory_id = v_factory AND phone = v_phone AND deleted_at IS NULL LIMIT 1;
  ELSE
    SELECT id INTO v_id FROM customers
     WHERE factory_id = v_factory AND lower(name) = lower(v_name) AND deleted_at IS NULL LIMIT 1;
  END IF;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_id, 'existing', true);
  END IF;

  INSERT INTO customers(factory_id, name, phone, address, registered)
  VALUES (v_factory, v_name, v_phone, v_address, true)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'create', 'customers', v_id::text,
          jsonb_build_object('name', v_name, 'phone', v_phone, 'source', 'record_payment'));

  RETURN jsonb_build_object('id', v_id, 'existing', false);
END; $$;
-- (deleted_at is added below; plpgsql only resolves it at call time.)

-- ============ 2. soft-delete columns ============
ALTER TABLE public.customers         ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.payments_received ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.debts             ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.sales_returns     ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.deliveries        ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
-- Which bin entry hid the row, so a customer restore brings back exactly
-- what went with it (and a sale deleted on its own stays separate).
ALTER TABLE public.customers         ADD COLUMN IF NOT EXISTS deleted_bin_id uuid;
ALTER TABLE public.sales             ADD COLUMN IF NOT EXISTS deleted_bin_id uuid;
ALTER TABLE public.payments_received ADD COLUMN IF NOT EXISTS deleted_bin_id uuid;
ALTER TABLE public.debts             ADD COLUMN IF NOT EXISTS deleted_bin_id uuid;
ALTER TABLE public.sales_returns     ADD COLUMN IF NOT EXISTS deleted_bin_id uuid;
ALTER TABLE public.deliveries        ADD COLUMN IF NOT EXISTS deleted_bin_id uuid;
CREATE INDEX IF NOT EXISTS idx_sales_deleted_bin ON public.sales (deleted_bin_id) WHERE deleted_bin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_deleted_bin ON public.payments_received (deleted_bin_id) WHERE deleted_bin_id IS NOT NULL;

-- ============ 3. recycle_bin ============
CREATE TABLE IF NOT EXISTS public.recycle_bin (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid REFERENCES public.factories(id) ON DELETE CASCADE,
  table_name text NOT NULL,
  entity_id uuid NOT NULL,
  entity_label text NOT NULL,
  reason text,
  delete_request_id uuid REFERENCES public.delete_requests(id) ON DELETE SET NULL,
  mode text NOT NULL CHECK (mode IN ('snapshot', 'soft')),
  snapshot jsonb,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  deleted_by uuid REFERENCES auth.users(id),
  deleted_at timestamptz NOT NULL DEFAULT now(),
  purge_after timestamptz NOT NULL DEFAULT now() + interval '30 days'
);
CREATE INDEX IF NOT EXISTS idx_recycle_bin_purge ON public.recycle_bin (purge_after);
GRANT SELECT ON public.recycle_bin TO authenticated;
GRANT ALL ON public.recycle_bin TO service_role;
ALTER TABLE public.recycle_bin ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "recycle bin read" ON public.recycle_bin;
CREATE POLICY "recycle bin read" ON public.recycle_bin FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'));
-- Written only by the SECURITY DEFINER functions below.

-- Legacy: sales soft-deleted before this migration get a bin entry so they
-- show up, restore and purge the same way.
INSERT INTO public.recycle_bin(factory_id, table_name, entity_id, entity_label, reason, delete_request_id,
                               mode, details, deleted_by, deleted_at, purge_after)
SELECT s.factory_id, 'sales', s.id, s.invoice_number, dr.reason, dr.id,
       'soft', jsonb_build_object('reversed', s.status = 'posted', 'legacy', true),
       dr.reviewed_by, s.deleted_at, s.deleted_at + interval '30 days'
  FROM public.sales s
  LEFT JOIN LATERAL (
    SELECT id, reason, reviewed_by FROM public.delete_requests
     WHERE table_name = 'sales' AND entity_id = s.id AND review_status = 'approved'
     ORDER BY reviewed_at DESC NULLS LAST LIMIT 1
  ) dr ON true
 WHERE s.deleted_at IS NOT NULL AND s.deleted_bin_id IS NULL;
UPDATE public.sales s SET deleted_bin_id = b.id
  FROM public.recycle_bin b
 WHERE b.table_name = 'sales' AND b.entity_id = s.id AND s.deleted_at IS NOT NULL AND s.deleted_bin_id IS NULL;

-- ============ 4. customer ledger: new row type + purge exemption ============
ALTER TABLE public.customer_account_transactions DROP CONSTRAINT IF EXISTS customer_account_transactions_txn_type_check;
ALTER TABLE public.customer_account_transactions ADD CONSTRAINT customer_account_transactions_txn_type_check
  CHECK (txn_type IN (
    'OPENING_BALANCE','ADVANCE_PAYMENT','SALE','ADVANCE_APPLIED','CUSTOMER_PAYMENT',
    'DEBT_SETTLEMENT','REFUND','CREDIT_ADJUSTMENT','DEBIT_ADJUSTMENT','REVERSAL','ADVANCE_RESTORED',
    'SALES_RETURN','SALE_RESTORED'
  ));

-- Still append-only, except while the recycle-bin purge permanently removes a
-- deleted customer's whole history (flag set only inside _purge_recycle_bin).
CREATE OR REPLACE FUNCTION public._customer_ledger_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.recycle_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'customer_account_transactions is append-only; post a compensating entry instead';
END;
$$;

-- ============ 5. RLS: hide soft-deleted rows ============
DROP POLICY IF EXISTS "customers read" ON public.customers;
CREATE POLICY "customers read" ON public.customers FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'customers'::module_key, 'read'::action_key) AND deleted_at IS NULL);
-- Was FOR ALL, which also allowed a direct DELETE; deletes now go through
-- request_delete() / approve_delete() only.
DROP POLICY IF EXISTS "customers write" ON public.customers;
DROP POLICY IF EXISTS "customers insert" ON public.customers;
DROP POLICY IF EXISTS "customers update" ON public.customers;
CREATE POLICY "customers insert" ON public.customers FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'customers'::module_key, 'write'::action_key));
CREATE POLICY "customers update" ON public.customers FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'customers'::module_key, 'write'::action_key) AND deleted_at IS NULL)
  WITH CHECK (public.has_permission(auth.uid(), 'customers'::module_key, 'write'::action_key));

DROP POLICY IF EXISTS "payments read" ON public.payments_received;
CREATE POLICY "payments read" ON public.payments_received FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'payments'::module_key, 'read'::action_key) AND deleted_at IS NULL);

DROP POLICY IF EXISTS "debts read" ON public.debts;
CREATE POLICY "debts read" ON public.debts FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'debts'::module_key, 'read'::action_key) AND deleted_at IS NULL);

DROP POLICY IF EXISTS "sales returns read" ON public.sales_returns;
CREATE POLICY "sales returns read" ON public.sales_returns FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'sales-returns'::module_key, 'view'::action_key) AND deleted_at IS NULL);

DROP POLICY IF EXISTS "logistics read deliveries" ON public.deliveries;
CREATE POLICY "logistics read deliveries" ON public.deliveries FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics'::module_key, 'read'::action_key) AND deleted_at IS NULL);
DROP POLICY IF EXISTS "logistics write deliveries" ON public.deliveries;
CREATE POLICY "logistics write deliveries" ON public.deliveries FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics'::module_key, 'write'::action_key) AND deleted_at IS NULL)
  WITH CHECK (public.has_permission(auth.uid(), 'logistics'::module_key, 'write'::action_key));

-- ============ 6. functions that bypass RLS: skip deleted rows ============
CREATE OR REPLACE FUNCTION public.cash_book_balances(p_factory uuid)
RETURNS TABLE(payments_cash numeric, expenses_cash numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE((SELECT sum(amount) FROM payments_received
               WHERE factory_id = p_factory AND deleted_at IS NULL
                 AND status::text NOT IN ('rejected', 'reversed')), 0)
    + COALESCE((SELECT sum(public._cash_book_effect(transaction_type, category, related_reference, amount, 'payments'))
                  FROM cash_transactions WHERE factory_id = p_factory), 0),
    COALESCE((SELECT sum(public._cash_book_effect(transaction_type, category, related_reference, amount, 'expenses'))
                FROM cash_transactions WHERE factory_id = p_factory), 0)
    - COALESCE((SELECT sum(amount) FROM expenses
                 WHERE factory_id = p_factory AND status::text IN ('approved', 'posted')), 0);
$$;
REVOKE ALL ON FUNCTION public.cash_book_balances(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rep_account_summary(p_sales_rep_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_goods_out numeric := 0;
  v_accepted numeric := 0;
  v_written_off numeric := 0;
  v_damaged numeric := 0;
  v_rejected numeric := 0;
  v_cash numeric := 0;
  v_credit numeric := 0;
  v_van_value numeric := 0;
  v_sales_count int := 0;
  v_sales_value numeric := 0;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  SELECT COALESCE(SUM(sdi.line_value), 0) INTO v_goods_out
  FROM stock_dispatch_items sdi
  JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
  WHERE sd.sales_rep_id = p_sales_rep_id AND sd.status = 'posted'
    AND (p_from IS NULL OR sd.dispatch_date >= p_from)
    AND (p_to   IS NULL OR sd.dispatch_date <= p_to);

  SELECT
    COALESCE(SUM(COALESCE(rri.accepted_quantity,0) * rri.unit_price), 0),
    COALESCE(SUM(CASE WHEN NOT rri.charge_rep THEN (rri.damaged_quantity + rri.rejected_quantity) * rri.unit_price ELSE 0 END), 0),
    COALESCE(SUM(rri.damaged_quantity * rri.unit_price), 0),
    COALESCE(SUM(rri.rejected_quantity * rri.unit_price), 0)
  INTO v_accepted, v_written_off, v_damaged, v_rejected
  FROM rep_return_items rri
  JOIN rep_returns rr ON rr.id = rri.rep_return_id
  WHERE rr.sales_rep_id = p_sales_rep_id AND rr.status = 'completed'
    AND (p_from IS NULL OR rr.return_date >= p_from)
    AND (p_to   IS NULL OR rr.return_date <= p_to);

  SELECT COALESCE(SUM(amount), 0) INTO v_cash
  FROM rep_remittances
  WHERE sales_rep_id = p_sales_rep_id
    AND (p_from IS NULL OR remittance_date >= p_from)
    AND (p_to   IS NULL OR remittance_date <= p_to);

  SELECT COALESCE(SUM(outstanding), 0) INTO v_credit
  FROM debts
  WHERE sales_rep_id = p_sales_rep_id AND status <> 'paid' AND deleted_at IS NULL;

  SELECT COALESCE(SUM(rs.quantity * p.unit_price), 0) INTO v_van_value
  FROM rep_stock rs JOIN products p ON p.id = rs.product_id
  WHERE rs.sales_rep_id = p_sales_rep_id;

  SELECT COUNT(*), COALESCE(SUM(grand_total), 0) INTO v_sales_count, v_sales_value
  FROM sales
  WHERE sales_rep_id = p_sales_rep_id AND deleted_at IS NULL
    AND (p_from IS NULL OR sale_date >= p_from)
    AND (p_to   IS NULL OR sale_date <= p_to);

  RETURN jsonb_build_object(
    'goods_out_value', v_goods_out,
    'accepted_returns_value', v_accepted + v_written_off,
    'accepted_only_value', v_accepted,
    'written_off_value', v_written_off,
    'damaged_value', v_damaged,
    'rejected_value', v_rejected,
    'cash_remitted', v_cash,
    'credit_outstanding', v_credit,
    'van_stock_value', v_van_value,
    'sales_count', v_sales_count,
    'sales_value', v_sales_value,
    'net_balance_owed', v_goods_out - (v_accepted + v_written_off) - v_cash - v_credit
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.rep_account_summary(uuid, date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.reconcile_customer_account(p_customer uuid DEFAULT NULL)
RETURNS TABLE(customer_id uuid, customer_name text,
              cache_credit numeric, ledger_credit numeric,
              cache_debt numeric, ledger_debt numeric, invoice_debts numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'customers'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT c.id, c.name, c.credit_balance, COALESCE(l.credit_after, 0),
         c.outstanding_balance, COALESCE(l.debt_after, 0),
         COALESCE((SELECT SUM(d.outstanding) FROM debts d WHERE d.customer_id = c.id AND d.deleted_at IS NULL), 0)
    FROM customers c
    LEFT JOIN LATERAL (
      SELECT credit_after, debt_after FROM customer_account_transactions t
       WHERE t.customer_id = c.id ORDER BY t.seq DESC LIMIT 1
    ) l ON true
   WHERE (p_customer IS NULL OR c.id = p_customer)
     AND c.deleted_at IS NULL
     AND (c.credit_balance <> COALESCE(l.credit_after, 0)
       OR c.outstanding_balance <> COALESCE(l.debt_after, 0)
       OR c.outstanding_balance <> COALESCE((SELECT SUM(d.outstanding) FROM debts d WHERE d.customer_id = c.id AND d.deleted_at IS NULL), 0));
END;
$$;
GRANT EXECUTE ON FUNCTION public.reconcile_customer_account(uuid) TO authenticated;

-- create_sale() / edit_sale() match a typed walk-in to an existing customer by
-- phone or name; a deleted customer must not be picked up again. Patched in
-- place (same technique as 20260928110000) so the rest of each function is
-- left exactly as the live database has it.
DO $$
DECLARE
  r record;
  v_def text;
  v_new text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('create_sale', 'edit_sale')
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(v_def,
      'WHERE factory_id = v_factory AND phone = v_customer_phone',
      'WHERE factory_id = v_factory AND phone = v_customer_phone AND deleted_at IS NULL');
    v_new := replace(v_new,
      'WHERE factory_id = v_factory AND lower(name) = lower(btrim(v_customer_name))',
      'WHERE factory_id = v_factory AND lower(name) = lower(btrim(v_customer_name)) AND deleted_at IS NULL');
    IF v_new <> v_def THEN
      EXECUTE v_new;
    ELSE
      RAISE NOTICE '% : customer lookup pattern not found, left unchanged', r.proname;
    END IF;
  END LOOP;
END $$;

-- ============ 7. stock helper shared by delete / restore ============
-- p_put_back = true gives a posted sale's goods back (sale deleted);
-- false takes them out again (sale restored), refusing if stock is short.
CREATE OR REPLACE FUNCTION public._sale_stock_effect(p_sale_id uuid, p_put_back boolean, p_uid uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sale sales%ROWTYPE;
  v_item RECORD;
  v_before numeric;
  v_name text;
BEGIN
  SELECT * INTO v_sale FROM sales WHERE id = p_sale_id;
  FOR v_item IN SELECT product_id, quantity FROM sale_items WHERE sale_id = p_sale_id LOOP
    IF v_sale.sales_rep_id IS NOT NULL THEN
      SELECT quantity INTO v_before FROM rep_stock
       WHERE sales_rep_id = v_sale.sales_rep_id AND product_id = v_item.product_id FOR UPDATE;
      IF p_put_back THEN
        UPDATE rep_stock SET quantity = quantity + v_item.quantity, updated_at = now()
         WHERE sales_rep_id = v_sale.sales_rep_id AND product_id = v_item.product_id;
        INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id)
        VALUES (v_sale.factory_id, v_sale.sales_rep_id, v_item.product_id, 'reversal', v_item.quantity, v_sale.invoice_number, p_reason, p_uid);
      ELSE
        IF COALESCE(v_before, 0) < v_item.quantity THEN
          SELECT name INTO v_name FROM products WHERE id = v_item.product_id;
          RAISE EXCEPTION 'Not enough van stock of % to restore %: rep has %, need %',
            v_name, v_sale.invoice_number, COALESCE(v_before, 0), v_item.quantity;
        END IF;
        UPDATE rep_stock SET quantity = quantity - v_item.quantity, updated_at = now()
         WHERE sales_rep_id = v_sale.sales_rep_id AND product_id = v_item.product_id;
        INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id)
        VALUES (v_sale.factory_id, v_sale.sales_rep_id, v_item.product_id, 'sold', v_item.quantity, v_sale.invoice_number, p_reason, p_uid);
      END IF;
    ELSE
      SELECT current_stock, name INTO v_before, v_name FROM products WHERE id = v_item.product_id FOR UPDATE;
      IF p_put_back THEN
        UPDATE products SET current_stock = current_stock + v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
        INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
        VALUES (v_sale.factory_id, v_item.product_id, 'returned', v_item.quantity, v_sale.invoice_number, p_reason, p_uid,
                COALESCE(v_before, 0), COALESCE(v_before, 0) + v_item.quantity);
      ELSE
        IF COALESCE(v_before, 0) < v_item.quantity THEN
          RAISE EXCEPTION 'Not enough % in stock to restore %: have %, need %',
            v_name, v_sale.invoice_number, COALESCE(v_before, 0), v_item.quantity;
        END IF;
        UPDATE products SET current_stock = current_stock - v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
        INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
        VALUES (v_sale.factory_id, v_item.product_id, 'sold', v_item.quantity, v_sale.invoice_number, p_reason, p_uid,
                v_before, v_before - v_item.quantity);
      END IF;
    END IF;
  END LOOP;
END; $$;
REVOKE ALL ON FUNCTION public._sale_stock_effect(uuid, boolean, uuid, text) FROM PUBLIC, anon, authenticated;

-- An accepted sales return added stock; p_put_back = false takes it out again
-- (customer deleted), true re-adds it (customer restored).
CREATE OR REPLACE FUNCTION public._sales_return_stock_effect(p_return_id uuid, p_put_back boolean, p_uid uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ret sales_returns%ROWTYPE;
  v_before numeric;
  v_name text;
BEGIN
  SELECT * INTO v_ret FROM sales_returns WHERE id = p_return_id;
  IF v_ret.status <> 'completed' OR COALESCE(v_ret.accepted_quantity, 0) <= 0 THEN RETURN; END IF;
  SELECT current_stock, name INTO v_before, v_name FROM products WHERE id = v_ret.product_id FOR UPDATE;
  IF p_put_back THEN
    UPDATE products SET current_stock = current_stock + v_ret.accepted_quantity, updated_at = now() WHERE id = v_ret.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_ret.factory_id, v_ret.product_id, 'returned', v_ret.accepted_quantity, v_ret.return_number, p_reason, p_uid,
            v_before, v_before + v_ret.accepted_quantity);
  ELSE
    IF COALESCE(v_before, 0) < v_ret.accepted_quantity THEN
      RAISE EXCEPTION 'Not enough % in stock to reverse sales return %: have %, need %',
        v_name, v_ret.return_number, COALESCE(v_before, 0), v_ret.accepted_quantity;
    END IF;
    UPDATE products SET current_stock = current_stock - v_ret.accepted_quantity, updated_at = now() WHERE id = v_ret.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_ret.factory_id, v_ret.product_id, 'adjusted', v_ret.accepted_quantity, v_ret.return_number, p_reason, p_uid,
            v_before, v_before - v_ret.accepted_quantity);
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public._sales_return_stock_effect(uuid, boolean, uuid, text) FROM PUBLIC, anon, authenticated;

-- Re-inserts a snapshot taken with to_jsonb(row). Only columns present in
-- the snapshot are written, so a column added since then keeps its default.
CREATE OR REPLACE FUNCTION public._recycle_reinsert(p_table text, p_row jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = p_table
     AND is_generated = 'NEVER'
     AND COALESCE(identity_generation, 'BY DEFAULT') = 'BY DEFAULT'
     AND p_row ? column_name;
  IF v_cols IS NULL THEN RAISE EXCEPTION 'Nothing to restore for %', p_table; END IF;
  EXECUTE format('INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1)',
                 p_table, v_cols, v_cols, p_table) USING p_row;
END; $$;
REVOKE ALL ON FUNCTION public._recycle_reinsert(text, jsonb) FROM PUBLIC, anon, authenticated;

-- ============ 8. delete_requests: customers ============
ALTER TABLE public.delete_requests DROP CONSTRAINT IF EXISTS delete_requests_table_name_check;
ALTER TABLE public.delete_requests ADD CONSTRAINT delete_requests_table_name_check CHECK (table_name IN (
  'employees','employee_documents','sales_reps','vehicles','drivers',
  'expenses','cash_transactions','product_units','suppliers','sales','customers'
));

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

-- ============ 9. approve_delete(): everything goes to the recycle bin ============
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

      -- Refund everything ever actually collected for this sale plus any
      -- credit applied to it, back to the customer's credit.
      SELECT COALESCE(SUM(amount), 0) INTO v_total_collected FROM payments_received WHERE sale_id = v_sale.id;
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
GRANT EXECUTE ON FUNCTION public.approve_delete(uuid) TO authenticated;

-- ============ 10. restore_from_recycle_bin() ============
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

-- Kept for older clients: restores the sale's bin entry.
CREATE OR REPLACE FUNCTION public.restore_sale(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_bin uuid;
BEGIN
  SELECT id INTO v_bin FROM recycle_bin WHERE table_name = 'sales' AND entity_id = p_id;
  IF v_bin IS NULL THEN RAISE EXCEPTION 'This sale is not in the recycle bin'; END IF;
  RETURN public.restore_from_recycle_bin(v_bin);
END;
$function$;

-- ============ 11. purge ============
CREATE OR REPLACE FUNCTION public._purge_recycle_bin()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r recycle_bin%ROWTYPE;
  v_files jsonb := '[]'::jsonb;
  v_purged int := 0;
  v_skipped int := 0;
BEGIN
  PERFORM set_config('app.recycle_purge', 'on', true);

  FOR r IN SELECT * FROM recycle_bin WHERE purge_after <= now() ORDER BY deleted_at LOOP
    BEGIN
      IF r.table_name = 'sales' AND r.mode = 'soft' THEN
        -- Payments stay (their value went to customer credit); they just
        -- lose the link to the sale that no longer exists.
        UPDATE payments_received SET sale_id = NULL WHERE sale_id = r.entity_id;
        UPDATE sales_returns SET sale_id = NULL WHERE sale_id = r.entity_id;
        UPDATE deliveries SET sale_id = NULL WHERE sale_id = r.entity_id;
        UPDATE debts SET sale_id = NULL WHERE sale_id = r.entity_id;
        DELETE FROM sales WHERE id = r.entity_id;

      ELSIF r.table_name = 'customers' AND r.mode = 'soft' THEN
        DELETE FROM customer_account_transactions WHERE customer_id = r.entity_id;
        DELETE FROM customer_account_adjustments WHERE customer_id = r.entity_id;
        DELETE FROM sales_returns WHERE deleted_bin_id = r.id;
        DELETE FROM payments_received WHERE deleted_bin_id = r.id;
        DELETE FROM debts WHERE deleted_bin_id = r.id;
        DELETE FROM deliveries WHERE deleted_bin_id = r.id;
        DELETE FROM sales WHERE deleted_bin_id = r.id;
        -- Anything else still naming this customer (e.g. a sale that was
        -- deleted on its own earlier) keeps its record, minus the link.
        UPDATE sales SET customer_id = NULL WHERE customer_id = r.entity_id;
        UPDATE payments_received SET customer_id = NULL WHERE customer_id = r.entity_id;
        UPDATE debts SET customer_id = NULL WHERE customer_id = r.entity_id;
        UPDATE sales_returns SET customer_id = NULL WHERE customer_id = r.entity_id;
        DELETE FROM customers WHERE id = r.entity_id;
      END IF;
      -- 'snapshot' entries: the record is already gone; only the bin entry
      -- (and any Storage file, returned below) remains.

      v_files := v_files || r.files;
      DELETE FROM recycle_bin WHERE id = r.id;
      v_purged := v_purged + 1;
    EXCEPTION WHEN foreign_key_violation OR not_null_violation THEN
      -- Something unexpected still depends on it; keep it and try next time.
      v_skipped := v_skipped + 1;
    END;
  END LOOP;

  PERFORM set_config('app.recycle_purge', 'off', true);
  RETURN jsonb_build_object('purged', v_purged, 'skipped', v_skipped, 'files', v_files);
END;
$function$;
REVOKE ALL ON FUNCTION public._purge_recycle_bin() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.purge_recycle_bin()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')) THEN
    RAISE EXCEPTION 'Only an admin can purge the recycle bin';
  END IF;
  RETURN public._purge_recycle_bin();
END;
$function$;
REVOKE ALL ON FUNCTION public.purge_recycle_bin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_recycle_bin() TO authenticated;

-- Kept for older clients.
CREATE OR REPLACE FUNCTION public.purge_expired_deleted_sales()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.purge_recycle_bin();
END;
$function$;

-- quick_add_customer grant (after deleted_at exists, so the first call works).
REVOKE ALL ON FUNCTION public.quick_add_customer(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quick_add_customer(jsonb) TO authenticated;
