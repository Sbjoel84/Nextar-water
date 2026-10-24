-- ============================================================================
-- Return Product: record damaged units and the return date at drop-off.
-- ----------------------------------------------------------------------------
-- create_sales_return() also takes an optional return_date (no future dates)
-- so a return brought in earlier can be logged against the right day.
--
-- When a Sales-Rep brings products back, the store now enters good and damaged
-- units separately. quantity_returned stays the full count (good + damaged),
-- so store_rep_returnables() keeps deducting everything the rep handed back,
-- and reported_damaged carries the damaged part to inspection, where it
-- pre-fills the "Damaged" figure.
--
-- Nothing changes in how the account is settled: inspect_sales_return()
-- already credits (accepted + damaged) x the price the rep was charged, so
-- damaged units count toward the rep's account exactly like good ones, and
-- still raise a damage record instead of going back into stock.
-- ============================================================================

ALTER TABLE public.sales_returns
  ADD COLUMN IF NOT EXISTS reported_damaged numeric NOT NULL DEFAULT 0
  CHECK (reported_damaged >= 0);

CREATE OR REPLACE FUNCTION public.create_sales_return(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_sale_id uuid := NULLIF(payload->>'sale_id','')::uuid;
  v_customer_id uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_product_id uuid := (payload->>'product_id')::uuid;
  v_qty numeric := (payload->>'quantity_returned')::numeric;
  v_damaged numeric := COALESCE(NULLIF(payload->>'damaged_quantity','')::numeric, 0);
  v_reason text := payload->>'reason';
  -- Optional business date the rep brought the goods back (YYYY-MM-DD);
  -- defaults to now. Stored in received_at with the current time of day.
  v_return_date date := NULLIF(payload->>'return_date','')::date;
  v_received_at timestamptz := now();
  v_product products%ROWTYPE;
  v_number text; v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales-returns'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity returned must be > 0'; END IF;
  IF v_damaged < 0 OR v_damaged > v_qty THEN
    RAISE EXCEPTION 'Damaged quantity must be between 0 and the % returned', v_qty;
  END IF;
  IF v_return_date IS NOT NULL THEN
    IF v_return_date > current_date THEN RAISE EXCEPTION 'Return date cannot be in the future'; END IF;
    IF v_return_date < current_date THEN
      v_received_at := v_return_date + localtime;
    END IF;
  END IF;

  SELECT * INTO v_product FROM products WHERE id = v_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;

  IF v_sale_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM sales WHERE id = v_sale_id AND factory_id = v_factory) THEN
      RAISE EXCEPTION 'Sale not found for this factory';
    END IF;
  END IF;

  v_number := 'SR-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO sales_returns(factory_id, return_number, sale_id, customer_id, product_id, quantity_returned, reported_damaged, unit, reason, received_by, received_at)
  VALUES (v_factory, v_number, v_sale_id, v_customer_id, v_product_id, v_qty, v_damaged, v_product.unit, v_reason, v_uid, v_received_at)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'return_number', v_number);
END; $$;
