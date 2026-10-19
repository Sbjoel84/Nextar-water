-- Makes Aliyu Atanda an Admin (super_admin): full access to every page and
-- every approval -- production posting, sales, procurement, payroll, account
-- approvals, etc. -- including approving his own submissions, which
-- has_permission()/get_my_permissions() and the workflow RPCs already grant
-- super_admin.
--
-- Matched by name because the account's id isn't known ahead of time. The
-- migration stops rather than guess if no account, or more than one, matches.
-- Like admin_set_user_role(), this replaces his global role and leaves any
-- factory-scoped roles alone. Activating the account matters too:
-- is_active_user() withholds every permission from non-active accounts.
DO $$
DECLARE
  v_ids uuid[];
  v_id uuid;
BEGIN
  SELECT array_agg(id) INTO v_ids
  FROM public.profiles
  WHERE full_name ILIKE '%aliyu%atanda%' OR full_name ILIKE '%atanda%aliyu%';

  IF v_ids IS NULL THEN
    RAISE EXCEPTION 'No account named Aliyu Atanda found -- he must sign up (or be created on the Users page) before this migration runs';
  END IF;
  IF array_length(v_ids, 1) > 1 THEN
    RAISE EXCEPTION 'More than one account matches Aliyu Atanda (%); grant the role from the Users page instead', v_ids;
  END IF;
  v_id := v_ids[1];

  DELETE FROM public.user_roles WHERE user_id = v_id AND factory_id IS NULL;
  INSERT INTO public.user_roles (user_id, role) VALUES (v_id, 'super_admin');

  UPDATE public.profiles SET
    status = 'active',
    department = COALESCE(department, 'Admin'),
    approved_at = COALESCE(approved_at, now())
  WHERE id = v_id;
END $$;
