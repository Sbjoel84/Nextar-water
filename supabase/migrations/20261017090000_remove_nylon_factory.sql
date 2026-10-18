-- ============================================================================
-- REMOVE THE NYLON FACTORY — the app now runs the Water factory only.
-- ----------------------------------------------------------------------------
-- Earlier migrations create a 'nylon' factory and seed it (demo data,
-- 20260922090000_nylon_products_seed.sql, internal supply links, ...). This
-- deletes every row that belongs to it, the Nylon production types, and then
-- the factory itself. Water data is untouched.
--
-- The CHECK constraints that still allow 'nylon' / 'NYLON' values are left in
-- place: they're harmless, and rewriting them would mean re-touching many
-- functions from older migrations.
-- ============================================================================

DO $$
DECLARE
  v_nylon uuid;
  pending text[];
  still_pending text[];
  t text;
BEGIN
  SELECT id INTO v_nylon FROM public.factories WHERE code = 'nylon';
  IF v_nylon IS NULL THEN
    RETURN; -- already gone
  END IF;

  -- Nylon-only production types and anyone/anything scoped to Nylon.
  DELETE FROM public.production_types WHERE production_scope = 'NYLON';
  UPDATE public.profiles SET production_scope = 'BOTH' WHERE production_scope = 'NYLON';

  -- Every public table with a factory_id column, deleted in dependency order:
  -- retry the tables a foreign key blocked until a full pass makes no progress.
  SELECT array_agg(c.table_name::text)
    INTO pending
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
   WHERE c.table_schema = 'public'
     AND c.column_name = 'factory_id'
     AND tb.table_type = 'BASE TABLE';

  LOOP
    still_pending := '{}';
    FOREACH t IN ARRAY coalesce(pending, '{}') LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE factory_id = $1', t) USING v_nylon;
      EXCEPTION WHEN foreign_key_violation THEN
        still_pending := still_pending || t;
      END;
    END LOOP;
    EXIT WHEN cardinality(still_pending) = 0;
    IF cardinality(still_pending) = cardinality(pending) THEN
      RAISE EXCEPTION 'Could not remove Nylon rows from: % (still referenced elsewhere)',
        array_to_string(still_pending, ', ');
    END IF;
    pending := still_pending;
  END LOOP;

  DELETE FROM public.factories WHERE id = v_nylon;
END $$;
