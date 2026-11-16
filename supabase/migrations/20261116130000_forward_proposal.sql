-- Requests & Proposals: forward to more people.
--
-- Anyone on a request (sender, recipients, anyone who has replied) or the
-- Chairman can forward it to other active users of the factory. They are
-- added to proposals.recipients, so they can open it and reply; a line in the
-- thread records who forwarded it to whom (with an optional note); the new
-- people get a notification. Deciding stays with the Chairman.

CREATE OR REPLACE FUNCTION public.forward_proposal(p_id uuid, p_recipients uuid[], p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row proposals%ROWTYPE;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_name text;
  v_new uuid[];
  v_new_names text[];
  v_msg uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in to forward'; END IF;
  SELECT * INTO v_row FROM proposals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF NOT (v_row.requested_by = v_uid
          OR v_uid = ANY (v_row.recipients)
          OR public.has_role(v_uid, 'chairman')
          OR EXISTS (SELECT 1 FROM proposal_messages WHERE proposal_id = p_id AND author_id = v_uid)) THEN
    RAISE EXCEPTION 'You are not on this request';
  END IF;
  IF v_row.status = 'cancelled' THEN RAISE EXCEPTION 'This request was withdrawn'; END IF;

  -- Only active people not already on it (and not the sender or yourself).
  SELECT array_agg(p.id ORDER BY p.full_name),
         array_agg(COALESCE(p.full_name, p.email, 'Unnamed user') ORDER BY p.full_name)
    INTO v_new, v_new_names
    FROM profiles p
   WHERE p.id = ANY (COALESCE(p_recipients, '{}'))
     AND p.status = 'active'
     AND p.id <> v_uid
     AND p.id <> v_row.requested_by
     AND NOT (p.id = ANY (v_row.recipients));
  IF v_new IS NULL THEN RAISE EXCEPTION 'Choose someone who is not already on this request'; END IF;

  UPDATE proposals
     SET recipients = recipients || v_new,
         recipient_names = recipient_names || v_new_names
   WHERE id = p_id;

  SELECT full_name INTO v_name FROM profiles WHERE id = v_uid;
  INSERT INTO proposal_messages(proposal_id, author_id, author_name, body)
  VALUES (p_id, v_uid, v_name,
          'Forwarded to ' || array_to_string(v_new_names, ', ')
          || CASE WHEN v_note IS NOT NULL THEN E'\n\n' || v_note ELSE '' END)
  RETURNING id INTO v_msg;

  INSERT INTO notifications(user_id, factory_id, title, body)
  SELECT u, v_row.factory_id,
         initcap(v_row.kind) || ' forwarded to you',
         v_row.reference || ' — ' || v_row.title || ' (forwarded by ' || COALESCE(v_name, 'someone') || ')'
    FROM unnest(v_new) u;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'forward_proposal', 'proposals', p_id::text,
          jsonb_build_object('reference', v_row.reference, 'forwarded_to', to_jsonb(v_new_names),
                             'message_id', v_msg));
  RETURN jsonb_build_object('id', p_id, 'forwarded_to', to_jsonb(v_new_names));
END;
$$;
REVOKE ALL ON FUNCTION public.forward_proposal(uuid, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forward_proposal(uuid, uuid[], text) TO authenticated;
