-- Cash taken at the point of sale belongs to the seller, not the approver.
--
-- When a sale is approved, its point-of-sale payment is inserted with
-- received_by = the approver (see the sale approval function), so cash a
-- salesperson took at the counter was counted as the approver's cash in hand.
-- On the Water Factory every such payment so far is Princess's sale approved
-- by Vivian: 21,000 + 2,800 + 3,500 + 3,400 + 3,400 (and a reversed 140,000).
--
-- 20261007090000 read those payments as Vivian's collections and moved three
-- of Princess's Cash Outs onto Vivian. That was wrong: it was Princess's own
-- cash all along. This undoes that one-off and counts point-of-sale cash for
-- the sale's creator, so Princess holds the 3,400 from INV20261006-00496 and
-- Vivian holds nothing.

CREATE OR REPLACE FUNCTION public.cash_in_hand(p_factory uuid, p_user uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE((SELECT sum(pr.amount)
                FROM payments_received pr
                LEFT JOIN sales s ON s.id = pr.sale_id
               WHERE COALESCE(CASE WHEN pr.remarks = 'Payment at point of sale' THEN s.created_by END,
                              pr.received_by) = p_user
                 AND pr.payment_method = 'cash' AND pr.deleted_at IS NULL
                 AND pr.status::text NOT IN ('rejected', 'reversed')), 0)
    + COALESCE((SELECT sum(public._cash_book_effect(transaction_type, category, related_reference, amount, 'payments'))
                  FROM cash_transactions
                 WHERE COALESCE(cash_holder, recorded_by) = p_user
                   AND payment_method = 'cash'), 0);
$$;
REVOKE ALL ON FUNCTION public.cash_in_hand(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------- undo the one-off from 20261007090000 ----------
-- Order keeps every guard satisfied: give Princess's 23 Sep Cash Out its full
-- 50,800 back first (Expenses cash goes up), then drop the split-off 23,800
-- row and return the other two Cash Outs to her. Re-running is a no-op.
DO $$
DECLARE
  v_vivian uuid := '6787213d-d519-429d-bf9a-3aa484d35c54';
BEGIN
  IF EXISTS (SELECT 1 FROM cash_transactions
              WHERE transaction_number = 'RCT-20260923-08369-V' AND cash_holder = v_vivian) THEN
    UPDATE cash_transactions SET amount = 50800
     WHERE transaction_number = 'RCT-20260923-08369' AND amount = 27000;
    DELETE FROM cash_transactions
     WHERE transaction_number = 'RCT-20260923-08369-V' AND cash_holder = v_vivian;
  END IF;

  UPDATE cash_transactions SET cash_holder = NULL
   WHERE transaction_number IN ('RCT-20260930-71929', 'RCT-20261002-49707')
     AND cash_holder = v_vivian;
END $$;
