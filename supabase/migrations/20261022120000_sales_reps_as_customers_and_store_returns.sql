-- ============================================================================
-- Sales-Reps: one person across Sales, Store and Distribution.
-- ----------------------------------------------------------------------------
-- The morning supply to a sales rep is a SALE ("Order from: Sales-Rep" in the
-- Sales & POS box, confirmed by the accountant), so the rep needs a customer
-- account to carry what they owe. At close of business the store logs what
-- the rep brings back as a sales return, which -- once inspected -- credits
-- that same account (inspect_sales_return(), unchanged).
--
-- 1. customers.sales_rep_id links each Distribution sales rep to exactly one
--    customer record (customer_type 'marketer', shown as "Sales-Rep"). A
--    trigger creates/renames it whenever a rep is added or edited, and every
--    existing rep is backfilled here.
-- 2. store_rep_activity(): the Store page's view of a day -- per rep, what
--    was supplied (posted sales) and what has come back (sales returns).
--    SECURITY DEFINER because store users read neither sales nor customers
--    directly under RLS.
-- 3. store_officer may now log (submit) and cancel sales returns, not only
--    inspect them -- logging the rep's return is the store's job.
-- ============================================================================

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS sales_rep_id uuid REFERENCES public.sales_reps(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customers_sales_rep_id_key
  ON public.customers (sales_rep_id) WHERE sales_rep_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_sales_rep_customer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE customers
     SET name = NEW.full_name, phone = COALESCE(NEW.phone, phone),
         customer_type = 'marketer', registered = true, updated_at = now()
   WHERE sales_rep_id = NEW.id;
  IF NOT FOUND THEN
    INSERT INTO customers (factory_id, name, phone, customer_type, registered, sales_rep_id)
    VALUES (NEW.factory_id, NEW.full_name, NEW.phone, 'marketer', true, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_sales_rep_customer() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_sales_rep_customer ON public.sales_reps;
CREATE TRIGGER trg_sync_sales_rep_customer
AFTER INSERT OR UPDATE OF full_name, phone ON public.sales_reps
FOR EACH ROW EXECUTE FUNCTION public.sync_sales_rep_customer();

-- Backfill: link an existing same-named Sales-Rep customer first (keeps any
-- sales already recorded against it), otherwise create one.
UPDATE public.customers c
   SET sales_rep_id = r.id
  FROM public.sales_reps r
 WHERE c.sales_rep_id IS NULL
   AND c.factory_id = r.factory_id
   AND c.customer_type = 'marketer'
   AND lower(btrim(c.name)) = lower(btrim(r.full_name))
   AND NOT EXISTS (SELECT 1 FROM public.customers x WHERE x.sales_rep_id = r.id);

INSERT INTO public.customers (factory_id, name, phone, customer_type, registered, sales_rep_id)
SELECT r.factory_id, r.full_name, r.phone, 'marketer', true, r.id
  FROM public.sales_reps r
 WHERE NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.sales_rep_id = r.id);

-- ---------- Store page: a day of sales-rep supplies and returns ----------
CREATE OR REPLACE FUNCTION public.store_rep_activity(p_factory_id uuid, p_date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT (public.has_permission(v_uid, 'finished-goods'::module_key, 'view'::action_key)
          OR public.has_permission(v_uid, 'sales-returns'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(rep ORDER BY rep->>'name')
      FROM (
        SELECT jsonb_build_object(
          'sales_rep_id', r.id,
          'customer_id', c.id,
          'name', r.full_name,
          'phone', r.phone,
          'status', r.status,
          -- Posted = confirmed by the accountant, goods released to the rep.
          'supplied', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                     'sale_id', s.id, 'invoice_number', s.invoice_number,
                     'product_id', si.product_id, 'product_name', p.name, 'unit', p.unit,
                     'quantity', si.quantity, 'unit_price', si.unit_price,
                     'created_at', s.created_at)
                   ORDER BY s.created_at)
              FROM sales s
              JOIN sale_items si ON si.sale_id = s.id
              JOIN products p ON p.id = si.product_id
             WHERE s.customer_id = c.id AND s.factory_id = p_factory_id
               AND s.sale_date = p_date AND s.status = 'posted' AND s.deleted_at IS NULL
          ), '[]'::jsonb),
          'pending_orders', (
            SELECT count(*) FROM sales s
             WHERE s.customer_id = c.id AND s.factory_id = p_factory_id
               AND s.sale_date = p_date AND s.status = 'pending_approval' AND s.deleted_at IS NULL
          ),
          'returned', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                     'id', sr.id, 'return_number', sr.return_number,
                     'product_id', sr.product_id, 'product_name', p.name, 'unit', sr.unit,
                     'quantity', sr.quantity_returned, 'accepted', sr.accepted_quantity,
                     'damaged', sr.damaged_quantity, 'rejected', sr.rejected_quantity,
                     'status', sr.status, 'received_at', sr.received_at)
                   ORDER BY sr.received_at)
              FROM sales_returns sr
              JOIN products p ON p.id = sr.product_id
             WHERE sr.customer_id = c.id AND sr.factory_id = p_factory_id
               AND sr.status <> 'cancelled'
               AND (sr.received_at AT TIME ZONE 'Africa/Lagos')::date = p_date
          ), '[]'::jsonb)
        ) AS rep
          FROM sales_reps r
          JOIN customers c ON c.sales_rep_id = r.id
         WHERE r.factory_id = p_factory_id
      ) t
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.store_rep_activity(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_rep_activity(uuid, date) TO authenticated;

INSERT INTO public.role_permissions (role, module, action)
VALUES
  ('store_officer', 'sales-returns', 'view'),
  ('store_officer', 'sales-returns', 'submit'),
  ('store_officer', 'sales-returns', 'cancel')
ON CONFLICT (role, module, action) DO NOTHING;
