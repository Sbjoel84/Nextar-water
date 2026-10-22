import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactorySettings } from "@/lib/use-factory";
import { usePermissions, useIsSuperAdmin } from "@/lib/permissions";
import { salePosition, useCustomerAccount } from "@/lib/customer-account";
import { openSaleInvoice } from "@/lib/sale-invoice";
import { logAudit } from "@/lib/audit";
import { fetchAll } from "@/lib/metrics";
import { money, num } from "@/lib/format";
import { matchesSearch } from "@/lib/search";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Trash2, Printer, X, Search } from "lucide-react";
import { ApprovalHistory } from "@/components/workflow/approval-history";
import { RefId } from "@/components/shared/ref-id";

export type PaymentMethod = "cash" | "transfer" | "pos" | "card" | "cheque" | "credit";
export type PaymentLine = { amount: number; method: PaymentMethod };

// Who the sales person is capturing the order for. Stored on sales.customer_type.
export type CustomerType = "walk_in" | "marketer" | "distributor" | "other";
export const CUSTOMER_TYPES: { value: CustomerType; label: string }[] = [
  { value: "walk_in", label: "Walk-in customer" },
  { value: "marketer", label: "Sales-Rep" },
  { value: "distributor", label: "Distributor" },
  { value: "other", label: "Other" },
];
export const customerTypeLabel = (t: string | null | undefined) =>
  CUSTOMER_TYPES.find((c) => c.value === t)?.label ?? "Walk-in customer";

export const PAY_DIALOG_METHODS: PaymentMethod[] = ["cash", "transfer", "pos", "card", "cheque"];
export const PAYMENT_TYPES = ["Full Payment", "Part Payment"];

// The fields of a pending order both the Sales table and the Finance page's
// confirmation list carry.
export type PendingSale = {
  id: string;
  invoice_number: string;
  sale_date: string;
  created_at: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_type: string | null;
  subtotal: number;
  grand_total: number;
  is_pr: boolean;
  sales_person: string | null;
  created_by: string | null;
  sales_rep_id?: string | null;
};

// One row per method so a customer paying part cash, part transfer can be
// recorded in a single transaction instead of forcing everything onto one
// payment_method.
export function PaymentLinesEditor({
  payments,
  onChange,
  methods,
}: {
  payments: PaymentLine[];
  onChange: (payments: PaymentLine[]) => void;
  methods: PaymentMethod[];
}) {
  const update = (i: number, patch: Partial<PaymentLine>) =>
    onChange(payments.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const remove = (i: number) => onChange(payments.filter((_, idx) => idx !== i));
  const add = () => onChange([...payments, { amount: 0, method: "cash" }]);

  return (
    <div className="space-y-2">
      {payments.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <MoneyInput
            value={p.amount}
            onChange={(v) => update(i, { amount: v })}
            className="flex-1"
          />
          <Select value={p.method} onValueChange={(v) => update(i, { method: v as PaymentMethod })}>
            <SelectTrigger className="w-32 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {methods.map((m) => (
                <SelectItem key={m} value={m} className="capitalize">
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {payments.length > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={() => remove(i)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={add}>
        <Plus className="h-3.5 w-3.5" /> Add payment method
      </Button>
    </div>
  );
}

// Every view a confirmed order moves: stock, the customer's account, and the
// finance figures.
function invalidateAfterConfirm(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [
    "sales-list",
    "pending-sales",
    "customer-account",
    "customer-sales-full",
    "customer-payments-full",
    "customers",
    "finished-goods",
    "products-active",
    "products-for-production",
    "fin",
  ]) {
    qc.invalidateQueries({ queryKey: [key] });
  }
}

// The accountant's half of an order: the sales person posted what is being
// sold and to whom; here the payment taken, discount / commission and VAT are
// set, the order is confirmed (stock decrements, debt/advance applied) and the
// receipt prints — all through confirm_sale(), in one transaction.
export function ConfirmSaleDialog({
  sale,
  factoryId,
  onDone,
}: {
  sale: PendingSale;
  factoryId: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const settings = useFactorySettings(factoryId);
  const detail = useQuery({
    queryKey: ["sale-confirm-detail", sale.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select(
          "remarks,customer_phone,discount,vat,pending_payments,sale_items(quantity,unit_price,line_total,products(name,unit))",
        )
        .eq("id", sale.id)
        .single();
      if (error) throw error;
      return data as any;
    },
  });

  const subtotal = Number(sale.subtotal ?? 0);
  const vatRate = Number(settings.data?.vat_rate ?? 0);
  const [discountInput, setDiscountInput] = useState(0);
  const [discountType, setDiscountType] = useState<"amount" | "percent">("amount");
  const [applyVat, setApplyVat] = useState(true);
  const [payments, setPayments] = useState<PaymentLine[]>([{ amount: 0, method: "cash" }]);
  const [paymentType, setPaymentType] = useState("");
  const [comment, setComment] = useState("");

  // An order posted before this flow existed may already carry figures the
  // sales person entered — start from those rather than silently dropping them.
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (prefilled || !detail.data) return;
    const d = detail.data;
    if (Number(d.discount) > 0) setDiscountInput(Number(d.discount));
    if (Array.isArray(d.pending_payments) && d.pending_payments.length > 0) {
      setPayments(d.pending_payments);
    }
    if (d.remarks) setPaymentType(d.remarks);
    setPrefilled(true);
  }, [detail.data, prefilled]);

  const customerAccount = useCustomerAccount(sale.customer_id ?? undefined);
  const availableAdvance = customerAccount.data?.summary.available_advance ?? 0;
  const existingDebt = customerAccount.data?.summary.outstanding_debt ?? 0;

  const amountPaid = useMemo(() => payments.reduce((s, p) => s + (p.amount || 0), 0), [payments]);
  const totals = useMemo(() => {
    if (sale.is_pr) return { discount: 0, vat: 0, grand: 0 };
    const discount =
      discountType === "percent"
        ? Math.min(subtotal * (Math.max(discountInput, 0) / 100), subtotal)
        : Math.min(Math.max(discountInput, 0), subtotal);
    // Rounded the same way confirm_sale() rounds it.
    const vat = applyVat ? Math.round(Math.max(subtotal - discount, 0) * vatRate) / 100 : 0;
    return { discount, vat, grand: Math.max(subtotal - discount + vat, 0) };
  }, [sale.is_pr, subtotal, discountInput, discountType, applyVat, vatRate]);

  const position = salePosition({
    grand: totals.grand,
    paid: sale.is_pr ? 0 : amountPaid,
    availableAdvance: sale.customer_id ? availableAdvance : 0,
    previousDebt: sale.customer_id ? existingDebt : 0,
  });

  const confirm = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("confirm_sale", {
        p_id: sale.id,
        payload: {
          discount: totals.discount,
          apply_vat: applyVat && !sale.is_pr,
          payments: sale.is_pr ? [] : payments.filter((p) => p.amount > 0),
          payment_type: paymentType || null,
          comment: comment || null,
        } as any,
      });
      if (error) throw error;
      return data as any;
    },
    onSuccess: () => {
      toast.success(`Order ${sale.invoice_number} confirmed — printing receipt`);
      logAudit({ action: "approve", entity: "sales", entityId: sale.id, factoryId });
      invalidateAfterConfirm(qc);
      onDone();
      openSaleInvoice(sale.id, settings.data, "print");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const items: any[] = detail.data?.sale_items ?? [];

  return (
    <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Confirm Order & Print Receipt</DialogTitle>
      </DialogHeader>
      <div className="grid gap-4">
        <div className="rounded-md bg-muted/30 p-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <span className="font-mono">{sale.invoice_number}</span>
            <span>{sale.sale_date}</span>
          </div>
          <div className="mt-1 font-medium">
            {sale.customer_name ?? "Walk-in"}{" "}
            <span className="font-normal text-muted-foreground">
              · {customerTypeLabel(sale.customer_type)}
            </span>
          </div>
          {sale.sales_person && (
            <div className="text-xs text-muted-foreground">Posted by {sale.sales_person}</div>
          )}
        </div>

        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : (
                items.map((it, i) => (
                  <TableRow key={i}>
                    <TableCell>{it.products?.name ?? "-"}</TableCell>
                    <TableCell className="text-right">
                      {num(Number(it.quantity))} {it.products?.unit ?? ""}
                    </TableCell>
                    <TableCell className="text-right">{money(Number(it.unit_price))}</TableCell>
                    <TableCell className="text-right">{money(Number(it.line_total))}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {sale.is_pr ? (
          <p className="rounded-md bg-warning/15 px-3 py-2 text-sm text-warning">
            PR — complimentary. Products go out of stock, but nothing is billed or paid.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Discount / Commission</Label>
              <div className="flex gap-1.5">
                {discountType === "percent" ? (
                  <MoneyInput
                    min={0}
                    max={100}
                    step="0.01"
                    value={discountInput}
                    onChange={setDiscountInput}
                  />
                ) : (
                  <MoneyInput value={discountInput} onChange={setDiscountInput} />
                )}
                <Select
                  value={discountType}
                  onValueChange={(v) => setDiscountType(v as "amount" | "percent")}
                >
                  <SelectTrigger className="w-16 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="amount">₦</SelectItem>
                    <SelectItem value="percent">%</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-xs">Type of Payment</Label>
              {/* Saved in the sale's remarks field, printed on the receipt. */}
              <Select value={paymentType || undefined} onValueChange={setPaymentType}>
                <SelectTrigger>
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                  {paymentType && !PAYMENT_TYPES.includes(paymentType) && (
                    <SelectItem value={paymentType}>{paymentType}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Checkbox checked={applyVat} onCheckedChange={(v) => setApplyVat(!!v)} />
              VAT ({vatRate}%)
            </label>
            <div className="sm:col-span-2">
              <Label className="text-xs">Payment received</Label>
              <PaymentLinesEditor
                payments={payments}
                onChange={setPayments}
                methods={PAY_DIALOG_METHODS}
              />
            </div>
          </div>
        )}

        <div className="space-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
          <div className="flex justify-between">
            <span>{sale.is_pr ? "Value of products issued" : "Subtotal"}</span>
            <span>{money(subtotal)}</span>
          </div>
          {!sale.is_pr && (
            <>
              <div className="flex justify-between">
                <span>
                  Discount / Commission
                  {discountType === "percent" ? ` (${discountInput}%)` : ""}
                </span>
                <span>-{money(totals.discount)}</span>
              </div>
              <div className="flex justify-between">
                <span>VAT {applyVat ? `(${vatRate}%)` : "(not applied)"}</span>
                <span>{money(totals.vat)}</span>
              </div>
            </>
          )}
          <div className="flex justify-between border-t pt-1 text-base font-semibold">
            <span>Total</span>
            <span>{money(totals.grand)}</span>
          </div>
          {!sale.is_pr && (
            <>
              <div className="flex justify-between">
                <span>Paid</span>
                <span>{money(amountPaid)}</span>
              </div>
              {position.advanceApplied > 0 && (
                <div className="flex justify-between">
                  <span>Customer advance applied</span>
                  <span className="text-success">{money(position.advanceApplied)}</span>
                </div>
              )}
              <div className="flex justify-between font-medium">
                <span>Balance (owed)</span>
                <span className={position.amountDue > 0 ? "text-destructive" : ""}>
                  {money(position.amountDue)}
                </span>
              </div>
              {position.overpaid > 0 && sale.customer_id && (
                <p className="text-xs text-muted-foreground">
                  {money(position.overpaid)} over the total is kept as the customer's advance.
                </p>
              )}
              {sale.customer_id && existingDebt > 0 && (
                <p className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
                  Earlier debt {money(existingDebt)} stays on the account. Total owed after this
                  order: <strong>{money(position.debtAfter)}</strong>.
                </p>
              )}
              {!sale.customer_id && position.amountDue > 0 && (
                <p className="rounded-md bg-warning/15 px-2 py-1 text-xs text-warning">
                  Unnamed walk-in with an unpaid balance — the debt won't be tied to a customer.
                </p>
              )}
            </>
          )}
        </div>

        <div>
          <Label>Comment (optional)</Label>
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        <ApprovalHistory module="sales" entityId={sale.id} />
      </div>
      <DialogFooter>
        <Button
          className="gap-2"
          disabled={confirm.isPending || detail.isLoading}
          onClick={() => confirm.mutate()}
        >
          <Printer className="h-4 w-4" />
          {confirm.isPending ? "Confirming…" : "Confirm & Print Receipt"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function RejectSaleDialog({
  sale,
  onSubmit,
  saving,
}: {
  sale: PendingSale;
  onSubmit: (reason: string) => void;
  saving: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reject Order</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {sale.invoice_number} · {sale.customer_name ?? "Walk-in"} ·{" "}
          {money(Number(sale.subtotal ?? sale.grand_total))}
        </p>
        <div>
          <Label>Reason</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <ApprovalHistory module="sales" entityId={sale.id} />
      </div>
      <DialogFooter>
        <Button
          variant="destructive"
          disabled={saving || !reason.trim()}
          onClick={() => onSubmit(reason)}
        >
          {saving ? "Rejecting…" : "Reject"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// Finance page: every order the sales persons have posted that is still
// waiting on the accountant to price, confirm and print.
export function PendingSalesCard({ factoryId }: { factoryId: string }) {
  const qc = useQueryClient();
  const { canApprove, canReject } = usePermissions();
  const approve = canApprove("sales");
  const reject = canReject("sales");
  const isSuperAdmin = useIsSuperAdmin().data ?? false;
  const [confirmTarget, setConfirmTarget] = useState<PendingSale | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingSale | null>(null);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const pending = useQuery({
    queryKey: ["pending-sales", factoryId],
    queryFn: () =>
      fetchAll<PendingSale>(
        (a, b) =>
          supabase
            .from("sales")
            .select(
              "id,invoice_number,sale_date,created_at,customer_id,customer_name,customer_type,subtotal,grand_total,is_pr,sales_person,created_by,sales_rep_id",
            )
            .eq("factory_id", factoryId)
            .eq("status", "pending_approval")
            .is("deleted_at", null)
            .order("created_at", { ascending: true })
            .order("id")
            .range(a, b) as any,
      ),
  });

  const rejectSale = useMutation({
    mutationFn: async (input: { sale: PendingSale; reason: string }) => {
      const { error } = await supabase.rpc("reject_sale", {
        p_id: input.sale.id,
        p_reason: input.reason,
      });
      if (error) throw error;
      return input;
    },
    onSuccess: ({ sale }) => {
      toast.success(`Order ${sale.invoice_number} rejected`);
      logAudit({ action: "reject", entity: "sales", entityId: sale.id, factoryId });
      qc.invalidateQueries({ queryKey: ["pending-sales"] });
      qc.invalidateQueries({ queryKey: ["sales-list"] });
      qc.invalidateQueries({ queryKey: ["customer-account"] });
      setRejectTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = (pending.data ?? []).filter(
    (s) => (typeFilter === "all" || s.customer_type === typeFilter) && matchesSearch(q, s),
  );

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>
            Orders awaiting confirmation
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({pending.data?.length ?? 0})
            </span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Posted by sales for walk-in customers, sales-reps and distributors. Set the payment,
            discount / commission and VAT, then confirm to print the receipt.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-9 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All buyers</SelectItem>
              {CUSTOMER_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search invoice, customer…"
              className="h-9 w-56 pl-8"
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
              <TableHead>Invoice</TableHead>
              <TableHead>Posted</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Sales person</TableHead>
              <TableHead className="text-right">Goods value</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pending.isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                  {pending.data?.length ? "No orders match." : "No orders waiting — all caught up."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((s) => {
                const isSelf = s.created_by === currentUser.data && !isSuperAdmin;
                return (
                  <TableRow key={s.id}>
                    <TableCell>
                      <RefId id={s.id} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{s.invoice_number}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {new Date(s.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{s.customer_name ?? "Walk-in"}</div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        {customerTypeLabel(s.customer_type)}
                        {s.is_pr && (
                          <Badge variant="outline" className="text-warning">
                            PR
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{s.sales_person ?? "—"}</TableCell>
                    <TableCell className="text-right">{money(Number(s.subtotal))}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {approve && (
                          <Button
                            size="sm"
                            className="gap-1"
                            disabled={isSelf}
                            title={
                              isSelf
                                ? "Someone other than who posted the order must confirm it"
                                : "Set payment, confirm & print receipt"
                            }
                            onClick={() => setConfirmTarget(s)}
                          >
                            <Printer className="h-4 w-4" /> Confirm & Print
                          </Button>
                        )}
                        {reject && !isSelf && (
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
              })
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={!!confirmTarget} onOpenChange={(v) => !v && setConfirmTarget(null)}>
        {confirmTarget && (
          <ConfirmSaleDialog
            sale={confirmTarget}
            factoryId={factoryId}
            onDone={() => setConfirmTarget(null)}
          />
        )}
      </Dialog>
      <Dialog open={!!rejectTarget} onOpenChange={(v) => !v && setRejectTarget(null)}>
        {rejectTarget && (
          <RejectSaleDialog
            sale={rejectTarget}
            saving={rejectSale.isPending}
            onSubmit={(reason) => rejectSale.mutate({ sale: rejectTarget, reason })}
          />
        )}
      </Dialog>
    </Card>
  );
}
