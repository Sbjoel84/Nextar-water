-- ============================================================================
-- FIX (again): "function public.has_permission(uuid, unknown, action_key) is
-- not unique" when confirming a production batch at the Store.
-- ----------------------------------------------------------------------------
-- 20260925110000 rewrote every function that passed has_permission() a bare
-- module literal, but functions (re)defined AFTER it reintroduced the pattern:
--   * confirm_production (20260928090000) -> 'production'
--   * production-request approve/confirm RPCs (20260925120000)
--     -> 'production-requests'
-- Re-run the same generic rewrite so every such call in the live database
-- casts the module literal to public.module_key.
-- ============================================================================
DO $$
DECLARE
  r record;
  v_def text;
  v_new text;
  v_count int := 0;
BEGIN
  FOR r IN
    SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.prosrc ~ 'has_permission\(\s*[^,()]+,\s*''[a-z-]+''\s*,\s*''[a-z_]+''::(public\.)?action_key'
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(
      v_def,
      'has_permission\((\s*[^,()]+,\s*)(''[a-z-]+'')(\s*,\s*''[a-z_]+''::(?:public\.)?action_key)',
      'has_permission(\1\2::public.module_key\3',
      'g'
    );
    IF v_new IS DISTINCT FROM v_def THEN
      EXECUTE v_new;
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'has_permission ambiguity fix: rewrote % function(s)', v_count;
END $$;
