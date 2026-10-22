-- ============================================================================
-- Updates & Requests page
-- ----------------------------------------------------------------------------
--   * Updates: factory-wide announcements. Posting one also drops a broadcast
--     notification in everyone's bell.
--   * Notifications: the page lists the same notifications as the bell.
--   * Requests & Proposals: an Operations Manager sends a request or proposal;
--     the Chairman approves or rejects it (with a comment). The chairman is
--     notified of each new one, and the sender of the decision.
--
-- New module 'updates' (page access + actions):
--   view    -- open the page (every role)
--   create  -- post updates (manager, operations_manager; admins always can)
--   submit  -- send requests/proposals (operations_manager)
--   cancel  -- withdraw your own pending request (operations_manager)
-- Deciding is the Chairman's alone (has_role 'chairman'), not a grantable
-- permission. Super Admin can read every request but not decide.
-- ============================================================================

-- ============ 1. module_key: add 'updates' ============
ALTER DOMAIN public.module_key DROP CONSTRAINT module_key_check;
ALTER DOMAIN public.module_key ADD CONSTRAINT module_key_check CHECK (VALUE IN (
  'dashboard','sales','production','production-requests','purchase-orders','raw-materials','finished-goods',
  'finance','inventory','expenses','payroll','payments','receipts-payments','cash-flow','debts',
  'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
  'settings','costing','logistics','approvals','goods-receiving','distribution','sales-returns',
  'updates'
));

-- ============ 2. get_my_permissions(): surface the new module to the UI ============
CREATE OR REPLACE FUNCTION public.get_my_permissions()
 RETURNS TABLE(module module_key, action action_key)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_module public.module_key;
  v_action public.action_key;
  v_modules public.module_key[] := ARRAY[
    'dashboard','sales','production','production-requests','purchase-orders','raw-materials','finished-goods',
    'finance','expenses','payroll','payments','receipts-payments','cash-flow','debts',
    'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
    'settings','costing','logistics','approvals','goods-receiving','distribution','sales-returns',
    'updates'
  ]::public.module_key[];
  v_concrete_actions public.action_key[] := ARRAY[
    'view','create','edit','submit','approve','reject','confirm','post','reverse','cancel','export','print','delete'
  ]::public.action_key[];
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  IF public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman') THEN
    FOREACH v_module IN ARRAY v_modules LOOP
      FOREACH v_action IN ARRAY v_concrete_actions LOOP
        module := v_module; action := v_action; RETURN NEXT;
      END LOOP;
    END LOOP;
    RETURN;
  END IF;
  FOREACH v_module IN ARRAY v_modules LOOP
    FOREACH v_action IN ARRAY v_concrete_actions LOOP
      IF public.has_permission(v_uid, v_module, v_action) THEN
        module := v_module; action := v_action; RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
  RETURN;
END;
$function$;

-- ============ 3. Operations Manager role + default grants ============
INSERT INTO public.roles (slug, label, is_system) VALUES
  ('operations_manager', 'Operations Manager', true)
ON CONFLICT (slug) DO NOTHING;

-- Every role can open the page (updates + their own notifications).
INSERT INTO public.role_permissions (role, module, action)
SELECT slug, 'updates', 'view' FROM public.roles
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role, module, action)
SELECT 'operations_manager', 'updates', a FROM unnest(ARRAY['create','submit','cancel']::action_key[]) a
UNION ALL
SELECT 'manager', 'updates', 'create'::action_key
ON CONFLICT DO NOTHING;

-- ============ 4. Updates (announcements) ============
CREATE TABLE IF NOT EXISTS public.updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  posted_by uuid REFERENCES auth.users(id),
  posted_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS updates_factory_idx ON public.updates(factory_id, created_at DESC);
GRANT SELECT ON public.updates TO authenticated;
GRANT ALL ON public.updates TO service_role;
ALTER TABLE public.updates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "updates read" ON public.updates;
CREATE POLICY "updates read" ON public.updates FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'updates'::module_key, 'view'::action_key));
-- No INSERT/UPDATE/DELETE policy: RPC-only.

CREATE OR REPLACE FUNCTION public.post_update(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := NULLIF(payload->>'factory_id', '')::uuid;
  v_title text := btrim(COALESCE(payload->>'title', ''));
  v_body text := btrim(COALESCE(payload->>'body', ''));
  v_name text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'updates'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'Factory is required'; END IF;
  IF v_title = '' THEN RAISE EXCEPTION 'Enter a title'; END IF;
  IF v_body = '' THEN RAISE EXCEPTION 'Enter the update'; END IF;
  SELECT full_name INTO v_name FROM profiles WHERE id = v_uid;

  INSERT INTO updates(factory_id, title, body, pinned, posted_by, posted_by_name)
  VALUES (v_factory, v_title, v_body, COALESCE((payload->>'pinned')::boolean, false), v_uid, v_name)
  RETURNING id INTO v_id;

  -- Broadcast to the factory's bell (user_id NULL = everyone).
  INSERT INTO notifications(user_id, factory_id, title, body)
  VALUES (NULL, v_factory, 'Update: ' || v_title,
          left(v_body, 160) || CASE WHEN length(v_body) > 160 THEN '…' ELSE '' END);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'post_update', 'updates', v_id::text,
          jsonb_build_object('title', v_title));
  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.post_update(jsonb) TO authenticated;

-- The author, a super_admin or the chairman can remove an update.
CREATE OR REPLACE FUNCTION public.delete_update(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row updates%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM updates WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Update not found'; END IF;
  IF v_row.posted_by IS DISTINCT FROM v_uid
     AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only the author or an admin can remove this update';
  END IF;
  DELETE FROM updates WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value)
  VALUES (v_uid, v_row.factory_id, 'delete_update', 'updates', p_id::text,
          jsonb_build_object('title', v_row.title, 'body', v_row.body));
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_update(uuid) TO authenticated;

-- ============ 5. Requests & Proposals ============
CREATE TABLE IF NOT EXISTS public.proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  reference text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('request', 'proposal')),
  title text NOT NULL,
  details text NOT NULL,
  amount numeric(14,2) CHECK (amount IS NULL OR amount >= 0),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  requested_by_name text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES auth.users(id),
  decided_by_name text,
  decided_at timestamptz,
  decision_comment text
);
CREATE INDEX IF NOT EXISTS proposals_factory_idx ON public.proposals(factory_id, requested_at DESC);
GRANT SELECT ON public.proposals TO authenticated;
GRANT ALL ON public.proposals TO service_role;
ALTER TABLE public.proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "proposals read" ON public.proposals;
-- The sender sees their own; the chairman (decides) and super_admin (oversight) see all.
CREATE POLICY "proposals read" ON public.proposals FOR SELECT TO authenticated
  USING (
    requested_by = auth.uid()
    OR public.has_role(auth.uid(), 'chairman')
    OR public.has_role(auth.uid(), 'super_admin')
  );
-- No INSERT/UPDATE/DELETE policy: RPC-only.

CREATE OR REPLACE FUNCTION public.submit_proposal(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := NULLIF(payload->>'factory_id', '')::uuid;
  v_kind text := COALESCE(NULLIF(payload->>'kind', ''), 'request');
  v_title text := btrim(COALESCE(payload->>'title', ''));
  v_details text := btrim(COALESCE(payload->>'details', ''));
  v_amount numeric := NULLIF(payload->>'amount', '')::numeric;
  v_priority text := COALESCE(NULLIF(payload->>'priority', ''), 'normal');
  v_name text;
  v_ref text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'updates'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'Factory is required'; END IF;
  IF v_title = '' THEN RAISE EXCEPTION 'Enter a title'; END IF;
  IF v_details = '' THEN RAISE EXCEPTION 'Describe the request or proposal'; END IF;
  SELECT full_name INTO v_name FROM profiles WHERE id = v_uid;

  -- Sequential reference per factory and year: PRP-2026-0001, ...
  PERFORM pg_advisory_xact_lock(hashtext('proposal:' || v_factory::text));
  SELECT 'PRP-' || to_char(now(), 'YYYY') || '-' || lpad((count(*) + 1)::text, 4, '0')
    INTO v_ref
    FROM proposals
   WHERE factory_id = v_factory AND reference LIKE 'PRP-' || to_char(now(), 'YYYY') || '-%';

  INSERT INTO proposals(factory_id, reference, kind, title, details, amount, priority,
                        requested_by, requested_by_name)
  VALUES (v_factory, v_ref, v_kind, v_title, v_details, v_amount, v_priority, v_uid, v_name)
  RETURNING id INTO v_id;

  -- One notification per chairman; cleared when the request is decided or withdrawn.
  INSERT INTO notifications(user_id, factory_id, title, body)
  SELECT DISTINCT ur.user_id, v_factory,
         CASE WHEN v_kind = 'proposal' THEN 'Proposal awaiting your review'
              ELSE 'Request awaiting your review' END,
         v_ref || ' — ' || v_title || ' (from ' || COALESCE(v_name, 'Operations Manager') || ')'
    FROM user_roles ur
   WHERE ur.role = 'chairman';

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'submit_proposal', 'proposals', v_id::text,
          jsonb_build_object('reference', v_ref, 'kind', v_kind, 'title', v_title,
                             'amount', v_amount, 'priority', v_priority));
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref);
END;
$$;
GRANT EXECUTE ON FUNCTION public.submit_proposal(jsonb) TO authenticated;

-- Clears the chairman's "awaiting your review" notifications for a reference.
CREATE OR REPLACE FUNCTION public.resolve_proposal_notifications(p_ref text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE notifications SET resolved_at = now()
   WHERE resolved_at IS NULL
     AND title IN ('Proposal awaiting your review', 'Request awaiting your review')
     AND left(body, length(p_ref || ' —')) = p_ref || ' —';
$$;
REVOKE ALL ON FUNCTION public.resolve_proposal_notifications(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.decide_proposal(p_id uuid, p_decision text, p_comment text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row proposals%ROWTYPE;
  v_name text;
  v_comment text := NULLIF(btrim(COALESCE(p_comment, '')), '');
BEGIN
  IF NOT public.has_role(v_uid, 'chairman') THEN
    RAISE EXCEPTION 'Only the Chairman can approve or reject requests and proposals';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Invalid decision'; END IF;
  IF p_decision = 'rejected' AND v_comment IS NULL THEN
    RAISE EXCEPTION 'Give a reason for rejecting';
  END IF;
  SELECT * INTO v_row FROM proposals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'This request is already %', v_row.status; END IF;
  SELECT full_name INTO v_name FROM profiles WHERE id = v_uid;

  UPDATE proposals SET
    status = p_decision, decided_by = v_uid, decided_by_name = v_name,
    decided_at = now(), decision_comment = v_comment
  WHERE id = p_id;

  PERFORM public.resolve_proposal_notifications(v_row.reference);
  INSERT INTO notifications(user_id, factory_id, title, body)
  VALUES (v_row.requested_by, v_row.factory_id,
          initcap(v_row.kind) || ' ' || p_decision || ' by the Chairman',
          v_row.reference || ' — ' || v_row.title || COALESCE(': ' || v_comment, ''));

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id,
          CASE WHEN p_decision = 'approved' THEN 'approve_proposal' ELSE 'reject_proposal' END,
          'proposals', p_id::text, jsonb_build_object('status', v_row.status),
          jsonb_build_object('status', p_decision, 'comment', v_comment));
END;
$$;
GRANT EXECUTE ON FUNCTION public.decide_proposal(uuid, text, text) TO authenticated;

-- The sender can withdraw their own request while it is still pending.
CREATE OR REPLACE FUNCTION public.cancel_proposal(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row proposals%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM proposals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_row.requested_by <> v_uid THEN RAISE EXCEPTION 'You can only withdraw your own requests'; END IF;
  IF NOT public.has_permission(v_uid, 'updates'::module_key, 'cancel'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'This request is already %', v_row.status; END IF;

  UPDATE proposals SET status = 'cancelled', decided_at = now() WHERE id = p_id;
  PERFORM public.resolve_proposal_notifications(v_row.reference);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'cancel_proposal', 'proposals', p_id::text,
          jsonb_build_object('status', 'cancelled'));
END;
$$;
GRANT EXECUTE ON FUNCTION public.cancel_proposal(uuid) TO authenticated;

-- ============ 6. Live updates ============
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'updates') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.updates;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'proposals') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.proposals;
  END IF;
END $$;
