-- ============================================================================
-- ACCOUNT SECURITY HARDENING
-- ----------------------------------------------------------------------------
-- Closes gaps found in a full audit of the final schema (all migrations
-- applied, Supabase's default grants in place):
--
-- 1. Only ACTIVE accounts hold permissions. has_role/has_permission ignored
--    profiles.status, so suspension relied on set_user_status deleting the
--    user's roles. Per-user permission_overrides survived it, so a suspended,
--    rejected or deactivated user with an override kept that access through
--    the API, including the server functions that check get_my_permissions
--    before using the secret key (e.g. resetting another user's password).
--
-- 2. Users could rewrite their own profile. "update own profile" allowed
--    every column, so anyone could set their own status to 'active', widen
--    their production_scope, or change role_requested while pending. Users
--    may now only change avatar_url and username (all the app writes). Every
--    other column goes through the admin RPCs, which run as owner.
--
-- 3. Staff could not be stopped from granting top-level roles. Anyone holding
--    account-approvals/users permissions (e.g. via an override) could approve
--    or provision an account as super_admin/chairman, or suspend/delete the
--    chairman. Now only a super_admin/chairman can grant or remove those
--    roles or change those accounts, and nobody can change their own status
--    or delete their own account.
--
-- 4. Audit history could be forged: "insert audit logs" accepted any user_id.
--
-- 5. Logged-out visitors (anon) had full table rights on every table created
--    after 20260814093000 and EXECUTE on every function, via Supabase's
--    default privileges. RLS still blocked them, but one loose policy would
--    have exposed a table to the internet. anon now keeps only what the
--    signup page reads (roles), and future objects no longer go to anon.
-- ============================================================================

-- ---------- 1. permissions require an active account ----------
CREATE OR REPLACE FUNCTION public.is_active_user(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = _user_id AND status = 'active');
$$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.is_active_user(_user_id)
     AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.has_role(_user_id, 'super_admin');
$$;

CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _module module_key, _action action_key DEFAULT 'view'::text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actions public.action_key[];
  v_result boolean;
BEGIN
  IF _user_id IS NULL THEN RETURN false; END IF;
  IF NOT public.is_active_user(_user_id) THEN RETURN false; END IF;
  IF public.has_role(_user_id, 'super_admin') OR public.has_role(_user_id, 'chairman') THEN RETURN true; END IF;

  -- Legacy aliases resolve against a bucket of concrete actions so existing
  -- RLS policies/RPC guards calling has_permission(x,'read'/'write') keep
  -- working unchanged against the new fine-grained grants.
  v_actions := CASE _action
    WHEN 'read' THEN ARRAY['view','create','edit','submit','approve','reject','confirm','post','reverse','cancel','export','print','delete']::public.action_key[]
    WHEN 'write' THEN ARRAY['create','edit','delete']::public.action_key[]
    ELSE ARRAY[_action]
  END;

  SELECT EXISTS (
    SELECT 1 FROM unnest(v_actions) AS a(action)
    WHERE COALESCE(
      (SELECT po.granted FROM public.permission_overrides po
        WHERE po.user_id = _user_id AND po.module = _module AND po.action = a.action),
      EXISTS (
        SELECT 1 FROM public.role_permissions rp
        JOIN public.user_roles ur ON ur.role = rp.role
        WHERE ur.user_id = _user_id AND rp.module = _module AND rp.action = a.action
      )
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

-- ---------- 2. users may only edit their own avatar and username ----------
REVOKE INSERT, UPDATE ON public.profiles FROM anon, authenticated;
GRANT UPDATE (avatar_url, username) ON public.profiles TO authenticated;

-- Profiles are created by handle_new_user() (runs as owner), never by clients.
DROP POLICY IF EXISTS "insert own profile" ON public.profiles;

DROP POLICY IF EXISTS "update own profile" ON public.profiles;
CREATE POLICY "update own profile" ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "read own profile" ON public.profiles;
CREATE POLICY "read own profile" ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = id);

-- Was USING (true): pending/rejected sign-ups could list every staff member's
-- email and phone. Staff directory is for active accounts only.
DROP POLICY IF EXISTS "read team profiles" ON public.profiles;
CREATE POLICY "read team profiles" ON public.profiles FOR SELECT TO authenticated
  USING (public.is_active_user(auth.uid()));

-- ---------- 3. protect top-level roles and accounts ----------
-- Triggers rather than edits to each RPC, so approve_user, admin_provision_user,
-- post_role_grant, admin_set_user_role, set_user_status, reject_user,
-- delete_user_account and any future path are all covered. auth.uid() is NULL
-- for migrations, the service role and the signup trigger, which stay allowed
-- (handle_new_user makes the very first account super_admin).
CREATE OR REPLACE FUNCTION public._guard_top_level_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  IF (TG_OP IN ('INSERT','UPDATE') AND NEW.role IN ('super_admin','chairman'))
     OR (TG_OP IN ('UPDATE','DELETE') AND OLD.role IN ('super_admin','chairman')) THEN
    IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
      RAISE EXCEPTION 'Only an Admin or Chairman can grant or remove the % role',
        COALESCE(NEW.role, OLD.role);
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_top_level_roles ON public.user_roles;
CREATE TRIGGER trg_guard_top_level_roles
  BEFORE INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public._guard_top_level_roles();

CREATE OR REPLACE FUNCTION public._guard_account_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_target uuid := COALESCE(NEW.id, OLD.id);
BEGIN
  IF v_uid IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  IF v_target = v_uid THEN
    RAISE EXCEPTION 'You cannot change the status of, or delete, your own account';
  END IF;

  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_target AND role IN ('super_admin','chairman'))
     AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only an Admin or Chairman can change or delete an Admin or Chairman account';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_account_changes ON public.profiles;
CREATE TRIGGER trg_guard_account_changes
  BEFORE UPDATE OF status OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public._guard_account_changes();

-- ---------- 4. audit rows must name the person writing them ----------
DROP POLICY IF EXISTS "insert audit logs" ON public.audit_logs;
CREATE POLICY "insert audit logs" ON public.audit_logs FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM anon, authenticated;

-- ---------- 5. logged-out visitors get nothing but the signup role list ----------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, PUBLIC;
GRANT SELECT ON public.roles TO anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, PUBLIC;

-- New helper is used inside RLS policies, which run as the signed-in user.
GRANT EXECUTE ON FUNCTION public.is_active_user(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public._guard_top_level_roles() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public._guard_account_changes() FROM authenticated;
