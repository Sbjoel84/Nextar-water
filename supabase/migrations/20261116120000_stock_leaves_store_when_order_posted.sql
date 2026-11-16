-- ============================================================================
-- SALES -- stock leaves the store when the order is posted
-- ----------------------------------------------------------------------------
-- Until now an order took nothing out of stock until the accountant confirmed
-- it (approve_sale), although the goods leave the store as soon as sales post
-- the order. The store's figure was wrong in between, and confirming could
-- fail on "Insufficient stock" for goods that were long gone.
--
-- Now:
--   * Posting an order (create_sale / edit_sale) takes the stock out of the
--     store -- or the marketer's van for a van sale -- straight away. Each
--     line remembers how much it took (sale_items.stock_taken).
--   * Confirming (confirm_sale -> approve_sale) is money only: payment,
--     discount, VAT, debt / advance. It no longer touches stock for these
--     orders (sales.stock_released).
--   * Editing an order puts the old lines' stock back and takes the new
--     lines'. Cancelling it, or moving it to the recycle bin, puts its stock
--     back; restoring it takes it again. A rejected order keeps its stock out
--     (the goods are with the customer until sales fix or cancel it).
--   * Orders already waiting today are caught up once, oldest first: each line
--     takes what the store / van still has on record, never below zero, since
--     those goods have already left. Any shortfall is stock the store had
--     already miscounted.
-- ============================================================================

ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS stock_released boolean NOT NULL DEFAULT false;
-- Existing rows are false (stock handled the old way, at confirmation);
-- every order posted from now on is released at posting.
ALTER TABLE public.sales ALTER COLUMN stock_released SET DEFAULT true;
ALTER TABLE public.sale_items ADD COLUMN IF NOT EXISTS stock_taken numeric(14,3) NOT NULL DEFAULT 0;

-- Move one line's stock out of (p_take) or back into the store / van.
-- p_clamp: take only what's on record (catch-up of old orders). Returns the
-- quantity actually moved.
CREATE OR REPLACE FUNCTION public._sale_stock_move(
  p_sale_id uuid, p_product_id uuid, p_qty numeric, p_take boolean, p_clamp boolean, p_reason text
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale sales%ROWTYPE;
  v_before numeric;
  v_name text;
  v_qty numeric := p_qty;
  v_user uuid;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN RETURN 0; END IF;
  SELECT * INTO v_sale FROM sales WHERE id = p_sale_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  v_user := COALESCE(auth.uid(), v_sale.created_by);
  SELECT name INTO v_name FROM products WHERE id = p_product_id;

  IF v_sale.sales_rep_id IS NOT NULL THEN
    SELECT quantity INTO v_before FROM rep_stock
     WHERE sales_rep_id = v_sale.sales_rep_id AND product_id = p_product_id FOR UPDATE;
    v_before := COALESCE(v_before, 0);
    IF p_take THEN
      IF p_clamp THEN v_qty := LEAST(v_qty, GREATEST(v_before, 0)); END IF;
      IF v_qty <= 0 THEN RETURN 0; END IF;
      IF v_before < v_qty THEN
        RAISE EXCEPTION 'Insufficient van stock for %: has %, need %', COALESCE(v_name, 'product'), v_before, v_qty;
      END IF;
      UPDATE rep_stock SET quantity = quantity - v_qty, updated_at = now()
       WHERE sales_rep_id = v_sale.sales_rep_id AND product_id = p_product_id;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_sale.factory_id, v_sale.sales_rep_id, p_product_id, 'sold', -v_qty, v_sale.invoice_number, p_reason, v_user, v_before, v_before - v_qty);
    ELSE
      INSERT INTO rep_stock(sales_rep_id, product_id, factory_id, quantity)
      VALUES (v_sale.sales_rep_id, p_product_id, v_sale.factory_id, v_qty)
      ON CONFLICT (sales_rep_id, product_id) DO UPDATE
        SET quantity = rep_stock.quantity + EXCLUDED.quantity, updated_at = now();
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_sale.factory_id, v_sale.sales_rep_id, p_product_id, 'reversal', v_qty, v_sale.invoice_number, p_reason, v_user, v_before, v_before + v_qty);
    END IF;
  ELSE
    SELECT current_stock INTO v_before FROM products WHERE id = p_product_id FOR UPDATE;
    IF NOT FOUND THEN RETURN 0; END IF;
    v_before := COALESCE(v_before, 0);
    IF p_take THEN
      IF p_clamp THEN v_qty := LEAST(v_qty, GREATEST(v_before, 0)); END IF;
      IF v_qty <= 0 THEN RETURN 0; END IF;
      IF v_before < v_qty THEN
        RAISE EXCEPTION 'Insufficient stock for %: % in store, need %', COALESCE(v_name, 'product'), v_before, v_qty;
      END IF;
      UPDATE products SET current_stock = current_stock - v_qty, updated_at = now() WHERE id = p_product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_sale.factory_id, p_product_id, 'sold', v_qty, v_sale.invoice_number, p_reason, v_user, v_before, v_before - v_qty);
    ELSE
      UPDATE products SET current_stock = current_stock + v_qty, updated_at = now() WHERE id = p_product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_sale.factory_id, p_product_id, 'correction', v_qty, v_sale.invoice_number, p_reason, v_user, v_before, v_before + v_qty);
    END IF;
  END IF;
  RETURN v_qty;
END;
$$;
REVOKE ALL ON FUNCTION public._sale_stock_move(uuid, uuid, numeric, boolean, boolean, text) FROM PUBLIC, anon, authenticated;

-- ---------- order lines: take stock when posted, give it back when removed ----------
CREATE OR REPLACE FUNCTION public._sale_items_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale sales%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.stock_taken := 0;
    SELECT * INTO v_sale FROM sales WHERE id = NEW.sale_id;
    IF FOUND AND v_sale.stock_released AND v_sale.deleted_at IS NULL
       AND v_sale.status IN ('pending_approval', 'rejected') THEN
      NEW.stock_taken := public._sale_stock_move(
        NEW.sale_id, NEW.product_id, NEW.quantity, true, false,
        CASE WHEN v_sale.is_pr THEN 'PR - complimentary (order posted)' ELSE 'Sale (order posted)' END);
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE: an unconfirmed order's line coming off (edit) -> stock back.
  -- A confirmed (posted) sale's goods are sold for good; its reversal paths
  -- handle stock themselves.
  IF OLD.stock_taken > 0
     AND COALESCE((SELECT status FROM sales WHERE id = OLD.sale_id), 'pending_approval') <> 'posted' THEN
    PERFORM public._sale_stock_move(OLD.sale_id, OLD.product_id, OLD.stock_taken, false, false,
                                    'Order line changed - stock back');
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public._sale_items_stock() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sale_items_take_stock ON public.sale_items;
CREATE TRIGGER sale_items_take_stock
  BEFORE INSERT ON public.sale_items
  FOR EACH ROW EXECUTE FUNCTION public._sale_items_stock();
DROP TRIGGER IF EXISTS sale_items_return_stock ON public.sale_items;
CREATE TRIGGER sale_items_return_stock
  AFTER DELETE ON public.sale_items
  FOR EACH ROW EXECUTE FUNCTION public._sale_items_stock();

-- ---------- whole order withdrawn / restored ----------
CREATE OR REPLACE FUNCTION public._sales_stock_on_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_line record;
BEGIN
  IF NOT NEW.stock_released OR NEW.status = 'posted' THEN RETURN NEW; END IF;

  IF (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
     OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) THEN
    -- Cancelled, or moved to the recycle bin: the goods go back.
    FOR v_line IN SELECT id, product_id, stock_taken FROM sale_items
                   WHERE sale_id = NEW.id AND stock_taken > 0 LOOP
      PERFORM public._sale_stock_move(NEW.id, v_line.product_id, v_line.stock_taken, false, false,
                                      'Order cancelled / deleted - stock back');
      UPDATE sale_items SET stock_taken = 0 WHERE id = v_line.id;
    END LOOP;
  ELSIF NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL
        AND NEW.status IN ('pending_approval', 'rejected') THEN
    -- Restored from the recycle bin: the goods go out again.
    FOR v_line IN SELECT id, product_id, quantity FROM sale_items
                   WHERE sale_id = NEW.id AND stock_taken = 0 LOOP
      UPDATE sale_items
         SET stock_taken = public._sale_stock_move(NEW.id, v_line.product_id, v_line.quantity, true, false,
                                                   'Order restored - stock out again')
       WHERE id = v_line.id;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public._sales_stock_on_status() FROM PUBLIC, anon, authenticated;

-- ---------- what's still waiting to come out of the store ----------
-- Only orders from before this change (not released) are still "awaiting";
-- released ones are already off current_stock.
CREATE OR REPLACE FUNCTION public._store_stock_awaiting(p_product_id uuid, p_exclude_sale uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(si.quantity), 0)
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
   WHERE si.product_id = p_product_id
     AND s.status = 'pending_approval'
     AND s.deleted_at IS NULL
     AND s.sales_rep_id IS NULL
     AND NOT s.stock_released
     AND s.id IS DISTINCT FROM p_exclude_sale;
$$;
REVOKE ALL ON FUNCTION public._store_stock_awaiting(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.store_stock_awaiting_confirmation(p_factory_id uuid)
RETURNS TABLE(product_id uuid, quantity numeric, orders bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
          OR public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN QUERY
  SELECT si.product_id, sum(si.quantity)::numeric, count(DISTINCT s.id)
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
   WHERE s.factory_id = p_factory_id
     AND s.status = 'pending_approval'
     AND s.deleted_at IS NULL
     AND s.sales_rep_id IS NULL
     AND NOT s.stock_released
   GROUP BY si.product_id;
END;
$$;
REVOKE ALL ON FUNCTION public.store_stock_awaiting_confirmation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_stock_awaiting_confirmation(uuid) TO authenticated;

-- ---------- approve_sale(): skip stock for released orders ----------
-- As in 20261001090000_fix_payment_reject_reverse_and_ledger.sql, with the
-- stock loop only for orders posted before this change.
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
  -- Orders posted since 20261116120000 already took their stock when they
  -- were posted (stock_released); confirming is then money only.
  IF NOT COALESCE((SELECT stock_released FROM sales WHERE id = p_id), false) THEN
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
  END IF;

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
GRANT EXECUTE ON FUNCTION public.approve_sale(uuid, text) TO authenticated;

-- ---------- edit_sale(): old lines' stock back before checking the new ones ----------
-- As in 20261026100000_sales_check_stock_awaiting_confirmation.sql, with the
-- line replacement moved ahead of the stock check.
CREATE OR REPLACE FUNCTION public.edit_sale(p_id uuid, payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $
DECLARE
  v_uid uuid := auth.uid();
  v_row sales%ROWTYPE;
  v_factory uuid;
  v_sale_date date := COALESCE((payload->>'sale_date')::date, CURRENT_DATE);
  v_customer uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_customer_name text := payload->>'customer_name';
  v_customer_phone text := payload->>'customer_phone';
  v_customer_address text := payload->>'customer_address';
  v_discount numeric := COALESCE((payload->>'discount')::numeric, 0);
  v_vat numeric := COALESCE((payload->>'vat')::numeric, 0);
  v_amount_paid numeric := COALESCE((payload->>'amount_paid')::numeric, 0);
  v_payment_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'cash');
  v_payments jsonb := payload->'payments';
  v_apply_credit numeric := 0;
  v_customer_credit numeric;
  v_sales_person text := payload->>'sales_person';
  v_remarks text := payload->>'remarks';
  v_customer_type text := COALESCE(NULLIF(payload->>'customer_type',''), 'walk_in');
  v_sales_rep uuid := NULLIF(payload->>'sales_rep_id','')::uuid;
  v_is_pr boolean := COALESCE((payload->>'is_pr')::boolean, false);
  v_rep_row public.sales_reps%ROWTYPE;
  v_rep_stock numeric;
  v_reserved numeric;
  v_order_qty numeric;
  v_items jsonb := payload->'items';
  v_item jsonb;
  v_subtotal numeric := 0;
  v_grand numeric := 0;
  v_balance numeric := 0;
  v_product products%ROWTYPE;
  v_qty numeric;
  v_price numeric;
BEGIN
  SELECT * INTO v_row FROM sales WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'edit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_row.status NOT IN ('pending_approval', 'rejected') THEN
    RAISE EXCEPTION 'Only a sale awaiting approval or rejected can be edited';
  END IF;
  -- A rejected sale goes back to whoever recorded it to fix and re-post.
  IF v_row.status = 'rejected'
     AND v_row.created_by IS DISTINCT FROM v_uid
     AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only the person who recorded this sale can fix and re-post it';
  END IF;

  v_factory := v_row.factory_id;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'no items'; END IF;

  IF v_is_pr THEN
    v_payments := NULL;
  END IF;

  IF v_payments IS NOT NULL AND jsonb_array_length(v_payments) > 0 THEN
    SELECT COALESCE(SUM((p->>'amount')::numeric), 0) INTO v_amount_paid
      FROM jsonb_array_elements(v_payments) AS p
      WHERE (p->>'amount')::numeric > 0;
    SELECT (p->>'method')::payment_method INTO v_payment_method
      FROM jsonb_array_elements(v_payments) AS p
      WHERE (p->>'amount')::numeric > 0
      ORDER BY (p->>'amount')::numeric DESC
      LIMIT 1;
    v_payment_method := COALESCE(v_payment_method, 'cash');
  END IF;

  IF v_sales_rep IS NOT NULL THEN
    SELECT * INTO v_rep_row FROM sales_reps WHERE id = v_sales_rep;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sales rep not found'; END IF;
    IF v_rep_row.factory_id <> v_factory THEN RAISE EXCEPTION 'Sales rep does not belong to factory'; END IF;
    IF v_rep_row.status <> 'active' THEN RAISE EXCEPTION 'Sales rep is not active'; END IF;
  END IF;

  -- Same named-walk-in -> real customer resolution as create_sale(), in case
  -- the customer name/phone changed during the edit.
  IF v_customer IS NULL AND v_customer_name IS NOT NULL AND btrim(v_customer_name) <> '' THEN
    IF v_customer_phone IS NOT NULL AND btrim(v_customer_phone) <> '' THEN
      SELECT id INTO v_customer FROM customers
      WHERE factory_id = v_factory AND phone = v_customer_phone
      LIMIT 1;
    END IF;
    IF v_customer IS NULL THEN
      SELECT id INTO v_customer FROM customers
      WHERE factory_id = v_factory AND lower(name) = lower(btrim(v_customer_name))
      LIMIT 1;
    END IF;
    IF v_customer IS NULL THEN
      INSERT INTO customers(factory_id, name, phone, address, registered)
      VALUES (v_factory, btrim(v_customer_name), v_customer_phone, v_customer_address, false)
      RETURNING id INTO v_customer;
    END IF;
  END IF;

  -- Take the old lines off first: their stock goes back to the store / van
  -- (sale_items trigger), so the new lines are checked against everything
  -- available; their stock is taken when they're inserted below.
  DELETE FROM sale_items WHERE sale_id = p_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_item->>'product_id'; END IF;
    IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;
    IF v_sales_rep IS NOT NULL THEN
      SELECT quantity INTO v_rep_stock FROM rep_stock WHERE sales_rep_id = v_sales_rep AND product_id = v_product.id;
      IF COALESCE(v_rep_stock, 0) < v_qty THEN
        RAISE EXCEPTION 'Insufficient van stock for %: rep has %, need %', v_product.name, COALESCE(v_rep_stock,0), v_qty;
      END IF;
    ELSE
      -- Store stock still on the shelf: current_stock minus what other
      -- unconfirmed orders have already taken, against every line of this
      -- product in the order.
      PERFORM 1 FROM products WHERE id = v_product.id FOR UPDATE;
      v_reserved := public._store_stock_awaiting(v_product.id, p_id);
      SELECT COALESCE(SUM((i->>'quantity')::numeric), 0) INTO v_order_qty
        FROM jsonb_array_elements(v_items) AS i
       WHERE (i->>'product_id')::uuid = v_product.id;
      IF v_product.current_stock - v_reserved < v_order_qty THEN
        RAISE EXCEPTION 'Insufficient stock for %: % in store (% on record, % in orders awaiting confirmation), need %',
          v_product.name, GREATEST(v_product.current_stock - v_reserved, 0), v_product.current_stock, v_reserved, v_order_qty;
      END IF;
    END IF;
    v_subtotal := v_subtotal + (v_qty * v_price);
  END LOOP;

  IF v_is_pr THEN
    v_discount := 0; v_vat := 0; v_amount_paid := 0; v_grand := 0; v_balance := 0;
  ELSE
    v_grand := GREATEST(v_subtotal - v_discount + v_vat, 0);
    IF v_customer IS NOT NULL THEN
      SELECT credit_balance INTO v_customer_credit FROM customers WHERE id = v_customer;
      v_apply_credit := LEAST(GREATEST(v_grand - v_amount_paid, 0), COALESCE(v_customer_credit, 0));
    END IF;
    v_balance := GREATEST(v_grand - v_amount_paid - v_apply_credit, 0);
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := COALESCE((v_item->>'unit_price')::numeric, v_product.unit_price);
    INSERT INTO sale_items(sale_id, product_id, quantity, unit_price, line_total)
    VALUES (p_id, v_product.id, v_qty, v_price, v_qty * v_price);
  END LOOP;

  UPDATE sales SET
    sale_date = v_sale_date, customer_id = v_customer, customer_name = v_customer_name,
    customer_phone = v_customer_phone, customer_address = v_customer_address,
    subtotal = v_subtotal, discount = v_discount, vat = v_vat, grand_total = v_grand,
    amount_paid = v_amount_paid, balance = v_balance, payment_method = v_payment_method,
    sales_person = v_sales_person, sales_rep_id = v_sales_rep, remarks = v_remarks,
    is_pr = v_is_pr, pending_payments = v_payments, credit_applied = v_apply_credit,
    customer_type = v_customer_type,
    status = 'pending_approval', rejected_reason = NULL
  WHERE id = p_id;

  PERFORM public.record_workflow_action('sales', p_id,
    CASE WHEN v_row.status = 'rejected' THEN 'submit' ELSE 'edit' END::action_key,
    v_row.status::workflow_status, 'pending_approval', v_remarks);

  RETURN jsonb_build_object('sale_id', p_id, 'invoice_number', v_row.invoice_number,
                            'subtotal', v_subtotal, 'grand_total', v_grand, 'balance', v_balance);
END;
$;
REVOKE ALL ON FUNCTION public.edit_sale(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_sale(uuid, jsonb) TO authenticated;

-- ---------- catch up the orders already waiting ----------
-- Oldest first; each line takes what is still on record, never below zero.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT si.id, si.sale_id, si.product_id, si.quantity
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
     WHERE s.status IN ('pending_approval', 'rejected')
       AND s.deleted_at IS NULL
       AND NOT s.stock_released
     ORDER BY s.created_at, s.id
  LOOP
    UPDATE sale_items
       SET stock_taken = public._sale_stock_move(r.sale_id, r.product_id, r.quantity, true, true,
                                                 'Order posted earlier - goods already out (catch-up)')
     WHERE id = r.id;
  END LOOP;

  UPDATE sales SET stock_released = true
   WHERE status IN ('pending_approval', 'rejected')
     AND deleted_at IS NULL
     AND NOT stock_released;
END;
$$;

-- Installed after the catch-up so the backfill's own updates don't trigger it.
DROP TRIGGER IF EXISTS sales_stock_on_status ON public.sales;
CREATE TRIGGER sales_stock_on_status
  AFTER UPDATE OF status, deleted_at ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public._sales_stock_on_status();
