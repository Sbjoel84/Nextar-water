-- ============================================================================
-- YUSUF MAMUD (mayuss92@gmail.com) PREPARES PAYROLL; VIVIAN APPROVES IT
-- ----------------------------------------------------------------------------
-- Mamud may create, edit, submit, cancel, export and print payroll runs, but
-- must not approve, reject, post or reverse them -- one person should not
-- process payroll end to end. His accountant role grants payroll
-- approve/reject, so those are explicitly denied here as personal overrides;
-- other accountants are unchanged. Vivian (super_admin) holds every action.
-- Idempotent.
-- ============================================================================
INSERT INTO public.permission_overrides (user_id, module, action, granted)
SELECT 'e2c012ea-523f-4c10-8867-6e4e47de4a36'::uuid, 'payroll'::public.module_key, g.action::public.action_key, g.granted
FROM (VALUES
  ('view', true), ('create', true), ('edit', true), ('submit', true),
  ('cancel', true), ('export', true), ('print', true),
  ('approve', false), ('reject', false), ('post', false), ('reverse', false)
) AS g(action, granted)
WHERE EXISTS (SELECT 1 FROM auth.users WHERE id = 'e2c012ea-523f-4c10-8867-6e4e47de4a36')
ON CONFLICT (user_id, module, action) DO UPDATE SET granted = EXCLUDED.granted, granted_at = now();
