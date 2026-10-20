-- ============================================================================
-- Costing per product type, with logistics
-- ----------------------------------------------------------------------------
-- The Costing page now starts from a product type -- Bottle Water, Dispenser
-- Water or Sachet Water -- and lays out that type's raw materials (with their
-- units), labour and logistics. Two columns support it:
--
--   product_type   which of the three templates the sheet was built from, so
--                  editing reopens the same form.
--   logistics_cost batch logistics (haulage, delivery, fuel), costed like
--                  labour: total = materials + labour + overhead + logistics.
--
-- submit_costing_sheet / update_costing_sheet are patched in place from their
-- live definitions; everything else about them is unchanged.
-- ============================================================================

ALTER TABLE public.costing_sheets
  ADD COLUMN IF NOT EXISTS logistics_cost numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS product_type text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'costing_sheets_product_type_check') THEN
    ALTER TABLE public.costing_sheets
      ADD CONSTRAINT costing_sheets_product_type_check
      CHECK (product_type IS NULL OR product_type IN ('bottle', 'dispenser', 'sachet'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'costing_sheets_logistics_cost_check') THEN
    ALTER TABLE public.costing_sheets
      ADD CONSTRAINT costing_sheets_logistics_cost_check CHECK (logistics_cost >= 0);
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
    v_new := v_def;

    FOR v_step IN SELECT * FROM (VALUES
      ($a$  v_labor numeric := COALESCE((payload->>'labor_cost')::numeric, 0);$a$,
       $b$  v_labor numeric := COALESCE((payload->>'labor_cost')::numeric, 0);
  v_logistics numeric := COALESCE((payload->>'logistics_cost')::numeric, 0);
  v_product_type text := NULLIF(payload->>'product_type', '');$b$),
      ($a$  v_total := v_material_cost + v_labor + v_overhead;$a$,
       $b$  IF v_labor < 0 OR v_logistics < 0 THEN RAISE EXCEPTION 'Labour and logistics cannot be negative'; END IF;
  v_total := v_material_cost + v_labor + v_overhead + v_logistics;$b$)
    ) AS s(old_text, new_text)
    LOOP
      IF position(v_step.old_text IN v_new) = 0 THEN
        RAISE EXCEPTION 'Expected text not found in %: %', v_patch.sig, left(v_step.old_text, 60);
      END IF;
      v_new := replace(v_new, v_step.old_text, v_step.new_text);
    END LOOP;

    IF v_patch.sig LIKE 'public.submit%' THEN
      FOR v_step IN SELECT * FROM (VALUES
        ('apply_to_product, notes, created_by)', 'apply_to_product, notes, created_by, logistics_cost, product_type)'),
        ('v_apply, v_notes, v_uid)', 'v_apply, v_notes, v_uid, v_logistics, v_product_type)')
      ) AS s(old_text, new_text)
      LOOP
        IF position(v_step.old_text IN v_new) = 0 THEN
          RAISE EXCEPTION 'Expected text not found in %: %', v_patch.sig, v_step.old_text;
        END IF;
        v_new := replace(v_new, v_step.old_text, v_step.new_text);
      END LOOP;
    ELSE
      IF position('apply_to_product = v_apply, notes = v_notes' IN v_new) = 0 THEN
        RAISE EXCEPTION 'Expected text not found in %: UPDATE list', v_patch.sig;
      END IF;
      v_new := replace(v_new, 'apply_to_product = v_apply, notes = v_notes',
        'apply_to_product = v_apply, notes = v_notes, logistics_cost = v_logistics, product_type = COALESCE(v_product_type, product_type)');
    END IF;

    EXECUTE v_new;
  END LOOP;
END $$;
