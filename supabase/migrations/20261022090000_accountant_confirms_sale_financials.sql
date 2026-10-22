-- ============================================================================
-- Sales & POS: the sales person posts only WHAT is being sold and to whom
-- (walk-in customer, marketer, distributor, ...). The money side -- payment
-- taken, discount / commission, VAT, type of payment -- is now set by the
-- accountant on the Finance page while confirming the order, right before the
-- receipt is printed.
-- ----------------------------------------------------------------------------
-- confirm_sale(p_id, payload) writes those figures onto the still-pending sale
-- and approves it in the same transaction, via approve_sale() -- so stock,
-- payments, debt and the customer ledger are all applied exactly as before,
-- and a sale can never sit "half priced" between the two steps.
--
-- payload: { discount: numeric, apply_vat: boolean,
--            payments: [{amount, method}], payment_type: text, comment: text }
-- ============================================================================

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
    -- Same preview formula as create_sale(); approve_sale() re-derives the
    -- authoritative credit draw-down under a row lock right after this.
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

  -- approve_sale() enforces the self-approval rule and the status
  -- transition, and applies stock, payments, debt and ledger.
  RETURN public.approve_sale(p_id, v_comment);
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_sale(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_sale(uuid, jsonb) TO authenticated;

UPDATE public.workflow_configs
   SET description = 'Order captured and posted by the sales person (items and buyer only). The accountant sets payment, discount / commission and VAT, confirms it and prints the receipt -- only then is stock decremented and it counts toward the customer''s balance.'
 WHERE module = 'sales';
