import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import { usePermissions } from "@/lib/permissions";
import { useFactoryId } from "@/lib/use-factory";
import { useHydratedFactoryCode } from "@/lib/factory-store";
import { money, num } from "@/lib/format";
import { logAudit } from "@/lib/audit";
import { WORKFLOW_STATUS_LABELS, type WorkflowStatus } from "@/lib/workflow";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Trash2, Ban, Check, X, Pencil, Droplet } from "lucide-react";
import { RefId } from "@/components/shared/ref-id";
import { SearchBox } from "@/components/shared/search-box";
import { matchesSearch, useSearchQuery } from "@/lib/search";

export const Route = createFileRoute("/_app/costing")({
  head: () => ({ meta: [{ title: "Costing — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="costing">
      <CostingPage />
    </RequireAccess>
  ),
});

// Costing sheets are water-line only, filtered to water-tagged products/materials.
type SheetType = "water";
// Which product template a sheet was built from (see TEMPLATES below).
type ProductType = "bottle" | "dispenser" | "sachet";

type ProductRow = {
  id: string;
  name: string;
  unit: string;
  product_categories: { product_line: string | null } | null;
};
type MaterialRow = {
  id: string;
  name: string;
  unit: string;
  unit_cost: number;
  material_categories: { product_line: string | null } | null;
};

type Sheet = {
  id: string;
  sheet_number: string;
  product_id: string;
  sheet_type: SheetType | null;
  product_type: ProductType | null;
  logistics_cost: number;
  yield_quantity: number;
  material_cost: number;
  labor_cost: number;
  overhead_cost: number;
  overhead_percent: number | null;
  pack_quantity: number;
  pack_cost: number;
  cost_per_pack: number;
  total_cost: number;
  unit_cost: number;
  apply_to_product: boolean;
  is_applied: boolean;
  status: WorkflowStatus;
  created_by: string | null;
  notes: string | null;
  created_at: string;
  products: { name: string; unit: string } | null;
};

const statusBadge = (s: WorkflowStatus): "default" | "secondary" | "outline" | "destructive" => {
  if (s === "posted") return "secondary";
  if (s === "rejected" || s === "cancelled") return "destructive";
  return "outline";
};

function PriceOptionsEditor({
  priceOptions,
  setPriceOptions,
  costBasis,
}: {
  priceOptions: string[];
  setPriceOptions: (v: string[]) => void;
  costBasis: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Proposed selling prices</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setPriceOptions([...priceOptions, ""])}
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Add price
        </Button>
      </div>
      {priceOptions.map((p, i) => {
        const price = Number(p);
        const margin = price > 0 ? price - costBasis : null;
        return (
          <div key={i} className="flex items-center gap-2">
            <MoneyInput
              className="flex-1"
              placeholder="Proposed price"
              value={Number(p) || 0}
              onChange={(v) =>
                setPriceOptions(priceOptions.map((x, j) => (j === i ? String(v) : x)))
              }
            />
            {margin !== null && (
              <span
                className={`w-32 shrink-0 text-xs ${margin >= 0 ? "text-success" : "text-destructive"}`}
              >
                margin {money(margin)} (
                {costBasis > 0 ? ((margin / costBasis) * 100).toFixed(1) : "0"}%)
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setPriceOptions(priceOptions.filter((_, j) => j !== i))}
              disabled={priceOptions.length === 1}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function CostingPage() {
  const [q, setQ] = useSearchQuery();
  const qc = useQueryClient();
  const { canSubmit, canEdit, canCancel, canApprove, canReject } = usePermissions();
  const factory = useFactoryId();
  const factoryId = factory.data;
  const activeCode = useHydratedFactoryCode();
  const submitPerm = canSubmit("costing");
  const editPerm = canEdit("costing");
  const cancelPerm = canCancel("costing");
  const approvePerm = canApprove("costing");
  const rejectPerm = canReject("costing");

  const [showCreate, setShowCreate] = useState(false);
  const [editingSheet, setEditingSheet] = useState<Sheet | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Sheet | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const products = useQuery({
    queryKey: ["costing-products", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,unit,product_categories(product_line)")
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as ProductRow[];
    },
  });

  const materials = useQuery({
    queryKey: ["costing-materials", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials")
        .select("id,name,unit,unit_cost,material_categories(product_line)")
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .eq("approval_status", "approved")
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as MaterialRow[];
    },
  });

  const waterProducts = (products.data ?? []).filter(
    (p) => p.product_categories?.product_line === "water",
  );
  const waterMaterials = (materials.data ?? []).filter(
    (m) => m.material_categories?.product_line === "water",
  );

  const sheets = useQuery({
    queryKey: ["costing-sheets", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("costing_sheets")
        .select(
          "id,sheet_number,product_id,sheet_type,product_type,logistics_cost,yield_quantity,material_cost,labor_cost,overhead_cost,overhead_percent,pack_quantity,pack_cost,cost_per_pack,total_cost,unit_cost,apply_to_product,is_applied,status,created_by,notes,created_at,products(name,unit)",
        )
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as Sheet[];
    },
  });

  const pendingSheets = (sheets.data ?? []).filter((s) => s.status === "pending_approval");

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["costing-sheets"] });
    qc.invalidateQueries({ queryKey: ["costing-products"] });
  };

  const cancelSheet = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("cancel_costing_sheet", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Costing sheet cancelled");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const approveSheet = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("approve_costing_sheet", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Approved — cost applied to product");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectSheet = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc("reject_costing_sheet", { p_id: id, p_reason: reason });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Costing sheet rejected");
      setRejectTarget(null);
      setRejectReason("");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pageLabel = "Costing";
  const pageDesc =
    "Cost Bottle, Dispenser and Sachet Water from their raw materials, labour and logistics — submitted for approval before applying to the live cost price.";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{pageLabel}</h1>
          <p className="text-sm text-muted-foreground">{pageDesc}</p>
        </div>
        {submitPerm && activeCode && (
          <Button onClick={() => setShowCreate(true)}>
            <Droplet className="mr-2 h-4 w-4" />
            New Costing Sheet
          </Button>
        )}
      </div>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Costing history</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <SearchBox value={q} onChange={setQ} className="mb-3" />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Sheet #</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Yield</TableHead>
                <TableHead>Material</TableHead>
                <TableHead>Unit Cost</TableHead>
                <TableHead>Cost/Pack</TableHead>
                <TableHead>Applied</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(sheets.data ?? [])
                .filter((x) => matchesSearch(q, x))
                .map((s) => {
                  const isSelf = s.created_by === currentUser.data;
                  return (
                    <TableRow key={s.id}>
                      <TableCell>
                        <RefId id={s.id} />
                      </TableCell>
                      <TableCell className="font-medium">{s.sheet_number}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {TEMPLATES[s.product_type ?? "bottle"].label}
                      </TableCell>
                      <TableCell>{s.products?.name ?? "—"}</TableCell>
                      <TableCell>
                        {num(s.yield_quantity)} {s.products?.unit}
                      </TableCell>
                      <TableCell>{money(s.material_cost)}</TableCell>
                      <TableCell>{money(s.unit_cost)}</TableCell>
                      <TableCell className="font-medium">{money(s.cost_per_pack)}</TableCell>
                      <TableCell>{s.is_applied ? "Yes" : "No"}</TableCell>
                      <TableCell>
                        <Badge variant={statusBadge(s.status)}>
                          {WORKFLOW_STATUS_LABELS[s.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        {new Date(s.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        {s.status === "pending_approval" && (
                          <div className="flex justify-end gap-1">
                            {editPerm && isSelf && s.sheet_type && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Edit"
                                onClick={() => setEditingSheet(s)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            )}
                            {cancelPerm && isSelf && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Cancel"
                                onClick={() => cancelSheet.mutate(s.id)}
                              >
                                <Ban className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            )}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              {(sheets.data?.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={12} className="text-center text-muted-foreground py-8">
                    No costing sheets yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {pendingSheets.length > 0 && (approvePerm || rejectPerm) && (
        <Card className="rounded-2xl border-dashed">
          <CardHeader>
            <CardTitle>Pending Costing Sheets to Approve</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <SearchBox value={q} onChange={setQ} className="mb-3" />
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Sheet #</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Cost / Pack</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingSheets
                  .filter((x) => matchesSearch(q, x))
                  .map((s) => {
                    const isSelf = s.created_by === currentUser.data;
                    return (
                      <TableRow key={s.id}>
                        <TableCell>
                          <RefId id={s.id} />
                        </TableCell>
                        <TableCell className="font-medium">{s.sheet_number}</TableCell>
                        <TableCell>{s.products?.name ?? "—"}</TableCell>
                        <TableCell className="text-right">{money(s.cost_per_pack)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(s.created_at).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            {approvePerm && !isSelf && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Approve & Apply"
                                onClick={() => approveSheet.mutate(s.id)}
                              >
                                <Check className="h-4 w-4 text-success" />
                              </Button>
                            )}
                            {rejectPerm && !isSelf && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Reject"
                                onClick={() => setRejectTarget(s)}
                              >
                                <X className="h-4 w-4 text-destructive" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {showCreate && activeCode === "water" && (
        <CostingDialog
          factoryId={factoryId!}
          products={waterProducts}
          materials={waterMaterials}
          editing={null}
          onClose={() => setShowCreate(false)}
        />
      )}
      {editingSheet?.sheet_type === "water" && (
        <CostingDialog
          factoryId={factoryId!}
          products={waterProducts}
          materials={waterMaterials}
          editing={editingSheet}
          onClose={() => setEditingSheet(null)}
        />
      )}

      <Dialog
        open={!!rejectTarget}
        onOpenChange={(v) => {
          if (!v) {
            setRejectTarget(null);
            setRejectReason("");
          }
        }}
      >
        {rejectTarget && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reject {rejectTarget.sheet_number}</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <Label>Reason *</Label>
              <Textarea
                rows={3}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Explain what looks wrong…"
              />
            </div>
            <DialogFooter>
              <Button
                variant="destructive"
                disabled={!rejectReason.trim() || rejectSheet.isPending}
                onClick={() =>
                  rejectSheet.mutate({ id: rejectTarget.id, reason: rejectReason.trim() })
                }
              >
                {rejectSheet.isPending ? "Rejecting…" : "Reject Sheet"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

// ============================================================================
// COSTING SHEET — pick a product type, and its raw materials, units, labour
// and logistics are laid out ready to fill in.
// ============================================================================

// How a material's quantity is entered: for the whole batch (e.g. kg of
// preform), per finished unit (one cap per bottle), or per pack (one bag per
// 20 sachets). It is always submitted as the batch total.
type QtyBasis = "batch" | "per_unit" | "per_pack";

type MaterialSlot = {
  role: string;
  label: string;
  basis: QtyBasis;
  defaultQty: number;
  // Picks the matching raw material automatically when the type is chosen.
  match: RegExp;
};

type TypeTemplate = {
  label: string;
  unit: string; // one finished unit
  units: string;
  pack: string;
  packQty: number;
  packCostLabel: string;
  packCost: number;
  contentPercent: number;
  productMatch: RegExp;
  slots: MaterialSlot[];
};

const TEMPLATES: Record<ProductType, TypeTemplate> = {
  bottle: {
    label: "Bottle Water",
    unit: "bottle",
    units: "bottles",
    pack: "carton",
    packQty: 12,
    packCostLabel: "Shrink wrapper (₦ per carton)",
    packCost: 100,
    contentPercent: 10,
    productMatch: /bottle|\d+\s*cl\b|\bpet\b/i,
    slots: [
      { role: "preform", label: "Preform", basis: "batch", defaultQty: 0, match: /preform/i },
      { role: "cap", label: "Cap", basis: "per_unit", defaultQty: 1, match: /cap/i },
      { role: "label", label: "Label", basis: "per_unit", defaultQty: 1, match: /label/i },
    ],
  },
  dispenser: {
    label: "Dispenser Water",
    unit: "dispenser",
    units: "dispensers",
    pack: "unit",
    packQty: 1,
    packCostLabel: "Other packaging (₦ per dispenser)",
    packCost: 0,
    contentPercent: 0,
    productMatch: /dispenser|gallon|keg|(18\.9|19|20)\s*(l|lt|ltr|litre|liter)s?\b/i,
    slots: [
      {
        role: "dispenser_bottle",
        label: "Dispenser bottle (jar)",
        basis: "per_unit",
        defaultQty: 1,
        match: /dispenser|jar|keg|gallon|18\.9|19\s*l/i,
      },
      { role: "cap", label: "Cap", basis: "per_unit", defaultQty: 1, match: /cap/i },
      {
        role: "seal",
        label: "Seal / shrink band",
        basis: "per_unit",
        defaultQty: 1,
        match: /seal|band|shrink/i,
      },
      { role: "label", label: "Label", basis: "per_unit", defaultQty: 1, match: /label/i },
    ],
  },
  sachet: {
    label: "Sachet Water",
    unit: "sachet",
    units: "sachets",
    pack: "bag",
    packQty: 20,
    packCostLabel: "Other packing (₦ per bag)",
    packCost: 0,
    contentPercent: 0,
    productMatch: /sachet|pure\s*water/i,
    slots: [
      {
        role: "sachet_film",
        label: "Sachet film (roll)",
        basis: "batch",
        defaultQty: 0,
        match: /sachet|film|roll/i,
      },
      {
        role: "packing_bag",
        label: "Packing bag",
        basis: "per_pack",
        defaultQty: 1,
        match: /bag|nylon/i,
      },
    ],
  },
};
const PRODUCT_TYPES = Object.keys(TEMPLATES) as ProductType[];

type SlotState = { role: string; materialId: string; qty: string };
type ExtraLine = { materialId: string; qty: string };

function autoSlots(t: TypeTemplate, materials: MaterialRow[]): SlotState[] {
  const used = new Set<string>();
  return t.slots.map((s) => {
    const m = materials.find((x) => s.match.test(x.name) && !used.has(x.id));
    if (m) used.add(m.id);
    return { role: s.role, materialId: m?.id ?? "", qty: s.defaultQty ? String(s.defaultQty) : "" };
  });
}

function CostingDialog({
  factoryId,
  products,
  materials,
  editing,
  onClose,
}: {
  factoryId: string;
  products: ProductRow[];
  materials: MaterialRow[];
  editing: Sheet | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [productType, setProductType] = useState<ProductType>(editing?.product_type ?? "bottle");
  const t = TEMPLATES[productType];
  const [productId, setProductId] = useState(editing?.product_id ?? "");
  const [yieldQty, setYieldQty] = useState(editing ? String(editing.yield_quantity) : "");
  const [slots, setSlots] = useState<SlotState[]>(() =>
    editing
      ? t.slots.map((s) => ({ role: s.role, materialId: "", qty: "" }))
      : autoSlots(t, materials),
  );
  const [extras, setExtras] = useState<ExtraLine[]>([]);
  const [labour, setLabour] = useState(editing ? String(editing.labor_cost) : "");
  const [logistics, setLogistics] = useState(editing ? String(editing.logistics_cost ?? 0) : "");
  const [contentPercent, setContentPercent] = useState(
    editing?.overhead_percent != null ? String(editing.overhead_percent) : String(t.contentPercent),
  );
  const [packQty, setPackQty] = useState(
    editing ? String(editing.pack_quantity) : String(t.packQty),
  );
  const [packCost, setPackCost] = useState(
    editing ? String(editing.pack_cost) : String(t.packCost),
  );
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [applyToProduct, setApplyToProduct] = useState(editing?.apply_to_product ?? true);
  const [priceOptions, setPriceOptions] = useState<string[]>([""]);
  const [loaded, setLoaded] = useState(!editing);

  const yieldN = Number(yieldQty) || 0;
  const packQtyN = Number(packQty) || 1;
  const packs = yieldN / packQtyN;

  // Choosing a type lays out that type's materials and defaults.
  const changeType = (next: ProductType) => {
    const nt = TEMPLATES[next];
    setProductType(next);
    setSlots(autoSlots(nt, materials));
    setExtras([]);
    setContentPercent(String(nt.contentPercent));
    setPackQty(String(nt.packQty));
    setPackCost(String(nt.packCost));
    const current = products.find((p) => p.id === productId);
    if (current && !nt.productMatch.test(current.name)) setProductId("");
  };

  // A new sheet opened before the material list arrived: pick them once it has.
  useEffect(() => {
    if (!editing && materials.length > 0 && slots.every((x) => !x.materialId)) {
      setSlots(autoSlots(t, materials));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materials.length]);

  // Editing: rebuild the per-unit / per-pack figures from the stored batch totals.
  useEffect(() => {
    if (!editing) return;
    (async () => {
      const { data: items } = await supabase
        .from("costing_sheet_items")
        .select("material_id,quantity,role")
        .eq("sheet_id", editing.id);
      const tpl = TEMPLATES[editing.product_type ?? "bottle"];
      const y = Number(editing.yield_quantity) || 1;
      const p = y / (Number(editing.pack_quantity) || 1);
      const rows = items ?? [];
      setSlots(
        tpl.slots.map((s) => {
          const it = rows.find((i) => i.role === s.role);
          if (!it) return { role: s.role, materialId: "", qty: "" };
          const q = Number(it.quantity);
          const shown = s.basis === "batch" ? q : s.basis === "per_unit" ? q / y : q / p;
          return { role: s.role, materialId: it.material_id, qty: String(+shown.toFixed(4)) };
        }),
      );
      setExtras(
        rows
          .filter((i) => !tpl.slots.some((s) => s.role === i.role))
          .map((i) => ({ materialId: i.material_id, qty: String(i.quantity) })),
      );
      const { data: options } = await supabase
        .from("costing_price_options")
        .select("proposed_price")
        .eq("sheet_id", editing.id);
      setPriceOptions(
        (options ?? []).length > 0 ? (options ?? []).map((o) => String(o.proposed_price)) : [""],
      );
      setLoaded(true);
    })();
  }, [editing]);

  const materialById = (id: string) => materials.find((m) => m.id === id);
  const batchQty = (s: MaterialSlot, qty: number) =>
    s.basis === "batch" ? qty : s.basis === "per_unit" ? qty * yieldN : qty * packs;

  const lines = [
    ...t.slots.map((s, i) => {
      const st = slots[i] ?? { role: s.role, materialId: "", qty: "" };
      const m = materialById(st.materialId);
      const quantity = batchQty(s, Number(st.qty) || 0);
      return { role: s.role, label: s.label, m, quantity, cost: quantity * (m?.unit_cost ?? 0) };
    }),
    ...extras.map((e) => {
      const m = materialById(e.materialId);
      const quantity = Number(e.qty) || 0;
      return {
        role: "other",
        label: m?.name ?? "Other",
        m,
        quantity,
        cost: quantity * (m?.unit_cost ?? 0),
      };
    }),
  ];
  const materialCost = lines.reduce((sum, l) => sum + l.cost, 0);
  const contentCost = (materialCost * (Number(contentPercent) || 0)) / 100;
  const labourN = Number(labour) || 0;
  const logisticsN = Number(logistics) || 0;
  const packCostN = Number(packCost) || 0;
  const totalBatch = materialCost + contentCost + labourN + logisticsN;
  const costPerUnit = yieldN > 0 ? totalBatch / yieldN : 0;
  const costPerPack = costPerUnit * packQtyN + packCostN;

  const typeProducts = products.filter((p) => t.productMatch.test(p.name));
  const productChoices = typeProducts.length > 0 ? typeProducts : products;

  const buildPayload = () => ({
    factory_id: factoryId,
    product_id: productId,
    sheet_type: "water",
    product_type: productType,
    yield_quantity: yieldN,
    labor_cost: labourN,
    logistics_cost: logisticsN,
    overhead_cost: 0,
    overhead_percent: Number(contentPercent) || 0,
    pack_quantity: packQtyN,
    pack_cost: packCostN,
    apply_to_product: applyToProduct,
    notes: notes || null,
    items: lines
      .filter((l) => l.m && l.quantity > 0)
      .map((l) => ({ material_id: l.m!.id, quantity: +l.quantity.toFixed(4), role: l.role })),
    price_options: priceOptions
      .filter((p) => p.trim() !== "" && Number(p) >= 0)
      .map((p) => ({ proposed_price: Number(p) })),
  });

  const submit = useMutation({
    mutationFn: async () => {
      const payload = buildPayload();
      if (editing) {
        const { data, error } = await supabase.rpc("update_costing_sheet", {
          payload: { id: editing.id, ...payload },
        });
        if (error) throw error;
        return data as { id: string; unit_cost: number; cost_per_pack: number };
      }
      const { data, error } = await supabase.rpc("submit_costing_sheet", { payload });
      if (error) throw error;
      return data as { id: string; sheet_number: string; unit_cost: number; cost_per_pack: number };
    },
    onSuccess: (result: {
      id: string;
      sheet_number?: string;
      unit_cost: number;
      cost_per_pack: number;
    }) => {
      toast.success(
        editing ? "Costing sheet updated" : `Submitted ${result.sheet_number} — awaiting approval`,
      );
      logAudit({
        action: editing ? "update" : "create",
        entity: "costing_sheets",
        entityId: result.id,
        factoryId,
        newValue: { ...result, product_type: productType },
      });
      qc.invalidateQueries({ queryKey: ["costing-sheets"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const missingSlot = t.slots.find((s, i) => !slots[i]?.materialId || !(Number(slots[i]?.qty) > 0));
  const canSubmitForm = loaded && !!productId && yieldN > 0 && !missingSlot;

  const qtyLabel = (s: MaterialSlot, unit: string) =>
    s.basis === "batch"
      ? `${unit} used for the whole batch`
      : s.basis === "per_unit"
        ? `${unit} per ${t.unit}`
        : `${unit} per ${t.pack}`;

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Droplet className="h-4 w-4 text-sky-500" />
            {editing ? `Edit ${t.label} Costing` : "New Costing Sheet"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Product type</Label>
              <Select
                value={productType}
                onValueChange={(v) => changeType(v as ProductType)}
                disabled={!!editing}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_TYPES.map((k) => (
                    <SelectItem key={k} value={k}>
                      {TEMPLATES[k].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Product</Label>
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger>
                  <SelectValue placeholder={`Select ${t.label.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent>
                  {productChoices.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                  {productChoices.length === 0 && (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      No water products yet.
                    </div>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Batch yield ({t.units})</Label>
              <MoneyInput
                min="0"
                step="1"
                value={Number(yieldQty) || 0}
                onChange={(v) => setYieldQty(String(v))}
              />
            </div>
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Raw materials
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setExtras([...extras, { materialId: "", qty: "" }])}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Other material
              </Button>
            </div>
            {t.slots.map((s, i) => {
              const st = slots[i] ?? { role: s.role, materialId: "", qty: "" };
              const m = materialById(st.materialId);
              const line = lines[i];
              const update = (patch: Partial<SlotState>) =>
                setSlots(slots.map((x, j) => (j === i ? { ...st, ...patch } : x)));
              return (
                <div key={s.role} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <div className="space-y-1">
                    <Label className="text-xs">{s.label}</Label>
                    <Select value={st.materialId} onValueChange={(v) => update({ materialId: v })}>
                      <SelectTrigger>
                        <SelectValue placeholder={`Select ${s.label.toLowerCase()}`} />
                      </SelectTrigger>
                      <SelectContent>
                        {materials.map((mm) => (
                          <SelectItem key={mm.id} value={mm.id}>
                            {mm.name} ({money(mm.unit_cost)}/{mm.unit})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      {qtyLabel(s, m?.unit ?? "Qty")}
                    </Label>
                    <MoneyInput
                      min="0"
                      step="0.001"
                      value={Number(st.qty) || 0}
                      onChange={(v) => update({ qty: String(v) })}
                    />
                  </div>
                  <div className="self-end pb-2 text-right text-xs text-muted-foreground sm:w-28">
                    {num(+line.quantity.toFixed(3))} {m?.unit ?? ""}
                    <div className="font-medium text-foreground">{money(line.cost)}</div>
                  </div>
                </div>
              );
            })}
            {extras.map((e, i) => {
              const m = materialById(e.materialId);
              const update = (patch: Partial<ExtraLine>) =>
                setExtras(extras.map((x, j) => (j === i ? { ...e, ...patch } : x)));
              return (
                <div key={`x${i}`} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <div className="space-y-1">
                    <Label className="text-xs">Other material</Label>
                    <Select value={e.materialId} onValueChange={(v) => update({ materialId: v })}>
                      <SelectTrigger>
                        <SelectValue placeholder="e.g. treatment chemical" />
                      </SelectTrigger>
                      <SelectContent>
                        {materials.map((mm) => (
                          <SelectItem key={mm.id} value={mm.id}>
                            {mm.name} ({money(mm.unit_cost)}/{mm.unit})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      {m?.unit ?? "Qty"} used for the whole batch
                    </Label>
                    <MoneyInput
                      min="0"
                      step="0.001"
                      value={Number(e.qty) || 0}
                      onChange={(v) => update({ qty: String(v) })}
                    />
                  </div>
                  <div className="flex items-end justify-end gap-1 pb-1 sm:w-28">
                    <span className="pb-1 text-xs font-medium">
                      {money((Number(e.qty) || 0) * (m?.unit_cost ?? 0))}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setExtras(extras.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Labour (₦ for the whole batch)</Label>
              <MoneyInput value={Number(labour) || 0} onChange={(v) => setLabour(String(v))} />
            </div>
            <div className="space-y-2">
              <Label>Logistics (₦ for the whole batch)</Label>
              <MoneyInput
                value={Number(logistics) || 0}
                onChange={(v) => setLogistics(String(v))}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Water &amp; treatment (% of materials)</Label>
              <MoneyInput
                min="0"
                step="0.01"
                value={Number(contentPercent) || 0}
                onChange={(v) => setContentPercent(String(v))}
              />
            </div>
            <div className="space-y-2">
              <Label>
                {t.units.charAt(0).toUpperCase() + t.units.slice(1)} per {t.pack}
              </Label>
              <MoneyInput
                min="1"
                step="1"
                value={Number(packQty) || 0}
                onChange={(v) => setPackQty(String(v))}
              />
            </div>
            <div className="space-y-2">
              <Label>{t.packCostLabel}</Label>
              <MoneyInput value={Number(packCost) || 0} onChange={(v) => setPackCost(String(v))} />
            </div>
          </div>

          <PriceOptionsEditor
            priceOptions={priceOptions}
            setPriceOptions={setPriceOptions}
            costBasis={costPerPack}
          />

          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="apply-costing"
              checked={applyToProduct}
              onCheckedChange={(v) => setApplyToProduct(!!v)}
            />
            <Label htmlFor="apply-costing" className="cursor-pointer">
              Apply the cost per {t.pack} to this product's cost price once approved
            </Label>
          </div>

          <div className="space-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
            <Row label="Raw materials" value={money(materialCost)} />
            <Row label={`Water & treatment (${contentPercent || 0}%)`} value={money(contentCost)} />
            <Row label="Labour" value={money(labourN)} />
            <Row label="Logistics" value={money(logisticsN)} />
            <Row label="Total batch cost" value={money(totalBatch)} strong />
            <Row label={`Cost per ${t.unit}`} value={money(costPerUnit)} />
            {t.pack !== "unit" && (
              <>
                <Row
                  label={`${num(packQtyN)} ${t.units} per ${t.pack}`}
                  value={money(costPerUnit * packQtyN)}
                />
                <Row label={t.packCostLabel.replace(/\s*\(.*\)$/, "")} value={money(packCostN)} />
              </>
            )}
            {t.pack === "unit" && packCostN > 0 && (
              <Row label="Other packaging" value={money(packCostN)} />
            )}
            <Row label={`Final cost per ${t.pack}`} value={money(costPerPack)} strong />
          </div>
          {missingSlot && (
            <p className="text-xs text-warning">
              Choose the {missingSlot.label.toLowerCase()} and enter its quantity.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Requires a second person's approval — this submits a request instead of changing the
            product's cost price immediately.
          </p>
        </div>
        <DialogFooter>
          <Button disabled={!canSubmitForm || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? "Saving…" : editing ? "Save changes" : "Submit for approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "mt-1 border-t pt-1" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "font-semibold" : ""}>{value}</span>
    </div>
  );
}
