-- ============================================================================
-- Goods Received Note (GRN)
-- ----------------------------------------------------------------------------
-- Mirrors the printed Nextar GRN booklet used at the gate/store: one note per
-- supplier delivery, with delivery details (LPO no., delivery note/invoice
-- no., vehicle, driver), several item lines (ordered / received / rejected,
-- condition, remark), a quality inspection block, discrepancies, and four
-- signatories (Store Keeper, Internal Control, Supplier/Driver, Security).
--
-- The note is a header only. Every item line is an ordinary goods_receipts
-- row (linked by grn_id) submitted through submit_goods_receipt(), so the
-- existing dual-control confirmation, stock posting, PO matching and damage
-- ledger all apply unchanged. "Qty rejected" is the receipt's
-- damaged_quantity: it never reaches stock and is logged to damage_records.
-- ============================================================================

-- ============ 1. goods_received_notes ============
CREATE TABLE public.goods_received_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  grn_number text NOT NULL,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id),
  date_received date NOT NULL DEFAULT current_date,
  time_received time,
  lpo_number text,
  delivery_note_number text,
  supplier_phone text,
  vehicle_number text,
  driver_name text,
  overall_condition text CHECK (overall_condition IN ('excellent','good','fair','poor')),
  packaging_condition text CHECK (packaging_condition IN ('intact','damaged','open')),
  expiry_date date,
  discrepancies text,
  received_by_name text NOT NULL,
  received_by_designation text,
  inspected_by_name text,
  inspected_by_designation text,
  delivered_by_name text,
  verified_by_name text,
  verified_by_designation text,
  submitted_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (factory_id, grn_number)
);
CREATE INDEX goods_received_notes_supplier_idx ON public.goods_received_notes(supplier_id, date_received DESC);

GRANT SELECT ON public.goods_received_notes TO authenticated;
GRANT ALL ON public.goods_received_notes TO service_role;
ALTER TABLE public.goods_received_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "goods received notes read" ON public.goods_received_notes FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'suppliers'::module_key, 'view'::action_key)
  );
-- No INSERT/UPDATE policy: RPC-only, same as goods_receipts.

-- ============ 2. goods_receipts: GRN line details ============
ALTER TABLE public.goods_receipts
  ADD COLUMN grn_id uuid REFERENCES public.goods_received_notes(id),
  ADD COLUMN ordered_quantity numeric(14,3),
  ADD COLUMN item_condition text;
CREATE INDEX goods_receipts_grn_idx ON public.goods_receipts(grn_id);

-- ============ 3. submit_goods_received_note() ============
-- payload: { supplier_id, date_received, time_received, lpo_number,
--   delivery_note_number, supplier_phone, vehicle_number, driver_name,
--   overall_condition, packaging_condition, expiry_date, discrepancies,
--   received_by_name, received_by_designation, inspected_by_name,
--   inspected_by_designation, delivered_by_name, verified_by_name,
--   verified_by_designation,
--   items: [{ purchase_order_id?, material_id?, ordered_quantity?, quantity,
--             rejected_quantity?, unit_cost?, item_condition?, remark? }] }
CREATE OR REPLACE FUNCTION public.submit_goods_received_note(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_supplier suppliers%ROWTYPE;
  v_items jsonb := COALESCE(payload->'items', '[]'::jsonb);
  v_item jsonb;
  v_po purchase_orders%ROWTYPE;
  v_po_id uuid;
  v_material_id uuid;
  v_material_factory uuid;
  v_next int;
  v_number text;
  v_id uuid;
  v_receipt jsonb;
BEGIN
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;

  SELECT * INTO v_supplier FROM suppliers WHERE id = NULLIF(payload->>'supplier_id','')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found'; END IF;
  IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one item received';
  END IF;
  IF btrim(COALESCE(payload->>'received_by_name','')) = '' THEN
    RAISE EXCEPTION 'Enter the name of the store keeper receiving the goods';
  END IF;

  -- Sequential GRN number per factory (0001, 0002, ...), like the booklet.
  PERFORM pg_advisory_xact_lock(hashtext('grn:' || v_supplier.factory_id::text));
  SELECT COALESCE(MAX(grn_number::int), 0) + 1 INTO v_next
  FROM goods_received_notes WHERE factory_id = v_supplier.factory_id AND grn_number ~ '^[0-9]+$';
  v_number := lpad(v_next::text, 4, '0');

  INSERT INTO goods_received_notes(
    factory_id, grn_number, supplier_id, date_received, time_received, lpo_number, delivery_note_number,
    supplier_phone, vehicle_number, driver_name, overall_condition, packaging_condition, expiry_date,
    discrepancies, received_by_name, received_by_designation, inspected_by_name, inspected_by_designation,
    delivered_by_name, verified_by_name, verified_by_designation, submitted_by)
  VALUES (
    v_supplier.factory_id, v_number, v_supplier.id,
    COALESCE(NULLIF(payload->>'date_received','')::date, current_date),
    NULLIF(payload->>'time_received','')::time,
    NULLIF(btrim(payload->>'lpo_number'),''),
    NULLIF(btrim(payload->>'delivery_note_number'),''),
    NULLIF(btrim(payload->>'supplier_phone'),''),
    NULLIF(btrim(payload->>'vehicle_number'),''),
    NULLIF(btrim(payload->>'driver_name'),''),
    NULLIF(payload->>'overall_condition',''),
    NULLIF(payload->>'packaging_condition',''),
    NULLIF(payload->>'expiry_date','')::date,
    NULLIF(btrim(payload->>'discrepancies'),''),
    btrim(payload->>'received_by_name'),
    NULLIF(btrim(payload->>'received_by_designation'),''),
    NULLIF(btrim(payload->>'inspected_by_name'),''),
    NULLIF(btrim(payload->>'inspected_by_designation'),''),
    NULLIF(btrim(payload->>'delivered_by_name'),''),
    NULLIF(btrim(payload->>'verified_by_name'),''),
    NULLIF(btrim(payload->>'verified_by_designation'),''),
    v_uid)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_po_id := NULLIF(v_item->>'purchase_order_id','')::uuid;
    v_material_id := NULLIF(v_item->>'material_id','')::uuid;

    IF v_po_id IS NOT NULL THEN
      SELECT * INTO v_po FROM purchase_orders WHERE id = v_po_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
      IF v_po.supplier_id IS NOT NULL AND v_po.supplier_id <> v_supplier.id THEN
        RAISE EXCEPTION 'Purchase order % belongs to a different supplier', v_po.po_number;
      END IF;
      v_material_id := v_po.material_id;
    END IF;
    IF v_material_id IS NULL THEN RAISE EXCEPTION 'Select the item received on every line'; END IF;

    SELECT factory_id INTO v_material_factory FROM raw_materials WHERE id = v_material_id;
    IF v_material_factory IS DISTINCT FROM v_supplier.factory_id THEN
      RAISE EXCEPTION 'Item does not belong to this supplier''s factory';
    END IF;

    v_receipt := public.submit_goods_receipt(jsonb_build_object(
      'purchase_order_id', v_po_id,
      'material_id', v_material_id,
      'supplier_id', v_supplier.id,
      'quantity', v_item->'quantity',
      'damaged_quantity', COALESCE(v_item->'rejected_quantity', '0'::jsonb),
      'unit_cost', v_item->'unit_cost',
      'delivery_reference', COALESCE(NULLIF(btrim(payload->>'delivery_note_number'),''), 'GRN ' || v_number),
      'remarks', COALESCE(NULLIF(btrim(v_item->>'remark'),''), 'GRN ' || v_number)
    ));

    UPDATE goods_receipts SET
      grn_id = v_id,
      ordered_quantity = COALESCE(NULLIF(v_item->>'ordered_quantity','')::numeric,
                                  CASE WHEN v_po_id IS NOT NULL THEN v_po.quantity_ordered END),
      item_condition = NULLIF(btrim(v_item->>'item_condition'),'')
    WHERE id = (v_receipt->>'id')::uuid;
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_supplier.factory_id, 'submit_goods_received_note', 'goods_received_notes', v_id::text,
          jsonb_build_object('grn_number', v_number, 'supplier', v_supplier.name, 'items', jsonb_array_length(v_items)));

  RETURN jsonb_build_object('id', v_id, 'grn_number', v_number);
END; $$;
GRANT EXECUTE ON FUNCTION public.submit_goods_received_note(jsonb) TO authenticated;

-- ============ 4. confirm / reject a whole GRN ============
-- Runs the existing per-line RPCs, so their permission and dual-control
-- (different person) checks still apply to every line.
CREATE OR REPLACE FUNCTION public.confirm_goods_received_note(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_line uuid;
  v_count int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM goods_received_notes WHERE id = p_id) THEN RAISE EXCEPTION 'Goods received note not found'; END IF;
  FOR v_line IN
    SELECT id FROM goods_receipts WHERE grn_id = p_id AND status = 'pending_confirmation' ORDER BY receipt_number
  LOOP
    PERFORM public.confirm_goods_receipt(v_line, p_comment);
    v_count := v_count + 1;
  END LOOP;
  IF v_count = 0 THEN RAISE EXCEPTION 'Nothing on this note is awaiting confirmation'; END IF;
  RETURN jsonb_build_object('confirmed', v_count);
END; $$;
GRANT EXECUTE ON FUNCTION public.confirm_goods_received_note(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_goods_received_note(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_line uuid;
  v_count int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM goods_received_notes WHERE id = p_id) THEN RAISE EXCEPTION 'Goods received note not found'; END IF;
  FOR v_line IN
    SELECT id FROM goods_receipts WHERE grn_id = p_id AND status = 'pending_confirmation' ORDER BY receipt_number
  LOOP
    PERFORM public.reject_goods_receipt(v_line, p_reason);
    v_count := v_count + 1;
  END LOOP;
  IF v_count = 0 THEN RAISE EXCEPTION 'Nothing on this note is awaiting confirmation'; END IF;
  RETURN jsonb_build_object('rejected', v_count);
END; $$;
GRANT EXECUTE ON FUNCTION public.reject_goods_received_note(uuid, text) TO authenticated;
