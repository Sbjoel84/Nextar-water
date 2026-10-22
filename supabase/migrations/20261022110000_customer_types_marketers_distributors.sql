-- ============================================================================
-- Marketers and distributors as kinds of customer.
-- ----------------------------------------------------------------------------
-- 1. customers.customer_type -- same values as sales.customer_type -- so the
--    Sales & POS box can list only marketers when "Marketer" is picked and
--    only distributors when "Distributor" is picked. contact_person / area
--    hold the extra details captured on the Distribution page.
-- 2. Backfill: a customer already sold to as a marketer/distributor takes
--    that type (from their latest such sale).
-- 3. save_distributor(): Distribution -> Distributors adds/edits distributors.
--    Those users hold `distribution` grants but not necessarily `customers`
--    write, which the customers RLS insert/update policies require -- so the
--    write goes through this guarded function instead.
-- ============================================================================

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS customer_type text NOT NULL DEFAULT 'walk_in',
  ADD COLUMN IF NOT EXISTS contact_person text,
  ADD COLUMN IF NOT EXISTS area text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_customer_type_check') THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_customer_type_check
      CHECK (customer_type IN ('walk_in', 'marketer', 'distributor', 'other'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS customers_factory_type_idx ON public.customers (factory_id, customer_type);

UPDATE public.customers c
   SET customer_type = s.customer_type
  FROM (
    SELECT DISTINCT ON (customer_id) customer_id, customer_type
      FROM public.sales
     WHERE customer_id IS NOT NULL
       AND customer_type IN ('marketer', 'distributor')
       AND deleted_at IS NULL
     ORDER BY customer_id, created_at DESC
  ) s
 WHERE c.id = s.customer_id
   AND c.customer_type = 'walk_in';

CREATE OR REPLACE FUNCTION public.save_distributor(p_id uuid, payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := NULLIF(payload->>'factory_id', '')::uuid;
  v_name text := NULLIF(btrim(COALESCE(payload->>'name', '')), '');
  v_row customers%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_name IS NULL THEN RAISE EXCEPTION 'Distributor name is required'; END IF;

  IF p_id IS NULL THEN
    IF NOT (public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key)
            OR public.has_permission(v_uid, 'customers'::module_key, 'write'::action_key)) THEN
      RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;

    INSERT INTO customers (factory_id, name, phone, email, address, contact_person, area,
                           customer_type, registered)
    VALUES (v_factory, v_name,
            NULLIF(btrim(COALESCE(payload->>'phone', '')), ''),
            NULLIF(btrim(COALESCE(payload->>'email', '')), ''),
            NULLIF(btrim(COALESCE(payload->>'address', '')), ''),
            NULLIF(btrim(COALESCE(payload->>'contact_person', '')), ''),
            NULLIF(btrim(COALESCE(payload->>'area', '')), ''),
            'distributor', true)
    RETURNING id INTO v_id;

    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (v_uid, v_factory, 'create', 'customers', v_id::text,
            jsonb_build_object('name', v_name, 'customer_type', 'distributor'));
    RETURN v_id;
  END IF;

  SELECT * INTO v_row FROM customers WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Distributor not found'; END IF;
  IF NOT (public.has_permission(v_uid, 'distribution'::module_key, 'edit'::action_key)
          OR public.has_permission(v_uid, 'customers'::module_key, 'write'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  UPDATE customers SET
    name = v_name,
    phone = NULLIF(btrim(COALESCE(payload->>'phone', '')), ''),
    email = NULLIF(btrim(COALESCE(payload->>'email', '')), ''),
    address = NULLIF(btrim(COALESCE(payload->>'address', '')), ''),
    contact_person = NULLIF(btrim(COALESCE(payload->>'contact_person', '')), ''),
    area = NULLIF(btrim(COALESCE(payload->>'area', '')), ''),
    customer_type = 'distributor',
    registered = true,
    updated_at = now()
  WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'edit', 'customers', p_id::text,
          jsonb_build_object('name', v_row.name, 'customer_type', v_row.customer_type),
          jsonb_build_object('name', v_name, 'customer_type', 'distributor'));
  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_distributor(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_distributor(uuid, jsonb) TO authenticated;

-- Read side of the Distributors tab, for the same reason: `distribution`
-- users may not pass the customers RLS read policy.
CREATE OR REPLACE FUNCTION public.list_distributors(p_factory_id uuid)
RETURNS TABLE (
  id uuid, name text, phone text, email text, address text, contact_person text, area text,
  outstanding_balance numeric, credit_balance numeric, total_purchases numeric, created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
          OR public.has_permission(auth.uid(), 'customers'::module_key, 'read'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
    SELECT c.id, c.name, c.phone, c.email, c.address, c.contact_person, c.area,
           c.outstanding_balance, c.credit_balance, c.total_purchases, c.created_at
      FROM customers c
     WHERE c.factory_id = p_factory_id
       AND c.customer_type = 'distributor'
       AND c.deleted_at IS NULL
     ORDER BY c.name;
END;
$$;

REVOKE ALL ON FUNCTION public.list_distributors(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_distributors(uuid) TO authenticated;
