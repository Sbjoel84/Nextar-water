-- ============================================================================
-- Sachet Water is counted in bags, not pieces.
-- ----------------------------------------------------------------------------
-- New Sachet Water products are created with unit 'Bag' (src/lib/product-lines.ts
-- unitFor()). This moves the existing ones over too -- but only those holding
-- no stock: a product with stock was counted in pieces, and relabelling that
-- number as bags would change what it means. Those keep their unit until their
-- stock is 0 (the unit can then be changed on the product form).
-- ============================================================================

UPDATE public.products
   SET unit = 'Bag', updated_at = now()
 WHERE name ILIKE 'Sachet Water%'
   AND unit <> 'Bag'
   AND current_stock = 0;
