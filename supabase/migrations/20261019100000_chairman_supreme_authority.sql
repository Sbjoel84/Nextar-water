-- ============================================================================
-- CHAIRMAN: OWNER OF THE BUSINESS, ABOVE EVERY OTHER ACCOUNT
-- ----------------------------------------------------------------------------
-- 20260923190000_chairman_full_admin_parity already lets the chairman see
-- every page, do every action and approve their own submissions. This closes
-- what was left:
--
-- 1. The chairman account is untouchable. No signed-in user -- an Admin,
--    another chairman, or the chairman themselves -- can delete it, suspend
--    or deactivate it, or remove its Chairman role. Only the chairman can
--    edit the chairman's profile, and only a chairman can make someone else
--    a chairman. (Migrations and the service role are unaffected, so the
--    business can still change this through the database if ever needed.)
--
-- 2. The chairman never waits on anyone. Whatever the chairman initiates --
--    a sale, expense, payment, payroll run, stock write-off, goods receipt,
--    production batch, production request, costing sheet, staff loan or
--    deduction, debt write-off, customer adjustment, production correction,
--    role change or delete request -- is approved/confirmed/posted straight
--    away, through the same RPCs a checker would use (so stock, cash, ledger,
--    audit and approval history all update exactly as they normally do).
--    A deferred trigger runs this at commit, after the whole create
--    transaction (header + line items) is in place. If a step fails (e.g.
--    not enough stock), the record is still saved, stays pending, and the
--    chairman gets a notification with the reason.
--    Returns (sales returns, rep returns) are left for inspection: the
--    returned goods' condition is only known once someone counts them.
--
-- 3. A chairman's approval alone satisfies a workflow, even if its
--    required_approvals is set above 1 on the Approval Workflows page.
--
-- 4. Remaining super_admin-only checks now include chairman: is_admin()
--    (audit log, role and override policies) and the self-inspection rule
--    in inspect_rep_return().
-- ============================================================================

-- ---------- helper: does this account hold the Chairman role at all ----------
-- Unlike has_role() this ignores profiles.status, so protection can't be
-- sidestepped by first changing the account's status.
CREATE OR REPLACE FUNCTION public.is_chairman_account(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'chairman');
$$;
GRANT EXECUTE ON FUNCTION public.is_chairman_account(uuid) TO authenticated, service_role;

-- ---------- 1a. the Chairman role can't be removed, only a chairman grants it ----------
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

  IF TG_OP = 'DELETE' AND OLD.role = 'chairman' THEN
    RAISE EXCEPTION 'The Chairman role cannot be removed';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.role = 'chairman'
     AND (NEW.role <> 'chairman' OR NEW.user_id <> OLD.user_id) THEN
    RAISE EXCEPTION 'The Chairman role cannot be removed';
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.role = 'chairman' AND NOT public.has_role(v_uid, 'chairman') THEN
    RAISE EXCEPTION 'Only the Chairman can grant the Chairman role';
  END IF;

  IF (TG_OP IN ('INSERT','UPDATE') AND NEW.role = 'super_admin')
     OR (TG_OP IN ('UPDATE','DELETE') AND OLD.role = 'super_admin') THEN
    IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
      RAISE EXCEPTION 'Only an Admin or Chairman can grant or remove the % role',
        COALESCE(NEW.role, OLD.role);
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ---------- 1b. the chairman account can't be deleted or suspended ----------
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

  IF public.is_chairman_account(v_target) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'The Chairman account cannot be deleted';
    END IF;
    RAISE EXCEPTION 'The Chairman account cannot be suspended or deactivated';
  END IF;

  IF v_target = v_uid THEN
    RAISE EXCEPTION 'You cannot change the status of, or delete, your own account';
  END IF;

  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_target AND role = 'super_admin')
     AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only an Admin or Chairman can change or delete an Admin account';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ---------- 1c. only the chairman edits the chairman's profile ----------
CREATE OR REPLACE FUNCTION public._guard_chairman_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR v_uid = OLD.id THEN RETURN NEW; END IF;
  IF public.is_chairman_account(OLD.id) AND NOT public.has_role(v_uid, 'chairman') THEN
    RAISE EXCEPTION 'Only the Chairman can change the Chairman''s account';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_chairman_profile ON public.profiles;
CREATE TRIGGER trg_guard_chairman_profile
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public._guard_chairman_profile();

REVOKE EXECUTE ON FUNCTION public._guard_chairman_profile() FROM authenticated;

-- ---------- 2. whatever the chairman initiates completes immediately ----------
-- Walks one record through its remaining approval steps using the existing
-- RPCs. Each branch re-reads the current status, so it is safe to call on a
-- record that is already done (it does nothing).
CREATE OR REPLACE FUNCTION public._chairman_complete(p_table text, p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  c CONSTANT text := 'Chairman - approved automatically';
  v_pending CONSTANT text[] := ARRAY['submitted','pending_review','pending_approval','pending_confirmation'];
  v_uid uuid := auth.uid();
  s text;
  v_name text;
  v_prod production%ROWTYPE;
BEGIN
  CASE p_table
  WHEN 'expenses' THEN
    SELECT status::text INTO s FROM expenses WHERE id = p_id;
    IF s = ANY(v_pending) THEN PERFORM public.approve_expense(p_id, c); SELECT status::text INTO s FROM expenses WHERE id = p_id; END IF;
    IF s = 'approved' THEN PERFORM public.post_expense(p_id, c); END IF;

  WHEN 'debts' THEN
    SELECT writeoff_status::text INTO s FROM debts WHERE id = p_id;
    IF s = ANY(v_pending) THEN PERFORM public.approve_debt_writeoff(p_id, c); SELECT writeoff_status::text INTO s FROM debts WHERE id = p_id; END IF;
    IF s = 'approved' THEN PERFORM public.post_debt_writeoff(p_id, c); END IF;

  WHEN 'payments_received' THEN
    SELECT status::text INTO s FROM payments_received WHERE id = p_id;
    IF s = ANY(v_pending) THEN PERFORM public.confirm_payment(p_id, c); END IF;

  WHEN 'payroll' THEN
    SELECT status::text INTO s FROM payroll WHERE id = p_id;
    IF s = ANY(v_pending) THEN PERFORM public.approve_payroll(p_id, c); SELECT status::text INTO s FROM payroll WHERE id = p_id; END IF;
    IF s = 'approved' THEN PERFORM public.post_payroll(p_id, CURRENT_DATE, c); END IF;

  WHEN 'staff_loans' THEN
    SELECT status::text INTO s FROM staff_loans WHERE id = p_id;
    IF s = 'pending' THEN PERFORM public.approve_staff_loan(p_id, c); END IF;

  WHEN 'staff_deductions' THEN
    SELECT status::text INTO s FROM staff_deductions WHERE id = p_id;
    IF s = 'pending' THEN PERFORM public.approve_staff_deduction(p_id, c); END IF;

  WHEN 'stock_adjustment_requests' THEN
    SELECT status::text INTO s FROM stock_adjustment_requests WHERE id = p_id;
    IF s = ANY(v_pending) THEN PERFORM public.approve_stock_adjustment(p_id, c); SELECT status::text INTO s FROM stock_adjustment_requests WHERE id = p_id; END IF;
    IF s = 'approved' THEN PERFORM public.post_stock_adjustment(p_id, c); END IF;

  WHEN 'costing_sheets' THEN
    SELECT status::text INTO s FROM costing_sheets WHERE id = p_id;
    IF s = ANY(v_pending) THEN PERFORM public.approve_costing_sheet(p_id, c); END IF;

  WHEN 'raw_materials' THEN
    SELECT approval_status::text INTO s FROM raw_materials WHERE id = p_id;
    IF s = 'pending_approval' THEN PERFORM public.approve_new_material(p_id, c); END IF;

  WHEN 'goods_receipts' THEN
    SELECT status::text INTO s FROM goods_receipts WHERE id = p_id;
    IF s = ANY(v_pending) THEN PERFORM public.confirm_goods_receipt(p_id, c); END IF;

  WHEN 'production' THEN
    -- Received into store exactly as the chairman recorded it.
    SELECT * INTO v_prod FROM production WHERE id = p_id;
    IF v_prod.status::text = ANY(v_pending) THEN
      PERFORM public.confirm_production_batch(p_id, v_prod.quantity_produced, COALESCE(v_prod.damaged_quantity, 0), 0, c);
    END IF;

  WHEN 'production_requests' THEN
    SELECT approval_status::text INTO s FROM production_requests WHERE id = p_id;
    IF s = 'pending' THEN
      SELECT COALESCE(full_name, email, 'Chairman') INTO v_name FROM profiles WHERE id = v_uid;
      PERFORM public.approve_production_request(p_id, v_name);
    END IF;

  WHEN 'customer_account_adjustments' THEN
    SELECT status::text INTO s FROM customer_account_adjustments WHERE id = p_id;
    IF s = ANY(v_pending) THEN PERFORM public.approve_customer_adjustment(p_id, c); END IF;

  WHEN 'production_corrections' THEN
    SELECT review_status::text INTO s FROM production_corrections WHERE id = p_id;
    IF s = 'pending' THEN PERFORM public.approve_production_correction(p_id, c); END IF;

  WHEN 'role_grant_requests' THEN
    SELECT status::text INTO s FROM role_grant_requests WHERE id = p_id;
    IF s = ANY(v_pending) THEN PERFORM public.approve_role_grant(p_id, c); SELECT status::text INTO s FROM role_grant_requests WHERE id = p_id; END IF;
    IF s = 'approved' THEN PERFORM public.post_role_grant(p_id, c); END IF;

  WHEN 'delete_requests' THEN
    SELECT review_status::text INTO s FROM delete_requests WHERE id = p_id;
    IF s = 'pending' THEN PERFORM public.approve_delete(p_id); END IF;

  WHEN 'sales' THEN
    SELECT status::text INTO s FROM sales WHERE id = p_id;
    IF s = ANY(v_pending) THEN PERFORM public.approve_sale(p_id, c); END IF;

  ELSE
    NULL;
  END CASE;
END;
$$;
REVOKE EXECUTE ON FUNCTION public._chairman_complete(text, uuid) FROM authenticated, PUBLIC;

-- Trigger body. TG_ARGV[0] is the column naming who initiated the record;
-- only records the signed-in chairman initiated themselves are completed.
CREATE OR REPLACE FUNCTION public._chairman_auto_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row jsonb := to_jsonb(NEW);
  v_err text;
BEGIN
  IF v_uid IS NULL OR (v_row ->> TG_ARGV[0]) IS DISTINCT FROM v_uid::text THEN RETURN NULL; END IF;
  IF NOT public.has_role(v_uid, 'chairman') THEN RETURN NULL; END IF;

  BEGIN
    PERFORM public._chairman_complete(TG_TABLE_NAME, (v_row ->> 'id')::uuid);
  EXCEPTION WHEN OTHERS THEN
    -- Keep the record (pending) rather than losing what was entered.
    v_err := SQLERRM;
    INSERT INTO notifications(user_id, factory_id, title, body)
    VALUES (v_uid, NULLIF(v_row ->> 'factory_id', '')::uuid,
            'Saved but not completed',
            format('Your %s entry was saved but could not be approved automatically: %s. It is waiting in Approvals.',
                   replace(TG_TABLE_NAME, '_', ' '), v_err));
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (v_uid, NULLIF(v_row ->> 'factory_id', '')::uuid, 'chairman_auto_approve_failed',
            TG_TABLE_NAME, v_row ->> 'id', jsonb_build_object('error', v_err));
  END;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public._chairman_auto_complete() FROM authenticated, PUBLIC;

-- Deferred to commit so multi-row creates (a sale and its items, a request
-- and its materials) are complete before anything is approved.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('expenses',                     'submitted_by',          'status'),
    ('debts',                        'writeoff_requested_by', 'writeoff_status'),
    ('payments_received',            'received_by',           'status'),
    ('payroll',                      'submitted_by',          'status'),
    ('staff_loans',                  'submitted_by',          'status'),
    ('staff_deductions',             'submitted_by',          'status'),
    ('stock_adjustment_requests',    'submitted_by',          'status'),
    ('costing_sheets',               'created_by',            'status'),
    ('raw_materials',                'created_by',            'approval_status'),
    ('goods_receipts',               'submitted_by',          'status'),
    ('production',                   'created_by',            'status'),
    ('production_requests',          'requested_by',          'approval_status'),
    ('customer_account_adjustments', 'submitted_by',          'status'),
    ('production_corrections',       'requested_by',          'review_status'),
    ('role_grant_requests',          'requested_by',          'status'),
    ('delete_requests',              'requested_by',          'review_status'),
    ('sales',                        'created_by',            'status')
  ) AS t(tbl, maker_col, status_col)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_chairman_auto_complete ON public.%I', r.tbl);
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER trg_chairman_auto_complete
         AFTER INSERT OR UPDATE OF %I ON public.%I
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION public._chairman_auto_complete(%L)',
      r.status_col, r.tbl, r.maker_col);
  END LOOP;
END $$;

-- ---------- 3. a chairman's approval satisfies any approval count ----------
CREATE OR REPLACE FUNCTION public.workflow_approval_progress(p_module public.module_key, p_entity_id uuid)
RETURNS TABLE(approvals_so_far int, required_approvals int, satisfied boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_required int; v_cycle_start timestamptz; v_count int; v_by_chairman boolean;
BEGIN
  SELECT wc.required_approvals INTO v_required FROM public.workflow_configs wc WHERE wc.module = p_module;
  v_required := COALESCE(v_required, 1);

  -- The review cycle restarts every time the entity re-enters a pending
  -- state (first submission, or resubmission after rejection) — only
  -- approvals recorded since that point count toward the current cycle.
  SELECT h.created_at INTO v_cycle_start FROM public.workflow_approval_history h
   WHERE h.module = p_module AND h.entity_id = p_entity_id
     AND h.to_status IN ('submitted','pending_review','pending_approval','pending_confirmation')
   ORDER BY h.created_at DESC LIMIT 1;

  SELECT COUNT(DISTINCT h.actor),
         COALESCE(bool_or(public.is_chairman_account(h.actor)), false)
    INTO v_count, v_by_chairman
    FROM public.workflow_approval_history h
   WHERE h.module = p_module AND h.entity_id = p_entity_id
     AND h.action IN ('approve','confirm')
     AND (v_cycle_start IS NULL OR h.created_at >= v_cycle_start);

  approvals_so_far := COALESCE(v_count, 0);
  required_approvals := v_required;
  satisfied := COALESCE(v_count, 0) >= v_required OR v_by_chairman;
  RETURN NEXT;
END;
$$;

-- ---------- 4. remaining super_admin-only checks include chairman ----------
CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.has_role(_user_id, 'super_admin') OR public.has_role(_user_id, 'chairman');
$$;

-- Patched in place from their live definitions (same technique as
-- 20260923190000), failing loudly if the expected text isn't there.
DO $$
DECLARE
  v_def text;
  v_new text;
  v_patch record;
BEGIN
  FOR v_patch IN SELECT * FROM (VALUES
    ('public.inspect_rep_return(uuid, jsonb, text)',
     $a$v_row.received_by = v_uid AND NOT public.has_role(v_uid, 'super_admin')$a$,
     $b$v_row.received_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman'))$b$)
  ) AS t(sig, old_text, new_text)
  LOOP
    v_def := pg_get_functiondef(v_patch.sig::regprocedure);
    v_new := replace(v_def, v_patch.old_text, v_patch.new_text);
    IF v_new = v_def THEN
      RAISE EXCEPTION 'Expected text not found in %', v_patch.sig;
    END IF;
    EXECUTE v_new;
  END LOOP;
END $$;
