-- ============================================================================
-- No duplicate raw materials or products.
-- ----------------------------------------------------------------------------
-- "Shrink Wrapping Nylon", "Dispenser Packing Bag" / "DISPENSER PACKING BAG"
-- and others were listed more than once. Names are compared ignoring case and
-- extra spaces, within one factory, among active items.
--
-- 1. Merge existing duplicates: per name, the copy with a category (then the
--    most stock, then the oldest) is kept. Everything that pointed at the other
--    copies (requests, movements, purchase orders, costing lines, ...) is moved
--    onto the kept one, their stock is added to it, and the copies are deleted.
--    If two copies hold stock in different units the merge stops with an error
--    naming the item, rather than adding Kilograms to Pieces.
-- 2. A trigger refuses any new item, rename or re-activation that would create
--    a duplicate, with a plain message, whichever screen or function did it.
-- 3. A unique index backs that up at the database level.
--
-- Safe to run in the Supabase SQL Editor. Best run AFTER go_live_reset.sql,
-- when there is no stock or history to move.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.norm_item_name(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(btrim(p), '\s+', ' ', 'g'));
$$;

-- ---------- 1. merge existing duplicates ----------
CREATE OR REPLACE FUNCTION public._merge_duplicate_items(p_table text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  grp record;
  fk record;
  v_keep uuid;
  v_dup uuid;
  v_keep_unit text;
  v_dup_unit text;
  v_dup_stock numeric;
  v_removed integer := 0;
BEGIN
  FOR grp IN EXECUTE format($q$
    SELECT min(name) AS name,
           array_agg(id ORDER BY (category_id IS NOT NULL) DESC, current_stock DESC, created_at) AS ids
      FROM public.%I
     WHERE active
     GROUP BY factory_id, public.norm_item_name(name)
    HAVING count(*) > 1
  $q$, p_table)
  LOOP
    v_keep := grp.ids[1];
    EXECUTE format('SELECT unit FROM public.%I WHERE id = $1', p_table) INTO v_keep_unit USING v_keep;

    FOREACH v_dup IN ARRAY grp.ids[2:array_length(grp.ids, 1)] LOOP
      EXECUTE format('SELECT unit, current_stock FROM public.%I WHERE id = $1', p_table)
        INTO v_dup_unit, v_dup_stock USING v_dup;

      IF COALESCE(v_dup_stock, 0) <> 0 THEN
        IF lower(btrim(v_dup_unit)) <> lower(btrim(v_keep_unit)) THEN
          RAISE EXCEPTION '"%" is listed twice with stock in different units (% and %). Set one copy''s stock to 0, then run this again.',
            grp.name, v_keep_unit, v_dup_unit;
        END IF;
        IF p_table = 'raw_materials' THEN
          UPDATE public.raw_materials k SET
            current_stock = k.current_stock + d.current_stock,
            opening_stock = k.opening_stock + d.opening_stock,
            current_value = k.current_value + d.current_value
          FROM public.raw_materials d WHERE k.id = v_keep AND d.id = v_dup;
        ELSE
          UPDATE public.products k SET current_stock = k.current_stock + d.current_stock
          FROM public.products d WHERE k.id = v_keep AND d.id = v_dup;
        END IF;
      END IF;

      -- Move every reference onto the kept copy. Where the kept copy already
      -- has the equivalent row (a unique key clashes), the duplicate's row is
      -- dropped instead.
      FOR fk IN
        SELECT c.conrelid::regclass AS tbl, a.attname AS col
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.contype = 'f' AND c.confrelid = format('public.%I', p_table)::regclass
           AND array_length(c.conkey, 1) = 1
      LOOP
        BEGIN
          EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', fk.tbl, fk.col, fk.col) USING v_keep, v_dup;
        EXCEPTION WHEN unique_violation THEN
          EXECUTE format('DELETE FROM %s WHERE %I = $1', fk.tbl, fk.col) USING v_dup;
        END;
      END LOOP;

      EXECUTE format('DELETE FROM public.%I WHERE id = $1', p_table) USING v_dup;
      v_removed := v_removed + 1;
    END LOOP;
  END LOOP;
  RETURN v_removed;
END $$;

DO $$
DECLARE n_mat integer; n_prod integer;
BEGIN
  n_mat := public._merge_duplicate_items('raw_materials');
  n_prod := public._merge_duplicate_items('products');
  RAISE NOTICE 'Removed % duplicate raw material(s) and % duplicate product(s)', n_mat, n_prod;
END $$;

DROP FUNCTION public._merge_duplicate_items(text);

-- ---------- 2. refuse new duplicates with a clear message ----------
CREATE OR REPLACE FUNCTION public.prevent_duplicate_item_name()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_exists boolean;
BEGIN
  NEW.name := regexp_replace(btrim(NEW.name), '\s+', ' ', 'g');
  IF NEW.active THEN
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I WHERE factory_id = $1 AND active AND id <> $2
                         AND public.norm_item_name(name) = public.norm_item_name($3))', TG_TABLE_NAME)
      INTO v_exists USING NEW.factory_id, NEW.id, NEW.name;
    IF v_exists THEN
      RAISE EXCEPTION '"%" already exists — each item can only be listed once. Use the existing one.', NEW.name
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS raw_materials_no_duplicate_name ON public.raw_materials;
CREATE TRIGGER raw_materials_no_duplicate_name
  BEFORE INSERT OR UPDATE OF name, active, factory_id ON public.raw_materials
  FOR EACH ROW EXECUTE FUNCTION public.prevent_duplicate_item_name();

DROP TRIGGER IF EXISTS products_no_duplicate_name ON public.products;
CREATE TRIGGER products_no_duplicate_name
  BEFORE INSERT OR UPDATE OF name, active, factory_id ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.prevent_duplicate_item_name();

-- ---------- 3. hard guarantee ----------
CREATE UNIQUE INDEX IF NOT EXISTS raw_materials_factory_active_name_key
  ON public.raw_materials (factory_id, public.norm_item_name(name))
  WHERE active;

-- Replaces the narrower lower(btrim(name)) index from 20261024210000, which
-- let "Bottle  Water" (two spaces) through next to "Bottle Water".
DROP INDEX IF EXISTS public.products_factory_active_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS products_factory_active_name_norm_key
  ON public.products (factory_id, public.norm_item_name(name))
  WHERE active;

COMMIT;

-- Should return no rows.
SELECT 'raw_materials' AS list, min(name) AS name, count(*) FROM public.raw_materials WHERE active
 GROUP BY factory_id, public.norm_item_name(name) HAVING count(*) > 1
UNION ALL
SELECT 'products', min(name), count(*) FROM public.products WHERE active
 GROUP BY factory_id, public.norm_item_name(name) HAVING count(*) > 1;
