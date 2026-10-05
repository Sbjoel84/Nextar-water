-- ============================================================================
-- UNIVERSAL ACTIVITY TRAIL — every insert / update / delete gets a traceable ID
-- ----------------------------------------------------------------------------
-- Until now audit_logs only held what the app (logAudit) or a handful of RPCs
-- chose to write, so many changes — and most deletions — left no trace once
-- the row was gone.
--
-- This attaches one generic AFTER trigger to every business table in public
-- that has an `id` column. Each change writes an audit_logs row with:
--   action    = record_created | record_updated | record_deleted
--   entity    = the table name
--   entity_id = the record's id  (the "transaction ID" shown in the UI as
--                                 the first 8 characters, e.g. #A1B2C3D4)
--   old_value = the full row before the change (update / delete)
--   new_value = the full row (insert) or only the changed columns (update)
-- so a deleted record can still be found in Audit Logs by its ID or its name.
--
-- Skipped: audit_logs itself, notifications (+ reads), recycle_bin (the
-- original row's own delete/soft-delete is already logged) and rep_stock
-- (a running balance; every rep_stock_movements row is logged instead).
-- Updates that only touch housekeeping columns (updated_at, last_* timestamps)
-- are ignored.
--
-- Safe to re-run: the trigger is dropped and re-created on each table.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_diff jsonb;
  v_row jsonb;
  v_ignore text[] := ARRAY['updated_at', 'last_login_at', 'last_seen_at',
                           'last_sign_in_at', 'last_active_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_row := v_new;
  ELSIF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    v_row := to_jsonb(NEW);
    SELECT COALESCE(jsonb_object_agg(n.key, n.value), '{}'::jsonb)
      INTO v_diff
      FROM jsonb_each(v_row) n
     WHERE n.value IS DISTINCT FROM v_old -> n.key
       AND NOT (n.key = ANY (v_ignore));
    IF v_diff = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
    v_new := v_diff;
  ELSE
    v_old := to_jsonb(OLD);
    v_row := v_old;
  END IF;

  BEGIN
    INSERT INTO public.audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (
      auth.uid(),
      CASE WHEN TG_TABLE_NAME = 'factories' THEN (v_row ->> 'id')::uuid
           ELSE NULLIF(v_row ->> 'factory_id', '')::uuid END,
      CASE TG_OP WHEN 'INSERT' THEN 'record_created'
                 WHEN 'UPDATE' THEN 'record_updated'
                 ELSE 'record_deleted' END,
      TG_TABLE_NAME,
      v_row ->> 'id',
      v_old,
      v_new
    );
  EXCEPTION WHEN OTHERS THEN
    -- The trail must never block the change it describes (e.g. a factory
    -- being deleted, so its id no longer satisfies the factory_id FK).
    RAISE WARNING 'audit_row_change(%): %', TG_TABLE_NAME, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_row_change() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'id'
       AND tb.table_type = 'BASE TABLE'
       AND c.table_name NOT IN ('audit_logs', 'notifications', 'notification_reads',
                                'recycle_bin', 'rep_stock')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_row_change ON public.%I', t.table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_row_change AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.audit_row_change()',
      t.table_name);
  END LOOP;
END $$;

-- Tracing a record means looking it up by entity_id (prefix match on the
-- short ID) across a growing table.
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_id
  ON public.audit_logs (entity_id text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON public.audit_logs (created_at DESC);
