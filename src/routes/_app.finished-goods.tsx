import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { money, num } from "@/lib/format";
import { isLowStock } from "@/lib/metrics";
import { toast } from "sonner";
import { requestDelete } from "@/lib/request-delete";
import { RequestDeleteDialog } from "@/components/shared/request-delete-dialog";
import {
  SlidersHorizontal,
  PackageX,
  PackageCheck,
  PackagePlus,
  PackageMinus,
  ArrowLeftRight,
  History,
  Printer,
  Boxes,
  Wallet,
  AlertTriangle,
  Plus,
  Pencil,
  Send,
  Ban,
  Check,
  X,
  Factory,
  Trash2,
  Search,
  Undo2,
} from "lucide-react";
import { generateStockCardPdf } from "@/lib/pdf";
import { ADJUSTMENT_REASONS } from "@/lib/adjustment-reasons";
import { RepActivityCard, ReturnProductDialog } from "@/components/store/rep-activity";
import {
  PRODUCT_LINES,
  skuLabelFor,
  splitProductName,
  PRODUCT_VARIANTS,
  needsSku,
  unitFor,
} from "@/lib/product-lines";
import { SkuField } from "@/components/shared/sku-field";
import { ProductUnitSelect } from "@/components/shared/unit-select";
import { productUnitOf } from "@/lib/units";
import { matchesSearch, useSearchQuery } from "@/lib/search";
import { RefId } from "@/components/shared/ref-id";

export const Route = createFileRoute("/_app/finished-goods")({
  head: () => ({
    meta: [{ title: "Finished Products — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="finished-goods">
      <FinishedGoodsPage />
    </RequireAccess>
  ),
});

type Product = {
  id: string;
  name: string;
  sku: string | null;
  // Generated on insert, e.g. BW-35CL-001 (products_set_code trigger).
  product_code: string | null;
  unit: string;
  unit_price: number;
  cost_price: number;
  current_stock: number;
  reorder_level: number | null;
  category_id: string | null;
  product_type: string;
  product_categories: { name: string } | null;
};
type Category = { id: string; name: string };
type Movement = {
  id: string;
  movement_type: string;
  quantity: number;
  reference: string | null;
  reason: string | null;
  created_at: string;
  quantity_before: number | null;
  quantity_after: number | null;
};
type PendingAdjustment = {
  id: string;
  reference_number: string;
  product_id: string | null;
  quantity_delta: number;
  reason: string | null;
  submitted_by: string;
  submitted_at: string;
  status: string;
  products: { name: string; unit: string } | null;
};
type PendingBatch = {
  id: string;
  production_number: string;
  product_id: string;
  quantity_produced: number;
  damaged_quantity: number | null;
  unit: string;
  batch_number: string | null;
  created_by: string | null;
  created_at: string;
  products: { name: string; unit: string } | null;
};

function SummaryCard({
  icon: Icon,
  label,
  value,
  tone = "primary",
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  tone?: "primary" | "warning" | "destructive";
}) {
  const toneClasses = {
    primary: "bg-primary/10 text-primary",
    warning: "bg-warning/15 text-warning",
    destructive: "bg-destructive/10 text-destructive",
  }[tone];
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-5 flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold">{value}</div>
        </div>
        <div className={`grid h-10 w-10 place-items-center rounded-xl ${toneClasses}`}>
          <Icon className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  );
}

type PendingCorrection = {
  id: string;
  kind: "edit" | "delete";
  old_values: {
    quantity_produced: number | null;
    damaged_quantity: number | null;
    rejected_quantity: number | null;
    accepted_quantity: number | null;
  };
  new_quantity_produced: number | null;
  new_damaged_quantity: number | null;
  reason: string;
  requested_by: string;
  requested_by_name: string | null;
  requested_at: string;
  production: {
    production_number: string;
    unit: string;
    product_id: string;
    products: { name: string; unit: string } | null;
  } | null;
};

// A product linked to a raw material it supplies (e.g. an in-house made
// packaging item -> raw materials). mode "auto": confirmed batches skip
// finished-goods stock and go straight into the material (see
// confirm_production_batch()). mode "on_demand": the product is also sold, so
// batches enter finished goods and Store moves stock across with "Move to raw
// material" (transfer_product_to_material()).
type SupplyMode = "auto" | "on_demand";
type SupplyLink = {
  materialId: string;
  materialName: string;
  unit: string;
  mode: SupplyMode;
};
type MaterialOption = {
  id: string;
  name: string;
  unit: string;
};

// Only "auto" links reroute a confirmed batch away from finished goods.
const autoSupply = (link: SupplyLink | undefined) => (link?.mode === "auto" ? link : undefined);

// Change in finished-goods stock that approving this correction applies —
// mirrors approve_production_correction().
const correctionDelta = (c: PendingCorrection) => {
  const oldAccepted = Number(c.old_values.accepted_quantity ?? 0);
  if (c.kind === "delete") return -oldAccepted;
  return (
    Number(c.new_quantity_produced ?? 0) -
    Number(c.new_damaged_quantity ?? 0) -
    Number(c.old_values.rejected_quantity ?? 0) -
    oldAccepted
  );
};

function FinishedGoodsPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  const { canWrite, canSubmit, canApprove, canPost, canCancel, canConfirm, canReject, canDelete } =
    usePermissions();
  const write = canWrite("finished-goods");
  // Sales-Reps bring unsold products back to the store (logged as sales returns).
  const canLogReturn = canSubmit("sales-returns");
  const [returnOpen, setReturnOpen] = useState(false);
  const submit = canSubmit("finished-goods");
  const approve = canApprove("finished-goods");
  const post = canPost("finished-goods");
  const cancel = canCancel("finished-goods");
  const deletePerm = canDelete("finished-goods");
  const confirmBatchPerm = canConfirm("production");
  const rejectBatchPerm = canReject("production");
  useRealtimeInvalidate(
    [
      "products",
      "product_categories",
      "stock_adjustment_requests",
      "production",
      "inventory_movements",
      "product_price_history",
      "product_units",
      "damage_records",
      "production_corrections",
      "sales",
    ],
    [
      ["store-stock-awaiting-confirmation"],
      ["production-corrections-pending"],
      ["finished-goods"],
      ["product-categories"],
      ["stock-adjustment-requests"],
      ["pending-production-batches"],
      ["finished-goods-movements"],
      ["finished-goods-price-history"],
      ["product-units"],
      ["products-active"],
      ["products-for-production"],
      ["production-list"],
      ["damage-records-finished-goods"],
      ["damage-value-finished-goods"],
    ],
  );
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [q, setQ] = useSearchQuery();
  const [adjustTarget, setAdjustTarget] = useState<{
    product: Product;
    type: "adjusted" | "damaged";
  } | null>(null);
  const [transferTarget, setTransferTarget] = useState<Product | null>(null);
  const [historyTarget, setHistoryTarget] = useState<Product | null>(null);
  const [packagingTarget, setPackagingTarget] = useState<Product | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<PendingBatch | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingBatch | null>(null);
  const [rejectCorrection, setRejectCorrection] = useState<PendingCorrection | null>(null);

  const list = useQuery({
    queryKey: ["finished-goods", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select(
          "id,name,sku,product_code,unit,unit_price,cost_price,current_stock,reorder_level,category_id,product_type,product_categories(name)",
        )
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as Product[];
    },
  });

  const categories = useQuery({
    queryKey: ["product-categories", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_categories")
        .select("id,name")
        .eq("factory_id", factoryId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Category[];
    },
  });

  const pendingAdjustments = useQuery({
    queryKey: ["stock-adjustment-requests", "finished_good", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_adjustment_requests")
        .select(
          "id,reference_number,product_id,quantity_delta,reason,submitted_by,submitted_at,status,products(name,unit)",
        )
        .eq("factory_id", factoryId!)
        .eq("entity_type", "finished_good")
        .in("status", ["pending_approval", "approved"])
        .order("submitted_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PendingAdjustment[];
    },
  });

  const pendingBatches = useQuery({
    queryKey: ["pending-production-batches", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production")
        .select(
          "id,production_number,product_id,quantity_produced,damaged_quantity,unit,batch_number,created_by,created_at,products(name,unit)",
        )
        .eq("factory_id", factoryId!)
        .eq("status", "pending_confirmation")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PendingBatch[];
    },
  });

  // Keyed by product id. Resolves to {} if the internal-supply migration
  // hasn't been applied yet, so the page keeps working without it.
  const supplyLinks = useQuery({
    queryKey: ["product-supply-links", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const links: Record<string, SupplyLink> = {};
      const query = (cols: string) =>
        (supabase as any)
          .from("products")
          .select(cols)
          .eq("factory_id", factoryId!)
          .not("transfer_to_material_id", "is", null);
      const material = "raw_materials!products_transfer_to_material_id_fkey(id,name,unit)";
      // supply_mode arrives with a later migration than the link itself.
      let { data, error } = await query(`id,supply_mode,${material}`);
      if (error) ({ data, error } = await query(`id,${material}`));
      if (error) return links;
      for (const row of data ?? []) {
        const m = row.raw_materials;
        if (!m) continue;
        links[row.id] = {
          materialId: m.id,
          materialName: m.name,
          unit: m.unit,
          mode: row.supply_mode === "on_demand" ? "on_demand" : "auto",
        };
      }
      return links;
    },
  });

  const pendingCorrections = useQuery({
    queryKey: ["production-corrections-pending-store", factoryId],
    enabled: !!factoryId && confirmBatchPerm,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("production_corrections")
        .select(
          "id,kind,old_values,new_quantity_produced,new_damaged_quantity,reason,requested_by,requested_by_name,requested_at,production(production_number,unit,product_id,products(name,unit))",
        )
        .eq("factory_id", factoryId!)
        .eq("review_status", "pending")
        .order("requested_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PendingCorrection[];
    },
  });

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const recentDamage = useQuery({
    queryKey: ["damage-records-finished-goods", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("damage_records")
        .select(
          "id,reference_number,source_type,source_reference,quantity,unit,unit_cost,reason,created_at,products(name)",
        )
        .eq("factory_id", factoryId!)
        .not("product_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as unknown as {
        id: string;
        reference_number: string;
        source_type: string;
        source_reference: string | null;
        quantity: number;
        unit: string | null;
        unit_cost: number | null;
        reason: string | null;
        created_at: string;
        products: { name: string } | null;
      }[];
    },
  });

  // Separate from recentDamage (capped at 20 rows for display) so the
  // "Damaged Value" total below reflects every damage record, not just the
  // most recent page of them.
  const damageValue = useQuery({
    queryKey: ["damage-value-finished-goods", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("damage_records")
        .select("quantity,unit_cost")
        .eq("factory_id", factoryId!)
        .not("product_id", "is", null);
      if (error) throw error;
      return (data ?? []).reduce((s, d) => s + Number(d.quantity) * Number(d.unit_cost ?? 0), 0);
    },
  });

  // Stock only comes off products.current_stock when the cashier / accountant
  // confirms an order, but the goods leave the store as soon as Sales posts
  // it. Take what's in unconfirmed orders off so Available matches the shelf.
  const awaitingConfirmation = useQuery({
    queryKey: ["store-stock-awaiting-confirmation", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("store_stock_awaiting_confirmation", {
        p_factory_id: factoryId!,
      });
      // Optional until 20261026090000_store_stock_awaiting_confirmation.sql is applied.
      if (error) return {} as Record<string, { quantity: number; orders: number }>;
      return Object.fromEntries(
        (data ?? []).map((r) => [
          r.product_id,
          { quantity: Number(r.quantity), orders: Number(r.orders) },
        ]),
      );
    },
  });
  const awaitingOf = (p: Product) => awaitingConfirmation.data?.[p.id]?.quantity ?? 0;
  const availableOf = (p: Product) => Number(p.current_stock) - awaitingOf(p);

  // A wrongly created product: goes to admin approval, then the Recycle Bin.
  const removeProduct = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      await requestDelete("products", id, reason);
    },
    onSuccess: () => {
      toast.success("Deletion requested — pending admin approval");
      setDeleteTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["finished-goods"] });
    qc.invalidateQueries({ queryKey: ["store-stock-awaiting-confirmation"] });
    qc.invalidateQueries({ queryKey: ["products-active"] });
    qc.invalidateQueries({ queryKey: ["products-for-production"] });
    qc.invalidateQueries({ queryKey: ["stock-adjustment-requests"] });
    qc.invalidateQueries({ queryKey: ["production-list"] });
    qc.invalidateQueries({ queryKey: ["pending-production-batches"] });
    qc.invalidateQueries({ queryKey: ["damage-records-finished-goods"] });
    qc.invalidateQueries({ queryKey: ["damage-value-finished-goods"] });
    qc.invalidateQueries({ queryKey: ["production-corrections-pending"] });
    qc.invalidateQueries({ queryKey: ["production-corrections-pending-store"] });
    qc.invalidateQueries({ queryKey: ["product-supply-links"] });
    qc.invalidateQueries({ queryKey: ["raw-materials-list"] });
  };

  const approveCorrection = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc(
        "approve_production_correction" as any,
        {
          p_id: id,
        } as any,
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Correction approved — stock updated");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectCorrectionMut = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc(
        "reject_production_correction" as any,
        {
          p_id: id,
          p_reason: reason,
        } as any,
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Correction rejected");
      setRejectCorrection(null);
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectBatch = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc("reject_production_batch", {
        p_id: id,
        p_reason: reason,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Batch rejected");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reviewAdjustment = useMutation({
    mutationFn: async ({
      id,
      approve: doApprove,
      reason,
    }: {
      id: string;
      approve: boolean;
      reason?: string;
    }) => {
      const { error } = await supabase.rpc(
        doApprove ? "approve_stock_adjustment" : "reject_stock_adjustment",
        doApprove ? { p_id: id } : { p_id: id, p_reason: reason },
      );
      if (error) throw error;
    },
    onSuccess: (_r, vars) => {
      toast.success(
        vars.approve ? "Adjustment approved — post it next to apply" : "Adjustment rejected",
      );
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const postAdjustment = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("post_stock_adjustment", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Write-off posted");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelAdjustment = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("cancel_stock_adjustment", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Write-off request cancelled");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const filteredList = list.data ?? [];
  // Search only narrows which rows are shown in the table below — it
  // deliberately doesn't affect the summary cards above.
  const searchedList = filteredList.filter((p) => matchesSearch(q, p));

  const summary = {
    totalSkus: filteredList.length,
    totalValue: filteredList.reduce(
      (s, p) => s + Number(p.current_stock) * Number(p.cost_price),
      0,
    ),
    lowStock: filteredList.filter((p) => isLowStock(availableOf(p), p.reorder_level)).length,
  };

  const printCard = async (p: Product) => {
    const { data, error } = await supabase
      .from("inventory_movements")
      .select("movement_type,quantity,reference,reason,created_at")
      .eq("product_id", p.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      toast.error(error.message);
      return;
    }
    generateStockCardPdf({
      company: {
        name: settings.data?.company_name ?? "FMIS",
        address: settings.data?.address,
        phone: settings.data?.phone,
        logo_url: settings.data?.logo_url,
      },
      title: "Finished Products Card",
      item_name: p.name,
      unit: p.unit,
      current_stock: Number(p.current_stock),
      unit_cost: Number(p.cost_price),
      total_value: Number(p.current_stock) * Number(p.cost_price),
      reorder_level: p.reorder_level,
      extra: [
        ["Category", p.product_categories?.name || "—"],
        ["Selling price", money(Number(p.unit_price), settings.data?.currency ?? "NGN")],
      ],
      movements: (data ?? []).map((mv: any) => ({
        date: new Date(mv.created_at).toLocaleDateString(),
        type: mv.movement_type,
        quantity: Number(mv.quantity),
        reference: mv.reference,
        reason: mv.reason,
      })),
      currency: settings.data?.currency ?? "NGN",
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Finished Products</h1>
          <p className="text-sm text-muted-foreground">
            Record of finished products: production batches Store approves, what Sales sells, and
            returns, damages, adjustments and transfers.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canLogReturn && (
            <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" className="gap-2">
                  <Undo2 className="h-4 w-4" /> Return Product
                </Button>
              </DialogTrigger>
              {returnOpen && factoryId && (
                <ReturnProductDialog factoryId={factoryId} onDone={() => setReturnOpen(false)} />
              )}
            </Dialog>
          )}
          {write && (
            <Dialog
              open={formOpen}
              onOpenChange={(v) => {
                setFormOpen(v);
                if (!v) setEditing(null);
              }}
            >
              {/* No Add Product button: products are created where production
                  records them; Store keeps the record and edits it. */}
              {formOpen && editing && factoryId && (
                <ProductForm
                  factoryId={factoryId}
                  categories={categories.data ?? []}
                  editing={editing}
                  supplyLink={editing ? supplyLinks.data?.[editing.id] : undefined}
                  onDone={() => {
                    setFormOpen(false);
                    setEditing(null);
                    invalidateAll();
                  }}
                />
              )}
            </Dialog>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          icon={Boxes}
          label="Finished Products SKUs"
          value={String(summary.totalSkus)}
        />
        <SummaryCard icon={Wallet} label="Inventory Value" value={money(summary.totalValue)} />
        <SummaryCard
          icon={AlertTriangle}
          label="Low Stock Items"
          value={String(summary.lowStock)}
          tone={summary.lowStock > 0 ? "destructive" : "warning"}
        />
        <SummaryCard
          icon={PackageMinus}
          label="Damaged Value"
          value={money(damageValue.data ?? 0)}
          tone={(damageValue.data ?? 0) > 0 ? "destructive" : "primary"}
        />
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Available Stock</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search product, SKU, category, #ID…"
                className="pl-8 h-9 w-56"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Available Stock</TableHead>
                <TableHead className="text-right">Cost Price</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {searchedList.map((p) => {
                const awaiting = awaitingOf(p);
                const available = availableOf(p);
                const low = isLowStock(available, p.reorder_level);
                return (
                  <TableRow key={p.id}>
                    <TableCell>
                      <RefId id={p.id} />
                    </TableCell>
                    <TableCell className="font-medium">
                      {p.name}
                      {p.product_code && (
                        <div className="font-mono text-xs font-normal text-muted-foreground">
                          {p.product_code}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{p.product_categories?.name ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <span className={low ? "text-destructive font-medium" : ""}>
                        {num(available)} {p.unit}
                      </span>
                      {low && (
                        <Badge variant="destructive" className="ml-2">
                          Low
                        </Badge>
                      )}
                      {awaiting > 0 && (
                        <div className="text-xs text-muted-foreground">
                          {num(Number(p.current_stock))} on record − {num(awaiting)} in{" "}
                          {awaitingConfirmation.data?.[p.id]?.orders} order(s) awaiting confirmation
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{money(Number(p.cost_price))}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {write && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Edit"
                            onClick={() => {
                              setEditing(p);
                              setFormOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                        {submit && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Adjust"
                            onClick={() => setAdjustTarget({ product: p, type: "adjusted" })}
                          >
                            <SlidersHorizontal className="h-4 w-4" />
                          </Button>
                        )}
                        {submit && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Log Damage"
                            onClick={() => setAdjustTarget({ product: p, type: "damaged" })}
                          >
                            <PackageX className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                        {write && supplyLinks.data?.[p.id] && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Move to raw material"
                            onClick={() => setTransferTarget(p)}
                          >
                            <ArrowLeftRight className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          title="History"
                          onClick={() => setHistoryTarget(p)}
                        >
                          <History className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Packaging / Conversion"
                          onClick={() => setPackagingTarget(p)}
                        >
                          <PackagePlus className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Print"
                          onClick={() => printCard(p)}
                        >
                          <Printer className="h-4 w-4" />
                        </Button>
                        {deletePerm && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Request deletion"
                            onClick={() => setDeleteTarget(p)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {searchedList.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    {q.trim() ? "No products match your search." : "No products yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {factoryId && <RepActivityCard factoryId={factoryId} />}

      {(pendingAdjustments.data ?? []).length > 0 && (
        <Card className="rounded-2xl border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Pending Write-off Requests
              <Badge variant="destructive">{pendingAdjustments.data!.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pendingAdjustments.data ?? [])
                  .filter((x) => matchesSearch(q, x))
                  .map((a) => {
                    const isSelf = a.submitted_by === currentUser.data;
                    return (
                      <TableRow key={a.id}>
                        <TableCell>
                          <RefId id={a.id} />
                        </TableCell>
                        <TableCell className="font-mono text-xs">{a.reference_number}</TableCell>
                        <TableCell className="font-medium">{a.products?.name ?? "—"}</TableCell>
                        <TableCell className="text-right text-destructive">
                          {num(Number(a.quantity_delta))} {a.products?.unit ?? ""}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{a.reason ?? "—"}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize">
                            {a.status.replace(/_/g, " ")}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(a.submitted_at).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            {a.status === "pending_approval" && approve && !isSelf && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Approve"
                                onClick={() => reviewAdjustment.mutate({ id: a.id, approve: true })}
                              >
                                <PackageCheck className="h-4 w-4 text-success" />
                              </Button>
                            )}
                            {a.status === "pending_approval" && approve && !isSelf && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Reject"
                                onClick={() =>
                                  reviewAdjustment.mutate({
                                    id: a.id,
                                    approve: false,
                                    reason: "Rejected",
                                  })
                                }
                              >
                                <PackageX className="h-4 w-4 text-destructive" />
                              </Button>
                            )}
                            {a.status === "approved" && post && !isSelf && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Post"
                                onClick={() => postAdjustment.mutate(a.id)}
                              >
                                <Send className="h-4 w-4 text-success" />
                              </Button>
                            )}
                            {(a.status === "pending_approval" || a.status === "approved") &&
                              cancel && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="Cancel"
                                  onClick={() => cancelAdjustment.mutate(a.id)}
                                >
                                  <Ban className="h-4 w-4 text-muted-foreground" />
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

      {(pendingBatches.data ?? []).length > 0 && (
        <Card className="rounded-2xl border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Pending Production Batches to Confirm
              <Badge variant="destructive">{pendingBatches.data!.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Batch #</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Quantity Produced</TableHead>
                  <TableHead>Recorded</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pendingBatches.data ?? [])
                  .filter((x) => matchesSearch(q, x))
                  .map((b) => {
                    const isSelf = b.created_by === currentUser.data;
                    return (
                      <TableRow key={b.id}>
                        <TableCell>
                          <RefId id={b.id} />
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {b.production_number}
                          {b.batch_number ? ` · ${b.batch_number}` : ""}
                        </TableCell>
                        <TableCell className="font-medium">
                          {b.products?.name ?? "—"}
                          {autoSupply(supplyLinks.data?.[b.product_id]) && (
                            <div className="text-xs font-normal text-muted-foreground">
                              → raw material: {supplyLinks.data?.[b.product_id]?.materialName}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {num(Number(b.quantity_produced))} {b.products?.unit ?? b.unit}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(b.created_at).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            {confirmBatchPerm && !isSelf && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Confirm"
                                onClick={() => setConfirmTarget(b)}
                              >
                                <Check className="h-4 w-4 text-success" />
                              </Button>
                            )}
                            {rejectBatchPerm && !isSelf && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Reject"
                                onClick={() => setRejectTarget(b)}
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

      {(pendingCorrections.data ?? []).length > 0 && (
        <Card className="rounded-2xl border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Production Corrections Awaiting Approval
              <Badge variant="destructive">{pendingCorrections.data!.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Batch #</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Request</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead className="text-right">Stock Effect</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pendingCorrections.data ?? [])
                  .filter((x) => matchesSearch(q, x))
                  .map((c) => {
                    const isSelf = c.requested_by === currentUser.data;
                    const unit = c.production?.products?.unit ?? c.production?.unit ?? "";
                    const delta = correctionDelta(c);
                    return (
                      <TableRow key={c.id}>
                        <TableCell>
                          <RefId id={c.id} />
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {c.production?.production_number ?? "—"}
                        </TableCell>
                        <TableCell className="font-medium">
                          {c.production?.products?.name ?? "—"}
                          {c.production &&
                            autoSupply(supplyLinks.data?.[c.production.product_id]) && (
                              <div className="text-xs font-normal text-muted-foreground">
                                Adjusts raw material:{" "}
                                {supplyLinks.data?.[c.production.product_id]?.materialName}
                              </div>
                            )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={c.kind === "delete" ? "destructive" : "outline"}>
                            {c.kind === "delete" ? "Delete" : "Edit"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {c.kind === "edit" ? (
                            <>
                              Qty {num(Number(c.old_values.quantity_produced ?? 0))} →{" "}
                              {num(Number(c.new_quantity_produced ?? 0))}
                              <br />
                              Damaged {num(Number(c.old_values.damaged_quantity ?? 0))} →{" "}
                              {num(Number(c.new_damaged_quantity ?? 0))}
                            </>
                          ) : (
                            "Remove batch from stock"
                          )}
                        </TableCell>
                        <TableCell
                          className={`text-right font-medium ${delta < 0 ? "text-destructive" : delta > 0 ? "text-success" : ""}`}
                        >
                          {delta > 0 ? "+" : ""}
                          {num(delta)} {unit}
                        </TableCell>
                        <TableCell className="text-muted-foreground max-w-[220px]">
                          {c.reason}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {c.requested_by_name ?? "—"}
                          <br />
                          {new Date(c.requested_at).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            {!isSelf && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="Approve"
                                  disabled={approveCorrection.isPending}
                                  onClick={() => approveCorrection.mutate(c.id)}
                                >
                                  <Check className="h-4 w-4 text-success" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="Reject"
                                  onClick={() => setRejectCorrection(c)}
                                >
                                  <X className="h-4 w-4 text-destructive" />
                                </Button>
                              </>
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

      {(recentDamage.data ?? []).length > 0 && (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Recent Damage</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Unit Cost</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(recentDamage.data ?? [])
                  .filter((x) => matchesSearch(q, x))
                  .map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>
                        <RefId id={d.id} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{d.reference_number}</TableCell>
                      <TableCell>{d.products?.name ?? "—"}</TableCell>
                      <TableCell className="text-right text-destructive">
                        {num(Number(d.quantity))} {d.unit ?? ""}
                      </TableCell>
                      <TableCell className="text-right">
                        {d.unit_cost == null ? "—" : money(Number(d.unit_cost))}
                      </TableCell>
                      <TableCell className="text-right font-medium text-destructive">
                        {d.unit_cost == null
                          ? "—"
                          : money(Number(d.quantity) * Number(d.unit_cost))}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {d.source_type.toLowerCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{d.reason ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(d.created_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!confirmTarget} onOpenChange={(v) => !v && setConfirmTarget(null)}>
        {confirmTarget && (
          <ConfirmBatchDialog
            batch={confirmTarget}
            supplyTo={autoSupply(supplyLinks.data?.[confirmTarget.product_id])}
            onDone={() => {
              setConfirmTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>

      <Dialog open={!!rejectTarget} onOpenChange={(v) => !v && setRejectTarget(null)}>
        {rejectTarget && (
          <RejectBatchDialog
            batch={rejectTarget}
            isPending={rejectBatch.isPending}
            onReject={(reason) =>
              rejectBatch.mutate(
                { id: rejectTarget.id, reason },
                { onSuccess: () => setRejectTarget(null) },
              )
            }
          />
        )}
      </Dialog>

      <Dialog open={!!rejectCorrection} onOpenChange={(v) => !v && setRejectCorrection(null)}>
        {rejectCorrection && (
          <RejectCorrectionDialog
            correction={rejectCorrection}
            isPending={rejectCorrectionMut.isPending}
            onReject={(reason) => rejectCorrectionMut.mutate({ id: rejectCorrection.id, reason })}
          />
        )}
      </Dialog>

      <Dialog open={!!adjustTarget} onOpenChange={(v) => !v && setAdjustTarget(null)}>
        {adjustTarget && (
          <AdjustDialog
            product={adjustTarget.product}
            type={adjustTarget.type}
            onDone={() => {
              setAdjustTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!transferTarget} onOpenChange={(v) => !v && setTransferTarget(null)}>
        {transferTarget && supplyLinks.data?.[transferTarget.id] && (
          <TransferDialog
            product={transferTarget}
            supplyTo={supplyLinks.data[transferTarget.id]}
            onDone={() => {
              setTransferTarget(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!historyTarget} onOpenChange={(v) => !v && setHistoryTarget(null)}>
        {historyTarget && <HistoryDialog product={historyTarget} />}
      </Dialog>
      <Dialog open={!!packagingTarget} onOpenChange={(v) => !v && setPackagingTarget(null)}>
        {packagingTarget && (
          <PackagingDialog
            product={packagingTarget}
            canWrite={write}
            onDone={() => setPackagingTarget(null)}
          />
        )}
      </Dialog>
      <RequestDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        isPending={removeProduct.isPending}
        title={deleteTarget ? `Request deletion — ${deleteTarget.name}` : "Request deletion"}
        description={
          deleteTarget
            ? `Once an admin approves, the product is hidden everywhere and moved to the Recycle Bin for 30 days.` +
              (Number(deleteTarget.current_stock) !== 0
                ? ` The ${Number(deleteTarget.current_stock).toLocaleString()} ${deleteTarget.unit} still in stock will be written off (restoring the product puts it back).`
                : "")
            : undefined
        }
        onConfirm={(reason) =>
          deleteTarget && removeProduct.mutate({ id: deleteTarget.id, reason })
        }
      />
    </div>
  );
}

function ProductForm({
  factoryId,
  categories,
  editing,
  supplyLink,
  onDone,
}: {
  factoryId: string;
  categories: Category[];
  editing: Product | null;
  supplyLink?: SupplyLink;
  onDone: () => void;
}) {
  const [supplyMaterial, setSupplyMaterial] = useState(supplyLink?.materialId ?? "none");
  const [supplyMode, setSupplyMode] = useState<SupplyMode>(supplyLink?.mode ?? "auto");
  const materials = useQuery({
    queryKey: ["raw-materials-supply-options"],
    enabled: !!editing,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials")
        .select("id,name,unit")
        .eq("factory_id", factoryId)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as MaterialOption[];
    },
  });
  // Product is picked from the factory's product lines; the SKU is the
  // variant (35cl, 50cl, ...). The saved name is "<product> <SKU>" so every
  // list that only shows the name still tells the sizes apart.
  const split = splitProductName(editing?.name ?? "", editing?.sku ?? "");
  const [productLine, setProductLine] = useState(split.line);
  const [sku, setSku] = useState(editing?.sku ?? "");
  // An older product whose name doesn't follow "<product> <SKU>" keeps its
  // exact name unless the product is changed here.
  const name =
    editing && split.whole && productLine === split.line
      ? editing.name
      : [productLine, sku.trim()].filter(Boolean).join(" ");

  const skuLabel = skuLabelFor(productLine);
  // Defaults to the product type's usual unit (Sachet Water: bags) until a
  // unit is picked. A product holding stock keeps its unit — stock numbers
  // aren't converted between units.
  const unitLocked = !!editing && Number(editing.current_stock) !== 0;
  const [unit, setUnit] = useState<string | null>(null);
  const unitValue = unit ?? editing?.unit ?? unitFor(productLine);

  const save = useMutation({
    mutationFn: async () => {
      if (!productLine) throw new Error("Select the product type");
      if (!editing && needsSku(productLine) && !sku.trim())
        throw new Error(`Enter the ${skuLabel}`);
      if (!unitValue.trim()) throw new Error("Select or enter a unit");
      // Type, opening stock and reorder level are no longer asked for: a new
      // product is a finished product starting at 0 stock (stock arrives
      // through production). Editing keeps what's set.
      const payload = {
        name,
        sku: sku.trim() || null,
        product_type: editing?.product_type ?? "finished",
        unit: unitLocked ? editing!.unit : productUnitOf(unitValue),
        // Category is no longer asked for; editing keeps any existing one.
        category_id: editing?.category_id ?? null,
        // Prices aren't set here: an approved Costing sheet sets both the
        // cost price and the selling price (approve_costing_sheet_with_price).
      };
      if (editing) {
        // cost_price is column-locked for direct updates; a manual change goes
        // through the audited set_product_cost_price RPC instead.
        const { error } = await supabase.from("products").update(payload).eq("id", editing.id);
        if (error) throw error;
        const newMaterial = supplyMaterial === "none" ? null : supplyMaterial;
        if (
          newMaterial !== (supplyLink?.materialId ?? null) ||
          (newMaterial && supplyMode !== supplyLink?.mode)
        ) {
          const { error: linkErr } = await (supabase as any).rpc("set_product_supply_link", {
            p_product_id: editing.id,
            p_material_id: newMaterial,
            p_mode: supplyMode,
          });
          if (linkErr) throw linkErr;
        }
      } else {
        const { error } = await supabase.from("products").insert({
          ...payload,
          unit_price: 0,
          cost_price: 0,
          factory_id: factoryId,
          current_stock: 0,
          reorder_level: 0,
          active: true,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Product updated" : "Product added");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{editing ? "Edit Product" : "Add New Product"}</DialogTitle>
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
                {/* An older product named outside these lines stays editable. */}
                {productLine && !PRODUCT_LINES.includes(productLine) && (
                  <SelectItem value={productLine}>{productLine}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <SkuField productLine={productLine} value={sku} onChange={setSku} />
          <ProductUnitSelect
            value={unitLocked ? editing!.unit : unitValue}
            onChange={setUnit}
            disabled={unitLocked}
            hint={
              unitLocked
                ? `Can't change while ${num(Number(editing!.current_stock))} ${editing!.unit} are in stock.`
                : undefined
            }
          />
        </div>
        <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Product ID</div>
            <div className="font-mono font-medium">
              {editing?.product_code ?? "Assigned automatically on save"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Saved as</div>
            <div className="font-medium">{name || "—"}</div>
          </div>
          <p className="col-span-2 text-xs text-muted-foreground">
            {editing
              ? `Selling price ${money(Number(editing.unit_price))} · cost price ${money(Number(editing.cost_price))} — set by approving a Costing sheet.`
              : "Selling price and cost price are set on the Costing page when its sheet is approved."}
          </p>
        </div>
        {editing && (
          <div className="grid gap-3 rounded-md border p-3">
            <div>
              <Label>Supplies raw material</Label>
              <Select value={supplyMaterial} onValueChange={setSupplyMaterial}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— Not used as a raw material —</SelectItem>
                  {(materials.data ?? []).map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name} ({m.unit})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {supplyMaterial !== "none" && (
              <div>
                <Label>How it's used</Label>
                <Select value={supplyMode} onValueChange={(v) => setSupplyMode(v as SupplyMode)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Produced to use only</SelectItem>
                    <SelectItem value="on_demand">Produced to sell and use</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {supplyMode === "auto"
                    ? "Every batch Store confirms goes straight into this raw material, not finished products."
                    : "Confirmed batches enter finished products so they can be sold. Move what's needed with Move to raw material."}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : editing ? "Save changes" : "Add product"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

const typeLabels: Record<string, string> = {
  adjusted: "Adjust stock",
  damaged: "Log Damage",
};

function AdjustDialog({
  product,
  type,
  onDone,
}: {
  product: Product;
  type: "adjusted" | "damaged";
  onDone: () => void;
}) {
  const oldQuantity = Number(product.current_stock);
  const [newQuantity, setNewQuantity] = useState(oldQuantity);
  const [damagedQuantity, setDamagedQuantity] = useState(0);
  const [reasonCategory, setReasonCategory] = useState<string>(
    type === "damaged" ? "Damaged material" : ADJUSTMENT_REASONS[0],
  );
  const [otherDetail, setOtherDetail] = useState("");
  const delta = type === "adjusted" ? newQuantity - oldQuantity : -Math.abs(damagedQuantity);
  const reason = reasonCategory === "Other" ? otherDetail.trim() : reasonCategory;

  const submit = useMutation({
    mutationFn: async () => {
      if (delta === 0)
        throw new Error(
          type === "adjusted"
            ? "New quantity is the same as the current stock — enter a different value"
            : "Enter a non-zero quantity",
        );
      if (!reason) throw new Error("Describe the reason for this adjustment");
      const { error } = await supabase.rpc("request_stock_adjustment", {
        payload: {
          entity_type: "finished_good",
          product_id: product.id,
          quantity_delta: delta,
          reason,
          movement_type: type,
        } as any,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Submitted for approval");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          {typeLabels[type]} — {product.name}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        {type === "adjusted" ? (
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Old quantity</Label>
              <Input type="number" value={oldQuantity} disabled />
            </div>
            <div>
              <Label>New quantity</Label>
              <MoneyInput step="0.001" value={newQuantity} onChange={setNewQuantity} />
            </div>
            <div>
              <Label>Difference</Label>
              <Input
                value={`${delta > 0 ? "+" : ""}${num(delta)} ${product.unit}`}
                disabled
                className={delta < 0 ? "text-destructive" : delta > 0 ? "text-success" : ""}
              />
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Available: {num(Number(product.current_stock))} {product.unit}
            </p>
            <div>
              <Label>Quantity</Label>
              <MoneyInput
                min={0.001}
                step="0.001"
                value={damagedQuantity}
                onChange={setDamagedQuantity}
              />
            </div>
          </>
        )}
        <div>
          <Label>Reason</Label>
          <Select value={reasonCategory} onValueChange={setReasonCategory}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ADJUSTMENT_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {reasonCategory === "Other" && (
          <div>
            <Label>Describe the reason</Label>
            <Textarea
              rows={2}
              value={otherDetail}
              onChange={(e) => setOtherDetail(e.target.value)}
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Requires a second person's approval — this submits a request instead of adjusting stock
          immediately.
        </p>
      </div>
      <DialogFooter>
        <Button
          disabled={submit.isPending || delta === 0 || !reason}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? "Submitting…" : "Submit for approval"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ConfirmBatchDialog({
  batch,
  supplyTo,
  onDone,
}: {
  batch: PendingBatch;
  supplyTo?: SupplyLink;
  onDone: () => void;
}) {
  const [actualReceived, setActualReceived] = useState(Number(batch.quantity_produced));
  // Seeded from what Production already reported at batch creation, not 0 —
  // otherwise confirming here would silently overwrite their figure.
  const [damaged, setDamaged] = useState(Number(batch.damaged_quantity ?? 0));
  const [rejected, setRejected] = useState(0);
  const accepted = Math.max(actualReceived - damaged - rejected, 0);
  const unit = batch.products?.unit ?? batch.unit;

  const confirm = useMutation({
    mutationFn: async () => {
      if (actualReceived < 0) throw new Error("Actual quantity received must be >= 0");
      if (damaged < 0 || rejected < 0)
        throw new Error("Damaged/rejected quantities cannot be negative");
      if (damaged + rejected > actualReceived)
        throw new Error("Damaged + rejected cannot exceed actual quantity received");
      const { error } = await supabase.rpc("confirm_production_batch", {
        p_id: batch.id,
        p_actual_received: actualReceived,
        p_damaged: damaged,
        p_rejected: rejected,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(
        supplyTo
          ? `Confirmed — ${num(accepted)} ${unit} sent to raw material ${supplyTo.materialName}`
          : `Confirmed — ${num(accepted)} ${unit} posted to stock`,
      );
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Factory className="h-5 w-5" /> Confirm Batch — {batch.production_number}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {batch.products?.name} · Produced: {num(Number(batch.quantity_produced))} {unit}
        </p>
        <div>
          <Label>Actual Quantity Received</Label>
          <MoneyInput min={0} step="0.001" value={actualReceived} onChange={setActualReceived} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Damaged Quantity</Label>
            <MoneyInput min={0} step="0.001" value={damaged} onChange={setDamaged} />
            {Number(batch.damaged_quantity ?? 0) > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Pre-filled from what Production reported — adjust if needed.
              </p>
            )}
          </div>
          <div>
            <Label>Rejected Quantity</Label>
            <MoneyInput min={0} step="0.001" value={rejected} onChange={setRejected} />
          </div>
        </div>
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            {supplyTo
              ? `Accepted Quantity (goes to raw material ${supplyTo.materialName})`
              : "Accepted Quantity (enters stock)"}
          </div>
          <div className="mt-1 text-xl font-semibold">
            {num(accepted)} {unit}
          </div>
        </div>
        {supplyTo && (
          <p className="text-xs text-muted-foreground">
            This product is made for use as a raw material, so it bypasses finished-products stock.
            On confirmation the accepted quantity is received into{" "}
            <span className="font-medium text-foreground">{supplyTo.materialName}</span>.
          </p>
        )}
      </div>
      <DialogFooter>
        <Button disabled={confirm.isPending} onClick={() => confirm.mutate()}>
          {confirm.isPending ? "Confirming…" : "Confirm"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RejectBatchDialog({
  batch,
  isPending,
  onReject,
}: {
  batch: PendingBatch;
  isPending: boolean;
  onReject: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <X className="h-5 w-5 text-destructive" /> Reject Batch — {batch.production_number}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {batch.products?.name} · Produced: {num(Number(batch.quantity_produced))}{" "}
          {batch.products?.unit ?? batch.unit}
        </p>
        <div>
          <Label>Reason for rejection</Label>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain why this batch is being rejected…"
            autoFocus
          />
        </div>
        <p className="text-xs text-muted-foreground">
          This batch will not be posted to stock. The linked production request (if any) reopens so
          Production can submit a fresh batch.
        </p>
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          disabled={isPending || !trimmed}
          onClick={() => onReject(trimmed)}
        >
          {isPending ? "Rejecting…" : "Reject batch"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RejectCorrectionDialog({
  correction,
  isPending,
  onReject,
}: {
  correction: PendingCorrection;
  isPending: boolean;
  onReject: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <X className="h-5 w-5 text-destructive" /> Reject{" "}
          {correction.kind === "delete" ? "Delete" : "Correction"} —{" "}
          {correction.production?.production_number}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Reason for rejection</Label>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain why this correction is being rejected…"
            autoFocus
          />
        </div>
        <p className="text-xs text-muted-foreground">
          The batch and stock stay as they are. Production can submit a new correction.
        </p>
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          disabled={isPending || !trimmed}
          onClick={() => onReject(trimmed)}
        >
          {isPending ? "Rejecting…" : "Reject correction"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// Moves "produced to sell and use" stock out of finished products into the
// raw material it supplies.
function TransferDialog({
  product,
  supplyTo,
  onDone,
}: {
  product: Product;
  supplyTo: SupplyLink;
  onDone: () => void;
}) {
  const [quantity, setQuantity] = useState(0);
  const [reason, setReason] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      if (quantity <= 0) throw new Error("Quantity must be > 0");
      const { error } = await (supabase as any).rpc("transfer_product_to_material", {
        p_product_id: product.id,
        p_quantity: quantity,
        p_reason: reason || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(
        `${num(quantity)} ${product.unit} moved to raw material ${supplyTo.materialName}`,
      );
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Move to raw material — {product.name}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Available: {num(Number(product.current_stock))} {product.unit}. Leaves finished products
          and is received into{" "}
          <span className="font-medium text-foreground">{supplyTo.materialName}</span>.
        </p>
        <div>
          <Label>Quantity</Label>
          <MoneyInput
            min={0.001}
            max={Number(product.current_stock)}
            step="0.001"
            value={quantity}
            onChange={setQuantity}
          />
        </div>
        <div>
          <Label>Reason</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={submit.isPending || quantity <= 0} onClick={() => submit.mutate()}>
          {submit.isPending ? "Moving…" : "Move stock"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

const movementBadge = (type: string): "default" | "secondary" | "outline" | "destructive" => {
  if (["produced", "received", "returned"].includes(type)) return "secondary";
  if (["sold", "issued", "damaged", "used_for_production"].includes(type)) return "destructive";
  if (type === "transferred") return "outline";
  return "default";
};

type PriceHistoryRow = {
  id: string;
  price: number;
  previous_price: number | null;
  effective_date: string;
  created_by: string | null;
};

function HistoryDialog({ product }: { product: Product }) {
  const movements = useQuery({
    queryKey: ["finished-goods-movements", product.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inventory_movements")
        .select(
          "id,movement_type,quantity,reference,reason,created_at,quantity_before,quantity_after",
        )
        .eq("product_id", product.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Movement[];
    },
  });

  const priceHistory = useQuery({
    queryKey: ["finished-goods-price-history", product.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_price_history")
        .select("id,price,previous_price,effective_date,created_by")
        .eq("product_id", product.id)
        .order("effective_date", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as PriceHistoryRow[];
    },
  });

  return (
    <DialogContent className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>Stock movement — {product.name}</DialogTitle>
      </DialogHeader>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>Date &amp; Time</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Before</TableHead>
            <TableHead className="text-right">After</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(movements.data ?? []).map((m) => (
            <TableRow key={m.id}>
              <TableCell>
                <RefId id={m.id} />
              </TableCell>
              <TableCell>{new Date(m.created_at).toLocaleString()}</TableCell>
              <TableCell>
                <Badge variant={movementBadge(m.movement_type)} className="capitalize">
                  {m.movement_type.replace(/_/g, " ")}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                {num(Number(m.quantity))} {product.unit}
              </TableCell>
              <TableCell className="text-right text-muted-foreground text-xs">
                {m.quantity_before === null ? "—" : `${num(m.quantity_before)} ${product.unit}`}
              </TableCell>
              <TableCell className="text-right text-xs">
                {m.quantity_after === null ? "—" : `${num(m.quantity_after)} ${product.unit}`}
              </TableCell>
              <TableCell>{m.reference ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">{m.reason ?? "—"}</TableCell>
            </TableRow>
          ))}
          {(movements.data ?? []).length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                No movements yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <h3 className="mt-4 text-sm font-medium">Price history</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>Effective</TableHead>
            <TableHead className="text-right">Previous price</TableHead>
            <TableHead className="text-right">New price</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(priceHistory.data ?? []).map((h) => (
            <TableRow key={h.id}>
              <TableCell>
                <RefId id={h.id} />
              </TableCell>
              <TableCell>{new Date(h.effective_date).toLocaleString()}</TableCell>
              <TableCell className="text-right text-muted-foreground">
                {h.previous_price === null ? "—" : money(Number(h.previous_price))}
              </TableCell>
              <TableCell className="text-right font-medium">{money(Number(h.price))}</TableCell>
            </TableRow>
          ))}
          {(priceHistory.data ?? []).length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                No price history yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </DialogContent>
  );
}

type ProductUnitRow = {
  id: string;
  base_unit: string;
  packaging_unit: string;
  conversion_factor: number;
  active: boolean;
};

// Configurable packaging/conversion rules for this product (spec §8): e.g.
// "1 carton = 12 pieces". Production entry uses these to let a user type
// "500 cartons" while quantity_produced (and every downstream stock figure)
// stays in the product's base unit -- nothing here changes current_stock
// itself, it's pure configuration read by create_production().
function PackagingDialog({
  product,
  canWrite,
  onDone,
}: {
  product: Product;
  canWrite: boolean;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [packagingUnit, setPackagingUnit] = useState("");
  const [conversionFactor, setConversionFactor] = useState<number | "">("");
  const [deleteTarget, setDeleteTarget] = useState<ProductUnitRow | null>(null);

  const rules = useQuery({
    queryKey: ["product-units", product.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_units")
        .select("id,base_unit,packaging_unit,conversion_factor,active")
        .eq("product_id", product.id)
        .order("packaging_unit");
      if (error) throw error;
      return (data ?? []) as ProductUnitRow[];
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["product-units", product.id] });

  const add = useMutation({
    mutationFn: async () => {
      if (!packagingUnit.trim()) throw new Error("Packaging unit is required");
      if (!conversionFactor || conversionFactor <= 0)
        throw new Error("Conversion factor must be > 0");
      const { error } = await supabase.from("product_units").insert({
        product_id: product.id,
        base_unit: product.unit,
        packaging_unit: packagingUnit.trim().toLowerCase(),
        conversion_factor: conversionFactor,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Packaging rule added");
      setPackagingUnit("");
      setConversionFactor("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: async (rule: ProductUnitRow) => {
      const { error } = await supabase
        .from("product_units")
        .update({ active: !rule.active })
        .eq("id", rule.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      await requestDelete("product_units", id, reason);
    },
    onSuccess: () => {
      toast.success("Deletion requested — pending admin approval");
      setDeleteTarget(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Packaging / Conversion — {product.name}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-4">
        <p className="text-xs text-muted-foreground">
          Base unit: <span className="font-medium text-foreground">{product.unit}</span>. Each rule
          below lets Production enter a quantity in a packaging unit (e.g. cartons) and have it
          converted to {product.unit} automatically.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Packaging unit</TableHead>
              <TableHead className="text-right">1 unit =</TableHead>
              <TableHead>Status</TableHead>
              {canWrite && <TableHead></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rules.data ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <RefId id={r.id} />
                </TableCell>
                <TableCell className="font-medium capitalize">{r.packaging_unit}</TableCell>
                <TableCell className="text-right">
                  {num(Number(r.conversion_factor))} {r.base_unit}
                </TableCell>
                <TableCell>
                  <Badge variant={r.active ? "secondary" : "outline"}>
                    {r.active ? "Active" : "Inactive"}
                  </Badge>
                </TableCell>
                {canWrite && (
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => toggleActive.mutate(r)}>
                        {r.active ? "Deactivate" : "Activate"}
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(r)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {(rules.data ?? []).length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={canWrite ? 4 : 3}
                  className="text-center text-muted-foreground py-6"
                >
                  No packaging rules yet — production records this quantity in {product.unit} only.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        {canWrite && (
          <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2 border-t pt-4">
            <div>
              <Label>Packaging unit</Label>
              <Input
                value={packagingUnit}
                onChange={(e) => setPackagingUnit(e.target.value)}
                placeholder="e.g. carton"
              />
            </div>
            <div>
              <Label>{product.unit} per unit</Label>
              <MoneyInput
                min={0.0001}
                step="0.0001"
                value={conversionFactor === "" ? 0 : conversionFactor}
                onChange={(v) => setConversionFactor(v === 0 ? "" : v)}
              />
            </div>
            <Button
              size="sm"
              disabled={add.isPending}
              onClick={() => add.mutate()}
              className="gap-1"
            >
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Close
        </Button>
      </DialogFooter>

      <RequestDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        isPending={remove.isPending}
        title={
          deleteTarget ? `Request deletion — ${deleteTarget.packaging_unit}` : "Request deletion"
        }
        onConfirm={(reason) => deleteTarget && remove.mutate({ id: deleteTarget.id, reason })}
      />
    </DialogContent>
  );
}
