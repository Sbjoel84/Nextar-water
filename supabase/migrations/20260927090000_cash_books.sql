-- Payments and Expenses each run their own cash, linked only by Cash Out.
--
--   Payments: revenue = customer payments that still stand (not rejected/
--     reversed) + other income / donations recorded on the ledger;
--     minus other outflows and every Cash Out moved to Expenses.
--   Expenses: Cash In = every receipt with category 'other_inflow' (typed on
--     the Expenses page, or a Cash Out from the ledger, related_reference =
--     'sales_cash_out'); minus approved/posted expenses.
--
-- A Cash Out is one row: Cash In for Expenses and Cash Out for Payments, so the
-- money is never counted twice. The guards below stop either side from being
-- overdrawn: a Cash Out can't exceed what Payments holds, and an expense can't
-- be approved beyond the Expenses cash.

-- A Cash Out must be shaped as Expenses Cash In.
ALTER TABLE public.cash_transactions DROP CONSTRAINT IF EXISTS cash_transactions_cash_out_shape_check;
ALTER TABLE public.cash_transactions ADD CONSTRAINT cash_transactions_cash_out_shape_check
  CHECK (related_reference IS DISTINCT FROM 'sales_cash_out'
         OR (transaction_type = 'receipt' AND category = 'other_inflow'));

-- ---------- balances ----------
-- How one cash_transactions row moves 'payments' or 'expenses'.
CREATE OR REPLACE FUNCTION public._cash_book_effect(
  p_type text, p_category text, p_reference text, p_amount numeric, p_target text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_target = 'expenses' THEN
      CASE WHEN p_type = 'receipt' AND p_category = 'other_inflow' THEN p_amount ELSE 0 END
    ELSE
      CASE
        WHEN p_reference = 'sales_cash_out' THEN -p_amount
        WHEN p_type = 'receipt' AND p_category = 'other_inflow' THEN 0
        WHEN p_type = 'receipt' THEN p_amount
        ELSE -p_amount
      END
  END;
$$;

CREATE OR REPLACE FUNCTION public.cash_book_balances(p_factory uuid)
RETURNS TABLE(payments_cash numeric, expenses_cash numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE((SELECT sum(amount) FROM payments_received
               WHERE factory_id = p_factory AND status::text NOT IN ('rejected', 'reversed')), 0)
    + COALESCE((SELECT sum(public._cash_book_effect(transaction_type, category, related_reference, amount, 'payments'))
                  FROM cash_transactions WHERE factory_id = p_factory), 0),
    COALESCE((SELECT sum(public._cash_book_effect(transaction_type, category, related_reference, amount, 'expenses'))
                FROM cash_transactions WHERE factory_id = p_factory), 0)
    - COALESCE((SELECT sum(amount) FROM expenses
                 WHERE factory_id = p_factory AND status::text IN ('approved', 'posted')), 0);
$$;
REVOKE ALL ON FUNCTION public.cash_book_balances(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._fmt_money(p numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$ SELECT to_char(p, 'FM999,999,999,990.00') $$;

-- ---------- guard: cash_transactions ----------
-- Only a change that takes money out of a side is checked, so a side that is
-- already short from older data can still receive cash.
CREATE OR REPLACE FUNCTION public.guard_cash_transaction_books()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_factory uuid := COALESCE(NEW.factory_id, OLD.factory_id);
  v_old_pay numeric := 0; v_new_pay numeric := 0;
  v_old_exp numeric := 0; v_new_exp numeric := 0;
  v_bal record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.factory_id <> OLD.factory_id THEN
    RAISE EXCEPTION 'A cash transaction cannot be moved to another factory';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    v_old_pay := public._cash_book_effect(OLD.transaction_type, OLD.category, OLD.related_reference, OLD.amount, 'payments');
    v_old_exp := public._cash_book_effect(OLD.transaction_type, OLD.category, OLD.related_reference, OLD.amount, 'expenses');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new_pay := public._cash_book_effect(NEW.transaction_type, NEW.category, NEW.related_reference, NEW.amount, 'payments');
    v_new_exp := public._cash_book_effect(NEW.transaction_type, NEW.category, NEW.related_reference, NEW.amount, 'expenses');
  END IF;

  IF v_new_pay < v_old_pay OR v_new_exp < v_old_exp THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('cash_books:' || v_factory::text, 0));
    SELECT * INTO v_bal FROM public.cash_book_balances(v_factory);
    IF v_new_pay < v_old_pay AND v_bal.payments_cash < 0 THEN
      RAISE EXCEPTION 'Not enough cash in Payments for this Cash Out. Available: %',
        public._fmt_money(GREATEST(v_bal.payments_cash + (v_old_pay - v_new_pay), 0));
    END IF;
    IF v_new_exp < v_old_exp AND v_bal.expenses_cash < 0 THEN
      RAISE EXCEPTION 'This Cash In has already been spent on expenses. Available to remove: %',
        public._fmt_money(GREATEST(v_bal.expenses_cash + (v_old_exp - v_new_exp), 0));
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS cash_transactions_guard_books ON public.cash_transactions;
CREATE TRIGGER cash_transactions_guard_books
AFTER INSERT OR UPDATE OR DELETE ON public.cash_transactions
FOR EACH ROW EXECUTE FUNCTION public.guard_cash_transaction_books();

-- ---------- guard: expenses ----------
-- An expense only counts once approved/posted; at that point (or when an
-- approved expense's amount goes up) it must be covered by Expenses Cash In.
CREATE OR REPLACE FUNCTION public.guard_expense_float()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old numeric := 0;
  v_new numeric := 0;
  v_bal record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.factory_id <> OLD.factory_id THEN
      RAISE EXCEPTION 'An expense cannot be moved to another factory';
    END IF;
    IF OLD.status::text IN ('approved', 'posted') THEN v_old := OLD.amount; END IF;
  END IF;
  IF NEW.status::text IN ('approved', 'posted') THEN v_new := NEW.amount; END IF;

  IF v_new > v_old THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('cash_books:' || NEW.factory_id::text, 0));
    SELECT * INTO v_bal FROM public.cash_book_balances(NEW.factory_id);
    IF v_bal.expenses_cash < 0 THEN
      RAISE EXCEPTION 'Not enough Expenses cash to cover this expense. Available: %. Record a Cash In (or a Cash Out from Payments) first.',
        public._fmt_money(GREATEST(v_bal.expenses_cash + (v_new - v_old), 0));
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS expenses_guard_float ON public.expenses;
CREATE TRIGGER expenses_guard_float
AFTER INSERT OR UPDATE OF status, amount ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.guard_expense_float();
