-- ============================================================================
-- Sales can always see the product list they sell from.
-- ----------------------------------------------------------------------------
-- products / product_categories were readable only with finished-goods access
-- (20260814093000). New sales accounts get a per-user `finished-goods` view
-- BLOCK from the department page defaults (20261022100000), so the "Add
-- product" dropdown on New Sale came back empty even after production had
-- posted stock to the store. rep_stock had the same problem via
-- `distribution` -- selling through a distributor/marketer showed 0 on the van.
--
-- Read-only and additive: anyone who can work in Sales may read these rows.
-- Writes still need finished-goods / distribution write, unchanged.
-- ============================================================================

DROP POLICY IF EXISTS "sales read products" ON public.products;
CREATE POLICY "sales read products" ON public.products FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'sales'::module_key, 'read'::action_key));

DROP POLICY IF EXISTS "sales read product categories" ON public.product_categories;
CREATE POLICY "sales read product categories" ON public.product_categories FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'sales'::module_key, 'read'::action_key));

DROP POLICY IF EXISTS "sales read rep stock" ON public.rep_stock;
CREATE POLICY "sales read rep stock" ON public.rep_stock FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'sales'::module_key, 'read'::action_key));
