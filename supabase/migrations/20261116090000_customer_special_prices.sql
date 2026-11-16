-- Customer-specific prices (surcharge or special rate).
--
-- Some customers pay a different price from the regular product price. Sales
-- still post orders at the regular price; when the accountant confirms the
-- order they can set the price for this customer on each line, and choose to
-- remember it so the next order for that customer starts from it.
--
--   * customer_product_prices: the remembered price per (customer, product).
--   * set_customer_price() / remove_customer_price(): manage it (sales:approve).
--   * confirm_sale(): accepts payload.prices = [{product_id, unit_price}] to
--     reprice the order's lines before confirming, and payload.save_prices to
--     remember them for the customer.

CREATE TABLE IF NOT EXISTS public.customer_product_prices (
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  factory_id uuid NOT NULL,
  unit_price numeric(14,2) NOT NULL CHECK (unit_price > 0),
  notes text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);
CREATE INDEX IF NOT EXISTS customer_product_prices_factory_idx
  ON public.customer_product_prices (factory_id);

GRANT SELECT ON public.customer_product_prices TO authenticated;
GRANT ALL ON public.customer_product_prices TO service_role;
ALTER TABLE public.customer_product_prices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer prices read" ON public.customer_product_prices;
CREATE POLICY "customer prices read" ON public.customer_product_prices FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'customers'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
  );
-- No direct writes: only through the functions below.

CREATE OR REPLACE FUNCTION public.set_customer_price(
  p_customer_id uuid, p_product_id uuid, p_unit_price numeric, p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'approve'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_unit_price IS NULL OR p_unit_price <= 0 THEN
    RAISE EXCEPTION 'Enter a price above zero';
  END IF;
  SELECT factory_id INTO v_factory FROM customers WHERE id = p_customer_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = p_product_id AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  INSERT INTO customer_product_prices (customer_id, product_id, factory_id, unit_price, notes, updated_by, updated_at)
  VALUES (p_customer_id, p_product_id, v_factory, round(p_unit_price, 2), NULLIF(btrim(COALESCE(p_notes, '')), ''), v_uid, now())
  ON CONFLICT (customer_id, product_id) DO UPDATE
    SET unit_price = EXCLUDED.unit_price,
        notes = COALESCE(EXCLUDED.notes, customer_product_prices.notes),
        updated_by = EXCLUDED.updated_by,
        updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION public.set_customer_price(uuid, uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_customer_price(uuid, uuid, numeric, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_customer_price(p_customer_id uuid, p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'sales'::module_key, 'approve'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  DELETE FROM customer_product_prices WHERE customer_id = p_customer_id AND product_id = p_product_id;
END;
$$;
REVOKE ALL ON FUNCTION public.remove_customer_price(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_customer_price(uuid, uuid) TO authenticated;

-- confirm_sale(), as in 20261022090000_accountant_confirms_sale_financials.sql,
-- plus the optional repricing step (marked NEW).
CREATE OR REPLACE FUNCTION public.confirm_sale(p_id uuid, payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales%ROWTYPE;
  v_discount numeric := GREATEST(COALESCE((payload->>'discount')::numeric, 0), 0);
  v_apply_vat boolean := COALESCE((payload->>'apply_vat')::boolean, false);
  v_payments jsonb := payload->'payments';
  v_payment_type text := NULLIF(btrim(COALESCE(payload->>'payment_type', '')), '');
  v_comment text := NULLIF(btrim(COALESCE(payload->>'comment', '')), '');
  v_prices jsonb := payload->'prices';
  v_save_prices boolean := COALESCE((payload->>'save_prices')::boolean, false);
  v_price record;
  v_vat_rate numeric;
  v_vat numeric := 0;
  v_amount_paid numeric := 0;
  v_payment_method payment_method := 'cash';
  v_grand numeric := 0;
  v_customer_credit numeric;
  v_apply_credit numeric := 0;
  v_balance numeric := 0;
BEGIN
  SELECT * INTO v_row FROM sales WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'approve'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_row.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Only an order still awaiting confirmation can be confirmed';
  END IF;

  -- NEW: the accountant's price for this customer, per product line.
  IF NOT v_row.is_pr AND v_prices IS NOT NULL AND jsonb_typeof(v_prices) = 'array'
     AND jsonb_array_length(v_prices) > 0 THEN
    FOR v_price IN
      SELECT (p->>'product_id')::uuid AS product_id, round((p->>'unit_price')::numeric, 2) AS unit_price
        FROM jsonb_array_elements(v_prices) AS p
    LOOP
      IF v_price.unit_price IS NULL OR v_price.unit_price <= 0 THEN
        RAISE EXCEPTION 'Every price must be above zero';
      END IF;
      UPDATE sale_items
         SET unit_price = v_price.unit_price,
             line_total = round(quantity * v_price.unit_price, 2)
       WHERE sale_id = p_id AND product_id = v_price.product_id;

      IF v_save_prices AND v_row.customer_id IS NOT NULL THEN
        INSERT INTO customer_product_prices (customer_id, product_id, factory_id, unit_price, updated_by, updated_at)
        VALUES (v_row.customer_id, v_price.product_id, v_row.factory_id, v_price.unit_price, v_uid, now())
        ON CONFLICT (customer_id, product_id) DO UPDATE
          SET unit_price = EXCLUDED.unit_price, updated_by = EXCLUDED.updated_by, updated_at = now();
      END IF;
    END LOOP;

    SELECT COALESCE(SUM(line_total), 0) INTO v_row.subtotal FROM sale_items WHERE sale_id = p_id;
    UPDATE sales SET subtotal = v_row.subtotal WHERE id = p_id;
  END IF;

  IF v_row.is_pr THEN
    -- PR is complimentary: nothing billed, paid or owed.
    v_discount := 0; v_vat := 0; v_payments := NULL; v_grand := 0; v_balance := 0;
  ELSE
    v_discount := LEAST(v_discount, v_row.subtotal);

    IF v_apply_vat THEN
      SELECT COALESCE(vat_rate, 0) INTO v_vat_rate FROM settings WHERE factory_id = v_row.factory_id;
      v_vat := round(GREATEST(v_row.subtotal - v_discount, 0) * COALESCE(v_vat_rate, 0) / 100, 2);
    END IF;

    IF v_payments IS NOT NULL AND jsonb_typeof(v_payments) = 'array' AND jsonb_array_length(v_payments) > 0 THEN
      SELECT COALESCE(SUM((p->>'amount')::numeric), 0) INTO v_amount_paid
        FROM jsonb_array_elements(v_payments) AS p
        WHERE (p->>'amount')::numeric > 0;
      SELECT (p->>'method')::payment_method INTO v_payment_method
        FROM jsonb_array_elements(v_payments) AS p
        WHERE (p->>'amount')::numeric > 0
        ORDER BY (p->>'amount')::numeric DESC
        LIMIT 1;
      v_payment_method := COALESCE(v_payment_method, 'cash');
    ELSE
      v_payments := NULL;
    END IF;

    v_grand := GREATEST(v_row.subtotal - v_discount + v_vat, 0);
    IF v_row.customer_id IS NOT NULL THEN
      SELECT credit_balance INTO v_customer_credit FROM customers WHERE id = v_row.customer_id;
      v_apply_credit := LEAST(GREATEST(v_grand - v_amount_paid, 0), COALESCE(v_customer_credit, 0));
    END IF;
    v_balance := GREATEST(v_grand - v_amount_paid - v_apply_credit, 0);
  END IF;

  UPDATE sales SET
    discount = v_discount, vat = v_vat, grand_total = v_grand,
    amount_paid = v_amount_paid, balance = v_balance, payment_method = v_payment_method,
    pending_payments = v_payments, credit_applied = v_apply_credit,
    remarks = COALESCE(v_payment_type, remarks)
  WHERE id = p_id;

  RETURN public.approve_sale(p_id, v_comment);
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_sale(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_sale(uuid, jsonb) TO authenticated;
