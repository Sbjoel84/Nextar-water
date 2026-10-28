import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import { usePermissions } from "@/lib/permissions";
import { useFactoryId } from "@/lib/use-factory";
import { useHydratedFactoryCode } from "@/lib/factory-store";
import { money, num, fmtDate, fmtDateTime } from "@/lib/format";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProductPricesTab } from "@/components/costing/product-prices";
import { RefId } from "@/components/shared/ref-id";
import { SearchBox } from "@/components/shared/search-box";
import { matchesSearch, useSearchQuery } from "@/lib/search";
import {
  matchesRequisitionItem,
  requisitionItem,
  requisitionItemForMaterial,
  type QtyBasis,
} from "@/lib/requisition-items";

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
// Which product template a sheet was built from (see TEMPLATES below). Plain
// "bottle" is the size-less template older sheets were saved with.
type ProductType =
  "bottle_33cl" | "bottle_50cl" | "bottle_75cl" | "dispenser" | "sachet" | "bottle";

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
  electricity_cost: number; // NEPA
  fuel_cost: number; // diesel / fuel
  loading_cost: number;
  working_days: number;
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

// A sheet costs one day's production; working_days projects it over the month.
const DEFAULT_WORKING_DAYS = 26;
const daysOf = (s: Sheet) => Number(s.working_days) || DEFAULT_WORKING_DAYS;
// total_cost covers the day's batch; per-pack packaging is added on top of it.
const packagingPerDay = (s: Sheet) =>
  Number(s.pack_cost) * (Number(s.yield_quantity) / (Number(s.pack_quantity) || 1));
const dailySpend = (s: Sheet) => Number(s.total_cost) + packagingPerDay(s);

// What each product costs the company over a month, from its approved sheet
// (or, until one is approved, its latest sheet awaiting approval).
function MonthlyProjection({ sheets }: { sheets: Sheet[] }) {
  const byProduct = new Map<string, Sheet>();
  // sheets arrive newest first, so the first posted / pending one wins.
  for (const status of ["posted", "pending_approval"] as WorkflowStatus[]) {
    sheets
      .filter((s) => s.status === status && !byProduct.has(s.product_id))
      .forEach((s) => byProduct.set(s.product_id, s));
  }
  const rows = [...byProduct.values()].map((s) => {
    const days = daysOf(s);
    return {
      s,
      days,
      units: Number(s.yield_quantity) * days,
      materials: (Number(s.material_cost) + packagingPerDay(s)) * days,
      treatment: Number(s.overhead_cost) * days,
      labour: Number(s.labor_cost) * days,
      running: (Number(s.electricity_cost ?? 0) + Number(s.fuel_cost ?? 0)) * days,
      logistics: (Number(s.logistics_cost ?? 0) + Number(s.loading_cost ?? 0)) * days,
      total: dailySpend(s) * days,
    };
  });
  const totals = rows.reduce(
    (t, r) => ({
      materials: t.materials + r.materials,
      treatment: t.treatment + r.treatment,
      labour: t.labour + r.labour,
      running: t.running + r.running,
      logistics: t.logistics + r.logistics,
      total: t.total + r.total,
    }),
    { materials: 0, treatment: 0, labour: 0, running: 0, logistics: 0, total: 0 },
  );

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Monthly spend projection</CardTitle>
        <p className="text-sm text-muted-foreground">
          Each product's daily production cost × its production days per month.
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Output / month</TableHead>
              <TableHead className="text-right">Raw materials</TableHead>
              <TableHead className="text-right">Water &amp; treatment</TableHead>
              <TableHead className="text-right">Labour</TableHead>
              <TableHead className="text-right">Running cost</TableHead>
              <TableHead className="text-right">Logistics &amp; loading</TableHead>
              <TableHead className="text-right">Total / month</TableHead>
              <TableHead className="text-right">Cost / unit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const t = templateFor(r.s.product_type);
              return (
                <TableRow key={r.s.id}>
                  <TableCell>
                    <div className="font-medium">{r.s.products?.name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.s.sheet_number}
                      {r.s.status === "pending_approval" && " · awaiting approval"}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {num(r.units)} {t.units}
                    <div className="text-xs text-muted-foreground">
                      {num(Number(r.s.yield_quantity))}/day × {num(r.days)} days
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{money(r.materials)}</TableCell>
                  <TableCell className="text-right">{money(r.treatment)}</TableCell>
                  <TableCell className="text-right">{money(r.labour)}</TableCell>
                  <TableCell className="text-right">{money(r.running)}</TableCell>
                  <TableCell className="text-right">{money(r.logistics)}</TableCell>
                  <TableCell className="text-right font-semibold">{money(r.total)}</TableCell>
                  <TableCell className="text-right">{money(r.s.unit_cost)}</TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  Submit a costing sheet to see the month's projected spend.
                </TableCell>
              </TableRow>
            ) : (
              <TableRow className="bg-muted/30 font-semibold">
                <TableCell colSpan={2}>All products</TableCell>
                <TableCell className="text-right">{money(totals.materials)}</TableCell>
                <TableCell className="text-right">{money(totals.treatment)}</TableCell>
                <TableCell className="text-right">{money(totals.labour)}</TableCell>
                <TableCell className="text-right">{money(totals.running)}</TableCell>
                <TableCell className="text-right">{money(totals.logistics)}</TableCell>
                <TableCell className="text-right">{money(totals.total)}</TableCell>
                <TableCell />
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

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
  // Approving opens a dialog to pick the product's selling price.
  const [approveTarget, setApproveTarget] = useState<Sheet | null>(null);
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
          "id,sheet_number,product_id,sheet_type,product_type,logistics_cost,electricity_cost,fuel_cost,loading_cost,working_days,yield_quantity,material_cost,labor_cost,overhead_cost,overhead_percent,pack_quantity,pack_cost,cost_per_pack,total_cost,unit_cost,apply_to_product,is_applied,status,created_by,notes,created_at,products(name,unit)",
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
    mutationFn: async ({ id, price }: { id: string; price: number | null }) => {
      const { error } = await supabase.rpc("approve_costing_sheet_with_price", {
        p_id: id,
        p_selling_price: price,
      });
      if (error) throw error;
      return price;
    },
    onSuccess: (price) => {
      toast.success(
        price
          ? `Approved — cost and selling price ${money(price)} applied`
          : "Approved — cost applied",
      );
      setApproveTarget(null);
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
    "What the company spends to produce each product: one day's raw materials at their cost per piece, labour wages, running cost (NEPA, diesel/fuel) and logistics with loading — projected over the month. Sheets are approved before the cost applies to the product.";

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

      <Tabs defaultValue="sheets">
        <TabsList>
          <TabsTrigger value="sheets">Costing Sheets</TabsTrigger>
          <TabsTrigger value="prices">Product Prices</TabsTrigger>
        </TabsList>
        <TabsContent value="sheets" className="mt-4 space-y-6">
          <MonthlyProjection sheets={sheets.data ?? []} />

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
                    <TableHead>Daily Output</TableHead>
                    <TableHead>Material</TableHead>
                    <TableHead>Labour</TableHead>
                    <TableHead>Running Cost</TableHead>
                    <TableHead>Logistics</TableHead>
                    <TableHead>Daily Cost</TableHead>
                    <TableHead>Monthly Spend</TableHead>
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
                            {templateFor(s.product_type).label}
                          </TableCell>
                          <TableCell>{s.products?.name ?? "—"}</TableCell>
                          <TableCell>
                            {num(s.yield_quantity)} {s.products?.unit}
                          </TableCell>
                          <TableCell>{money(s.material_cost)}</TableCell>
                          <TableCell>{money(s.labor_cost)}</TableCell>
                          <TableCell>
                            {money(Number(s.electricity_cost ?? 0) + Number(s.fuel_cost ?? 0))}
                          </TableCell>
                          <TableCell>
                            {money(Number(s.logistics_cost ?? 0) + Number(s.loading_cost ?? 0))}
                          </TableCell>
                          <TableCell>{money(dailySpend(s))}</TableCell>
                          <TableCell className="font-medium whitespace-nowrap">
                            {money(dailySpend(s) * daysOf(s))}
                            <div className="text-xs font-normal text-muted-foreground">
                              {num(daysOf(s))} days
                            </div>
                          </TableCell>
                          <TableCell>{money(s.unit_cost)}</TableCell>
                          <TableCell className="font-medium">{money(s.cost_per_pack)}</TableCell>
                          <TableCell>{s.is_applied ? "Yes" : "No"}</TableCell>
                          <TableCell>
                            <Badge variant={statusBadge(s.status)}>
                              {WORKFLOW_STATUS_LABELS[s.status]}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap">
                            {fmtDate(s.created_at)}
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
                      <TableCell colSpan={17} className="text-center text-muted-foreground py-8">
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
                              {fmtDateTime(s.created_at)}
                            </TableCell>
                            <TableCell>
                              <div className="flex justify-end gap-1">
                                {approvePerm && !isSelf && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    title="Approve & Apply"
                                    onClick={() => setApproveTarget(s)}
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

          <Dialog open={!!approveTarget} onOpenChange={(v) => !v && setApproveTarget(null)}>
            {approveTarget && (
              <ApproveCostingDialog
                sheet={approveTarget}
                saving={approveSheet.isPending}
                onSubmit={(price) => approveSheet.mutate({ id: approveTarget.id, price })}
              />
            )}
          </Dialog>

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
        </TabsContent>
        <TabsContent value="prices" className="mt-4">
          {factoryId && <ProductPricesTab factoryId={factoryId} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================================
// COSTING SHEET — pick a product (33CL, 50CL, 75CL, Dispenser or Sachet
// Water) and its store requisition items, labour and logistics are laid out
// ready to fill in. Any other requisition item can be added from the dropdown.
// ============================================================================

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
  // Requisition items laid out when the type is chosen.
  items: string[];
};

const bottleTemplate = (size: string, preform: string): TypeTemplate => ({
  label: `${size}CL Bottle Water`,
  unit: "bottle",
  units: "bottles",
  pack: "pack",
  packQty: 12,
  packCostLabel: "Other packaging (₦ per pack)",
  packCost: 0,
  contentPercent: 10,
  productMatch: new RegExp(`${size}\\s*cl`, "i"),
  items: [preform, "cap_bottle", "label_bottle", "shrink_nylon"],
});

const TEMPLATES: Record<ProductType, TypeTemplate> = {
  bottle_33cl: bottleTemplate("33", "preform_33cl"),
  bottle_50cl: bottleTemplate("50", "preform_50cl"),
  bottle_75cl: bottleTemplate("75", "preform_75cl"),
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
    items: [
      "dispenser_bottle",
      "top_label_dispenser",
      "side_label_dispenser",
      "tamper_proof",
      "packing_bag_dispenser",
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
    items: ["nylon_roll_sachet", "packing_bag_sachet"],
  },
  // Sheets saved before bottles were costed per size. Never offered for new ones.
  bottle: {
    ...bottleTemplate("33", "preform_33cl"),
    label: "Bottle Water",
    productMatch: /bottle|\d+\s*cl\b|\bpet\b/i,
  },
};
const PRODUCT_TYPES: ProductType[] = [
  "bottle_33cl",
  "bottle_50cl",
  "bottle_75cl",
  "dispenser",
  "sachet",
];
const templateFor = (type: string | null) =>
  TEMPLATES[(type ?? "bottle") as ProductType] ?? TEMPLATES.bottle;

// Basis of the roles older sheets were saved with.
const LEGACY_ROLE_BASIS: Record<string, QtyBasis> = {
  preform: "batch",
  sachet_film: "batch",
  cap: "per_unit",
  label: "per_unit",
  dispenser_bottle: "per_unit",
  seal: "per_unit",
  packing_bag: "per_pack",
};

// "other" = a stock item that isn't on the requisition note.
const OTHER_ITEM = "other";

type Line = { item: string; materialId: string; qty: string; basis: QtyBasis };

const matchingMaterials = (item: string, materials: MaterialRow[]) => {
  const r = requisitionItem(item);
  return r ? materials.filter((m) => matchesRequisitionItem(r, m.name)) : [];
};

const newLine = (item: string, materials: MaterialRow[]): Line => {
  const r = requisitionItem(item);
  const basis = r?.basis ?? "batch";
  return {
    item,
    materialId: matchingMaterials(item, materials)[0]?.id ?? "",
    qty: basis === "batch" ? "" : "1",
    basis,
  };
};

const templateLines = (t: TypeTemplate, materials: MaterialRow[]) =>
  t.items.map((i) => newLine(i, materials));

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
  const [productType, setProductType] = useState<ProductType>(
    (editing?.product_type as ProductType | null) ?? "bottle_33cl",
  );
  const t = templateFor(productType);
  const [yieldQty, setYieldQty] = useState(editing ? String(editing.yield_quantity) : "");
  const [workingDays, setWorkingDays] = useState(
    String(editing ? daysOf(editing) : DEFAULT_WORKING_DAYS),
  );
  const [lines, setLines] = useState<Line[]>(() => (editing ? [] : templateLines(t, materials)));
  const [labour, setLabour] = useState(editing ? String(editing.labor_cost) : "");
  const [logistics, setLogistics] = useState(editing ? String(editing.logistics_cost ?? 0) : "");
  const [electricity, setElectricity] = useState(
    editing ? String(editing.electricity_cost ?? 0) : "",
  );
  const [fuel, setFuel] = useState(editing ? String(editing.fuel_cost ?? 0) : "");
  const [loading, setLoading] = useState(editing ? String(editing.loading_cost ?? 0) : "");
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

  // Choosing a product lays out its requisition items and defaults.
  const changeType = (next: ProductType) => {
    const nt = TEMPLATES[next];
    setProductType(next);
    setLines(templateLines(nt, materials));
    setContentPercent(String(nt.contentPercent));
    setPackQty(String(nt.packQty));
    setPackCost(String(nt.packCost));
  };

  // A new sheet opened before the material list arrived: link them once it has.
  useEffect(() => {
    if (!editing && materials.length > 0 && lines.every((x) => !x.materialId)) {
      setLines(lines.map((l) => ({ ...l, materialId: newLine(l.item, materials).materialId })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materials.length]);

  // Editing: rebuild the per-unit / per-pack figures from the stored batch totals.
  useEffect(() => {
    if (!editing) return;
    (async () => {
      const { data: items } = await supabase
        .from("costing_sheet_items")
        .select("material_id,quantity,role,raw_materials(name)")
        .eq("sheet_id", editing.id);
      const y = Number(editing.yield_quantity) || 1;
      const p = y / (Number(editing.pack_quantity) || 1);
      setLines(
        (items ?? []).map((it) => {
          const role = it.role ?? "";
          const name = (it.raw_materials as { name: string } | null)?.name ?? "";
          const item =
            requisitionItem(role)?.key ?? requisitionItemForMaterial(name)?.key ?? OTHER_ITEM;
          const basis = requisitionItem(role)?.basis ?? LEGACY_ROLE_BASIS[role] ?? "batch";
          const q = Number(it.quantity);
          const shown = basis === "batch" ? q : basis === "per_unit" ? q / y : q / p;
          return { item, materialId: it.material_id, qty: String(+shown.toFixed(4)), basis };
        }),
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
  const batchQty = (basis: QtyBasis, qty: number) =>
    basis === "batch" ? qty : basis === "per_unit" ? qty * yieldN : qty * packs;

  const costed = lines.map((l) => {
    const m = materialById(l.materialId);
    const quantity = batchQty(l.basis, Number(l.qty) || 0);
    return { ...l, m, quantity, cost: quantity * (m?.unit_cost ?? 0) };
  });
  const materialCost = costed.reduce((sum, l) => sum + l.cost, 0);
  const contentCost = (materialCost * (Number(contentPercent) || 0)) / 100;
  const labourN = Number(labour) || 0;
  const logisticsN = Number(logistics) || 0;
  const electricityN = Number(electricity) || 0;
  const fuelN = Number(fuel) || 0;
  const loadingN = Number(loading) || 0;
  const runningN = electricityN + fuelN;
  const packCostN = Number(packCost) || 0;
  const totalBatch = materialCost + contentCost + labourN + runningN + logisticsN + loadingN;
  const costPerUnit = yieldN > 0 ? totalBatch / yieldN : 0;
  const costPerPack = costPerUnit * packQtyN + packCostN;
  // One day's spend, packaging included, and the month it projects to.
  const daysN = Number(workingDays) || 0;
  const packagingDay = packCostN * packs;
  const totalDay = totalBatch + packagingDay;
  const totalMonth = totalDay * daysN;

  // The product is the one matching the chosen type (an edited sheet keeps its own).
  // When no product name matches the type, the user picks it.
  const [pickedProductId, setPickedProductId] = useState("");
  const matchedProductId =
    editing?.product_id ?? products.find((p) => t.productMatch.test(p.name))?.id ?? "";
  const productId = matchedProductId || pickedProductId;
  const product = products.find((p) => p.id === productId);

  const buildPayload = () => ({
    factory_id: factoryId,
    product_id: productId,
    sheet_type: "water",
    product_type: productType,
    yield_quantity: yieldN,
    labor_cost: labourN,
    logistics_cost: logisticsN,
    electricity_cost: electricityN,
    fuel_cost: fuelN,
    loading_cost: loadingN,
    working_days: daysN,
    overhead_cost: 0,
    overhead_percent: Number(contentPercent) || 0,
    pack_quantity: packQtyN,
    pack_cost: packCostN,
    apply_to_product: applyToProduct,
    notes: notes || null,
    items: costed
      .filter((l) => l.m && l.quantity > 0)
      .map((l) => ({ material_id: l.m!.id, quantity: +l.quantity.toFixed(4), role: l.item })),
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

  const lineLabel = (l: Line) =>
    materialById(l.materialId)?.name ?? requisitionItem(l.item)?.name ?? "Raw material";
  // Lines with no raw material chosen are skipped; a chosen one needs a quantity.
  const filled = costed.filter((l) => l.m && Number(l.qty) > 0);
  const incomplete = costed.find((l) => l.m && !(Number(l.qty) > 0));
  const missing = [
    !productId && `the ${t.label} product`,
    !(yieldN > 0) && "daily production",
    !(daysN > 0 && daysN <= 31) && "production days per month (1–31)",
    filled.length === 0 && "at least one raw material with its quantity",
    incomplete && `the quantity for ${lineLabel(incomplete)}`,
  ].filter(Boolean) as string[];
  const canSubmitForm = loaded && missing.length === 0;

  const basisOptions: { value: QtyBasis; label: string }[] = [
    { value: "batch", label: "For the day" },
    { value: "per_unit", label: `Per ${t.unit}` },
    ...(t.pack !== "unit" ? [{ value: "per_pack" as const, label: `Per ${t.pack}` }] : []),
  ];

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
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
                  {(productType === "bottle" ? [...PRODUCT_TYPES, productType] : PRODUCT_TYPES).map(
                    (k) => (
                      <SelectItem key={k} value={k}>
                        {TEMPLATES[k].label}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
              {product ? (
                <p className="text-xs text-muted-foreground">
                  Costing for <span className="font-medium text-foreground">{product.name}</span>
                </p>
              ) : null}
              {!matchedProductId && products.length > 0 && (
                <Select value={pickedProductId} onValueChange={setPickedProductId}>
                  <SelectTrigger>
                    <SelectValue placeholder={`Which product is ${t.label}?`} />
                  </SelectTrigger>
                  <SelectContent>
                    {products.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {products.length === 0 && (
                <p className="text-xs text-warning">
                  No water products yet — add one on the Finished Goods page.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Daily production ({t.units} per day)</Label>
              <MoneyInput
                min="0"
                step="1"
                value={Number(yieldQty) || 0}
                onChange={(v) => setYieldQty(String(v))}
              />
            </div>
            <div className="space-y-2">
              <Label>Production days per month</Label>
              <MoneyInput
                min="1"
                max="31"
                step="1"
                value={Number(workingDays) || 0}
                onChange={(v) => setWorkingDays(String(v))}
              />
              {(daysN <= 0 || daysN > 31) && (
                <p className="text-xs text-warning">Enter between 1 and 31 days.</p>
              )}
            </div>
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Raw materials used in a day
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setLines([
                    ...lines,
                    { item: OTHER_ITEM, materialId: "", qty: "", basis: "batch" },
                  ])
                }
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add item
              </Button>
            </div>
            {costed.map((l, i) => {
              const update = (patch: Partial<Line>) =>
                setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              const req = requisitionItem(l.item);
              return (
                <div key={i} className="space-y-2 rounded-md border bg-muted/20 p-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Raw material</Label>
                    <Select
                      value={l.materialId}
                      onValueChange={(v) => {
                        const name = materialById(v)?.name ?? "";
                        update({
                          materialId: v,
                          item: requisitionItemForMaterial(name)?.key ?? OTHER_ITEM,
                        });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue
                          placeholder={req ? `Select ${req.name}` : "Select raw material"}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {materials.map((mm) => (
                          <SelectItem key={mm.id} value={mm.id}>
                            {mm.name} ({money(mm.unit_cost)}/{mm.unit})
                          </SelectItem>
                        ))}
                        {materials.length === 0 && (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            No water raw materials yet.
                          </div>
                        )}
                      </SelectContent>
                    </Select>
                    {l.m && (
                      <p className="text-xs text-muted-foreground">
                        Cost per {l.m.unit}:{" "}
                        <span className="font-medium text-foreground">{money(l.m.unit_cost)}</span>
                      </p>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">
                        Quantity ({l.m?.unit ?? req?.unit ?? "qty"})
                      </Label>
                      <MoneyInput
                        min="0"
                        step="0.001"
                        value={Number(l.qty) || 0}
                        onChange={(v) => update({ qty: String(v) })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Quantity is</Label>
                      <Select
                        value={l.basis}
                        onValueChange={(v) => update({ basis: v as QtyBasis })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {basisOptions.map((b) => (
                            <SelectItem key={b.value} value={b.value}>
                              {b.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-end justify-end gap-1 sm:w-36">
                      <div className="pb-1 text-right text-xs text-muted-foreground">
                        {num(+l.quantity.toFixed(3))} {l.m?.unit ?? ""}/day
                        <div className="font-medium text-foreground">{money(l.cost)}/day</div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="Remove item"
                        onClick={() => setLines(lines.filter((_, j) => j !== i))}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
            {costed.length === 0 && loaded && (
              <p className="py-2 text-center text-xs text-muted-foreground">
                Add the raw materials a day's production uses.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Labour wages (₦ per day)</Label>
            <MoneyInput value={Number(labour) || 0} onChange={(v) => setLabour(String(v))} />
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Running cost (per day)
              </Label>
              <span className="text-xs text-muted-foreground">{money(runningN)}/day</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">NEPA (₦)</Label>
                <MoneyInput
                  value={Number(electricity) || 0}
                  onChange={(v) => setElectricity(String(v))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Diesel / fuel (₦)</Label>
                <MoneyInput value={Number(fuel) || 0} onChange={(v) => setFuel(String(v))} />
              </div>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Logistics (per day)
              </Label>
              <span className="text-xs text-muted-foreground">
                {money(logisticsN + loadingN)}/day
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Transport / haulage (₦)</Label>
                <MoneyInput
                  value={Number(logistics) || 0}
                  onChange={(v) => setLogistics(String(v))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Loading (₦)</Label>
                <MoneyInput value={Number(loading) || 0} onChange={(v) => setLoading(String(v))} />
              </div>
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

          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="mb-1 grid grid-cols-[1fr_auto_auto] gap-x-4 text-xs uppercase tracking-wide text-muted-foreground">
              <span>Cost</span>
              <span className="w-28 text-right">Per day</span>
              <span className="w-32 text-right">Month ({num(daysN)} days)</span>
            </div>
            {costed
              .filter((l) => l.cost > 0)
              .map((l, i) => (
                <SpendRow key={i} label={lineLabel(l)} day={l.cost} days={daysN} />
              ))}
            <SpendRow label="Raw materials" day={materialCost} days={daysN} strong />
            <SpendRow
              label={`Water & treatment (${contentPercent || 0}%)`}
              day={contentCost}
              days={daysN}
            />
            <SpendRow label="Labour wages" day={labourN} days={daysN} />
            <SpendRow label="Running cost — NEPA" day={electricityN} days={daysN} />
            <SpendRow label="Running cost — diesel / fuel" day={fuelN} days={daysN} />
            <SpendRow label="Logistics — transport" day={logisticsN} days={daysN} />
            <SpendRow label="Logistics — loading" day={loadingN} days={daysN} />
            {packagingDay > 0 && (
              <SpendRow label="Other packaging" day={packagingDay} days={daysN} />
            )}
            <SpendRow label="Total spend" day={totalDay} days={daysN} strong />
            <div className="mt-1 grid grid-cols-[1fr_auto_auto] gap-x-4">
              <span className="text-muted-foreground">Output</span>
              <span className="w-28 text-right">
                {num(yieldN)} {t.units}
              </span>
              <span className="w-32 text-right">
                {num(yieldN * daysN)} {t.units}
              </span>
            </div>
            <div className="mt-2 space-y-1 border-t pt-2">
              <Row label={`Cost per ${t.unit}`} value={money(costPerUnit)} />
              {t.pack !== "unit" && (
                <Row
                  label={`Cost per ${t.pack} (${num(packQtyN)} ${t.units} + packaging)`}
                  value={money(costPerPack)}
                />
              )}
              <Row label="Projected spend for the month" value={money(totalMonth)} strong />
            </div>
          </div>
          {loaded && missing.length > 0 && (
            <p className="text-xs text-warning">To submit, enter {missing.join(", ")}.</p>
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

function SpendRow({
  label,
  day,
  days,
  strong,
}: {
  label: string;
  day: number;
  days: number;
  strong?: boolean;
}) {
  return (
    <div
      className={`grid grid-cols-[1fr_auto_auto] gap-x-4 ${strong ? "mt-1 border-t pt-1 font-semibold" : ""}`}
    >
      <span className={strong ? "" : "text-muted-foreground"}>{label}</span>
      <span className="w-28 text-right">{money(day)}</span>
      <span className="w-32 text-right">{money(day * days)}</span>
    </div>
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

// Approving a sheet sets the product's cost price (from the sheet) and its
// selling price — picked here from the sheet's proposed prices, or typed in.
function ApproveCostingDialog({
  sheet,
  saving,
  onSubmit,
}: {
  sheet: Sheet;
  saving: boolean;
  onSubmit: (price: number | null) => void;
}) {
  const options = useQuery({
    queryKey: ["costing-price-options", sheet.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("costing_price_options")
        .select("proposed_price,margin,margin_percent")
        .eq("sheet_id", sheet.id)
        .order("proposed_price");
      if (error) throw error;
      return (data ?? []) as { proposed_price: number; margin: number; margin_percent: number }[];
    },
  });
  const [price, setPrice] = useState<number>(0);
  const [touched, setTouched] = useState(false);
  // Default to the first proposed price once the options load.
  useEffect(() => {
    if (!touched && options.data?.length) setPrice(Number(options.data[0].proposed_price));
  }, [options.data, touched]);

  const cost = Number(sheet.cost_per_pack);
  const margin = price > 0 ? price - cost : null;

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Approve {sheet.sheet_number}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 text-sm">
        <div className="rounded-md bg-muted/30 p-3">
          <div className="font-medium">{sheet.products?.name ?? "—"}</div>
          <div className="text-muted-foreground">Cost per pack {money(cost)}</div>
        </div>
        {sheet.apply_to_product ? (
          <>
            {(options.data ?? []).length > 0 && (
              <div className="grid gap-1.5">
                <Label>Proposed selling prices</Label>
                <div className="flex flex-wrap gap-2">
                  {options.data!.map((o) => (
                    <Button
                      key={o.proposed_price}
                      type="button"
                      size="sm"
                      variant={price === Number(o.proposed_price) ? "default" : "outline"}
                      onClick={() => {
                        setTouched(true);
                        setPrice(Number(o.proposed_price));
                      }}
                    >
                      {money(Number(o.proposed_price))}
                      <span className="ml-1 text-xs opacity-75">
                        ({Number(o.margin_percent).toFixed(1)}%)
                      </span>
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <Label>Selling price to apply</Label>
              <MoneyInput
                value={price}
                onChange={(v) => {
                  setTouched(true);
                  setPrice(v);
                }}
              />
              {margin !== null && (
                <p className={`mt-1 text-xs ${margin >= 0 ? "text-success" : "text-destructive"}`}>
                  Margin {money(margin)} per pack
                  {cost > 0 ? ` (${((margin / cost) * 100).toFixed(1)}%)` : ""}
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                Leave at 0 to keep the product's current selling price.
              </p>
            </div>
          </>
        ) : (
          <p className="text-muted-foreground">
            This sheet isn't set to apply to the product, so prices stay as they are.
          </p>
        )}
      </div>
      <DialogFooter>
        <Button disabled={saving} onClick={() => onSubmit(price > 0 ? price : null)}>
          {saving ? "Approving…" : "Approve & Apply"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
