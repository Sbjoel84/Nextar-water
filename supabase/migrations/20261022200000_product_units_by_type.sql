-- ============================================================================
-- Count each product in its own unit, not "pieces" for everything.
-- ----------------------------------------------------------------------------
--   Bottle Water ...  -> Packs
--   Sachet Water ...  -> Bag
--   Dispenser, Ice Block (and anything else still on "pieces") -> Piece
-- Same mapping new products get (src/lib/product-lines.ts unitFor()).
--
-- Only products holding no stock are relabelled: a stock figure counted in
-- pieces would mean something different read as packs or bags. Products with
-- stock keep their unit until it is 0 (it can then be changed on the product
-- form). Every live product held 0 stock when this was written.
-- ============================================================================

UPDATE public.products
   SET unit = CASE
                WHEN name ILIKE 'Bottle Water%' THEN 'Packs'
                WHEN name ILIKE 'Sachet Water%' THEN 'Bag'
                ELSE 'Piece'
              END,
       updated_at = now()
 WHERE current_stock = 0
   AND (name ILIKE 'Bottle Water%'
        OR name ILIKE 'Sachet Water%'
        OR name ILIKE 'Dispenser%'
        OR name ILIKE 'Ice Block%'
        OR lower(unit) IN ('pieces', 'pcs', 'piece'))
   AND unit IS DISTINCT FROM CASE
                WHEN name ILIKE 'Bottle Water%' THEN 'Packs'
                WHEN name ILIKE 'Sachet Water%' THEN 'Bag'
                ELSE 'Piece'
              END;

-- Show what each product is now counted in.
SELECT name, unit, current_stock, active FROM public.products ORDER BY active DESC, name;
