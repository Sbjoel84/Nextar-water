-- ============================================================================
-- Approving a supplier deletion failed with:
--   update or delete on table "suppliers" violates foreign key constraint
--   "raw_materials_supplier_fk" on table "raw_materials"
-- ----------------------------------------------------------------------------
-- approve_delete() hard-deletes the supplier row (it is snapshotted to the
-- recycle bin first), but raw_materials.supplier_id -- each material's
-- default/usual supplier -- still pointed at it.
--
-- Before a supplier row is deleted:
--   * raw materials that list it as their usual supplier are set to "no
--     supplier". That link is only a default for new receipts, nothing
--     historical is lost.
--   * if the supplier has purchase history (purchase orders, goods receipts,
--     goods received notes, purchase requests), the delete is refused with a
--     readable message instead of a raw foreign-key error -- those records
--     must keep naming who supplied the goods. Because approve_delete() runs
--     in one transaction, the request simply stays pending and nothing changes.
--
-- Note: restoring a deleted supplier from the recycle bin brings the supplier
-- back but does not re-attach it to the materials as their usual supplier.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.suppliers_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po int;
  v_gr int;
  v_grn int;
  v_req int;
BEGIN
  SELECT count(*) INTO v_po  FROM purchase_orders     WHERE supplier_id = OLD.id;
  SELECT count(*) INTO v_gr  FROM goods_receipts      WHERE supplier_id = OLD.id;
  SELECT count(*) INTO v_grn FROM goods_received_notes WHERE supplier_id = OLD.id;
  SELECT count(*) INTO v_req FROM production_requests WHERE supplier_id = OLD.id;

  IF v_po + v_gr + v_grn + v_req > 0 THEN
    RAISE EXCEPTION
      'Supplier "%" can''t be deleted: it has purchase history (% purchase order(s), % goods receipt(s), % goods received note(s), % purchase request(s)). Reject this request, or keep the supplier.',
      OLD.name, v_po, v_gr, v_grn, v_req;
  END IF;

  UPDATE raw_materials SET supplier_id = NULL WHERE supplier_id = OLD.id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.suppliers_before_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_suppliers_before_delete ON public.suppliers;
CREATE TRIGGER trg_suppliers_before_delete
BEFORE DELETE ON public.suppliers
FOR EACH ROW EXECUTE FUNCTION public.suppliers_before_delete();
