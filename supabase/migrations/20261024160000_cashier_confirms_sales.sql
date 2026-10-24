-- ============================================================================
-- ROLE PERMISSIONS — cashier confirms sales and prints the payment receipt
-- ----------------------------------------------------------------------------
-- Orders posted by sales (walk-in customers, marketers, distributors, ...) wait
-- in "Sales awaiting confirmation" on the Finance page. confirm_sale() takes
-- the payment, applies discount / VAT, decrements stock and the dialog prints
-- the receipt -- all gated on `sales` approve, which only the accountant and
-- chairman had (20261022090000). The cashier takes the money, so give them the
-- same confirm step, plus reject to send a wrong order back to sales.
--
-- The confirmation card still disables Confirm/Reject on an order the viewer
-- created themselves, so a cashier who keys in a sale can't confirm it too.
-- ============================================================================

INSERT INTO public.role_permissions (role, module, action) VALUES
  ('cashier', 'sales', 'approve'),
  ('cashier', 'sales', 'reject')
ON CONFLICT DO NOTHING;
