-- Split a person's cash in hand by factory.
--
-- Since 20261007090000 cash in hand is a person's total across factories, so
-- the Cash Out dialog showed Princess's 3,400 on both the Water and the Nylon
-- page. That 3,400 is Water cash (INV20261006-00496); the Nylon page should
-- show 0.
--
-- The split replays the person's cash in time order. Cash collected goes to
-- its factory. A Cash Out takes from its own factory first and, if that runs
-- short, from cash held for the other factory: that's how the 2026-10-05 Water
-- Cash Out of 82,850 carried Princess's 50,000 of Nylon cash. Whatever is
-- still short stays negative on the Cash Out's factory.
--
-- The guard keeps checking the total (cash_in_hand), so a Cash Out can still
-- hand over cash held for another factory.

CREATE OR REPLACE FUNCTION public.cash_in_hand_by_factory(p_user uuid)
RETURNS TABLE(factory_id uuid, amount numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pool jsonb := '{}'::jsonb;
  v_ev RECORD;
  v_need numeric;
  v_take numeric;
  v_have numeric;
  v_other text;
BEGIN
  FOR v_ev IN
    SELECT e.factory_id, e.delta FROM (
      SELECT pr.factory_id, pr.amount AS delta, pr.created_at, pr.id
        FROM payments_received pr
        LEFT JOIN sales s ON s.id = pr.sale_id
       WHERE COALESCE(CASE WHEN pr.remarks = 'Payment at point of sale' THEN s.created_by END,
                      pr.received_by) = p_user
         AND pr.payment_method = 'cash' AND pr.deleted_at IS NULL
         AND pr.status::text NOT IN ('rejected', 'reversed')
      UNION ALL
      SELECT ct.factory_id,
             public._cash_book_effect(ct.transaction_type, ct.category, ct.related_reference, ct.amount, 'payments'),
             ct.created_at, ct.id
        FROM cash_transactions ct
       WHERE COALESCE(ct.cash_holder, ct.recorded_by) = p_user
         AND ct.payment_method = 'cash'
    ) e
    WHERE e.delta <> 0
    ORDER BY e.created_at, e.id
  LOOP
    v_have := COALESCE((v_pool->>v_ev.factory_id::text)::numeric, 0);
    IF v_ev.delta > 0 THEN
      v_pool := v_pool || jsonb_build_object(v_ev.factory_id::text, v_have + v_ev.delta);
      CONTINUE;
    END IF;

    v_need := -v_ev.delta;
    v_take := LEAST(v_need, GREATEST(v_have, 0));
    v_have := v_have - v_take;
    v_need := v_need - v_take;
    FOR v_other IN SELECT k FROM jsonb_object_keys(v_pool) k WHERE k <> v_ev.factory_id::text ORDER BY k LOOP
      EXIT WHEN v_need <= 0;
      v_take := LEAST(v_need, GREATEST((v_pool->>v_other)::numeric, 0));
      IF v_take > 0 THEN
        v_pool := v_pool || jsonb_build_object(v_other, (v_pool->>v_other)::numeric - v_take);
        v_need := v_need - v_take;
      END IF;
    END LOOP;
    v_pool := v_pool || jsonb_build_object(v_ev.factory_id::text, v_have - v_need);
  END LOOP;

  RETURN QUERY SELECT k::uuid, v::numeric FROM jsonb_each_text(v_pool) AS j(k, v);
END;
$$;
REVOKE ALL ON FUNCTION public.cash_in_hand_by_factory(uuid) FROM PUBLIC, anon, authenticated;

-- What the Cash Out dialog shows: the person's cash for this factory, and
-- their total (what the guard allows them to hand over).
CREATE OR REPLACE FUNCTION public.staff_cash_in_hand_split(p_factory uuid, p_user uuid)
RETURNS jsonb
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
  RETURN jsonb_build_object(
    'factory', COALESCE((SELECT amount FROM public.cash_in_hand_by_factory(p_user) WHERE factory_id = p_factory), 0),
    'total', public.cash_in_hand(p_factory, p_user));
END;
$$;
REVOKE ALL ON FUNCTION public.staff_cash_in_hand_split(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_cash_in_hand_split(uuid, uuid) TO authenticated;
