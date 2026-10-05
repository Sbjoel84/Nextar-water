import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { usePermissions, useMyProductionScope } from "@/lib/permissions";
import { useActiveFactoryCode, setActiveFactoryCode } from "@/lib/factory-store";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Pencil,
  Ban,
  Printer,
  FileDown,
  Loader2,
  AlertTriangle,
  Trash2,
  Clock,
} from "lucide-react";
import { money, num } from "@/lib/format";
import { toast } from "sonner";
import { generateProductionSlipPdf } from "@/lib/pdf";
import { logAudit } from "@/lib/audit";
import { QuickAddProductDialog, ADD_NEW_ITEM } from "@/components/shared/quick-add-item";
import { RefId } from "@/components/shared/ref-id";
import { SearchBox } from "@/components/shared/search-box";
import { matchesSearch, useSearchQuery } from "@/lib/search";

export const Route = createFileRoute("/_app/production")({
  head: () => ({ meta: [{ title: "Production — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="production">
      <ProductionFactoryGate />
    </RequireAccess>
  ),
});

// Nylon and Water production are isolated per profiles.production_scope (see
// has_production_scope_access() — enforced at the RLS/RPC layer). The Factory
// Switcher (src/components/layout/factory-switcher.tsx) no longer locks a
// scoped user's factory selection app-wide — Sales, Customers, Expenses etc.
// are shared across both factories for everyone. This page is the one place
// production_scope still matters on the front end, so it owns the
// auto-correct itself: the moment a scoped user lands here on the "wrong"
// factory (because they were freely switching around the rest of the app),
// this snaps their active factory back to their own scope. The warning card
// below is a defense-in-depth fallback for the brief window before that
// effect and the scope query resolve.
function ProductionFactoryGate() {
  const factory = useFactoryId();
  const factoryId = factory.data;
  const myScope = useMyProductionScope();
  const active = useActiveFactoryCode();
  const qc = useQueryClient();
  const currentFactory = useQuery({
    queryKey: ["factory-code-for-gate", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("factories")
        .select("code,name")
        .eq("id", factoryId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const scope = myScope.data ?? "BOTH";
  const lockedCode = scope === "WATER" ? "water" : scope === "NYLON" ? "nylon" : null;

  useEffect(() => {
    if (lockedCode && active !== lockedCode) {
      setActiveFactoryCode(lockedCode);
      qc.invalidateQueries();
    }
  }, [lockedCode, active, qc]);

  if (!factoryId || myScope.isLoading || currentFactory.isLoading) return null;

  const isRestricted =
    scope !== "BOTH" &&
    currentFactory.data?.code &&
    scope !== currentFactory.data.code.toUpperCase();

  if (isRestricted) {
    return (
      <Card className="rounded-2xl border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" /> Wrong factory selected
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Your production scope is <span className="font-medium text-foreground">{scope}</span>{" "}
          only. This should resolve automatically — if it doesn't, reload the page or ask an Admin
          to check your access.
        </CardContent>
      </Card>
    );
  }

  return <ProductionPage />;
}

type Product = { id: string; name: string; unit: string; current_stock: number };
type ProductionRow = {
  id: string;
  production_number: string;
  production_date: string;
  product_id: string;
  quantity_produced: number;
  unit: string;
  production_cost: number | null;
  supervisor: string | null;
  batch_number: string | null;
  remarks: string | null;
  status: string;
  accepted_quantity: number | null;
  damaged_quantity: number | null;
  rejected_quantity: number | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  department: string | null;
  production_scope: string | null;
  packaging_unit: string | null;
  packaging_quantity: number | null;
  products: { name: string; unit: string } | null;
  production_requests: { request_number: string } | null;
  production_types: { name: string } | null;
};
type ProductUnit = { id: string; packaging_unit: string; conversion_factor: number };

const statusBadge = (s: string): "default" | "secondary" | "outline" | "destructive" => {
  if (s === "posted") return "secondary";
  if (s === "rejected" || s === "cancelled" || s === "reversed") return "destructive";
  if (s === "confirmed") return "default";
  return "outline";
};
type EligibleRequest = {
  id: string;
  request_number: string;
  product_id: string;
  quantity_requested: number;
  unit: string | null;
  products: { name: string; unit: string } | null;
};

function ProductionPage() {
  const [q, setQ] = useSearchQuery();
  const factory = useFactoryId();
  const factoryId = factory.data;
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  const { canWrite, canEdit, canCancel, canDelete, canPrint, canExport } = usePermissions();
  const write = canWrite("production");
  const cancel = canCancel("production");
  const allowPrint = canPrint("production");
  const allowExport = canExport("production");
  // Posted batches are already in finished-goods stock, so corrections go to
  // Store for approval (request_production_correction) instead of applying
  // directly. Server accepts edit|create for edits and delete|cancel for deletes.
  const requestEdit = write || canEdit("production");
  const requestDelete = cancel || canDelete("production");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProductionRow | null>(null);
  const [correction, setCorrection] = useState<{
    row: ProductionRow;
    kind: "edit" | "delete";
  } | null>(null);

  const products = useQuery({
    queryKey: ["products-for-production", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,unit,current_stock")
        .eq("factory_id", factoryId!)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Product[];
    },
  });

  const list = useQuery({
    queryKey: ["production-list", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production")
        .select(
          "id,production_number,production_date,product_id,quantity_produced,unit,production_cost,supervisor,batch_number,remarks,status,accepted_quantity,damaged_quantity,rejected_quantity,confirmed_by,confirmed_at,department,production_scope,packaging_unit,packaging_quantity,products(name,unit),production_requests!production_production_request_id_fkey(request_number),production_types(name)",
        )
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as ProductionRow[];
    },
  });

  const eligibleRequests = useQuery({
    queryKey: ["eligible-production-requests", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("production_requests")
        .select("id,request_number,product_id,quantity_requested,unit,products(name,unit)")
        .eq("factory_id", factoryId!)
        .eq("approval_status", "approved")
        .eq("materials_issued", true)
        .eq("production_status", "materials_issued")
        .order("request_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as EligibleRequest[];
    },
  });

  const pendingCorrections = useQuery({
    queryKey: ["production-corrections-pending", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("production_corrections")
        .select("production_id,kind")
        .eq("factory_id", factoryId!)
        .eq("review_status", "pending");
      if (error) throw error;
      const map: Record<string, "edit" | "delete"> = {};
      ((data ?? []) as { production_id: string; kind: "edit" | "delete" }[]).forEach((c) => {
        map[c.production_id] = c.kind;
      });
      return map;
    },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["production-corrections-pending"] });
    qc.invalidateQueries({ queryKey: ["production-list"] });
    qc.invalidateQueries({ queryKey: ["products-for-production"] });
    qc.invalidateQueries({ queryKey: ["products-active"] });
    qc.invalidateQueries({ queryKey: ["finished-goods"] });
    qc.invalidateQueries({ queryKey: ["production-requests-list"] });
    qc.invalidateQueries({ queryKey: ["eligible-production-requests"] });
  };

  const cancelBatch = useMutation({
    mutationFn: async (row: ProductionRow) => {
      const { error } = await supabase.rpc("cancel_production", { p_id: row.id });
      if (error) throw error;
      return row;
    },
    onSuccess: (row) => {
      toast.success("Production batch cancelled");
      logAudit({
        action: "cancel",
        entity: "production",
        entityId: row.id,
        factoryId,
        oldValue: row,
      });
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const print = (row: ProductionRow, action: "print" | "download" = "download") => {
    generateProductionSlipPdf(
      {
        company: {
          name: settings.data?.company_name ?? "FMIS",
          address: settings.data?.address,
          phone: settings.data?.phone,
          logo_url: settings.data?.logo_url,
        },
        production_number: row.production_number,
        production_date: row.production_date,
        product_name: row.products?.name ?? "—",
        quantity_produced: Number(row.quantity_produced),
        unit: row.unit ?? row.products?.unit ?? "",
        production_cost: Number(row.production_cost ?? 0),
        supervisor: row.supervisor,
        batch_number: row.batch_number,
        remarks: row.remarks,
        currency: settings.data?.currency ?? "NGN",
        production_type: row.production_types?.name ?? null,
        department: row.department,
        production_scope: row.production_scope,
        status: row.status,
        packaging_unit: row.packaging_unit,
        packaging_quantity: row.packaging_quantity != null ? Number(row.packaging_quantity) : null,
        accepted_quantity: row.accepted_quantity != null ? Number(row.accepted_quantity) : null,
        damaged_quantity: row.damaged_quantity != null ? Number(row.damaged_quantity) : null,
        rejected_quantity: row.rejected_quantity != null ? Number(row.rejected_quantity) : null,
        confirmed_at: row.confirmed_at,
      },
      action,
    );
    logAudit({
      action: action === "print" ? "print" : "export",
      entity: "production",
      entityId: row.id,
      factoryId,
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Production</h1>
          <p className="text-sm text-muted-foreground">
            Batch runs recorded here — Store must confirm each one before it enters finished
            products inventory.
          </p>
        </div>
        {write && (
          <Dialog
            open={formOpen}
            onOpenChange={(v) => {
              setFormOpen(v);
              if (!v) setEditing(null);
            }}
          >
            <DialogTrigger asChild>
              <Button
                className="gap-2"
                disabled={factory.isLoading}
                onClick={() => setEditing(null)}
              >
                {factory.isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                New Production
              </Button>
            </DialogTrigger>
            {formOpen &&
              (factoryId ? (
                <ProductionForm
                  factoryId={factoryId}
                  products={products.data ?? []}
                  eligibleRequests={eligibleRequests.data ?? []}
                  editing={editing}
                  onDone={() => {
                    setFormOpen(false);
                    setEditing(null);
                    invalidateAll();
                  }}
                />
              ) : (
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Can't load factory data</DialogTitle>
                  </DialogHeader>
                  <p className="text-sm text-muted-foreground">
                    {factory.error instanceof Error
                      ? factory.error.message
                      : "Factory data is unavailable right now."}
                  </p>
                </DialogContent>
              ))}
          </Dialog>
        )}
      </div>

      {factory.isError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Can't reach factory data</AlertTitle>
          <AlertDescription>
            {factory.error instanceof Error ? factory.error.message : "Unknown error"} — production,
            and every other action on this page, needs this to load first.
          </AlertDescription>
        </Alert>
      )}

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Production Runs</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <SearchBox value={q} onChange={setQ} className="mb-3" />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Qty Produced</TableHead>
                <TableHead className="text-right">Damaged</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Supervisor</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead>Request</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? [])
                .filter((x) => matchesSearch(q, x))
                .map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <RefId id={row.id} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.production_number}</TableCell>
                    <TableCell>{row.production_date}</TableCell>
                    <TableCell>{row.production_types?.name ?? "—"}</TableCell>
                    <TableCell className="font-medium">
                      {row.products?.name ?? "—"}
                      {row.packaging_unit && row.packaging_quantity != null && (
                        <div className="text-xs text-muted-foreground">
                          {num(Number(row.packaging_quantity))} {row.packaging_unit}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {num(Number(row.quantity_produced))} {row.unit}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.damaged_quantity ? (
                        <span className="text-destructive">
                          {num(Number(row.damaged_quantity))} {row.unit}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {money(Number(row.production_cost ?? 0))}
                    </TableCell>
                    <TableCell>
                      {row.production_scope ? (
                        <Badge variant="outline" className="capitalize">
                          {row.production_scope.toLowerCase()}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>{row.supervisor ?? "—"}</TableCell>
                    <TableCell>{row.batch_number ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.production_requests?.request_number ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusBadge(row.status)} className="capitalize">
                        {row.status.replace(/_/g, " ")}
                      </Badge>
                      {pendingCorrections.data?.[row.id] && (
                        <Badge variant="outline" className="mt-1 gap-1 whitespace-nowrap">
                          <Clock className="h-3 w-3" />
                          {pendingCorrections.data[row.id] === "delete" ? "Delete" : "Edit"}{" "}
                          awaiting Store
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {allowPrint && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Print"
                            onClick={() => print(row, "print")}
                          >
                            <Printer className="h-4 w-4" />
                          </Button>
                        )}
                        {allowExport && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Export PDF"
                            onClick={() => print(row, "download")}
                          >
                            <FileDown className="h-4 w-4" />
                          </Button>
                        )}
                        {row.status === "pending_confirmation" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Edit"
                            onClick={() => {
                              setEditing(row);
                              setFormOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                        {row.status === "pending_confirmation" && cancel && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon" title="Cancel">
                                <Ban className="h-4 w-4 text-destructive" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Cancel this batch?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Nothing has posted to finished-products stock yet, so this simply
                                  removes the pending batch. Its linked production request (if any)
                                  becomes available for a new batch.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Back</AlertDialogCancel>
                                <AlertDialogAction onClick={() => cancelBatch.mutate(row)}>
                                  Cancel Batch
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                        {row.status === "posted" && !pendingCorrections.data?.[row.id] && (
                          <>
                            {requestEdit && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Request correction (Store approval)"
                                onClick={() => setCorrection({ row, kind: "edit" })}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            )}
                            {requestDelete && (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Request delete (Store approval)"
                                onClick={() => setCorrection({ row, kind: "delete" })}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              {(list.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={13} className="text-center text-muted-foreground py-8">
                    No production runs yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!correction} onOpenChange={(v) => !v && setCorrection(null)}>
        {correction && (
          <CorrectionDialog
            row={correction.row}
            kind={correction.kind}
            onDone={() => {
              setCorrection(null);
              invalidateAll();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

// Correction request for a batch Store has already posted to stock. Nothing
// changes until Store approves it on the Finished Goods page; approval then
// adjusts finished-goods stock by the change in accepted quantity (or removes
// the whole accepted quantity for a delete).
function CorrectionDialog({
  row,
  kind,
  onDone,
}: {
  row: ProductionRow;
  kind: "edit" | "delete";
  onDone: () => void;
}) {
  const baseUnit = row.products?.unit ?? row.unit;
  const rejected = Number(row.rejected_quantity ?? 0);
  const [quantity, setQuantity] = useState(Number(row.quantity_produced));
  const [damaged, setDamaged] = useState(Number(row.damaged_quantity ?? 0));
  const [cost, setCost] = useState(Number(row.production_cost ?? 0));
  const [date, setDate] = useState(row.production_date);
  const [remarks, setRemarks] = useState(row.remarks ?? "");
  const [reason, setReason] = useState("");

  const oldAccepted = Number(row.accepted_quantity ?? 0);
  const newAccepted = kind === "edit" ? quantity - damaged - rejected : 0;
  const delta = newAccepted - oldAccepted;

  const submit = useMutation({
    mutationFn: async () => {
      if (!reason.trim()) throw new Error("Enter a reason for the correction");
      if (kind === "edit") {
        if (quantity <= 0) throw new Error("Quantity must be greater than 0");
        if (damaged < 0) throw new Error("Damaged quantity cannot be negative");
        if (newAccepted < 0) throw new Error("Damaged + rejected cannot exceed quantity produced");
      }
      const { error } = await supabase.rpc(
        "request_production_correction" as any,
        {
          payload: {
            production_id: row.id,
            kind,
            reason: reason.trim(),
            ...(kind === "edit"
              ? {
                  quantity_produced: quantity,
                  damaged_quantity: damaged,
                  production_cost: cost,
                  production_date: date,
                  remarks: remarks || null,
                }
              : {}),
          },
        } as any,
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(
        kind === "edit"
          ? "Correction sent to Store for approval"
          : "Delete request sent to Store for approval",
      );
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          {kind === "edit" ? "Correct" : "Delete"} Batch — {row.production_number}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 max-h-[75vh] overflow-y-auto pr-1">
        <p className="text-sm text-muted-foreground">
          {row.products?.name} · Posted to stock: {num(oldAccepted)} {baseUnit}. This batch is
          already in finished products, so your {kind === "edit" ? "correction" : "delete"} goes to
          Store for approval before stock changes.
        </p>
        {kind === "edit" && (
          <>
            <div>
              <Label>Production date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Quantity produced ({baseUnit})</Label>
                <MoneyInput min={0.001} step="0.001" value={quantity} onChange={setQuantity} />
              </div>
              <div>
                <Label>Damaged ({baseUnit})</Label>
                <MoneyInput min={0} step="0.001" value={damaged} onChange={setDamaged} />
              </div>
            </div>
            <div>
              <Label>Production cost</Label>
              <MoneyInput value={cost} onChange={setCost} />
            </div>
            <div>
              <Label>Remarks</Label>
              <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>
          </>
        )}
        <div className="rounded-lg border p-3 text-sm">
          Stock change once approved:{" "}
          <span
            className={
              delta > 0
                ? "font-medium text-success"
                : delta < 0
                  ? "font-medium text-destructive"
                  : "font-medium"
            }
          >
            {delta > 0 ? "+" : ""}
            {num(delta)} {baseUnit}
          </span>
          {rejected > 0 && kind === "edit" && (
            <span className="block text-xs text-muted-foreground">
              Includes Store's rejected quantity of {num(rejected)} {baseUnit}.
            </span>
          )}
        </div>
        <div>
          <Label>Reason</Label>
          <Textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              kind === "edit"
                ? "What was wrong with the original posting?"
                : "Why should this batch be deleted?"
            }
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          variant={kind === "delete" ? "destructive" : "default"}
          disabled={submit.isPending || !reason.trim()}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? "Sending…" : "Send to Store for approval"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function generateBatchNumber() {
  const now = new Date();
  const stamp =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0");
  const rand = Math.floor(100 + Math.random() * 900);
  return `BATCH-${stamp}-${rand}`;
}

function ProductionForm({
  factoryId,
  products,
  eligibleRequests,
  editing,
  onDone,
}: {
  factoryId: string;
  products: Product[];
  eligibleRequests: EligibleRequest[];
  editing: ProductionRow | null;
  onDone: () => void;
}) {
  const [requestId, setRequestId] = useState("");
  const [productId, setProductId] = useState(editing?.product_id ?? "");
  const [addingProduct, setAddingProduct] = useState(false);
  const [date, setDate] = useState(
    editing?.production_date ?? new Date().toISOString().slice(0, 10),
  );
  const [quantityUnit, setQuantityUnit] = useState(editing?.packaging_unit ?? "__base__");
  const [quantity, setQuantity] = useState(
    editing ? Number(editing.packaging_quantity ?? editing.quantity_produced) : 0,
  );
  const [unit, setUnit] = useState(editing?.unit ?? "");
  // Always in the product's base/stocking unit (like Store's own Confirm
  // Batch fields), regardless of what unit "Quantity produced" is entered
  // in above — avoids re-deriving a packaging conversion for this figure too.
  const [damagedQuantity, setDamagedQuantity] = useState(
    editing ? Number(editing.damaged_quantity ?? 0) : 0,
  );
  const [cost, setCost] = useState(editing ? Number(editing.production_cost ?? 0) : 0);
  const [supervisor, setSupervisor] = useState(editing?.supervisor ?? "");
  const [batch] = useState(editing?.batch_number ?? generateBatchNumber());
  const [remarks, setRemarks] = useState(editing?.remarks ?? "");

  const currentUserName = useQuery({
    queryKey: ["current-user-full-name"],
    queryFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return null;
      const { data } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", userData.user.id)
        .maybeSingle();
      return data?.full_name || userData.user.email || null;
    },
    enabled: !editing,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!editing && currentUserName.data) {
      setSupervisor(currentUserName.data);
    }
  }, [editing, currentUserName.data]);

  const selectedProduct = products.find((p) => p.id === productId);

  const productUnits = useQuery({
    queryKey: ["product-units-for-production", productId],
    enabled: !!productId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_units")
        .select("id,packaging_unit,conversion_factor")
        .eq("product_id", productId)
        .eq("active", true)
        .order("packaging_unit");
      if (error) throw error;
      return (data ?? []) as ProductUnit[];
    },
  });

  const selectedPackaging = (productUnits.data ?? []).find(
    (u) => u.packaging_unit === quantityUnit,
  );
  const computedBaseQty = selectedPackaging
    ? quantity * Number(selectedPackaging.conversion_factor)
    : quantity;

  const applyRequest = (id: string) => {
    setRequestId(id);
    const req = eligibleRequests.find((r) => r.id === id);
    if (req) {
      setProductId(req.product_id);
      setQuantityUnit("__base__");
      setQuantity(Number(req.quantity_requested));
      setUnit(req.unit ?? req.products?.unit ?? "");
    }
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!productId) throw new Error("Select a finished product");
      if (quantity <= 0) throw new Error("Quantity must be greater than 0");
      if (damagedQuantity < 0) throw new Error("Damaged quantity cannot be negative");
      if (damagedQuantity > computedBaseQty)
        throw new Error("Damaged quantity cannot exceed quantity produced");
      if (editing) {
        const { error } = await supabase.rpc("update_production", {
          payload: {
            id: editing.id,
            quantity_produced: computedBaseQty,
            damaged_quantity: damagedQuantity,
            unit: unit || selectedProduct?.unit,
            production_cost: cost,
            supervisor: supervisor || null,
            batch_number: batch || null,
            remarks: remarks || null,
            production_date: date,
          } as any,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.rpc("create_production", {
          payload: {
            factory_id: factoryId,
            product_id: productId,
            quantity_produced: selectedPackaging ? undefined : quantity,
            packaging_unit: selectedPackaging ? quantityUnit : undefined,
            packaging_quantity: selectedPackaging ? quantity : undefined,
            damaged_quantity: damagedQuantity,
            unit: unit || selectedProduct?.unit,
            production_cost: cost,
            supervisor: supervisor || null,
            batch_number: batch || null,
            remarks: remarks || null,
            production_date: date,
            production_request_id: requestId || null,
          } as any,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Production updated" : "Submitted — awaiting Store confirmation");
      logAudit({
        action: "production",
        entity: "production",
        entityId: editing?.id,
        factoryId,
        oldValue: editing
          ? {
              quantity_produced: editing.quantity_produced,
              production_cost: editing.production_cost,
            }
          : undefined,
        newValue: {
          product_id: productId,
          quantity_produced: computedBaseQty,
          production_cost: cost,
        },
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{editing ? "Update Production" : "New Production"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3 max-h-[75vh] overflow-y-auto pr-1">
        <div>
          <Label>Production date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {!editing && eligibleRequests.length > 0 && (
          <div>
            <Label>Link to Production Request (optional)</Label>
            <Select
              value={requestId || "none"}
              onValueChange={(v) => applyRequest(v === "none" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {eligibleRequests.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.request_number} · {r.products?.name} · {num(Number(r.quantity_requested))}{" "}
                    {r.unit}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div>
          <Label>Finished product</Label>
          <Select
            value={productId}
            onValueChange={(v) => {
              if (v === ADD_NEW_ITEM) {
                setAddingProduct(true);
                return;
              }
              setProductId(v);
              setQuantityUnit("__base__");
              const p = products.find((x) => x.id === v);
              if (p) setUnit(p.unit);
            }}
            disabled={!!editing || !!requestId}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select product…" />
            </SelectTrigger>
            <SelectContent>
              {products.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name} · stock {num(Number(p.current_stock))} {p.unit}
                </SelectItem>
              ))}
              <SelectItem value={ADD_NEW_ITEM} className="font-medium text-primary">
                + Add new product…
              </SelectItem>
            </SelectContent>
          </Select>
          <QuickAddProductDialog
            open={addingProduct}
            onOpenChange={setAddingProduct}
            factoryId={factoryId}
            hideOpeningStock
            onCreated={(id) => {
              setProductId(id);
              setQuantityUnit("__base__");
            }}
          />
        </div>
        {!editing && selectedProduct && (
          <div>
            <Label>Quantity entered as</Label>
            <Select value={quantityUnit} onValueChange={setQuantityUnit}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__base__">{selectedProduct.unit} (base unit)</SelectItem>
                {(productUnits.data ?? []).map((u) => (
                  <SelectItem key={u.id} value={u.packaging_unit} className="capitalize">
                    {u.packaging_unit} (1 = {num(Number(u.conversion_factor))}{" "}
                    {selectedProduct.unit})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{selectedPackaging ? `Quantity (${quantityUnit})` : "Quantity produced"}</Label>
            <MoneyInput min={0.001} step="0.001" value={quantity} onChange={setQuantity} />
            {selectedPackaging && (
              <p className="mt-1 text-xs text-muted-foreground">
                = {num(computedBaseQty)} {selectedProduct?.unit} (base unit)
              </p>
            )}
          </div>
          <div>
            <Label>Unit</Label>
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
          </div>
        </div>
        <div>
          <Label>Damaged quantity {selectedProduct ? `(${selectedProduct.unit})` : ""}</Label>
          <MoneyInput min={0} step="0.001" value={damagedQuantity} onChange={setDamagedQuantity} />
          <p className="mt-1 text-xs text-muted-foreground">
            Damage already known at production time. Store can review and adjust this when they
            confirm the batch.
          </p>
        </div>
        <div>
          <Label>Production cost</Label>
          <MoneyInput value={cost} onChange={setCost} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Supervisor</Label>
            <Input value={supervisor} disabled className="disabled:opacity-100" />
            <p className="mt-1 text-xs text-muted-foreground">
              Auto-filled with your account name.
            </p>
          </div>
          <div>
            <Label>Batch number</Label>
            <Input value={batch} disabled className="disabled:opacity-100 font-mono" />
            <p className="mt-1 text-xs text-muted-foreground">Auto-generated.</p>
          </div>
        </div>
        <div>
          <Label>Remarks</Label>
          <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : editing ? "Update" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
