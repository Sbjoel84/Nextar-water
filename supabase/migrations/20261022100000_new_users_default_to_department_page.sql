-- ============================================================================
-- New users start with ONLY their own department's page.
-- ----------------------------------------------------------------------------
-- Until now a new account saw every page its role grants. From now on, when
-- an account gets its first role -- admin_provision_user() (admin-created) or
-- approve_user() (self-registered, then approved) -- it is given per-user
-- page overrides: `view` granted on its department's page(s), `view` blocked
-- on every other page. An admin then grants extra pages from Roles &
-- Permissions -> Page access, exactly as before.
--
-- These are the same permission_overrides rows the Page access grid writes
-- (src/components/permissions/user-page-access.tsx), so they show there as
-- "Granted"/"Blocked" and "Reset to role default" undoes them. Only `view` is
-- touched: it gates which pages the user can open; the role's other grants
-- still drive what the department page itself can do and read.
--
-- Department -> page(s), matching DEPARTMENT_OPTIONS (src/lib/departments.ts):
--   Sales               -> Sales
--   Inventory / Store   -> Inventory (raw materials) + Store (finished goods)
--   Finance & Accounts  -> Account Overview (finance)
--   Production          -> Production
--   Water Factory       -> Production
--   Admin               -> Admin Panel (users)
-- No/unknown department falls back to the role. Admin and Chairman are never
-- restricted (has_permission() lets them through regardless), and existing
-- users are not changed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.default_pages_for(p_department text, p_role text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN lower(COALESCE(p_department, '')) LIKE '%sales%' THEN ARRAY['sales']
    WHEN lower(COALESCE(p_department, '')) LIKE '%inventory%'
      OR lower(COALESCE(p_department, '')) LIKE '%store%' THEN ARRAY['raw-materials', 'finished-goods']
    WHEN lower(COALESCE(p_department, '')) LIKE '%financ%'
      OR lower(COALESCE(p_department, '')) LIKE '%account%' THEN ARRAY['finance']
    WHEN lower(COALESCE(p_department, '')) LIKE '%production%'
      OR lower(COALESCE(p_department, '')) LIKE '%water%' THEN ARRAY['production']
    WHEN lower(COALESCE(p_department, '')) LIKE '%admin%' THEN ARRAY['users']
    ELSE CASE p_role
      WHEN 'sales' THEN ARRAY['sales']
      WHEN 'accountant' THEN ARRAY['finance']
      WHEN 'cashier' THEN ARRAY['finance']
      WHEN 'production' THEN ARRAY['production']
      WHEN 'inventory_officer' THEN ARRAY['raw-materials']
      WHEN 'store_officer' THEN ARRAY['finished-goods']
      WHEN 'costing_officer' THEN ARRAY['costing']
      WHEN 'logistics' THEN ARRAY['logistics']
      WHEN 'hr' THEN ARRAY['employees']
      WHEN 'payroll_officer' THEN ARRAY['payroll']
      -- Anything else (e.g. manager, or a custom role) keeps its role's pages.
      ELSE NULL
    END
  END;
$$;

CREATE OR REPLACE FUNCTION public.apply_default_page_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_department text;
  v_pages text[];
BEGIN
  IF NEW.role IN ('super_admin', 'chairman') THEN RETURN NEW; END IF;

  -- Only an account's FIRST role: a later role grant to an existing user
  -- must never wipe the pages an admin has already given them.
  IF EXISTS (
    SELECT 1 FROM user_roles
     WHERE user_id = NEW.user_id
       AND (role, factory_id) IS DISTINCT FROM (NEW.role, NEW.factory_id)
  ) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM permission_overrides WHERE user_id = NEW.user_id AND action = 'view') THEN
    RETURN NEW;
  END IF;

  -- Both provisioning paths set profiles.department before inserting the role.
  SELECT department INTO v_department FROM profiles WHERE id = NEW.user_id;
  v_pages := public.default_pages_for(v_department, NEW.role);
  IF v_pages IS NULL THEN RETURN NEW; END IF;

  -- Every page module (module_key is a text domain -- this is its allowed
  -- list as of 20260916090000_split_sales_returns_module.sql).
  INSERT INTO permission_overrides (user_id, module, action, granted, granted_by)
  SELECT NEW.user_id, m::module_key, 'view', m = ANY (v_pages), auth.uid()
    FROM unnest(ARRAY[
      'dashboard','sales','production','production-requests','purchase-orders','raw-materials',
      'finished-goods','finance','inventory','expenses','payroll','payments','receipts-payments',
      'cash-flow','debts','customers','suppliers','employees','reports','users','account-approvals',
      'audit-logs','settings','costing','logistics','approvals','goods-receiving','distribution',
      'sales-returns'
    ]) AS m
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_default_page_access() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_apply_default_page_access ON public.user_roles;
CREATE TRIGGER trg_apply_default_page_access
AFTER INSERT ON public.user_roles
FOR EACH ROW EXECUTE FUNCTION public.apply_default_page_access();
