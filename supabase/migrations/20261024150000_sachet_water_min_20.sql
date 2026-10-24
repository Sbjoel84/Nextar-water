-- ============================================================================
-- Sachet water sells in at least 20 bags per sale line.
-- ----------------------------------------------------------------------------
-- 20261024120000 set a flat minimum of 5 units per product. Sachet water is
-- now 20 (bags); every other product stays at 5. "Sachet water" is any
-- product whose name contains "sachet", so a new sachet product is covered
-- without extra setup. The New Sale form uses the same rule (minSaleQty in
-- src/routes/_app.sales.tsx) -- keep the two in step.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.min_sale_qty(p_product_name text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_product_name ILIKE '%sachet%' THEN 20 ELSE 5 END::numeric;
$$;

CREATE OR REPLACE FUNCTION public._sale_items_min_quantity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_name text;
  v_min numeric;
BEGIN
  SELECT name INTO v_name FROM products WHERE id = NEW.product_id;
  v_min := public.min_sale_qty(COALESCE(v_name, ''));
  IF NEW.quantity < v_min THEN
    RAISE EXCEPTION '%: minimum is %', COALESCE(v_name, 'Product'), v_min;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sale_items_min_quantity ON public.sale_items;
CREATE TRIGGER sale_items_min_quantity
  BEFORE INSERT OR UPDATE OF quantity ON public.sale_items
  FOR EACH ROW EXECUTE FUNCTION public._sale_items_min_quantity();
