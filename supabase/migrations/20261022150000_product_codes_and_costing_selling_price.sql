-- ============================================================================
-- 1. Automatic product codes.
-- ----------------------------------------------------------------------------
-- products.product_code is generated on insert from the product name and SKU:
-- initials of the product + the SKU + a running number, e.g.
--   Bottle Water 35cl (SKU 35cl) -> BW-35CL-001
--   Dispenser 19L     (SKU 19L)  -> D-19L-001
--   Sachet Water      (no SKU)   -> SW-001
-- Unique per factory. Existing products are backfilled, oldest first.
--
-- 2. Selling price comes from the Costing page.
-- ----------------------------------------------------------------------------
-- The Store's Add Product form no longer asks for prices. When a costing
-- sheet is approved, the approver picks the selling price (one of the sheet's
-- proposed prices, or their own) and approve_costing_sheet_with_price() applies
-- it to the product alongside the cost price approve_costing_sheet() already
-- sets. Price history is recorded by the existing products_price_history
-- trigger.
-- ============================================================================

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS product_code text;
CREATE UNIQUE INDEX IF NOT EXISTS products_factory_code_key
  ON public.products (factory_id, product_code) WHERE product_code IS NOT NULL;

CREATE OR REPLACE FUNCTION public.next_product_code(p_factory_id uuid, p_name text, p_sku text)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_sku text := upper(regexp_replace(COALESCE(p_sku, ''), '[^A-Za-z0-9]', '', 'g'));
  v_base text := btrim(COALESCE(p_name, ''));
  v_initials text;
  v_prefix text;
  v_n int;
  v_code text;
BEGIN
  -- Drop the SKU from the end of the name ("Bottle Water 35cl" -> "Bottle Water").
  IF p_sku IS NOT NULL AND btrim(p_sku) <> ''
     AND lower(v_base) LIKE '%' || lower(btrim(p_sku)) THEN
    v_base := btrim(left(v_base, length(v_base) - length(btrim(p_sku))));
  END IF;

  SELECT string_agg(upper(left(w, 1)), '') INTO v_initials
    FROM regexp_split_to_table(v_base, '\s+') AS w
   WHERE w ~ '^[A-Za-z]';
  v_initials := left(COALESCE(NULLIF(v_initials, ''), 'P'), 4);

  v_prefix := v_initials || CASE WHEN v_sku <> '' THEN '-' || v_sku ELSE '' END || '-';

  SELECT COALESCE(max(substring(product_code FROM length(v_prefix) + 1)::int), 0) + 1 INTO v_n
    FROM products
   WHERE factory_id = p_factory_id
     AND product_code LIKE v_prefix || '%'
     AND substring(product_code FROM length(v_prefix) + 1) ~ '^[0-9]+$';

  LOOP
    v_code := v_prefix || lpad(v_n::text, 3, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM products WHERE factory_id = p_factory_id AND product_code = v_code);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.products_set_code()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.product_code IS NULL OR btrim(NEW.product_code) = '' THEN
    NEW.product_code := public.next_product_code(NEW.factory_id, NEW.name, NEW.sku);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_set_code ON public.products;
CREATE TRIGGER products_set_code BEFORE INSERT ON public.products
FOR EACH ROW EXECUTE FUNCTION public.products_set_code();

-- Backfill, one at a time so each sees the codes handed out before it.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, factory_id, name, sku FROM public.products
            WHERE product_code IS NULL ORDER BY created_at, id LOOP
    UPDATE public.products
       SET product_code = public.next_product_code(r.factory_id, r.name, r.sku)
     WHERE id = r.id;
  END LOOP;
END $$;

-- ---------- Costing approval sets the selling price ----------
CREATE OR REPLACE FUNCTION public.approve_costing_sheet_with_price(
  p_id uuid,
  p_selling_price numeric DEFAULT NULL,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row costing_sheets%ROWTYPE;
  v_result jsonb;
  v_old_price numeric;
BEGIN
  IF p_selling_price IS NOT NULL AND p_selling_price < 0 THEN
    RAISE EXCEPTION 'Selling price cannot be negative';
  END IF;

  -- Permission, self-approval rule, status transition and cost price.
  v_result := public.approve_costing_sheet(p_id, p_comment);

  SELECT * INTO v_row FROM costing_sheets WHERE id = p_id;
  IF v_row.apply_to_product AND p_selling_price IS NOT NULL AND p_selling_price > 0 THEN
    SELECT unit_price INTO v_old_price FROM products WHERE id = v_row.product_id FOR UPDATE;
    UPDATE products SET unit_price = p_selling_price, updated_at = now() WHERE id = v_row.product_id;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_row.factory_id, 'approve_costing_sheet', 'products', v_row.product_id::text,
            jsonb_build_object('sheet_id', p_id, 'unit_price', v_old_price),
            jsonb_build_object('unit_price', p_selling_price));
    v_result := v_result || jsonb_build_object('selling_price', p_selling_price);
  END IF;

  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.approve_costing_sheet_with_price(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_costing_sheet_with_price(uuid, numeric, text) TO authenticated;
