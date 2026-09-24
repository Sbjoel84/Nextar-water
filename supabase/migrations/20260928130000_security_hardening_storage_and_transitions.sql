-- ============================================================================
-- SECURITY HARDENING — storage buckets + workflow_transitions
-- ----------------------------------------------------------------------------
-- 1. workflow_transitions never had RLS enabled. It's the table
--    assert_valid_transition() reads to decide which status changes are
--    legal (draft -> submitted -> approved -> posted ...), and the public
--    API currently serves it to anonymous callers. Lock it to read-only for
--    signed-in users; only migrations (table owner) change it.
--
-- 2. Storage: every signed-in user — any role — could read, upload and
--    delete every employee document/photo and every expense attachment, and
--    replace or delete the company logo. Avatars' policies were created
--    outside migrations. Now:
--      employee-files       read: employees view   write/delete: employees write
--      expense-attachments  read: expenses view    upload: expenses write
--                           delete: own upload + expenses write
--      company-logos        read: public (logo on login page / printouts)
--                           write/delete: settings write
--      avatars              read: public           write/delete: own folder only
--                           (uploads go to "<user id>/<file>")
--    All existing policies that mention these buckets are dropped first,
--    including any created in the dashboard — storage policies are OR'ed,
--    so one leftover permissive policy would undo the rest.
--
-- 3. Bucket limits: logos/avatars images only, 5 MB; documents 10 MB.
-- ============================================================================

-- ---------- 1. workflow_transitions ----------
ALTER TABLE public.workflow_transitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workflow_transitions FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.workflow_transitions FROM authenticated;
GRANT SELECT ON public.workflow_transitions TO authenticated;
DROP POLICY IF EXISTS "workflow transitions read" ON public.workflow_transitions;
CREATE POLICY "workflow transitions read" ON public.workflow_transitions
  FOR SELECT TO authenticated USING (true);

-- ---------- 2. storage policies ----------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND (COALESCE(qual, '') || ' ' || COALESCE(with_check, ''))
           ~ '(employee-files|expense-attachments|company-logos|avatars)'
  LOOP
    EXECUTE format('DROP POLICY %I ON storage.objects', r.policyname);
    RAISE NOTICE 'dropped storage policy: %', r.policyname;
  END LOOP;
END $$;

-- employee-files
CREATE POLICY "employee files read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'employee-files'
         AND public.has_permission(auth.uid(), 'employees'::public.module_key, 'view'::public.action_key));
CREATE POLICY "employee files upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'employee-files'
              AND public.has_permission(auth.uid(), 'employees'::public.module_key, 'write'::public.action_key));
CREATE POLICY "employee files update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'employee-files'
         AND public.has_permission(auth.uid(), 'employees'::public.module_key, 'write'::public.action_key));
CREATE POLICY "employee files delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'employee-files'
         AND public.has_permission(auth.uid(), 'employees'::public.module_key, 'write'::public.action_key));

-- expense-attachments
CREATE POLICY "expense attachments read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'expense-attachments'
         AND public.has_permission(auth.uid(), 'expenses'::public.module_key, 'view'::public.action_key));
CREATE POLICY "expense attachments upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'expense-attachments'
              AND public.has_permission(auth.uid(), 'expenses'::public.module_key, 'write'::public.action_key));
CREATE POLICY "expense attachments delete own" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'expense-attachments' AND owner = auth.uid()
         AND public.has_permission(auth.uid(), 'expenses'::public.module_key, 'write'::public.action_key));

-- company-logos
CREATE POLICY "company logos read" ON storage.objects FOR SELECT
  USING (bucket_id = 'company-logos');
CREATE POLICY "company logos upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'company-logos'
              AND public.has_permission(auth.uid(), 'settings'::public.module_key, 'write'::public.action_key));
CREATE POLICY "company logos update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'company-logos'
         AND public.has_permission(auth.uid(), 'settings'::public.module_key, 'write'::public.action_key));
CREATE POLICY "company logos delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'company-logos'
         AND public.has_permission(auth.uid(), 'settings'::public.module_key, 'write'::public.action_key));

-- avatars: anyone signed in manages only their own "<uid>/..." folder
CREATE POLICY "avatars read" ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');
CREATE POLICY "avatars upload own" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "avatars update own" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "avatars delete own" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- 3. bucket limits ----------
UPDATE storage.buckets SET file_size_limit = 5 * 1024 * 1024,
       allowed_mime_types = ARRAY['image/png','image/jpeg','image/webp','image/gif']
 WHERE id IN ('company-logos', 'avatars');
UPDATE storage.buckets SET file_size_limit = 10 * 1024 * 1024
 WHERE id IN ('employee-files', 'expense-attachments');
