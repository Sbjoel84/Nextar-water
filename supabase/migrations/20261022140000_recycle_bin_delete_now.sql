-- ============================================================================
-- Recycle bin: delete permanently NOW, without waiting for the 30 days.
-- ----------------------------------------------------------------------------
-- The purge body moves into _purge_recycle_bin_items(p_id, p_force):
--   p_id    NULL = every entry, otherwise just that one entry
--   p_force true = ignore purge_after (delete now); false = expired only
-- _purge_recycle_bin() (the automatic 30-day clean-up) keeps its behaviour by
-- calling it with (NULL, false). The body is otherwise unchanged from
-- 20260930090000_recycle_bin_and_customer_delete.sql.
--
-- purge_recycle_bin_now(p_id) is the new admin-only button: one item, or the
-- whole bin when p_id is NULL. Like the automatic purge it returns the
-- Storage files to remove, which the client deletes (src/lib/recycle-bin.ts).
-- ============================================================================

CREATE OR REPLACE FUNCTION public._purge_recycle_bin_items(p_id uuid, p_force boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r recycle_bin%ROWTYPE;
  v_files jsonb := '[]'::jsonb;
  v_purged int := 0;
  v_skipped int := 0;
BEGIN
  PERFORM set_config('app.recycle_purge', 'on', true);

  FOR r IN SELECT * FROM recycle_bin
            WHERE (p_id IS NULL OR id = p_id)
              AND (p_force OR purge_after <= now())
            ORDER BY deleted_at LOOP
    BEGIN
      IF r.table_name = 'sales' AND r.mode = 'soft' THEN
        -- Payments stay (their value went to customer credit); they just
        -- lose the link to the sale that no longer exists.
        UPDATE payments_received SET sale_id = NULL WHERE sale_id = r.entity_id;
        UPDATE sales_returns SET sale_id = NULL WHERE sale_id = r.entity_id;
        UPDATE deliveries SET sale_id = NULL WHERE sale_id = r.entity_id;
        UPDATE debts SET sale_id = NULL WHERE sale_id = r.entity_id;
        DELETE FROM sales WHERE id = r.entity_id;

      ELSIF r.table_name = 'customers' AND r.mode = 'soft' THEN
        DELETE FROM customer_account_transactions WHERE customer_id = r.entity_id;
        DELETE FROM customer_account_adjustments WHERE customer_id = r.entity_id;
        DELETE FROM sales_returns WHERE deleted_bin_id = r.id;
        DELETE FROM payments_received WHERE deleted_bin_id = r.id;
        DELETE FROM debts WHERE deleted_bin_id = r.id;
        DELETE FROM deliveries WHERE deleted_bin_id = r.id;
        DELETE FROM sales WHERE deleted_bin_id = r.id;
        -- Anything else still naming this customer (e.g. a sale that was
        -- deleted on its own earlier) keeps its record, minus the link.
        UPDATE sales SET customer_id = NULL WHERE customer_id = r.entity_id;
        UPDATE payments_received SET customer_id = NULL WHERE customer_id = r.entity_id;
        UPDATE debts SET customer_id = NULL WHERE customer_id = r.entity_id;
        UPDATE sales_returns SET customer_id = NULL WHERE customer_id = r.entity_id;
        DELETE FROM customers WHERE id = r.entity_id;
      END IF;
      -- 'snapshot' entries: the record is already gone; only the bin entry
      -- (and any Storage file, returned below) remains.

      v_files := v_files || r.files;
      DELETE FROM recycle_bin WHERE id = r.id;
      v_purged := v_purged + 1;
    EXCEPTION WHEN foreign_key_violation OR not_null_violation THEN
      -- Something unexpected still depends on it; keep it and try next time.
      v_skipped := v_skipped + 1;
    END;
  END LOOP;

  PERFORM set_config('app.recycle_purge', 'off', true);
  RETURN jsonb_build_object('purged', v_purged, 'skipped', v_skipped, 'files', v_files);
END;
$function$;
REVOKE ALL ON FUNCTION public._purge_recycle_bin_items(uuid, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._purge_recycle_bin()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public._purge_recycle_bin_items(NULL, false);
END;
$function$;
REVOKE ALL ON FUNCTION public._purge_recycle_bin() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.purge_recycle_bin_now(p_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')) THEN
    RAISE EXCEPTION 'Only an admin can permanently delete from the recycle bin';
  END IF;
  IF p_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM recycle_bin WHERE id = p_id) THEN
    RAISE EXCEPTION 'That item is no longer in the recycle bin';
  END IF;

  v_result := public._purge_recycle_bin_items(p_id, true);

  INSERT INTO audit_logs(user_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), 'purge_recycle_bin_now', 'recycle_bin', COALESCE(p_id::text, 'all'),
          jsonb_build_object('purged', v_result->'purged', 'skipped', v_result->'skipped'));
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.purge_recycle_bin_now(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_recycle_bin_now(uuid) TO authenticated;
