-- ============================================================================
-- REMOVE THE NYLON FACTORY — the app now runs the Water factory only.
-- ----------------------------------------------------------------------------
-- Earlier migrations create a 'nylon' factory and seed it (demo data,
-- 20260922090000_nylon_products_seed.sql, internal supply links, ...). This
-- deletes every row that belongs to it, the Nylon production types, and then
-- the factory itself. Water data is untouched.
--
-- Nylon rows are referenced from tables that have no factory_id of their own
-- (line items, movements, recipes, ...), so a plain DELETE per table hits
-- foreign keys. _purge_rows follows every foreign key that points at the rows
-- being deleted and clears those references first:
--   * a nullable reference (e.g. a Water row or a user profile that points at
--     a Nylon row) is set to NULL, so the referencing row survives;
--   * a NOT NULL reference means the row belongs to the Nylon row (a line
--     item, a movement, ...) and is deleted, recursively.
-- Nylon rows in factory-scoped tables are still deleted by their own pass.
-- User triggers (e.g. the append-only guard on customer_account_transactions)
-- are switched off around each statement; FK constraint triggers stay on.
--
-- The CHECK constraints that still allow 'nylon' / 'NYLON' values are left in
-- place: they're harmless, and rewriting them would mean re-touching many
-- functions from older migrations.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._purge_rows(p_table regclass, p_cond text, p_depth int DEFAULT 0)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  v_ref text;
BEGIN
  IF p_depth > 15 THEN
    RAISE EXCEPTION 'Nylon cleanup recursed too deep at %', p_table;
  END IF;

  FOR r IN
    SELECT c.conrelid::regclass AS child,
           a.attname AS child_col,
           pa.attname AS parent_col,
           a.attnotnull AS not_null
      FROM pg_constraint c
      JOIN pg_attribute a  ON a.attrelid = c.conrelid  AND a.attnum = c.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid = p_table
       AND cardinality(c.conkey) = 1
  LOOP
    v_ref := format('%I IN (SELECT %I FROM %s WHERE %s)', r.child_col, r.parent_col, p_table, p_cond);

    IF r.child = p_table OR NOT r.not_null THEN
      EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER', r.child);
      EXECUTE format('UPDATE %s SET %I = NULL WHERE %s', r.child, r.child_col, v_ref);
      EXECUTE format('ALTER TABLE %s ENABLE TRIGGER USER', r.child);
    ELSE
      PERFORM public._purge_rows(r.child, v_ref, p_depth + 1);
    END IF;
  END LOOP;

  EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER', p_table);
  EXECUTE format('DELETE FROM %s WHERE %s', p_table, p_cond);
  EXECUTE format('ALTER TABLE %s ENABLE TRIGGER USER', p_table);
END;
$$;

DO $$
DECLARE
  v_nylon uuid;
  t text;
BEGIN
  SELECT id INTO v_nylon FROM public.factories WHERE code = 'nylon';
  IF v_nylon IS NULL THEN
    RETURN; -- already gone
  END IF;

  -- Nylon-only production types and anyone/anything scoped to Nylon.
  PERFORM public._purge_rows('public.production_types', $c$production_scope = 'NYLON'$c$);
  UPDATE public.profiles SET production_scope = 'BOTH' WHERE production_scope = 'NYLON';

  -- Every row in every public table with a factory_id column.
  FOR t IN
    SELECT c.table_name::text
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'factory_id'
       AND tb.table_type = 'BASE TABLE'
  LOOP
    PERFORM public._purge_rows(format('public.%I', t)::regclass, format('factory_id = %L', v_nylon));
  END LOOP;

  -- Finally the factory itself; any remaining references (profiles.active_factory_id,
  -- profiles.requested_factory_id, ...) are nullable and get set to NULL.
  PERFORM public._purge_rows('public.factories', format('id = %L', v_nylon));
END $$;

DROP FUNCTION public._purge_rows(regclass, text, int);
