-- ============================================================================
-- Costing: light (electricity) consumption
-- ----------------------------------------------------------------------------
-- A costing sheet now totals everything it takes to produce a batch:
--
--   total = materials + water & treatment + labour + light + logistics
--
-- electricity_cost holds the batch's light/power consumption in naira and is
-- costed like labour and logistics. submit_costing_sheet /
-- update_costing_sheet are patched in place from their live definitions;
-- everything else about them is unchanged.
-- ============================================================================

ALTER TABLE public.costing_sheets
  ADD COLUMN IF NOT EXISTS electricity_cost numeric NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'costing_sheets_electricity_cost_check') THEN
    ALTER TABLE public.costing_sheets
      ADD CONSTRAINT costing_sheets_electricity_cost_check CHECK (electricity_cost >= 0);
  END IF;
END $$;

DO $$
DECLARE
  v_patch record;
  v_def text;
  v_new text;
  v_step record;
BEGIN
  FOR v_patch IN SELECT * FROM (VALUES ('public.submit_costing_sheet(jsonb)'), ('public.update_costing_sheet(jsonb)')) AS t(sig)
  LOOP
    v_def := pg_get_functiondef(v_patch.sig::regprocedure);
    -- Already applied (e.g. by 20261021100000, which carries this change too).
    CONTINUE WHEN position('v_electricity' IN v_def) > 0;
    v_new := v_def;

    FOR v_step IN SELECT * FROM (VALUES
      ($a$  v_logistics numeric := COALESCE((payload->>'logistics_cost')::numeric, 0);$a$,
       $b$  v_logistics numeric := COALESCE((payload->>'logistics_cost')::numeric, 0);
  v_electricity numeric := COALESCE((payload->>'electricity_cost')::numeric, 0);$b$),
      ($a$  v_total := v_material_cost + v_labor + v_overhead + v_logistics;$a$,
       $b$  IF v_electricity < 0 THEN RAISE EXCEPTION 'Light consumption cannot be negative'; END IF;
  v_total := v_material_cost + v_labor + v_overhead + v_logistics + v_electricity;$b$)
    ) AS s(old_text, new_text)
    LOOP
      IF position(v_step.old_text IN v_new) = 0 THEN
        RAISE EXCEPTION 'Expected text not found in %: %', v_patch.sig, left(v_step.old_text, 60);
      END IF;
      v_new := replace(v_new, v_step.old_text, v_step.new_text);
    END LOOP;

    IF v_patch.sig LIKE 'public.submit%' THEN
      FOR v_step IN SELECT * FROM (VALUES
        ('created_by, logistics_cost, product_type)', 'created_by, logistics_cost, product_type, electricity_cost)'),
        ('v_uid, v_logistics, v_product_type)', 'v_uid, v_logistics, v_product_type, v_electricity)')
      ) AS s(old_text, new_text)
      LOOP
        IF position(v_step.old_text IN v_new) = 0 THEN
          RAISE EXCEPTION 'Expected text not found in %: %', v_patch.sig, v_step.old_text;
        END IF;
        v_new := replace(v_new, v_step.old_text, v_step.new_text);
      END LOOP;
    ELSE
      IF position('logistics_cost = v_logistics,' IN v_new) = 0 THEN
        RAISE EXCEPTION 'Expected text not found in %: UPDATE list', v_patch.sig;
      END IF;
      v_new := replace(v_new, 'logistics_cost = v_logistics,',
        'logistics_cost = v_logistics, electricity_cost = v_electricity,');
    END IF;

    EXECUTE v_new;
  END LOOP;
END $$;
