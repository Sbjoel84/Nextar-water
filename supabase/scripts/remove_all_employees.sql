-- ============================================================================
-- REMOVE ALL EMPLOYEES — go-live clean-up
-- ----------------------------------------------------------------------------
-- THIS CANNOT BE UNDONE. All-or-nothing: if anything fails, NOTHING changes.
--
-- What it does, in every factory:
--
--   * DELETES every employee record on the Employees page, together with
--     their documents, staff loans (and loan repayments) and staff deductions
--     (those cascade automatically).
--
--   * KEEPS payroll history. payroll.employee_id has no cascade, so an
--     employee who already has a payroll row cannot be deleted without losing
--     that salary record. Those employees are marked 'terminated' instead —
--     they drop out of active lists and new payroll runs. (If you run
--     go_live_reset.sql first, it clears payroll, and then this script
--     deletes every employee with nothing left over.)
--
--   * UNLINKS sales reps from employees (sales_reps.employee_id -> NULL). The
--     sales reps themselves, and their Sales-Rep customer accounts, stay.
--
--   * Does NOT touch login accounts (Admin Panel -> Users) — they are a
--     separate thing from Employees-page records.
--
-- Not covered (Supabase Storage is separate from the database): uploaded
-- employee document files stay in the 'employee-files' storage bucket.
--
-- Run the whole file in the Supabase SQL Editor. Read the NOTICE lines; the
-- result at the bottom shows what is left.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_total int;
  v_with_payroll int;
BEGIN
  SELECT count(*) INTO v_total FROM public.employees;
  SELECT count(DISTINCT employee_id) INTO v_with_payroll FROM public.payroll;
  RAISE NOTICE 'Employees found: %', v_total;
  RAISE NOTICE 'To delete: % — to mark terminated (have payroll history): %',
    v_total - v_with_payroll, v_with_payroll;
END $$;

-- 1. Sales reps keep existing; they just stop pointing at an employee.
UPDATE public.sales_reps SET employee_id = NULL WHERE employee_id IS NOT NULL;

-- 2. Employees with payroll history: keep the row (and its payroll), retire it.
UPDATE public.employees
   SET status = 'terminated'
 WHERE id IN (SELECT employee_id FROM public.payroll);

-- 3. Everyone else: delete. Documents, staff loans, loan repayments and staff
--    deductions go with them (ON DELETE CASCADE).
DELETE FROM public.employees
 WHERE id NOT IN (SELECT employee_id FROM public.payroll);

COMMIT;

SELECT
  (SELECT count(*) FROM public.employees)                              AS employees_left,
  (SELECT count(*) FROM public.employees WHERE status = 'terminated')  AS of_which_terminated,
  (SELECT count(*) FROM public.employee_documents)                     AS employee_documents_left,
  (SELECT count(*) FROM public.staff_loans)                            AS staff_loans_left,
  (SELECT count(*) FROM public.staff_deductions)                       AS staff_deductions_left,
  'EMPLOYEES REMOVED'                                                  AS result;
