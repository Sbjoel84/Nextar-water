-- A point-of-sale payment is received by the seller, not by the sale's approver.
--
-- approve_sale() inserts the sale's payments with received_by = the approver.
-- received_by is who "recorded" the payment, so the approver (Vivian on every
-- sale so far) could never confirm, reject or reverse those payments: the
-- ledger hides the buttons and the RPCs refuse a payment you recorded. At the
-- time of writing 16 pending payments were stuck that way, all sold by
-- Princess or Blessing.
--
-- Now received_by on a point-of-sale payment is the person who recorded the
-- sale, for existing rows and (via trigger, so approve_sale() itself is left
-- untouched) for every new one. The approver stays a valid reviewer; the
-- seller still can't confirm their own payment.

CREATE OR REPLACE FUNCTION public.point_of_sale_payment_received_by_seller()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seller uuid;
BEGIN
  IF NEW.sale_id IS NOT NULL AND NEW.remarks = 'Payment at point of sale' THEN
    SELECT created_by INTO v_seller FROM sales WHERE id = NEW.sale_id;
    NEW.received_by := COALESCE(v_seller, NEW.received_by);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payments_received_pos_seller ON public.payments_received;
CREATE TRIGGER payments_received_pos_seller
BEFORE INSERT ON public.payments_received
FOR EACH ROW EXECUTE FUNCTION public.point_of_sale_payment_received_by_seller();

UPDATE public.payments_received pr
   SET received_by = s.created_by
  FROM public.sales s
 WHERE s.id = pr.sale_id
   AND pr.remarks = 'Payment at point of sale'
   AND s.created_by IS NOT NULL
   AND pr.received_by IS DISTINCT FROM s.created_by;
