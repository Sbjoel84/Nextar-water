-- Adds a general "Manager" role so it appears in the signup page's
-- "Role requested" dropdown (which reads public.roles). It starts with no
-- role_permissions; a super_admin grants its module access from the Permissions page.
INSERT INTO public.roles (slug, label, is_system) VALUES
  ('manager', 'Manager', true)
ON CONFLICT (slug) DO NOTHING;
