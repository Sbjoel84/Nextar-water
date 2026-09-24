-- ============================================================================
-- NOTIFICATIONS — clear approval requests once someone has acted on them
-- ----------------------------------------------------------------------------
-- Two notifications ask an approver to act:
--   * 'Stock adjustment awaiting approval' — one row per request with
--     user_id NULL (a broadcast to the whole factory);
--   * 'Deletion requested' — one row per super_admin/chairman.
-- Neither was ever cleared when another approver approved/rejected the
-- request, so every other approver kept seeing it. Worse, a broadcast row
-- could never be marked read: the UPDATE policy only matches user_id =
-- auth.uid(), so "mark all read" silently skipped it and it stayed in the
-- bell's unread count forever.
--
-- This:
--   1. adds notifications.resolved_at and hides resolved rows from everyone
--      (SELECT policy), so no frontend change is needed for the clearing;
--   2. resolves an approval notification as soon as its request leaves the
--      pending state (triggers on stock_adjustment_requests/delete_requests),
--      and back-fills the ones already stale;
--   3. adds per-user read state for broadcast rows (notification_reads) and
--      mark_notifications_read(ids) so opening the bell clears them too.
-- ============================================================================

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

DROP POLICY IF EXISTS "read own notifications" ON public.notifications;
CREATE POLICY "read own notifications" ON public.notifications FOR SELECT TO anon, authenticated
  USING ((user_id = auth.uid() OR user_id IS NULL) AND resolved_at IS NULL);

-- ============ per-user read state for broadcast notifications ============
CREATE TABLE IF NOT EXISTS public.notification_reads (
  notification_id uuid NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);
GRANT SELECT ON public.notification_reads TO authenticated;
GRANT ALL ON public.notification_reads TO service_role;
ALTER TABLE public.notification_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read own notification reads" ON public.notification_reads;
CREATE POLICY "read own notification reads" ON public.notification_reads FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  UPDATE notifications SET read = true WHERE id = ANY(p_ids) AND user_id = v_uid;
  INSERT INTO notification_reads(notification_id, user_id)
  SELECT id, v_uid FROM notifications WHERE id = ANY(p_ids) AND user_id IS NULL
  ON CONFLICT DO NOTHING;
END;
$$;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid[]) TO authenticated;

-- ============ resolve approval notifications whose request is no longer pending ============
-- Matches on the text the request RPCs write (the notification rows carry no
-- foreign key): stock adjustments start with the request's reference number,
-- deletion requests with '<Table> "<label>"'.
CREATE OR REPLACE FUNCTION public.resolve_stale_approval_notifications()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notifications n SET resolved_at = now()
  WHERE n.resolved_at IS NULL
    AND n.title = 'Stock adjustment awaiting approval'
    AND NOT EXISTS (
      SELECT 1 FROM stock_adjustment_requests s
      WHERE s.status = 'pending_approval'
        AND s.reference_number IS NOT NULL
        AND s.factory_id IS NOT DISTINCT FROM n.factory_id
        AND left(n.body, length(s.reference_number || ' —')) = s.reference_number || ' —');

  UPDATE notifications n SET resolved_at = now()
  WHERE n.resolved_at IS NULL
    AND n.title = 'Deletion requested'
    AND NOT EXISTS (
      SELECT 1 FROM delete_requests d
      WHERE d.review_status = 'pending'
        AND d.factory_id IS NOT DISTINCT FROM n.factory_id
        AND left(n.body, length(initcap(replace(d.table_name, '_', ' ')) || ' "' || d.entity_label || '"'))
            = initcap(replace(d.table_name, '_', ' ')) || ' "' || d.entity_label || '"');
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_resolve_approval_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.resolve_stale_approval_notifications();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS resolve_notifications_on_stock_adjustment ON public.stock_adjustment_requests;
CREATE TRIGGER resolve_notifications_on_stock_adjustment
AFTER UPDATE OF status OR DELETE ON public.stock_adjustment_requests
FOR EACH STATEMENT EXECUTE FUNCTION public.trg_resolve_approval_notifications();

DROP TRIGGER IF EXISTS resolve_notifications_on_delete_request ON public.delete_requests;
CREATE TRIGGER resolve_notifications_on_delete_request
AFTER UPDATE OF review_status OR DELETE ON public.delete_requests
FOR EACH STATEMENT EXECUTE FUNCTION public.trg_resolve_approval_notifications();

-- Clear everything that is already stale.
SELECT public.resolve_stale_approval_notifications();

-- Live updates for the bell, so a notification disappears for every approver
-- the moment one of them acts, not on the next 60s poll.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END $$;

-- A resolved notification is hidden by RLS, so its UPDATE event isn't
-- delivered to other approvers; the bell also listens on delete_requests.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'delete_requests') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.delete_requests;
  END IF;
END $$;
