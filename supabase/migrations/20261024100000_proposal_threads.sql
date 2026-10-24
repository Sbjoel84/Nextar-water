-- ============================================================================
-- Requests & Proposals: recipients + mail-style reply threads
-- ----------------------------------------------------------------------------
--   * The sender chooses who a request/proposal goes to (proposals.recipients).
--     Nobody chosen = every Chairman, as before.
--   * Everyone on it (sender, recipients, anyone who has replied) and the
--     Chairman can open it and reply. Each reply notifies everyone else on it.
--   * Deciding (approve/reject) stays with the Chairman.
-- ============================================================================

-- ============ 1. Recipients ============
ALTER TABLE public.proposals ADD COLUMN IF NOT EXISTS recipients uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.proposals ADD COLUMN IF NOT EXISTS recipient_names text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS proposals_recipients_idx ON public.proposals USING gin (recipients);

-- Existing requests went to every Chairman.
UPDATE public.proposals p SET
  recipients = c.ids,
  recipient_names = c.names
FROM (
  SELECT array_agg(pr.id ORDER BY pr.full_name) AS ids,
         array_agg(COALESCE(pr.full_name, pr.email, 'Chairman') ORDER BY pr.full_name) AS names
    FROM profiles pr
   WHERE pr.id IN (SELECT user_id FROM user_roles WHERE role = 'chairman')
) c
WHERE cardinality(p.recipients) = 0 AND c.ids IS NOT NULL;

DROP POLICY IF EXISTS "proposals read" ON public.proposals;
-- Sender and recipients see theirs; the chairman (decides) and super_admin
-- (oversight) see all.
CREATE POLICY "proposals read" ON public.proposals FOR SELECT TO authenticated
  USING (
    requested_by = auth.uid()
    OR auth.uid() = ANY (recipients)
    OR public.has_role(auth.uid(), 'chairman')
    OR public.has_role(auth.uid(), 'super_admin')
  );

-- ============ 2. Reply thread ============
CREATE TABLE IF NOT EXISTS public.proposal_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES public.proposals(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES auth.users(id),
  author_name text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proposal_messages_proposal_idx
  ON public.proposal_messages(proposal_id, created_at);
GRANT SELECT ON public.proposal_messages TO authenticated;
GRANT ALL ON public.proposal_messages TO service_role;
ALTER TABLE public.proposal_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "proposal messages read" ON public.proposal_messages;
-- Readable by whoever can read the proposal (its own policy applies here).
CREATE POLICY "proposal messages read" ON public.proposal_messages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.proposals p WHERE p.id = proposal_id));
-- No INSERT/UPDATE/DELETE policy: RPC-only.

-- ============ 3. Who a request can be sent to ============
-- Active users of the factory (other than the caller), with their role labels.
CREATE OR REPLACE FUNCTION public.list_message_recipients(p_factory uuid)
RETURNS TABLE(id uuid, full_name text, roles text, is_chairman boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id,
         COALESCE(p.full_name, p.email, 'Unnamed user'),
         COALESCE(string_agg(DISTINCT COALESCE(r.label, ur.role::text), ', '), ''),
         bool_or(ur.role::text = 'chairman') IS TRUE
    FROM profiles p
    LEFT JOIN user_roles ur ON ur.user_id = p.id
    LEFT JOIN roles r ON r.slug = ur.role::text
   WHERE auth.uid() IS NOT NULL
     AND p.id <> auth.uid()
     AND p.status = 'active'
     AND (p.active_factory_id = p_factory
          OR EXISTS (SELECT 1 FROM user_roles x
                      WHERE x.user_id = p.id AND (x.factory_id = p_factory OR x.factory_id IS NULL)))
   GROUP BY p.id, p.full_name, p.email
   ORDER BY bool_or(ur.role::text = 'chairman') IS TRUE DESC, 2;
$$;
GRANT EXECUTE ON FUNCTION public.list_message_recipients(uuid) TO authenticated;

-- ============ 4. submit_proposal(): send to the chosen recipients ============
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
  v_wanted uuid[];
  v_recipients uuid[];
  v_names text[];
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

  SELECT array_agg(DISTINCT x::uuid) INTO v_wanted
    FROM jsonb_array_elements_text(COALESCE(payload->'recipients', '[]'::jsonb)) x;
  -- Nobody chosen: every Chairman.
  IF v_wanted IS NULL THEN
    SELECT array_agg(DISTINCT user_id) INTO v_wanted FROM user_roles WHERE role = 'chairman';
  END IF;
  SELECT array_agg(p.id ORDER BY p.full_name),
         array_agg(COALESCE(p.full_name, p.email, 'Unnamed user') ORDER BY p.full_name)
    INTO v_recipients, v_names
    FROM profiles p
   WHERE p.id = ANY (COALESCE(v_wanted, '{}')) AND p.id <> v_uid AND p.status = 'active';
  IF v_recipients IS NULL THEN RAISE EXCEPTION 'Choose who to send it to'; END IF;

  -- Sequential reference per factory and year: PRP-2026-0001, ...
  PERFORM pg_advisory_xact_lock(hashtext('proposal:' || v_factory::text));
  SELECT 'PRP-' || to_char(now(), 'YYYY') || '-' || lpad((count(*) + 1)::text, 4, '0')
    INTO v_ref
    FROM proposals
   WHERE factory_id = v_factory AND reference LIKE 'PRP-' || to_char(now(), 'YYYY') || '-%';

  INSERT INTO proposals(factory_id, reference, kind, title, details, amount, priority,
                        requested_by, requested_by_name, recipients, recipient_names)
  VALUES (v_factory, v_ref, v_kind, v_title, v_details, v_amount, v_priority, v_uid, v_name,
          v_recipients, v_names)
  RETURNING id INTO v_id;

  -- One notification per recipient; cleared when the request is decided or withdrawn.
  INSERT INTO notifications(user_id, factory_id, title, body)
  SELECT r, v_factory,
         CASE WHEN public.has_role(r, 'chairman')
              THEN initcap(v_kind) || ' awaiting your review'
              ELSE initcap(v_kind) || ' sent to you' END,
         v_ref || ' — ' || v_title || ' (from ' || COALESCE(v_name, 'Operations Manager') || ')'
    FROM unnest(v_recipients) r;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'submit_proposal', 'proposals', v_id::text,
          jsonb_build_object('reference', v_ref, 'kind', v_kind, 'title', v_title,
                             'amount', v_amount, 'priority', v_priority,
                             'recipients', to_jsonb(v_names)));
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref, 'recipients', to_jsonb(v_names));
END;
$$;
GRANT EXECUTE ON FUNCTION public.submit_proposal(jsonb) TO authenticated;

-- Clears the "awaiting your review" / "sent to you" notifications for a reference.
CREATE OR REPLACE FUNCTION public.resolve_proposal_notifications(p_ref text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE notifications SET resolved_at = now()
   WHERE resolved_at IS NULL
     AND title IN ('Proposal awaiting your review', 'Request awaiting your review',
                   'Proposal sent to you', 'Request sent to you')
     AND left(body, length(p_ref || ' —')) = p_ref || ' —';
$$;
REVOKE ALL ON FUNCTION public.resolve_proposal_notifications(text) FROM PUBLIC, anon, authenticated;

-- ============ 5. reply_proposal() ============
CREATE OR REPLACE FUNCTION public.reply_proposal(p_id uuid, p_body text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row proposals%ROWTYPE;
  v_body text := btrim(COALESCE(p_body, ''));
  v_name text;
  v_msg uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in to reply'; END IF;
  IF v_body = '' THEN RAISE EXCEPTION 'Write a reply'; END IF;
  SELECT * INTO v_row FROM proposals WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF NOT (v_row.requested_by = v_uid
          OR v_uid = ANY (v_row.recipients)
          OR public.has_role(v_uid, 'chairman')
          OR EXISTS (SELECT 1 FROM proposal_messages WHERE proposal_id = p_id AND author_id = v_uid)) THEN
    RAISE EXCEPTION 'You are not on this request';
  END IF;
  IF v_row.status = 'cancelled' THEN RAISE EXCEPTION 'This request was withdrawn'; END IF;
  SELECT full_name INTO v_name FROM profiles WHERE id = v_uid;

  INSERT INTO proposal_messages(proposal_id, author_id, author_name, body)
  VALUES (p_id, v_uid, v_name, v_body)
  RETURNING id INTO v_msg;

  -- Everyone else on the thread hears about it.
  INSERT INTO notifications(user_id, factory_id, title, body)
  SELECT u, v_row.factory_id,
         'New reply on ' || v_row.reference,
         COALESCE(v_name, 'Someone') || ': ' || left(v_body, 140)
           || CASE WHEN length(v_body) > 140 THEN '…' ELSE '' END
    FROM (
      SELECT v_row.requested_by AS u
      UNION SELECT unnest(v_row.recipients)
      UNION SELECT author_id FROM proposal_messages WHERE proposal_id = p_id
    ) people
   WHERE u IS DISTINCT FROM v_uid;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'reply_proposal', 'proposals', p_id::text,
          jsonb_build_object('reference', v_row.reference, 'message_id', v_msg));
  RETURN jsonb_build_object('id', v_msg);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reply_proposal(uuid, text) TO authenticated;

-- ============ 6. Live updates ============
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'proposal_messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.proposal_messages;
  END IF;
END $$;
