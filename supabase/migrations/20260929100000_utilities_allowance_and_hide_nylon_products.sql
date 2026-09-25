-- ============================================================================
-- 1) Employee allowances: Utilities
-- ----------------------------------------------------------------------------
-- The UI now labels meal_allowance "Productivity" and medical_allowance
-- "Inconvenience" (columns kept, so existing figures carry over unchanged)
-- and adds a Utilities allowance. process_payroll() includes it in gross and
-- snapshots it on the payroll row like the other allowances.
--
-- 2) Hide the seeded Nylon finished products the business doesn't make
-- ----------------------------------------------------------------------------
-- Deactivated, not deleted: past sales, production and stock movements still
-- reference them, and every product picker already filters active = true.
-- Re-enable by setting active = true. Matched on the name with spaces,
-- brackets and case ignored, so "SS2 (Count 100)" and "SS2 Count 100" both hit.
-- ============================================================================

ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS utilities_allowance numeric(14,2) DEFAULT 0;
ALTER TABLE public.payroll ADD COLUMN IF NOT EXISTS utilities_allowance numeric(14,2) NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.process_payroll(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_employee_id uuid := (payload->>'employee_id')::uuid;
  v_month int := (payload->>'period_month')::int;
  v_year int := (payload->>'period_year')::int;
  v_overtime numeric := COALESCE((payload->>'overtime')::numeric, 0);
  v_paye numeric := COALESCE((payload->>'paye')::numeric, 0);
  v_pension numeric := COALESCE((payload->>'pension')::numeric, 0);
  v_advance numeric := COALESCE((payload->>'advance')::numeric, 0);
  v_manual_other numeric := COALESCE((payload->>'other_deductions')::numeric, 0);
  v_method payment_method := COALESCE((payload->>'payment_method')::payment_method, 'transfer');
  v_emp employees%ROWTYPE;
  v_gross numeric; v_net numeric; v_id uuid;
  v_loan staff_loans%ROWTYPE;
  v_this numeric;
  v_loan_ded numeric := 0;
  v_adj_ded numeric := 0;
  v_other_total numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_month IS NULL OR v_month < 1 OR v_month > 12 THEN RAISE EXCEPTION 'period_month must be 1-12'; END IF;
  IF v_year IS NULL THEN RAISE EXCEPTION 'period_year required'; END IF;

  SELECT * INTO v_emp FROM employees WHERE id = v_employee_id AND factory_id = v_factory;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found in this factory'; END IF;

  IF EXISTS (
    SELECT 1 FROM payroll
    WHERE employee_id = v_employee_id AND period_month = v_month AND period_year = v_year
      AND status IN ('pending_approval','approved','posted')
  ) THEN
    RAISE EXCEPTION 'A payroll run for this employee and period already exists';
  END IF;

  v_gross := v_emp.basic_salary + COALESCE(v_emp.housing_allowance,0) + COALESCE(v_emp.transport_allowance,0)
           + COALESCE(v_emp.meal_allowance,0) + COALESCE(v_emp.medical_allowance,0) + COALESCE(v_emp.utilities_allowance,0)
           + COALESCE(v_emp.other_allowances,0) + v_overtime;

  -- loan repayment slice for this period (active loans with a balance)
  FOR v_loan IN
    SELECT * FROM staff_loans
    WHERE employee_id = v_employee_id AND status = 'active' AND (principal - amount_repaid) > 0
    ORDER BY disbursed_on
    FOR UPDATE
  LOOP
    v_this := CASE
      WHEN v_loan.repayment_type = 'one_time' THEN v_loan.outstanding
      WHEN v_loan.installment_mode = 'amount' THEN LEAST(v_loan.installment_amount, v_loan.outstanding)
      ELSE LEAST(round(v_loan.principal / v_loan.installment_months, 2), v_loan.outstanding)
    END;
    IF v_this > 0 THEN
      v_loan_ded := v_loan_ded + v_this;
    END IF;
  END LOOP;

  -- approved fines / contributions for this period
  SELECT COALESCE(SUM(amount), 0) INTO v_adj_ded
  FROM staff_deductions
  WHERE employee_id = v_employee_id AND period_month = v_month AND period_year = v_year AND status = 'approved';

  v_other_total := v_manual_other + v_adj_ded;
  v_net := v_gross - v_paye - v_pension - v_loan_ded - v_advance - v_other_total;

  INSERT INTO payroll(
    factory_id, employee_id, period_month, period_year,
    basic_salary, housing_allowance, transport_allowance, meal_allowance, medical_allowance, utilities_allowance, other_allowances,
    overtime, gross_salary, paye, pension, loans, advance, other_deductions, net_salary,
    payment_method, status, bank_name, account_number, submitted_by, submitted_at
  ) VALUES (
    v_factory, v_employee_id, v_month, v_year,
    v_emp.basic_salary, v_emp.housing_allowance, v_emp.transport_allowance, v_emp.meal_allowance, v_emp.medical_allowance,
    COALESCE(v_emp.utilities_allowance,0), v_emp.other_allowances,
    v_overtime, v_gross, v_paye, v_pension, v_loan_ded, v_advance, v_other_total, v_net,
    v_method, 'pending_approval', v_emp.bank_name, v_emp.account_number, v_uid, now()
  ) RETURNING id INTO v_id;

  -- schedule the loan repayments against this run
  FOR v_loan IN
    SELECT * FROM staff_loans
    WHERE employee_id = v_employee_id AND status = 'active' AND (principal - amount_repaid) > 0
    ORDER BY disbursed_on
  LOOP
    v_this := CASE
      WHEN v_loan.repayment_type = 'one_time' THEN v_loan.outstanding
      WHEN v_loan.installment_mode = 'amount' THEN LEAST(v_loan.installment_amount, v_loan.outstanding)
      ELSE LEAST(round(v_loan.principal / v_loan.installment_months, 2), v_loan.outstanding)
    END;
    IF v_this > 0 THEN
      INSERT INTO staff_loan_repayments(loan_id, factory_id, payroll_id, period_month, period_year, amount, status, created_by)
      VALUES (v_loan.id, v_factory, v_id, v_month, v_year, v_this, 'scheduled', v_uid);
    END IF;
  END LOOP;

  -- stamp the fines / contributions applied to this run
  UPDATE staff_deductions SET status = 'applied', applied_payroll_id = v_id
  WHERE employee_id = v_employee_id AND period_month = v_month AND period_year = v_year AND status = 'approved';

  PERFORM public.record_workflow_action('payroll', v_id, 'submit', NULL, 'pending_approval', NULL);
  RETURN jsonb_build_object('id', v_id, 'gross_salary', v_gross, 'net_salary', v_net,
                            'loan_deduction', v_loan_ded, 'adjustment_deduction', v_adj_ded,
                            'manual_other_deduction', v_manual_other);
END; $$;
GRANT EXECUTE ON FUNCTION public.process_payroll(jsonb) TO authenticated;

-- ============ 2. hide Nylon products ============
UPDATE public.products p
   SET active = false, updated_at = now()
  FROM public.factories f
 WHERE p.factory_id = f.id
   AND f.code = 'nylon'
   AND p.active
   AND lower(regexp_replace(p.name, '[^a-zA-Z0-9]', '', 'g')) IN (
     'brandedshoppingbag', 'brandedshoppingbags',
     'blackjumbonylon',
     'breadnylon',
     'jumboblackshopping',
     'packingbags',
     'pharmacybags',
     'plainshoppingbags',
     'printedpurewaterrolls',
     'shrink',
     'ss2count100',
     'ss2count80'
   );
