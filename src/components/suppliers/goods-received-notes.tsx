import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { useFactorySettings } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { usePrefillFromProfile } from "@/lib/use-my-profile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Dialog,
} from "@/components/ui/dialog";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, Eye, Loader2, Plus, Printer, Trash2, X } from "lucide-react";
import { num, money } from "@/lib/format";
import { toast } from "sonner";
import { generateGoodsReceivedNotePdf } from "@/lib/pdf";
import { logAudit } from "@/lib/audit";

// ============================== Types ==============================

export type GrnSupplier = { id: string; name: string; phone: string | null };

type GrnLine = {
  id: string;
  receipt_number: string;
  ordered_quantity: number | null;
  quantity: number;
  damaged_quantity: number;
  accepted_quantity: number | null;
  unit: string | null;
  unit_cost: number | null;
  item_condition: string | null;
  remarks: string | null;
  status: string;
  reject_reason: string | null;
  raw_materials: { name: string; unit: string } | null;
  purchase_orders: { po_number: string } | null;
};

export type GrnRow = {
  id: string;
  grn_number: string;
  supplier_id: string;
  date_received: string;
  time_received: string | null;
  lpo_number: string | null;
  delivery_note_number: string | null;
  supplier_phone: string | null;
  vehicle_number: string | null;
  driver_name: string | null;
  overall_condition: string | null;
  packaging_condition: string | null;
  expiry_date: string | null;
  discrepancies: string | null;
  received_by_name: string;
  received_by_designation: string | null;
  inspected_by_name: string | null;
  inspected_by_designation: string | null;
  delivered_by_name: string | null;
  verified_by_name: string | null;
  verified_by_designation: string | null;
  created_at: string;
  suppliers: { name: string } | null;
  goods_receipts: GrnLine[];
};

const GRN_SELECT =
  "*,suppliers(name),goods_receipts(id,receipt_number,ordered_quantity,quantity,damaged_quantity,accepted_quantity,unit,unit_cost,item_condition,remarks,status,reject_reason,raw_materials(name,unit),purchase_orders(po_number))";

const OVERALL_CONDITIONS = ["excellent", "good", "fair", "poor"] as const;
const PACKAGING_CONDITIONS = ["intact", "damaged", "open"] as const;
const ITEM_CONDITIONS = ["Good", "Fair", "Damaged", "Expired", "Short supply", "Wrong item"];

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The note itself has no status: it follows its item lines, each of which
// goes through the normal goods-receipt dual control.
function grnStatus(lines: GrnLine[]): {
  label: string;
  variant: "default" | "secondary" | "outline" | "destructive";
  pending: boolean;
} {
  const s = lines.map((l) => l.status);
  if (s.some((x) => x === "pending_confirmation"))
    return { label: "Awaiting confirmation", variant: "outline", pending: true };
  if (s.length > 0 && s.every((x) => x === "posted"))
    return { label: "Posted to stock", variant: "secondary", pending: false };
  if (s.length > 0 && s.every((x) => x === "rejected"))
    return { label: "Rejected", variant: "destructive", pending: false };
  if (s.length > 0 && s.every((x) => x === "cancelled"))
    return { label: "Cancelled", variant: "destructive", pending: false };
  return { label: "Partly posted", variant: "default", pending: false };
}

function useGoodsReceivedNotes(factoryId: string | undefined, supplierId?: string) {
  return useQuery({
    queryKey: ["grns", factoryId, supplierId ?? "all"],
    enabled: !!factoryId,
    queryFn: async () => {
      let query = supabase
        .from("goods_received_notes")
        .select(GRN_SELECT)
        .eq("factory_id", factoryId!)
        .order("date_received", { ascending: false })
        .order("grn_number", { ascending: false })
        .limit(300);
      if (supplierId) query = query.eq("supplier_id", supplierId);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as unknown as GrnRow[];
    },
  });
}

// ============================== List ==============================

export function GoodsReceivedNotesTable({
  factoryId,
  supplierId,
  emptyText = "No goods received notes yet.",
}: {
  factoryId: string | undefined;
  supplierId?: string;
  emptyText?: string;
}) {
  const { canConfirm, canReject } = usePermissions();
  const qc = useQueryClient();
  const settings = useFactorySettings(factoryId);
  const list = useGoodsReceivedNotes(factoryId, supplierId);
  const data = list.data ?? [];
  const [viewing, setViewing] = useState<GrnRow | null>(null);
  const [rejecting, setRejecting] = useState<GrnRow | null>(null);

  const confirm = useMutation({
    mutationFn: async (grn: GrnRow) => {
      const { error } = await supabase.rpc("confirm_goods_received_note", { p_id: grn.id });
      if (error) throw error;
    },
    onSuccess: (_d, grn) => {
      toast.success(`GRN ${grn.grn_number} confirmed — accepted quantities posted to stock`);
      qc.invalidateQueries();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const print = (grn: GrnRow) => {
    printGoodsReceivedNote(grn, settings.data);
    logAudit({ action: "print", entity: "goods_received_notes", entityId: grn.id, factoryId });
  };

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>GRN No.</TableHead>
            <TableHead>Date</TableHead>
            {!supplierId && <TableHead>Supplier</TableHead>}
            <TableHead>LPO No.</TableHead>
            <TableHead>Items</TableHead>
            <TableHead>Received by</TableHead>
            <TableHead>Status</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((grn) => {
            const st = grnStatus(grn.goods_receipts);
            return (
              <TableRow key={grn.id}>
                <TableCell className="font-mono text-xs">{grn.grn_number}</TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {grn.date_received}
                  {grn.time_received ? ` ${grn.time_received.slice(0, 5)}` : ""}
                </TableCell>
                {!supplierId && (
                  <TableCell className="font-medium">{grn.suppliers?.name ?? "—"}</TableCell>
                )}
                <TableCell>{grn.lpo_number ?? "—"}</TableCell>
                <TableCell className="max-w-60 truncate">
                  {grn.goods_receipts.map((l) => l.raw_materials?.name ?? "—").join(", ")}
                </TableCell>
                <TableCell>{grn.received_by_name}</TableCell>
                <TableCell>
                  <Badge variant={st.variant}>{st.label}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {st.pending && canConfirm("goods-receiving") && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Confirm and post to stock"
                        disabled={confirm.isPending}
                        onClick={() => confirm.mutate(grn)}
                      >
                        <Check className="h-4 w-4 text-success" />
                      </Button>
                    )}
                    {st.pending && canReject("goods-receiving") && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Reject"
                        onClick={() => setRejecting(grn)}
                      >
                        <X className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      title="View"
                      onClick={() => setViewing(grn)}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" title="Print" onClick={() => print(grn)}>
                      <Printer className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
          {data.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={supplierId ? 7 : 8}
                className="py-6 text-center text-muted-foreground"
              >
                {list.isLoading ? "Loading…" : emptyText}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        {viewing && <GoodsReceivedNoteDetail grn={viewing} onPrint={() => print(viewing)} />}
      </Dialog>
      <Dialog open={!!rejecting} onOpenChange={(v) => !v && setRejecting(null)}>
        {rejecting && (
          <RejectGrnDialog
            grn={rejecting}
            onDone={() => {
              setRejecting(null);
              qc.invalidateQueries();
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function printGoodsReceivedNote(
  grn: GrnRow,
  settings:
    | {
        company_name?: string | null;
        address?: string | null;
        phone?: string | null;
        email?: string | null;
        logo_url?: string | null;
      }
    | null
    | undefined,
) {
  generateGoodsReceivedNotePdf(
    {
      company: {
        name: settings?.company_name ?? "FMIS",
        address: settings?.address,
        phone: settings?.phone,
        email: settings?.email,
        logo_url: settings?.logo_url,
      },
      grn_number: grn.grn_number,
      date_received: grn.date_received,
      time_received: grn.time_received?.slice(0, 5),
      lpo_number: grn.lpo_number,
      supplier_name: grn.suppliers?.name ?? "—",
      supplier_phone: grn.supplier_phone,
      vehicle_number: grn.vehicle_number,
      driver_name: grn.driver_name,
      delivery_note_number: grn.delivery_note_number,
      items: grn.goods_receipts.map((l) => ({
        description: l.raw_materials?.name ?? "—",
        quantity_ordered: l.ordered_quantity != null ? Number(l.ordered_quantity) : null,
        quantity_received: Number(l.quantity),
        quantity_rejected: Number(l.damaged_quantity),
        condition: l.item_condition,
        remark: l.remarks?.startsWith("GRN ") ? null : l.remarks,
        unit: l.unit ?? l.raw_materials?.unit ?? "",
      })),
      overall_condition: grn.overall_condition,
      packaging_condition: grn.packaging_condition,
      expiry_date: grn.expiry_date,
      discrepancies: grn.discrepancies,
      received_by_name: grn.received_by_name,
      received_by_designation: grn.received_by_designation,
      inspected_by_name: grn.inspected_by_name,
      inspected_by_designation: grn.inspected_by_designation,
      delivered_by_name: grn.delivered_by_name,
      verified_by_name: grn.verified_by_name,
      verified_by_designation: grn.verified_by_designation,
      status: grnStatus(grn.goods_receipts).label,
    },
    "print",
  );
}

function RejectGrnDialog({ grn, onDone }: { grn: GrnRow; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("reject_goods_received_note", {
        p_id: grn.id,
        p_reason: reason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`GRN ${grn.grn_number} rejected — nothing was posted to stock`);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reject GRN {grn.grn_number}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-2">
        <Label>Reason</Label>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          disabled={!reason.trim() || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? "Rejecting…" : "Reject GRN"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// ============================== Detail ==============================

function GoodsReceivedNoteDetail({ grn, onPrint }: { grn: GrnRow; onPrint: () => void }) {
  const st = grnStatus(grn.goods_receipts);
  const Field = ({ label, value }: { label: string; value: string | null | undefined }) => (
    <div>
      <span className="text-muted-foreground">{label}:</span> {value || "—"}
    </div>
  );

  return (
    <DialogContent className="max-w-3xl">
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2">
          Goods Received Note {grn.grn_number}
          <Badge variant={st.variant}>{st.label}</Badge>
        </DialogTitle>
      </DialogHeader>
      <div className="grid max-h-[75vh] gap-4 overflow-y-auto pr-1 text-sm">
        <div className="grid gap-2 rounded-md bg-muted/30 p-3 sm:grid-cols-3">
          <Field label="Date received" value={grn.date_received} />
          <Field label="Time received" value={grn.time_received?.slice(0, 5)} />
          <Field label="LPO No." value={grn.lpo_number} />
          <Field label="Supplier" value={grn.suppliers?.name} />
          <Field label="Phone" value={grn.supplier_phone} />
          <Field label="Delivery note / Invoice No." value={grn.delivery_note_number} />
          <Field label="Vehicle No." value={grn.vehicle_number} />
          <Field label="Driver / Delivery person" value={grn.driver_name} />
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>S/No.</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Rejected</TableHead>
                <TableHead className="text-right">Accepted</TableHead>
                <TableHead>Condition</TableHead>
                <TableHead>Remark</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grn.goods_receipts.map((l, i) => {
                const unit = l.unit ?? l.raw_materials?.unit ?? "";
                return (
                  <TableRow key={l.id}>
                    <TableCell>{i + 1}</TableCell>
                    <TableCell className="font-medium">
                      {l.raw_materials?.name ?? "—"}
                      {l.purchase_orders && (
                        <div className="text-xs text-muted-foreground">
                          {l.purchase_orders.po_number}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {l.ordered_quantity != null
                        ? `${num(Number(l.ordered_quantity))} ${unit}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {num(Number(l.quantity))} {unit}
                    </TableCell>
                    <TableCell className="text-right">
                      {num(Number(l.damaged_quantity))} {unit}
                    </TableCell>
                    <TableCell className="text-right">
                      {num(Number(l.accepted_quantity ?? 0))} {unit}
                    </TableCell>
                    <TableCell>{l.item_condition ?? "—"}</TableCell>
                    <TableCell className="max-w-40 truncate">
                      {l.remarks?.startsWith("GRN ") ? "—" : (l.remarks ?? "—")}
                    </TableCell>
                    <TableCell className="text-right">
                      {l.unit_cost != null ? money(Number(l.unit_cost)) : "—"}
                    </TableCell>
                    <TableCell className="capitalize">
                      {l.status.replace(/_/g, " ")}
                      {l.reject_reason && (
                        <div className="text-xs text-destructive">{l.reject_reason}</div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <div className="grid gap-2 rounded-md bg-muted/30 p-3 sm:grid-cols-3">
          <Field
            label="Overall condition"
            value={grn.overall_condition && capitalize(grn.overall_condition)}
          />
          <Field
            label="Packaging condition"
            value={grn.packaging_condition && capitalize(grn.packaging_condition)}
          />
          <Field label="Expiry date" value={grn.expiry_date} />
          <div className="sm:col-span-3">
            <span className="text-muted-foreground">Discrepancies / observations:</span>{" "}
            {grn.discrepancies || "—"}
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Field
            label="Received by (Store Keeper)"
            value={[grn.received_by_name, grn.received_by_designation].filter(Boolean).join(" — ")}
          />
          <Field
            label="Inspected by (Internal Control)"
            value={[grn.inspected_by_name, grn.inspected_by_designation]
              .filter(Boolean)
              .join(" — ")}
          />
          <Field label="Delivered by (Supplier / Driver)" value={grn.delivered_by_name} />
          <Field
            label="Verified by (Security)"
            value={[grn.verified_by_name, grn.verified_by_designation].filter(Boolean).join(" — ")}
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" className="gap-2" onClick={onPrint}>
          <Printer className="h-4 w-4" /> Print GRN
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// ============================== Form ==============================

type OpenPo = {
  id: string;
  po_number: string;
  material_id: string;
  quantity_ordered: number;
  quantity_received: number;
  unit: string | null;
  unit_cost: number | null;
  raw_materials: { name: string; unit: string } | null;
};
type MaterialOption = {
  id: string;
  name: string;
  unit: string;
  unit_cost: number | null;
  supplier_id: string | null;
};

type FormLine = {
  key: number;
  // "po:<purchase order id>" or "mat:<raw material id>"
  source: string;
  ordered: number;
  received: number;
  rejected: number;
  unitCost: number;
  condition: string;
  remark: string;
};

const blankLine = (key: number): FormLine => ({
  key,
  source: "",
  ordered: 0,
  received: 0,
  rejected: 0,
  unitCost: 0,
  condition: "Good",
  remark: "",
});

const todayLocal = () => new Date().toLocaleDateString("en-CA");
const nowTime = () => new Date().toTimeString().slice(0, 5);

export function GoodsReceivedNoteFormDialog({
  supplier,
  factoryId,
  onDone,
}: {
  supplier: GrnSupplier;
  factoryId: string | undefined;
  onDone: () => void;
}) {
  const qc = useQueryClient();

  const [dateReceived, setDateReceived] = useState(todayLocal);
  const [timeReceived, setTimeReceived] = useState(nowTime);
  const [lpoNumber, setLpoNumber] = useState("");
  const [lpoTouched, setLpoTouched] = useState(false);
  const [phone, setPhone] = useState(supplier.phone ?? "");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [driverName, setDriverName] = useState("");
  const [deliveryNote, setDeliveryNote] = useState("");
  const [lines, setLines] = useState<FormLine[]>([blankLine(1)]);
  const [overall, setOverall] = useState("");
  const [packaging, setPackaging] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [discrepancies, setDiscrepancies] = useState("");
  const [receivedBy, setReceivedBy] = useState("");
  usePrefillFromProfile("name", receivedBy, setReceivedBy);
  const [receivedByDesignation, setReceivedByDesignation] = useState("Store Keeper");
  const [inspectedBy, setInspectedBy] = useState("");
  const [inspectedByDesignation, setInspectedByDesignation] = useState("Internal Control");
  const [deliveredBy, setDeliveredBy] = useState("");
  const [verifiedBy, setVerifiedBy] = useState("");
  const [verifiedByDesignation, setVerifiedByDesignation] = useState("Security");

  const openPos = useQuery({
    queryKey: ["grn-open-pos", supplier.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("purchase_orders")
        .select(
          "id,po_number,material_id,quantity_ordered,quantity_received,unit,unit_cost,raw_materials(name,unit)",
        )
        .eq("supplier_id", supplier.id)
        .in("status", ["issued", "partially_received"])
        .order("issued_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as OpenPo[];
    },
  });

  const materials = useQuery({
    queryKey: ["grn-materials", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("raw_materials")
        .select("id,name,unit,unit_cost,supplier_id")
        .eq("factory_id", factoryId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as MaterialOption[];
    },
  });

  const pos = openPos.data ?? [];
  const allMaterials = materials.data ?? [];
  // This supplier's usual materials first, then everything else.
  const supplierMaterials = allMaterials.filter((m) => m.supplier_id === supplier.id);
  const otherMaterials = allMaterials.filter((m) => m.supplier_id !== supplier.id);

  const resolve = (source: string) => {
    if (source.startsWith("po:")) {
      const po = pos.find((p) => p.id === source.slice(3));
      return po
        ? {
            po,
            name: po.raw_materials?.name ?? "—",
            unit: po.unit ?? po.raw_materials?.unit ?? "",
          }
        : null;
    }
    if (source.startsWith("mat:")) {
      const m = allMaterials.find((x) => x.id === source.slice(4));
      return m ? { po: null, name: m.name, unit: m.unit } : null;
    }
    return null;
  };

  // LPO No. follows the purchase orders picked below until someone types over it.
  const lpoValue = lpoTouched
    ? lpoNumber
    : Array.from(new Set(lines.map((l) => resolve(l.source)?.po?.po_number).filter(Boolean))).join(
        ", ",
      );

  const updateLine = (key: number, patch: Partial<FormLine>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const pickSource = (key: number, source: string) => {
    if (source.startsWith("po:")) {
      const po = pos.find((p) => p.id === source.slice(3));
      if (po) {
        const outstanding = Number(po.quantity_ordered) - Number(po.quantity_received);
        return updateLine(key, {
          source,
          ordered: Number(po.quantity_ordered),
          received: outstanding,
          unitCost: po.unit_cost != null ? Number(po.unit_cost) : 0,
        });
      }
    }
    const m = allMaterials.find((x) => x.id === source.slice(4));
    updateLine(key, { source, unitCost: m?.unit_cost != null ? Number(m.unit_cost) : 0 });
  };

  const removeLine = (key: number) => setLines((prev) => prev.filter((l) => l.key !== key));

  const lineError = (l: FormLine): string | null => {
    const r = resolve(l.source);
    if (!r) return "Select the item received";
    if (l.received <= 0) return "Enter the quantity received";
    if (l.rejected > l.received) return "Rejected can't be more than received";
    if (r.po) {
      const outstanding = Number(r.po.quantity_ordered) - Number(r.po.quantity_received);
      if (l.received > outstanding)
        return `Only ${num(outstanding)} ${r.unit} still outstanding on ${r.po.po_number}`;
    }
    return null;
  };
  const firstError =
    lines.length === 0
      ? "Add at least one item"
      : (lines.map(lineError).find(Boolean) ??
        (!receivedBy.trim() ? "Enter who received the goods" : null));

  const submit = useMutation({
    mutationFn: async () => {
      if (firstError) throw new Error(firstError);
      const { data, error } = await supabase.rpc("submit_goods_received_note", {
        payload: {
          supplier_id: supplier.id,
          date_received: dateReceived,
          time_received: timeReceived || undefined,
          lpo_number: lpoValue,
          delivery_note_number: deliveryNote,
          supplier_phone: phone,
          vehicle_number: vehicleNumber,
          driver_name: driverName,
          overall_condition: overall || undefined,
          packaging_condition: packaging || undefined,
          expiry_date: expiryDate || undefined,
          discrepancies,
          received_by_name: receivedBy.trim(),
          received_by_designation: receivedByDesignation,
          inspected_by_name: inspectedBy,
          inspected_by_designation: inspectedByDesignation,
          delivered_by_name: deliveredBy || driverName,
          verified_by_name: verifiedBy,
          verified_by_designation: verifiedByDesignation,
          items: lines.map((l) => ({
            purchase_order_id: l.source.startsWith("po:") ? l.source.slice(3) : undefined,
            material_id: l.source.startsWith("mat:") ? l.source.slice(4) : undefined,
            ordered_quantity: l.ordered > 0 ? l.ordered : undefined,
            quantity: l.received,
            rejected_quantity: l.rejected,
            unit_cost: l.unitCost > 0 ? l.unitCost : undefined,
            item_condition: l.condition,
            remark: l.remark,
          })),
        } as unknown as Json,
      });
      if (error) throw error;
      return data as { id: string; grn_number: string };
    },
    onSuccess: (data) => {
      toast.success(
        `GRN ${data.grn_number} saved — awaiting confirmation by a different person before stock is updated`,
      );
      logAudit({ action: "create", entity: "goods_received_notes", entityId: data.id, factoryId });
      qc.invalidateQueries({ queryKey: ["grns"] });
      qc.invalidateQueries({ queryKey: ["goods-receipts"] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sectionTitle = "text-xs font-semibold uppercase tracking-wider text-primary";

  return (
    <DialogContent className="max-w-5xl">
      <DialogHeader>
        <DialogTitle>Goods Received Note — {supplier.name}</DialogTitle>
      </DialogHeader>
      <div className="grid max-h-[75vh] gap-5 overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label>Date received</Label>
            <Input
              type="date"
              value={dateReceived}
              onChange={(e) => setDateReceived(e.target.value)}
            />
          </div>
          <div>
            <Label>Time received</Label>
            <Input
              type="time"
              value={timeReceived}
              onChange={(e) => setTimeReceived(e.target.value)}
            />
          </div>
          <div>
            <Label>LPO No.</Label>
            <Input
              value={lpoValue}
              onChange={(e) => {
                setLpoTouched(true);
                setLpoNumber(e.target.value);
              }}
              placeholder="Filled from the purchase orders below"
            />
          </div>
        </div>

        <section className="grid gap-3">
          <h3 className={sectionTitle}>Supplier details</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Supplier name</Label>
              <Input value={supplier.name} disabled />
            </div>
            <div>
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>Vehicle No.</Label>
              <Input value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} />
            </div>
            <div>
              <Label>Driver / Delivery person</Label>
              <Input value={driverName} onChange={(e) => setDriverName(e.target.value)} />
            </div>
            <div>
              <Label>Delivery note / Invoice No.</Label>
              <Input value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} />
            </div>
          </div>
        </section>

        <section className="grid gap-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className={sectionTitle}>Items received</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={() =>
                setLines((prev) => [...prev, blankLine(Math.max(0, ...prev.map((l) => l.key)) + 1)])
              }
            >
              <Plus className="h-4 w-4" /> Add item
            </Button>
          </div>
          <div className="overflow-x-auto">
            <Table className="min-w-[960px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">S/No.</TableHead>
                  <TableHead className="w-64">Item description</TableHead>
                  <TableHead>Qty ordered</TableHead>
                  <TableHead>Qty received</TableHead>
                  <TableHead>Qty rejected</TableHead>
                  <TableHead>Condition</TableHead>
                  <TableHead>Remark</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Unit cost</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l, i) => {
                  const r = resolve(l.source);
                  const err = l.source ? lineError(l) : null;
                  return (
                    <TableRow key={l.key} className="align-top">
                      <TableCell className="pt-4">{i + 1}</TableCell>
                      <TableCell>
                        <Select value={l.source} onValueChange={(v) => pickSource(l.key, v)}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select item…" />
                          </SelectTrigger>
                          <SelectContent>
                            {pos.length > 0 && (
                              <SelectGroup>
                                <SelectLabel>Open purchase orders</SelectLabel>
                                {pos.map((p) => (
                                  <SelectItem key={p.id} value={`po:${p.id}`}>
                                    {p.po_number} · {p.raw_materials?.name} (
                                    {num(Number(p.quantity_ordered) - Number(p.quantity_received))}{" "}
                                    {p.unit} outstanding)
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            )}
                            {supplierMaterials.length > 0 && (
                              <SelectGroup>
                                <SelectLabel>Supplied by {supplier.name}</SelectLabel>
                                {supplierMaterials.map((m) => (
                                  <SelectItem key={m.id} value={`mat:${m.id}`}>
                                    {m.name}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            )}
                            {otherMaterials.length > 0 && (
                              <SelectGroup>
                                <SelectLabel>Other materials</SelectLabel>
                                {otherMaterials.map((m) => (
                                  <SelectItem key={m.id} value={`mat:${m.id}`}>
                                    {m.name}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            )}
                          </SelectContent>
                        </Select>
                        {err && <p className="mt-1 text-xs text-destructive">{err}</p>}
                      </TableCell>
                      <TableCell>
                        <MoneyInput
                          value={l.ordered}
                          onChange={(v) => updateLine(l.key, { ordered: v })}
                          disabled={!!r?.po}
                          className="w-24"
                        />
                      </TableCell>
                      <TableCell>
                        <MoneyInput
                          value={l.received}
                          onChange={(v) => updateLine(l.key, { received: v })}
                          className="w-24"
                        />
                      </TableCell>
                      <TableCell>
                        <MoneyInput
                          value={l.rejected}
                          onChange={(v) => updateLine(l.key, { rejected: v })}
                          className="w-24"
                        />
                      </TableCell>
                      <TableCell>
                        <Select
                          value={l.condition}
                          onValueChange={(v) => updateLine(l.key, { condition: v })}
                        >
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ITEM_CONDITIONS.map((c) => (
                              <SelectItem key={c} value={c}>
                                {c}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Input
                          value={l.remark}
                          onChange={(e) => updateLine(l.key, { remark: e.target.value })}
                          className="w-36"
                        />
                      </TableCell>
                      <TableCell className="pt-4 text-sm">{r?.unit ?? "—"}</TableCell>
                      <TableCell>
                        <MoneyInput
                          value={l.unitCost}
                          onChange={(v) => updateLine(l.key, { unitCost: v })}
                          className="w-28"
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          title="Remove item"
                          disabled={lines.length === 1}
                          onClick={() => removeLine(l.key)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            Only the accepted quantity (received − rejected) goes into stock. Rejected quantities
            are logged to the damage ledger. Unit cost values the stock and comes from the purchase
            order when there is one.
          </p>
        </section>

        <section className="grid gap-3">
          <h3 className={sectionTitle}>Quality inspection</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <ChoiceGroup
              label="Overall condition"
              options={OVERALL_CONDITIONS}
              value={overall}
              onChange={setOverall}
            />
            <ChoiceGroup
              label="Packaging condition"
              options={PACKAGING_CONDITIONS}
              value={packaging}
              onChange={setPackaging}
            />
            <div>
              <Label>Expiry date</Label>
              <Input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
              />
            </div>
          </div>
        </section>

        <section className="grid gap-2">
          <h3 className={sectionTitle}>Discrepancies / observations</h3>
          <Textarea
            rows={3}
            value={discrepancies}
            onChange={(e) => setDiscrepancies(e.target.value)}
            placeholder="Shortages, damaged items, wrong items, late delivery…"
          />
        </section>

        <section className="grid gap-3">
          <h3 className={sectionTitle}>Signatories</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Signatory
              title="Received by (Store Keeper) *"
              name={receivedBy}
              onName={setReceivedBy}
              designation={receivedByDesignation}
              onDesignation={setReceivedByDesignation}
            />
            <Signatory
              title="Inspected by (Internal Control)"
              name={inspectedBy}
              onName={setInspectedBy}
              designation={inspectedByDesignation}
              onDesignation={setInspectedByDesignation}
            />
            <Signatory
              title="Delivered by (Supplier / Driver)"
              name={deliveredBy}
              onName={setDeliveredBy}
              namePlaceholder={driverName || "Name"}
            />
            <Signatory
              title="Verified by (Security)"
              name={verifiedBy}
              onName={setVerifiedBy}
              designation={verifiedByDesignation}
              onDesignation={setVerifiedByDesignation}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Signatures are collected on the printed GRN.
          </p>
        </section>
      </div>
      <DialogFooter className="items-center gap-2">
        {firstError && lines.some((l) => l.source) && (
          <span className="text-xs text-muted-foreground sm:mr-auto">{firstError}</span>
        )}
        <Button
          disabled={!!firstError || submit.isPending}
          onClick={() => submit.mutate()}
          className="gap-2"
        >
          {submit.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {submit.isPending ? "Saving…" : "Save GRN"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ChoiceGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {options.map((o) => (
          <Button
            key={o}
            type="button"
            size="sm"
            variant={value === o ? "default" : "outline"}
            onClick={() => onChange(value === o ? "" : o)}
          >
            {capitalize(o)}
          </Button>
        ))}
      </div>
    </div>
  );
}

function Signatory({
  title,
  name,
  onName,
  designation,
  onDesignation,
  namePlaceholder = "Name",
}: {
  title: string;
  name: string;
  onName: (v: string) => void;
  designation?: string;
  onDesignation?: (v: string) => void;
  namePlaceholder?: string;
}) {
  return (
    <div className="grid gap-2 rounded-md border p-3">
      <Label>{title}</Label>
      <div className={onDesignation ? "grid grid-cols-2 gap-2" : "grid"}>
        <Input
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder={namePlaceholder}
        />
        {onDesignation && (
          <Input
            value={designation ?? ""}
            onChange={(e) => onDesignation(e.target.value)}
            placeholder="Designation"
          />
        )}
      </div>
    </div>
  );
}
