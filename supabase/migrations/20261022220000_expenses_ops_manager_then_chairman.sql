-- ============================================================================
-- Expenses: Operations Manager reviews, Chairman gives final approval
-- ----------------------------------------------------------------------------
--   pending_approval --(Operations Manager approves = sends to Chairman)--> approved
--   approved         --(Chairman final approval)-----------------------------> posted
--   Either stage can be rejected, with a reason:
--     pending_approval -> rejected   by the Operations Manager (or Chairman)
--     approved         -> rejected   by the Chairman
--
-- The stages are tied to roles, not to the grantable approve/post permissions,
-- so no other role (accountant, super_admin) can approve or post an expense:
--   approve_expense -- operations_manager or chairman
--   post_expense    -- chairman only
--   reject_expense  -- operations_manager (pending stage) or chairman (either)
-- The chairman keeps the ability to complete an expense in one go (his own
-- expenses still auto-complete via _chairman_complete()).
--
-- Notifications: the Operations Manager is told about each new expense, the
-- Chairman when one is sent to him, and the submitter of the final outcome.
-- Each "awaiting" notification clears once that step is taken.
--
-- Aliyu Atanda (super_admin) is given the Operations Manager role as well, so
-- the first stage is his. Rowland is already the chairman.
-- ============================================================================

-- ============ 1. role + who holds it ============
INSERT INTO public.roles (slug, label, is_system) VALUES
  ('operations_manager', 'Operations Manager', true)
ON CONFLICT (slug) DO NOTHING;

DO $$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT array_agg(id) INTO v_ids
  FROM public.profiles
  WHERE full_name ILIKE '%aliyu%atanda%' OR full_name ILIKE '%atanda%aliyu%';
  IF v_ids IS NULL THEN
    RAISE EXCEPTION 'No account named Aliyu Atanda found';
  END IF;
  IF array_length(v_ids, 1) > 1 THEN
    RAISE EXCEPTION 'More than one account matches Aliyu Atanda (%); grant the Operations Manager role from the Admin Panel instead', v_ids;
  END IF;
  -- Added alongside his Admin role, not replacing it.
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_ids[1] AND role = 'operations_manager') THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (v_ids[1], 'operations_manager');
  END IF;
END $$;

-- ============ 2. permissions that drive the Expenses page buttons ============
INSERT INTO public.role_permissions (role, module, action)
SELECT 'operations_manager', 'expenses', a FROM unnest(ARRAY['view','approve','reject','export','print']::action_key[]) a
ON CONFLICT DO NOTHING;
-- The accountant records expenses; approving and posting are no longer theirs.
DELETE FROM public.role_permissions
 WHERE role = 'accountant' AND module = 'expenses' AND action IN ('approve', 'reject', 'post');

UPDATE public.workflow_configs
   SET checker_label = 'Operations Manager → Chairman',
       description = 'Operating expense: reviewed by the Operations Manager, then given final approval by the Chairman.'
 WHERE module = 'expenses';

-- ============ 3. notification helpers ============
-- Expenses have no reference number, so notifications start with the short id
-- the app shows (#7A040148) and are cleared by matching it.
CREATE OR REPLACE FUNCTION public._expense_ref(p_id uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$ SELECT '#' || upper(left(p_id::text, 8)) $$;

CREATE OR REPLACE FUNCTION public._expense_summary(p_row public.expenses)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT public._expense_ref(p_row.id) || ' — ' || COALESCE(NULLIF(btrim(p_row.description), ''), 'Expense')
         || ' · ' || public._fmt_money(p_row.amount)
$$;

CREATE OR REPLACE FUNCTION public._resolve_expense_notifications(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE notifications SET resolved_at = now()
   WHERE resolved_at IS NULL
     AND title IN ('Expense awaiting your review', 'Expense awaiting your final approval')
     AND left(body, 9) = public._expense_ref(p_id);
$$;
REVOKE ALL ON FUNCTION public._resolve_expense_notifications(uuid) FROM PUBLIC, anon, authenticated;

-- New expense awaiting review -> every Operations Manager.
CREATE OR REPLACE FUNCTION public.notify_expense_submitted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status::text = 'pending_approval'
     AND (TG_OP = 'INSERT' OR OLD.status::text IS DISTINCT FROM 'pending_approval') THEN
    INSERT INTO notifications(user_id, factory_id, title, body)
    SELECT DISTINCT ur.user_id, NEW.factory_id, 'Expense awaiting your review',
           public._expense_summary(NEW)
      FROM user_roles ur
     WHERE ur.role = 'operations_manager'
       AND ur.user_id IS DISTINCT FROM NEW.submitted_by;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_expense_submitted() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notify_expense_submitted ON public.expenses;
CREATE TRIGGER trg_notify_expense_submitted
AFTER INSERT OR UPDATE OF status ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.notify_expense_submitted();

-- ============ 4. approve_expense: Operations Manager sends it to the Chairman ============
CREATE OR REPLACE FUNCTION public.approve_expense(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid(); v_progress record; v_name text;
BEGIN
  IF NOT (public.has_role(v_uid, 'operations_manager') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only the Operations Manager reviews expenses before they go to the Chairman';
  END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT public.has_role(v_uid, 'chairman') THEN
    RAISE EXCEPTION 'You cannot approve an expense you submitted yourself';
  END IF;

  PERFORM public.record_workflow_action('expenses', p_id, 'approve', v_row.status, v_row.status, p_comment);
  SELECT * INTO v_progress FROM public.workflow_approval_progress('expenses', p_id);
  IF NOT v_progress.satisfied THEN
    RETURN jsonb_build_object('approved', false, 'partial', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
  END IF;

  PERFORM public.assert_valid_transition(v_row.status, 'approved');
  UPDATE expenses SET status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;

  PERFORM public._resolve_expense_notifications(p_id);
  SELECT full_name INTO v_name FROM profiles WHERE id = v_uid;
  INSERT INTO notifications(user_id, factory_id, title, body)
  SELECT DISTINCT ur.user_id, v_row.factory_id, 'Expense awaiting your final approval',
         public._expense_summary(v_row) || ' (approved by ' || COALESCE(v_name, 'Operations Manager') || ')'
    FROM user_roles ur
   WHERE ur.role = 'chairman' AND ur.user_id <> v_uid;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'approved', 'comment', p_comment));
  RETURN jsonb_build_object('approved', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
END; $function$;

-- ============ 5. post_expense: Chairman's final approval ============
CREATE OR REPLACE FUNCTION public.post_expense(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid(); v_name text;
BEGIN
  IF NOT public.has_role(v_uid, 'chairman') THEN
    RAISE EXCEPTION 'Only the Chairman gives final approval to expenses';
  END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  SELECT COALESCE(full_name, email, 'Unknown') INTO v_name FROM profiles WHERE id = v_uid;
  UPDATE expenses SET status = 'posted', approval_status = 'approved', approved_by = v_name, approved_at = now(),
    reviewed_by = v_uid, reviewed_at = now()
  WHERE id = p_id;
  PERFORM public.record_workflow_action('expenses', p_id, 'post', v_row.status, 'posted', p_comment);

  PERFORM public._resolve_expense_notifications(p_id);
  IF v_row.submitted_by IS NOT NULL AND v_row.submitted_by <> v_uid THEN
    INSERT INTO notifications(user_id, factory_id, title, body)
    VALUES (v_row.submitted_by, v_row.factory_id, 'Expense approved by the Chairman',
            public._expense_summary(v_row) || COALESCE(': ' || NULLIF(btrim(p_comment), ''), ''));
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'post_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'posted', 'comment', p_comment));
  RETURN jsonb_build_object('posted', true);
END; $function$;

-- ============ 6. reject_expense: at either stage, reason required ============
CREATE OR REPLACE FUNCTION public.reject_expense(p_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row expenses%ROWTYPE;
  v_uid uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_is_chairman boolean := public.has_role(v_uid, 'chairman');
  v_name text;
  v_title text;
BEGIN
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Give a reason for rejecting this expense'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;

  IF v_row.status::text = 'pending_approval' THEN
    IF NOT (v_is_chairman OR public.has_role(v_uid, 'operations_manager')) THEN
      RAISE EXCEPTION 'Only the Operations Manager or the Chairman can reject this expense';
    END IF;
    IF v_row.submitted_by = v_uid AND NOT v_is_chairman THEN
      RAISE EXCEPTION 'You cannot reject an expense you submitted yourself';
    END IF;
    PERFORM public.assert_valid_transition(v_row.status, 'rejected');
  ELSIF v_row.status::text = 'approved' THEN
    -- Sent to the Chairman: only he can turn it down now. (approved -> rejected
    -- isn't in workflow_transitions for other flows, so it's allowed here only.)
    IF NOT v_is_chairman THEN
      RAISE EXCEPTION 'This expense is with the Chairman for final approval';
    END IF;
  ELSE
    RAISE EXCEPTION 'Only an expense awaiting approval can be rejected (this one is %)', v_row.status;
  END IF;

  UPDATE expenses SET status = 'rejected', approval_status = 'rejected', reviewed_by = v_uid, reviewed_at = now(),
    remarks = COALESCE(remarks || E'\n', '') || 'Rejected: ' || v_reason
  WHERE id = p_id;
  PERFORM public.record_workflow_action('expenses', p_id, 'reject', v_row.status, 'rejected', v_reason);

  PERFORM public._resolve_expense_notifications(p_id);
  SELECT full_name INTO v_name FROM profiles WHERE id = v_uid;
  v_title := 'Expense rejected by ' || CASE WHEN v_is_chairman THEN 'the Chairman' ELSE COALESCE(v_name, 'the Operations Manager') END;
  -- The submitter, and (when the Chairman turns down a forwarded expense) the
  -- Operations Manager who sent it.
  INSERT INTO notifications(user_id, factory_id, title, body)
  SELECT DISTINCT u, v_row.factory_id, v_title, public._expense_summary(v_row) || ': ' || v_reason
    FROM unnest(ARRAY[
      v_row.submitted_by,
      CASE WHEN v_row.status::text = 'approved' THEN v_row.reviewed_by END
    ]) AS u
   WHERE u IS NOT NULL AND u <> v_uid;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reject_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'rejected', 'reason', v_reason));
  RETURN jsonb_build_object('rejected', true);
END; $function$;

-- Cancelling or reversing also clears any "awaiting" notification.
CREATE OR REPLACE FUNCTION public.clear_expense_notifications_on_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status::text IN ('cancelled', 'reversed') AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM public._resolve_expense_notifications(NEW.id);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.clear_expense_notifications_on_close() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_clear_expense_notifications ON public.expenses;
CREATE TRIGGER trg_clear_expense_notifications
AFTER UPDATE OF status ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.clear_expense_notifications_on_close();
