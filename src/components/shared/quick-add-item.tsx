import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";
import {
  PRODUCT_LINES,
  productNameFor,
  skuLabelFor,
  PRODUCT_VARIANTS,
  needsSku,
  unitFor,
} from "@/lib/product-lines";
import { SkuField } from "@/components/shared/sku-field";
import { ProductUnitSelect } from "@/components/shared/unit-select";
import { useUnitsOfMeasure, UNIT_OPTIONS as UNIT_OPTIONS_FALLBACK } from "@/lib/units";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Sentinel value for the "+ Add new …" entry that sits at the bottom of the
// product / material dropdowns. Selects intercept it before touching state.
export const ADD_NEW_ITEM = "__add_new__";

// A newly added product or material is saved for real (same tables the
// Finished Goods / Raw Materials pages read), including the cost typed here.
// The cost is stored as-is and only changes when someone edits that
// product / material later.
function refreshItemLists(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({
    predicate: (q) => {
      const k = String(q.queryKey[0] ?? "");
      return (
        k.startsWith("products") || k.startsWith("raw-materials") || k.startsWith("dist-products")
      );
    },
  });
}

// Unit of a new raw material: picked from the configured units, with no
// default and no free-typed entry, so every material is registered with its
// own unit.
function UnitField({ unit, setUnit }: { unit: string; setUnit: (v: string) => void }) {
  const unitsOfMeasure = useUnitsOfMeasure();
  const unitOptions = unitsOfMeasure.data ?? UNIT_OPTIONS_FALLBACK;
  return (
    <div>
      <Label>Unit of measurement</Label>
      <Select value={unit || undefined} onValueChange={setUnit}>
        <SelectTrigger>
          <SelectValue placeholder="Select unit…" />
        </SelectTrigger>
        <SelectContent>
          {unitOptions.map((u) => (
            <SelectItem key={u} value={u} className="capitalize">
              {u}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function QuickAddProductDialog({
  open,
  onOpenChange,
  factoryId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  factoryId: string;
  onCreated?: (id: string) => void;
  // Kept for existing callers: a new product always starts at zero stock now
  // (the production batch brings stock in once Store confirms it).
  hideOpeningStock?: boolean;
}) {
  const qc = useQueryClient();
  // Same fields as the Store's product form: product type + SKU only. Prices
  // come from an approved Costing sheet; unit, type and stock use defaults.
  const [productLine, setProductLine] = useState("");
  const [sku, setSku] = useState("");
  const name = productNameFor(productLine, sku);
  const skuLabel = skuLabelFor(productLine);
  // The product type's usual unit until one is picked.
  const [unit, setUnit] = useState<string | null>(null);
  const unitValue = unit ?? unitFor(productLine);

  useEffect(() => {
    if (open) {
      setProductLine("");
      setSku("");
      setUnit(null);
    }
  }, [open]);

  const save = useMutation({
    mutationFn: async () => {
      if (!productLine) throw new Error("Select the product type");
      if (needsSku(productLine) && !sku.trim()) throw new Error(`Enter the ${skuLabel}`);
      if (!unitValue.trim()) throw new Error("Select or enter a unit");
      // The name is fixed by type + SKU, so the same product can't be added twice.
      const { data: existing } = await supabase
        .from("products")
        .select("id")
        .eq("factory_id", factoryId)
        .eq("active", true)
        .ilike("name", name)
        .limit(1);
      if (existing?.length) throw new Error(`"${name}" already exists — select it from the list`);
      // Goes through an RPC (permission-checked server side) because the
      // products table itself only lets Finished Goods writers insert.
      const { data, error } = await supabase.rpc(
        "quick_add_product" as any,
        {
          payload: {
            factory_id: factoryId,
            name,
            sku: sku.trim() || null,
            product_type: "finished",
            unit: unitValue.trim(),
            unit_price: 0,
            cost_price: 0,
            current_stock: 0,
          },
        } as any,
      );
      if (error) throw error;
      return (data as { id: string }).id;
    },
    onSuccess: (id) => {
      toast.success(`"${name}" added`);
      logAudit({
        action: "create",
        entity: "products",
        entityId: id,
        factoryId,
        newValue: { name, sku: sku.trim() },
      });
      refreshItemLists(qc);
      onCreated?.(id);
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Product</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Product Type</Label>
              <Select
                value={productLine || undefined}
                onValueChange={(v) => {
                  setProductLine(v);
                  const variants = PRODUCT_VARIANTS[v];
                  if ((variants && !variants.includes(sku)) || !needsSku(v)) setSku("");
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select product type…" />
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_LINES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <SkuField productLine={productLine} value={sku} onChange={setSku} />
            <ProductUnitSelect value={unitValue} onChange={setUnit} />
          </div>
          <p className="text-xs text-muted-foreground">
            {name ? (
              <>
                Saved as <strong>{name}</strong> · Finished product, product ID assigned
                automatically.{" "}
              </>
            ) : null}
            Starts at zero stock — the production batch adds stock once Store confirms it. Set its
            selling price on Costing → Product Prices before it can be sold.
          </p>
        </div>
        <DialogFooter>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Add product"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function QuickAddMaterialDialog({
  open,
  onOpenChange,
  factoryId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  factoryId: string;
  onCreated?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [unitCost, setUnitCost] = useState(0);
  const [openingStock, setOpeningStock] = useState(0);
  const [reorderLevel, setReorderLevel] = useState(0);

  useEffect(() => {
    if (open) {
      setName("");
      setUnit("");
      setUnitCost(0);
      setOpeningStock(0);
      setReorderLevel(0);
    }
  }, [open]);

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Material name is required");
      if (!unit.trim()) throw new Error("Select the unit of measurement");
      const { data, error } = await supabase.rpc("request_new_material", {
        payload: {
          factory_id: factoryId,
          name: name.trim(),
          unit: unit.trim(),
          unit_cost: unitCost,
          opening_stock: openingStock,
          reorder_level: reorderLevel,
        } as any,
      });
      if (error) throw error;
      return (data as { id: string }).id;
    },
    onSuccess: (id) => {
      toast.success(`"${name.trim()}" added`);
      logAudit({
        action: "create",
        entity: "raw_materials",
        entityId: id,
        factoryId,
        newValue: { name: name.trim(), unit: unit.trim(), unit_cost: unitCost },
      });
      refreshItemLists(qc);
      onCreated?.(id);
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Raw Material</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label>Raw material name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <UnitField unit={unit} setUnit={setUnit} />
            <div>
              <Label>Unit cost</Label>
              <MoneyInput value={unitCost} onChange={setUnitCost} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Opening stock</Label>
              <MoneyInput min={0} step="0.001" value={openingStock} onChange={setOpeningStock} />
            </div>
            <div>
              <Label>Reorder level</Label>
              <MoneyInput min={0} step="0.001" value={reorderLevel} onChange={setReorderLevel} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            The unit cost is saved with the material and stays until someone changes it on the Raw
            Materials page.
          </p>
        </div>
        <DialogFooter>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Add material"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
