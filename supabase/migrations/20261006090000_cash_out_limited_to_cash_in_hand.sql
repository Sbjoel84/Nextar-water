-- A cash Cash Out can only move physical cash the person actually holds.
--
-- The cash_books guard (20260927090000) only checks the factory-wide Payments
-- balance, and that balance is mostly bank transfers / POS. So a salesperson
-- could "move" cash to Expenses that they never collected: the factory total
-- covered it, but no physical cash existed in their hands.
--
-- Cash in hand for a person = cash customer payments they received (not
-- rejected / reversed / deleted)
--   + cash other income they recorded on the ledger
--   - cash outflows they recorded, including every cash Cash Out to Expenses.
--
-- Only a change that lowers someone's cash in hand is checked, so a correction
-- that adds cash (or a payment rejected after the fact) is never blocked.
--
-- Earlier over-moves are not undone: the balance is cumulative, so a shortfall
-- (e.g. a person who moved more cash than they collected before this guard)
-- is recovered from their next cash collections before they can move more.

CREATE OR REPLACE FUNCTION public.cash_in_hand(p_factory uuid, p_user uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE((SELECT sum(amount) FROM payments_received
               WHERE factory_id = p_factory AND received_by = p_user
                 AND payment_method = 'cash' AND deleted_at IS NULL
                 AND status::text NOT IN ('rejected', 'reversed')), 0)
    + COALESCE((SELECT sum(public._cash_book_effect(transaction_type, category, related_reference, amount, 'payments'))
                  FROM cash_transactions
                 WHERE factory_id = p_factory AND recorded_by = p_user
                   AND payment_method = 'cash'), 0);
$$;
REVOKE ALL ON FUNCTION public.cash_in_hand(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- What the Cash Out dialog shows the signed-in user.
CREATE OR REPLACE FUNCTION public.my_cash_in_hand(p_factory uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT public.cash_in_hand(p_factory, auth.uid()) $$;
REVOKE ALL ON FUNCTION public.my_cash_in_hand(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_cash_in_hand(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_cash_in_hand()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_factory uuid := COALESCE(NEW.factory_id, OLD.factory_id);
  v_holder uuid;
  v_old numeric;
  v_new numeric;
  v_bal numeric;
  v_name text;
BEGIN
  FOREACH v_holder IN ARRAY ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.recorded_by END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.recorded_by END
  ] LOOP
    CONTINUE WHEN v_holder IS NULL;
    v_old := 0; v_new := 0;
    IF TG_OP <> 'INSERT' AND OLD.recorded_by = v_holder AND OLD.payment_method = 'cash' THEN
      v_old := public._cash_book_effect(OLD.transaction_type, OLD.category, OLD.related_reference, OLD.amount, 'payments');
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.recorded_by = v_holder AND NEW.payment_method = 'cash' THEN
      v_new := public._cash_book_effect(NEW.transaction_type, NEW.category, NEW.related_reference, NEW.amount, 'payments');
    END IF;
    CONTINUE WHEN v_new >= v_old;

    PERFORM pg_advisory_xact_lock(hashtextextended('cash_in_hand:' || v_factory::text || ':' || v_holder::text, 0));
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

DROP TRIGGER IF EXISTS cash_transactions_guard_cash_in_hand ON public.cash_transactions;
CREATE TRIGGER cash_transactions_guard_cash_in_hand
AFTER INSERT OR UPDATE OR DELETE ON public.cash_transactions
FOR EACH ROW EXECUTE FUNCTION public.guard_cash_in_hand();
