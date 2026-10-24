-- ============================================================================
-- ROLE PERMISSIONS — inventory_officer logs product returns from Sales-Reps
-- ----------------------------------------------------------------------------
-- The Store page's "Return Product" button (and create_sales_return()) need
-- `sales-returns` submit. inventory_officer only had view + confirm
-- (20260929090000), so the button never showed for them even though they
-- receive the goods back into the store. Give them the same maker pair as
-- store_officer: submit to log a return, cancel to withdraw one logged in
-- error.
--
-- Maker/checker is unchanged: inspect_sales_return() still refuses the person
-- who logged the return, so another inventory/store officer (or the chairman)
-- inspects it.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action) VALUES
  ('inventory_officer', 'sales-returns', 'submit'),
  ('inventory_officer', 'sales-returns', 'cancel')
ON CONFLICT DO NOTHING;
