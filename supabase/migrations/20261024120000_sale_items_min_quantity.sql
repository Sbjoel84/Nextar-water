-- ============================================================================
-- Minimum of 5 units per product on a sale.
-- ----------------------------------------------------------------------------
-- Every line a sale carries -- store or sales-rep (van) sale, any customer
-- type -- must be at least 5 of that product. The New Sale form enforces this
-- too (MIN_SALE_QTY in src/routes/_app.sales.tsx); this trigger is the
-- backstop for create_sale()/edit_sale() and anything else writing lines.
-- Only new writes are checked: sales already on the books are untouched.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._sale_items_min_quantity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_name text;
BEGIN
  IF NEW.quantity < 5 THEN
    SELECT name INTO v_name FROM products WHERE id = NEW.product_id;
    RAISE EXCEPTION '%: minimum per product is 5', COALESCE(v_name, 'Product');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sale_items_min_quantity ON public.sale_items;
CREATE TRIGGER sale_items_min_quantity
  BEFORE INSERT OR UPDATE OF quantity ON public.sale_items
  FOR EACH ROW EXECUTE FUNCTION public._sale_items_min_quantity();
