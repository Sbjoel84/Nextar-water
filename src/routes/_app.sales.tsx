import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { usePermissions, useIsSuperAdmin } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Trash2,
  FileDown,
  Printer,
  Eye,
  HandCoins,
  History,
  ShoppingCart,
  Check,
  X,
  Ban,
  Pencil,
  Search,
  Gift,
  Send,
} from "lucide-react";
import { money, num } from "@/lib/format";
import { toast } from "sonner";
import { generateInvoicePdf } from "@/lib/pdf";
import { logAudit } from "@/lib/audit";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { salePaymentStatus, salePosition, useCustomerAccount } from "@/lib/customer-account";
import { AccountLedgerTable, AccountStatusBadge } from "@/components/sales/account-ledger";
import { CustomerAccountDialog } from "@/components/sales/customer-account-dialog";
import { ApprovalHistory } from "@/components/workflow/approval-history";
import { requestDelete } from "@/lib/request-delete";
import { RequestDeleteDialog } from "@/components/shared/request-delete-dialog";
import { QuickAddProductDialog, ADD_NEW_ITEM } from "@/components/shared/quick-add-item";
import { matchesSearch, useSearchQuery } from "@/lib/search";
import { fetchAll } from "@/lib/metrics";
import { RefId } from "@/components/shared/ref-id";

export const Route = createFileRoute("/_app/sales")({
  head: () => ({ meta: [{ title: "Sales & POS — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="sales">
      <SalesPage />
    </RequireAccess>
  ),
});

type PaymentMethod = "cash" | "transfer" | "pos" | "card" | "cheque" | "credit";

// Who the sales person is capturing the order for. Stored on sales.customer_type.
type CustomerType = "walk_in" | "marketer" | "distributor" | "other";
const CUSTOMER_TYPES: { value: CustomerType; label: string }[] = [
  { value: "walk_in", label: "Walk-in customer" },
  { value: "marketer", label: "Marketer" },
  { value: "distributor", label: "Distributor" },
  { value: "other", label: "Other" },
];
const customerTypeLabel = (t: string | null | undefined) =>
  CUSTOMER_TYPES.find((c) => c.value === t)?.label ?? "Walk-in customer";

type Product = {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  unit_price: number;
  current_stock: number;
  category_id: string | null;
};
type Category = { id: string; name: string };
type Customer = { id: string; name: string; phone: string | null; address: string | null };
type SaleRow = {
  id: string;
  invoice_number: string;
  sale_date: string;
  created_at: string;
  customer_id: string | null;
  customer_name: string | null;
  grand_total: number;
  // Value of the goods at their line prices. For a PR sale grand_total is
  // forced to 0, so this is the only record of what the giveaway was worth.
  subtotal: number;
  amount_paid: number;
  balance: number;
  credit_applied: number;
  payment_method: string;
  is_pr: boolean;
  status: string;
  // Only visible to super_admin (see the "deleted sales" RLS policy).
  deleted_at: string | null;
  created_by: string | null;
  rejected_reason: string | null;
  sales_person: string | null;
  customer_type: CustomerType;
  // Only fetched for search matching — not rendered as a column.
  sale_items?: { products: { name: string } | null }[];
};
type CartItem = {
  product_id: string;
  name: string;
  unit: string;
  quantity: number;
  unit_price: number;
  stock: number;
};
// Full detail needed to re-open a still-pending sale in PosDialog for
// editing — a superset of SaleRow's list-view fields.
type EditingSaleData = {
  id: string;
  invoice_number: string;
  sale_date: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  discount: number;
  vat: number;
  is_pr: boolean;
  sales_person: string | null;
  sales_rep_id: string | null;
  customer_type: CustomerType;
  remarks: string | null;
  pending_payments: { amount: number; method: PaymentMethod }[] | null;
  amount_paid: number;
  payment_method: PaymentMethod;
  items: { product_id: string; quantity: number; unit_price: number }[];
};

const saleStatusBadge = (s: string): "default" | "secondary" | "outline" | "destructive" =>
  s === "posted" ? "secondary" : s === "rejected" || s === "cancelled" ? "destructive" : "outline";

function SalesPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const qc = useQueryClient();
  // Other users' approvals, payments and advances move a customer's account —
  // keep every open account view current without a manual refresh.
  useRealtimeInvalidate(
    ["customer_account_transactions", "sales", "payments_received"],
    [["sales-list"], ["customer-account"], ["customer-sales-full"], ["customer-payments-full"]],
  );
  const { canWrite, canApprove, canReject, canCancel, canDelete, canEdit } = usePermissions();
  const write = canWrite("sales");
  const approve = canApprove("sales");
  const reject = canReject("sales");
  const cancel = canCancel("sales");
  const canRequestDelete = canDelete("sales");
  // Editing only makes sense while nothing has taken effect yet — see
  // edit_sale()'s own guard. The next approve_sale() call reviews whatever
  // the sale looks like at that point, which is the "approval" an edit is
  // subject to; there's no separate edit-approval step.
  const canEditSale = canEdit("sales");
  // record_payment() needs payments or debts write, not sales.
  const canReceivePayment = canWrite("payments") || canWrite("debts");
  // Mirrors approve_sale()/reject_sale()'s own self-approval exception --
  // an admin (super_admin) can approve/reject a sale even if they're the
  // one who recorded it; every other approver role still can't.
  const isSuperAdmin = useIsSuperAdmin().data ?? false;
  const [posOpen, setPosOpen] = useState(false);
  const [presetCustomerId, setPresetCustomerId] = useState<string | undefined>(undefined);
  const [payTarget, setPayTarget] = useState<SaleRow | null>(null);
  const [historyTarget, setHistoryTarget] = useState<{ id: string; name: string } | null>(null);
  const [approveTarget, setApproveTarget] = useState<SaleRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<SaleRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<SaleRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SaleRow | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editingSale, setEditingSale] = useState<EditingSaleData | null>(null);
  const [loadingEditId, setLoadingEditId] = useState<string | null>(null);

  const currentUser = useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });

  const sales = useQuery({
    queryKey: ["sales-list", factoryId],
    enabled: !!factoryId,
    // Every sale, not the latest 200, so search can find older invoices.
    queryFn: () =>
      fetchAll<SaleRow>(
        (a, b) =>
          supabase
            .from("sales")
            .select(
              "id,invoice_number,sale_date,customer_id,customer_name,grand_total,subtotal,amount_paid,balance,credit_applied,payment_method,created_at,is_pr,status,deleted_at,created_by,rejected_reason,sales_person,customer_type,sale_items(products(name))",
            )
            .eq("factory_id", factoryId!)
            .order("created_at", { ascending: false })
            .order("id")
            .range(a, b) as any,
      ),
  });
  const [q, setQ] = useSearchQuery();

  // Period the summary cards and the sales table cover. sale_date is a plain
  // YYYY-MM-DD string, so month/year are prefix matches.
  const [period, setPeriod] = useState<"today" | "month" | "year" | "day" | "all">("today");
  const [summaryDay, setSummaryDay] = useState(() => new Date().toLocaleDateString("en-CA"));
  const today = new Date().toLocaleDateString("en-CA");
  const inPeriod = (saleDate: string) => {
    switch (period) {
      case "today":
        return saleDate === today;
      case "month":
        return saleDate.startsWith(today.slice(0, 7));
      case "year":
        return saleDate.startsWith(today.slice(0, 4));
      case "day":
        return saleDate === summaryDay;
      default:
        return true;
    }
  };
  const periodLabel = {
    today: "Today",
    month: "This month",
    year: "This year",
    day: summaryDay,
    all: "All time",
  }[period];
  // A search looks across every sale (so an old invoice/ID can still be
  // found); otherwise the table shows only the selected period.
  const filteredSales = (sales.data ?? []).filter((s) =>
    q.trim() ? matchesSearch(q, s) : inPeriod(s.sale_date),
  );

  // Period figures: revenue and PR (complimentary) giveaways are kept
  // apart, so what went out free is visible without inflating revenue. Same
  // rule as postedSalesRows(): only approved (posted), non-deleted sales count.
  const daySummary = useMemo(() => {
    const out = { revenue: 0, salesCount: 0, prValue: 0, prCount: 0, prPendingValue: 0 };
    for (const s of sales.data ?? []) {
      if (s.deleted_at || !inPeriod(s.sale_date)) continue;
      if (s.is_pr) {
        if (s.status === "posted") {
          out.prValue += Number(s.subtotal ?? 0);
          out.prCount += 1;
        } else if (s.status === "pending_approval") {
          out.prPendingValue += Number(s.subtotal ?? 0);
        }
      } else if (s.status === "posted") {
        out.revenue += Number(s.grand_total ?? 0);
        out.salesCount += 1;
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sales.data, summaryDay, period, today]);

  const openInvoice = async (saleId: string, action: "download" | "print") => {
    const { data, error } = await supabase
      .from("sales")
      .select(
        `
      *, sale_items(quantity,unit_price,line_total,products(name,unit))
    `,
      )
      .eq("id", saleId)
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }
    const s = data as any;
    await generateInvoicePdf(
      {
        company: {
          name: settings.data?.company_name ?? "FMIS",
          address: settings.data?.address,
          phone: settings.data?.phone,
          email: settings.data?.email,
          logo_url: settings.data?.logo_url,
        },
        invoice_number: s.invoice_number,
        sale_date: s.sale_date,
        customer: { name: s.customer_name, phone: s.customer_phone, address: s.customer_address },
        items: (s.sale_items ?? []).map((it: any) => ({
          name: it.products?.name ?? "-",
          quantity: Number(it.quantity),
          unit: it.products?.unit ?? "",
          unit_price: Number(it.unit_price),
          line_total: Number(it.line_total),
        })),
        subtotal: Number(s.subtotal),
        discount: Number(s.discount),
        vat: Number(s.vat),
        grand_total: Number(s.grand_total),
        amount_paid: Number(s.amount_paid),
        balance: Number(s.balance),
        currency: settings.data?.currency ?? "NGN",
        remarks: s.remarks,
        sales_person: s.sales_person,
        is_pr: s.is_pr,
      },
      action,
    );
  };

  // Loads the full detail (including line items) a still-pending sale needs
  // to reopen in PosDialog for editing — the list row above only carries the
  // summary fields.
  const openEditSale = async (saleId: string) => {
    setLoadingEditId(saleId);
    const { data, error } = await supabase
      .from("sales")
      .select(
        "id,invoice_number,sale_date,customer_id,customer_name,customer_phone,customer_address,discount,vat,is_pr,sales_person,sales_rep_id,customer_type,remarks,pending_payments,amount_paid,payment_method,sale_items(product_id,quantity,unit_price)",
      )
      .eq("id", saleId)
      .single();
    setLoadingEditId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    const s = data as any;
    setEditingSale({
      id: s.id,
      invoice_number: s.invoice_number,
      sale_date: s.sale_date,
      customer_id: s.customer_id,
      customer_name: s.customer_name,
      customer_phone: s.customer_phone,
      customer_address: s.customer_address,
      discount: Number(s.discount),
      vat: Number(s.vat),
      is_pr: s.is_pr,
      sales_person: s.sales_person,
      sales_rep_id: s.sales_rep_id,
      customer_type: s.customer_type ?? "walk_in",
      remarks: s.remarks,
      pending_payments: s.pending_payments,
      amount_paid: Number(s.amount_paid),
      payment_method: s.payment_method,
      items: (s.sale_items ?? []).map((it: any) => ({
        product_id: it.product_id,
        quantity: Number(it.quantity),
        unit_price: Number(it.unit_price),
      })),
    });
    setEditOpen(true);
  };

  const pay = useMutation({
    mutationFn: async (input: {
      sale: SaleRow;
      payments: { amount: number; method: PaymentMethod }[];
      remarks: string;
    }) => {
      const { data, error } = await supabase.rpc("record_payment", {
        payload: {
          factory_id: factoryId,
          customer_id: input.sale.customer_id,
          sale_id: input.sale.id,
          payments: input.payments,
          remarks: input.remarks,
        } as any,
      });
      if (error) throw error;
      return { res: data as any, input };
    },
    onSuccess: ({ res }) => {
      const lines: { receipt_number: string; amount: number; payment_method: string }[] =
        res.payments;
      toast.success(
        lines.length > 1
          ? `${lines.length} receipts recorded`
          : `Receipt ${lines[0].receipt_number}`,
      );
      qc.invalidateQueries({ queryKey: ["sales-list"] });
      qc.invalidateQueries({ queryKey: ["customer-account"] });
      qc.invalidateQueries({ queryKey: ["customer-sales-full"] });
      qc.invalidateQueries({ queryKey: ["customer-payments-full"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      setPayTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const invalidateAfterApproval = () => {
    qc.invalidateQueries({ queryKey: ["sales-list"] });
    qc.invalidateQueries({ queryKey: ["customer-account"] });
    qc.invalidateQueries({ queryKey: ["customer-sales-full"] });
    qc.invalidateQueries({ queryKey: ["customer-payments-full"] });
    qc.invalidateQueries({ queryKey: ["customers"] });
    // approve_sale is what actually decrements stock -- keep the rest of
    // the app's stock-derived views in sync, same as a normal sale used to.
    qc.invalidateQueries({ queryKey: ["finished-goods"] });
    qc.invalidateQueries({ queryKey: ["products-active"] });
    qc.invalidateQueries({ queryKey: ["products-for-production"] });
  };

  const approveSale = useMutation({
    mutationFn: async (input: { sale: SaleRow; comment: string }) => {
      const { error } = await supabase.rpc("approve_sale", {
        p_id: input.sale.id,
        p_comment: input.comment || undefined,
      });
      if (error) throw error;
      return input;
    },
    onSuccess: ({ sale }) => {
      toast.success(`Order ${sale.invoice_number} approved — printing receipt`);
      logAudit({ action: "approve", entity: "sales", entityId: sale.id, factoryId });
      invalidateAfterApproval();
      setApproveTarget(null);
      // The accountant prints the customer's receipt as part of approving.
      openInvoice(sale.id, "print");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectSale = useMutation({
    mutationFn: async (input: { sale: SaleRow; reason: string }) => {
      const { error } = await supabase.rpc("reject_sale", {
        p_id: input.sale.id,
        p_reason: input.reason,
      });
      if (error) throw error;
      return input;
    },
    onSuccess: ({ sale }) => {
      toast.success(`Sale ${sale.invoice_number} rejected`);
      logAudit({ action: "reject", entity: "sales", entityId: sale.id, factoryId });
      qc.invalidateQueries({ queryKey: ["sales-list"] });
      qc.invalidateQueries({ queryKey: ["customer-account"] });
      qc.invalidateQueries({ queryKey: ["customer-sales-full"] });
      qc.invalidateQueries({ queryKey: ["customer-payments-full"] });
      setRejectTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelSale = useMutation({
    mutationFn: async (sale: SaleRow) => {
      const { error } = await supabase.rpc("cancel_sale", { p_id: sale.id });
      if (error) throw error;
      return sale;
    },
    onSuccess: (sale) => {
      toast.success(`Sale ${sale.invoice_number} cancelled`);
      logAudit({ action: "cancel", entity: "sales", entityId: sale.id, factoryId });
      qc.invalidateQueries({ queryKey: ["sales-list"] });
      qc.invalidateQueries({ queryKey: ["customer-account"] });
      qc.invalidateQueries({ queryKey: ["customer-sales-full"] });
      qc.invalidateQueries({ queryKey: ["customer-payments-full"] });
      setCancelTarget(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteSale = useMutation({
    mutationFn: async ({ sale, reason }: { sale: SaleRow; reason: string }) => {
      await requestDelete("sales", sale.id, reason);
    },
    onSuccess: () => {
      toast.success("Deletion requested — pending admin approval");
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["sales-list"] });
      qc.invalidateQueries({ queryKey: ["customer-account"] });
      qc.invalidateQueries({ queryKey: ["customer-sales-full"] });
      qc.invalidateQueries({ queryKey: ["customer-payments-full"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sales & POS</h1>
          <p className="text-sm text-muted-foreground">
            Sales persons capture orders from walk-in customers, marketers, distributors and others,
            then post them to the accountant. The accountant approves each order and prints the
            receipt — only then does it decrement stock and count toward the customer's balance.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {write && (
            <Dialog
              open={posOpen}
              onOpenChange={(v) => {
                setPosOpen(v);
                if (!v) setPresetCustomerId(undefined);
              }}
            >
              <DialogTrigger asChild>
                <Button className="gap-2" onClick={() => setPresetCustomerId(undefined)}>
                  <Plus className="h-4 w-4" /> New Order
                </Button>
              </DialogTrigger>
              {posOpen && factoryId && (
                <PosDialog
                  factoryId={factoryId}
                  presetCustomerId={presetCustomerId}
                  onDone={() => {
                    setPosOpen(false);
                    setPresetCustomerId(undefined);
                    qc.invalidateQueries({ queryKey: ["sales-list"] });
                    qc.invalidateQueries({ queryKey: ["customer-account"] });
                    qc.invalidateQueries({ queryKey: ["customer-sales-full"] });
                    qc.invalidateQueries({ queryKey: ["customer-payments-full"] });
                    // A sale decrements products.current_stock — make sure the
                    // Finished Goods / Store page picks that up even if it's
                    // already mounted elsewhere, instead of relying only on
                    // realtime or a fresh navigation.
                    qc.invalidateQueries({ queryKey: ["finished-goods"] });
                    qc.invalidateQueries({ queryKey: ["products-active"] });
                    qc.invalidateQueries({ queryKey: ["products-for-production"] });
                  }}
                />
              )}
            </Dialog>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Summary · {periodLabel}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={period} onValueChange={(v) => setPeriod(v as typeof period)}>
              <SelectTrigger className="h-9 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="month">This month</SelectItem>
                <SelectItem value="year">This year</SelectItem>
                <SelectItem value="day">Pick a day…</SelectItem>
                <SelectItem value="all">All time</SelectItem>
              </SelectContent>
            </Select>
            {period === "day" && (
              <Input
                type="date"
                className="h-9 w-auto"
                value={summaryDay}
                onChange={(e) => e.target.value && setSummaryDay(e.target.value)}
              />
            )}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Card className="rounded-2xl">
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  Revenue Generated
                </div>
                <div className="mt-2 text-2xl font-semibold">{money(daySummary.revenue)}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {daySummary.salesCount} approved sale{daySummary.salesCount === 1 ? "" : "s"} ·
                  excludes PR
                </div>
              </div>
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
                <ShoppingCart className="h-5 w-5" />
              </div>
            </CardContent>
          </Card>
          <Card className="rounded-2xl border-warning/40">
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  PR Value Given Out
                </div>
                <div className="mt-2 text-2xl font-semibold text-warning">
                  {money(daySummary.prValue)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {daySummary.prCount} approved PR{daySummary.prCount === 1 ? "" : "s"} · not
                  counted in revenue
                  {daySummary.prPendingValue > 0 &&
                    ` · ${money(daySummary.prPendingValue)} awaiting approval`}
                </div>
              </div>
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-warning/15 text-warning">
                <Gift className="h-5 w-5" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>
            Sales · {q.trim() ? "Search results" : periodLabel}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({filteredSales.length})
            </span>
          </CardTitle>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search invoice, customer, product, #ID…"
              className="pl-8 h-9 w-64"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Date &amp; Time</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead>Payment Status</TableHead>
                <TableHead>Approval</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredSales.map((s) => {
                const status = salePaymentStatus(s);
                const isSelf = s.created_by === currentUser.data && !isSuperAdmin;
                // Every transaction gets a delete button for anyone holding
                // sales:delete — admin or not, any status. It only requests
                // the deletion (with a required reason); nothing is actually
                // removed until an admin approves it (request_delete /
                // approve_delete), and approve_delete() already knows how to
                // reverse a posted sale's stock/debt/customer effects, so
                // there's no status this could leave in a bad state.
                const canDeleteRow = canRequestDelete;
                return (
                  <TableRow key={s.id}>
                    <TableCell>
                      <RefId id={s.id} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{s.invoice_number}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {new Date(s.created_at).toLocaleString()}
                      {/* sale_date is a business/backdating field, separate
                          from when the record was actually entered — flag it
                          only when it doesn't match, instead of always
                          showing two dates for the common case. */}
                      {s.sale_date !== new Date(s.created_at).toLocaleDateString("en-CA") && (
                        <div className="text-xs text-muted-foreground">
                          Recorded for {s.sale_date}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {s.customer_id ? (
                        <button
                          type="button"
                          className="text-left font-medium text-primary hover:underline"
                          title="View this customer's products & transactions"
                          onClick={() =>
                            setHistoryTarget({
                              id: s.customer_id!,
                              name: s.customer_name ?? "Customer",
                            })
                          }
                        >
                          {s.customer_name ?? "Customer"}
                        </button>
                      ) : (
                        (s.customer_name ?? "Walk-in")
                      )}
                      <div className="text-xs text-muted-foreground">
                        {customerTypeLabel(s.customer_type)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {money(Number(s.grand_total))}
                      {s.is_pr && (
                        <div
                          className="text-xs text-warning"
                          title="Value of products given out — not counted in revenue"
                        >
                          PR value {money(Number(s.subtotal ?? 0))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{money(Number(s.amount_paid))}</TableCell>
                    <TableCell className="text-right">
                      <span className={Number(s.balance) > 0 ? "text-destructive font-medium" : ""}>
                        {money(Number(s.balance))}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={status.variant}
                        className={s.is_pr ? "text-warning" : "capitalize"}
                      >
                        {status.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={saleStatusBadge(s.status)} className="capitalize">
                        {s.status.replace(/_/g, " ")}
                      </Badge>
                      {s.status === "rejected" && s.rejected_reason && (
                        <div
                          className="mt-1 max-w-[160px] truncate text-xs text-muted-foreground"
                          title={s.rejected_reason}
                        >
                          {s.rejected_reason}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {s.status === "pending_approval" && approve && !isSelf && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Approve & print receipt"
                            onClick={() => setApproveTarget(s)}
                          >
                            <Check className="h-4 w-4 text-success" />
                          </Button>
                        )}
                        {s.status === "pending_approval" && reject && !isSelf && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Reject"
                            onClick={() => setRejectTarget(s)}
                          >
                            <X className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                        {s.status === "pending_approval" && cancel && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Cancel"
                            onClick={() => setCancelTarget(s)}
                          >
                            <Ban className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        )}
                        {canReceivePayment && s.status === "posted" && Number(s.balance) > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1"
                            onClick={() => setPayTarget(s)}
                          >
                            <HandCoins className="h-4 w-4" /> Receive
                          </Button>
                        )}
                        {write && s.customer_id && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={`Add products to ${s.customer_name ?? "this customer"}'s account`}
                            onClick={() => {
                              setPresetCustomerId(s.customer_id!);
                              setPosOpen(true);
                            }}
                          >
                            <ShoppingCart className="h-4 w-4" />
                          </Button>
                        )}
                        {s.customer_id && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1"
                            onClick={() =>
                              setHistoryTarget({
                                id: s.customer_id!,
                                name: s.customer_name ?? "Customer",
                              })
                            }
                          >
                            <History className="h-4 w-4" /> History
                          </Button>
                        )}
                        {/* A receipt only exists once the accountant has approved the order. */}
                        {s.status === "posted" && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="gap-1"
                              onClick={() => openInvoice(s.id, "print")}
                            >
                              <Printer className="h-4 w-4" /> Print
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="gap-1"
                              onClick={() => openInvoice(s.id, "download")}
                            >
                              <FileDown className="h-4 w-4" /> PDF
                            </Button>
                          </>
                        )}
                        {s.status === "pending_approval" && canEditSale && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Edit"
                            disabled={loadingEditId === s.id}
                            onClick={() => openEditSale(s.id)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                        {canDeleteRow && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Request deletion"
                            onClick={() => setDeleteTarget(s)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {filteredSales.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                    {q.trim() ? "No sales match your search." : "No sales yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!payTarget} onOpenChange={(v) => !v && setPayTarget(null)}>
        {payTarget && (
          <PayDialog
            sale={payTarget}
            saving={pay.isPending}
            onSubmit={(payments, remarks) => pay.mutate({ sale: payTarget, payments, remarks })}
          />
        )}
      </Dialog>

      <Dialog open={!!historyTarget} onOpenChange={(v) => !v && setHistoryTarget(null)}>
        {historyTarget && (
          <CustomerAccountDialog customerId={historyTarget.id} customerName={historyTarget.name} />
        )}
      </Dialog>

      <Dialog open={!!approveTarget} onOpenChange={(v) => !v && setApproveTarget(null)}>
        {approveTarget && (
          <ApproveSaleDialog
            sale={approveTarget}
            saving={approveSale.isPending}
            onSubmit={(comment) => approveSale.mutate({ sale: approveTarget, comment })}
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
      <Dialog open={!!cancelTarget} onOpenChange={(v) => !v && setCancelTarget(null)}>
        {cancelTarget && (
          <CancelSaleDialog
            sale={cancelTarget}
            saving={cancelSale.isPending}
            onConfirm={() => cancelSale.mutate(cancelTarget)}
          />
        )}
      </Dialog>

      <RequestDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        isPending={deleteSale.isPending}
        title={
          deleteTarget
            ? `Request deletion — ${deleteTarget.invoice_number}${
                deleteTarget.status === "posted"
                  ? " (posted — approval reverses its stock and restores any advance it used; the reversal is recorded on the customer account)"
                  : ""
              }`
            : "Request deletion"
        }
        onConfirm={(reason) => deleteTarget && deleteSale.mutate({ sale: deleteTarget, reason })}
      />


      <Dialog
        open={editOpen}
        onOpenChange={(v) => {
          setEditOpen(v);
          if (!v) setEditingSale(null);
        }}
      >
        {editOpen && editingSale && factoryId && (
          <PosDialog
            factoryId={factoryId}
            editingSale={editingSale}
            onDone={() => {
              setEditOpen(false);
              setEditingSale(null);
              qc.invalidateQueries({ queryKey: ["sales-list"] });
              qc.invalidateQueries({ queryKey: ["customer-account"] });
              qc.invalidateQueries({ queryKey: ["customer-sales-full"] });
              qc.invalidateQueries({ queryKey: ["customer-payments-full"] });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

type PaymentLine = { amount: number; method: PaymentMethod };

// Shared by the New Sale checkout and Receive Payment dialogs — one row per
// method so a customer paying part cash, part transfer can be recorded in a
// single transaction instead of forcing everything onto one payment_method.
function PaymentLinesEditor({
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

const PAY_DIALOG_METHODS: PaymentMethod[] = ["cash", "transfer", "pos", "card", "cheque"];

function PayDialog({
  sale,
  onSubmit,
  saving,
}: {
  sale: SaleRow;
  onSubmit: (payments: PaymentLine[], remarks: string) => void;
  saving: boolean;
}) {
  const [payments, setPayments] = useState<PaymentLine[]>([
    { amount: Number(sale.balance), method: "cash" },
  ]);
  const [remarks, setRemarks] = useState("");
  const total = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const balance = Number(sale.balance);
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Receive Payment</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div className="rounded-md bg-muted/30 p-3 text-sm">
          <div className="flex justify-between">
            <span>Customer</span>
            <span>{sale.customer_name ?? "Walk-in"}</span>
          </div>
          <div className="flex justify-between">
            <span>Invoice</span>
            <span className="font-mono">{sale.invoice_number}</span>
          </div>
          <div className="flex justify-between">
            <span>Outstanding</span>
            <span className="font-medium">{money(balance)}</span>
          </div>
        </div>
        <div>
          <Label>Payment{payments.length > 1 ? "s" : ""}</Label>
          <PaymentLinesEditor
            payments={payments}
            onChange={setPayments}
            methods={PAY_DIALOG_METHODS}
          />
        </div>
        <div className="flex justify-between text-sm font-medium">
          <span>Total</span>
          <span className={total > balance ? "text-destructive" : ""}>{money(total)}</span>
        </div>
        <div>
          <Label>Remarks</Label>
          <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={saving || total <= 0 || total > balance}
          onClick={() =>
            onSubmit(
              payments.filter((p) => p.amount > 0),
              remarks,
            )
          }
        >
          {saving ? "Saving…" : "Record & Print Receipt"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ApproveSaleDialog({
  sale,
  onSubmit,
  saving,
}: {
  sale: SaleRow;
  onSubmit: (comment: string) => void;
  saving: boolean;
}) {
  const [comment, setComment] = useState("");
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Approve Order & Print Receipt</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {sale.invoice_number} · {sale.customer_name ?? "Walk-in"} (
          {customerTypeLabel(sale.customer_type)}) · {money(Number(sale.grand_total))}
          {sale.sales_person && ` · posted by ${sale.sales_person}`}
        </p>
        <p className="text-sm text-muted-foreground">
          This decrements stock, records any payment taken with the order, and — if there's a
          balance — adds it to the customer's account, then opens the receipt to print. It can't be
          undone from here.
        </p>
        <div>
          <Label>Comment (optional)</Label>
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        <ApprovalHistory module="sales" entityId={sale.id} />
      </div>
      <DialogFooter>
        <Button disabled={saving} onClick={() => onSubmit(comment)}>
          {saving ? "Approving…" : "Approve & Print Receipt"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RejectSaleDialog({
  sale,
  onSubmit,
  saving,
}: {
  sale: SaleRow;
  onSubmit: (reason: string) => void;
  saving: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reject Sale</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {sale.invoice_number} · {sale.customer_name ?? "Walk-in"} ·{" "}
          {money(Number(sale.grand_total))}
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

function CancelSaleDialog({
  sale,
  onConfirm,
  saving,
}: {
  sale: SaleRow;
  onConfirm: () => void;
  saving: boolean;
}) {
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Cancel Sale</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {sale.invoice_number} · {sale.customer_name ?? "Walk-in"} ·{" "}
          {money(Number(sale.grand_total))}
        </p>
        <p className="text-sm text-muted-foreground">
          Nothing has posted to stock or the customer's account yet, so this simply withdraws the
          pending sale.
        </p>
      </div>
      <DialogFooter>
        <Button variant="destructive" disabled={saving} onClick={onConfirm}>
          {saving ? "Cancelling…" : "Cancel Sale"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// Shown inline once an existing (non-Walk-in) customer is picked in the New
// Sale form: the customer's real account position from the ledger — advance,
// debt, status, recent activity — so nothing has to be looked up separately.
function CustomerAccountPanel({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const account = useCustomerAccount(customerId);
  const [historyOpen, setHistoryOpen] = useState(false);

  if (customerId === "walkin") return null;
  if (account.isLoading || !account.data) {
    return <p className="text-xs text-muted-foreground">Loading customer account…</p>;
  }

  const { summary, ledger, pendingSales } = account.data;
  const hasHistory = ledger.length > 0 || pendingSales.length > 0;
  const hadAdvance = summary.total_advance_paid > 0 || summary.opening_credit > 0;

  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Customer account
        </span>
        <AccountStatusBadge status={summary.account_status} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className="block text-xs text-muted-foreground">Available Advance</span>
          <span
            className={`text-base font-semibold ${summary.available_advance > 0 ? "text-success" : ""}`}
          >
            {money(summary.available_advance)}
          </span>
        </div>
        <div>
          <span className="block text-xs text-muted-foreground">Outstanding Debt</span>
          <span
            className={`text-base font-semibold ${summary.outstanding_debt > 0 ? "text-destructive" : ""}`}
          >
            {money(summary.outstanding_debt)}
          </span>
        </div>
      </div>

      {summary.outstanding_debt > 0 && (
        <p className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {customerName} still owes {money(summary.outstanding_debt)} from earlier sales. This sale
          does not clear it.
        </p>
      )}
      {summary.available_advance === 0 && hadAdvance && summary.outstanding_debt === 0 && (
        <p className="rounded-md bg-warning/15 px-2 py-1 text-xs text-warning">
          Advance exhausted — this customer has no advance left to draw on.
        </p>
      )}
      {pendingSales.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {pendingSales.length} earlier sale{pendingSales.length === 1 ? " is" : "s are"} still
          awaiting approval and not counted above.
        </p>
      )}

      {hasHistory ? (
        <AccountLedgerTable ledger={ledger} pendingSales={pendingSales} compact limit={5} />
      ) : (
        <p className="text-xs text-muted-foreground">No prior transactions with this customer.</p>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0"
          onClick={() => setHistoryOpen(true)}
        >
          View Account History
        </Button>
      </div>
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        {historyOpen && (
          <CustomerAccountDialog customerId={customerId} customerName={customerName} />
        )}
      </Dialog>
    </div>
  );
}

// Exported so the Store (Finished Goods) page can offer the exact same
// checkout flow -- same create_sale RPC, same stock/customer/debt effects --
// rather than a second, divergent way to record a sale.
export function PosDialog({
  factoryId,
  onDone,
  presetCustomerId,
  editingSale,
}: {
  factoryId: string;
  onDone: () => void;
  // Set from the Sales table's per-row "add products to account" icon, so
  // the customer is already selected instead of defaulting to Walk-in.
  presetCustomerId?: string;
  // Set from the Sales table's per-row Edit icon (pending sales only) — the
  // whole form pre-fills from this and submits to edit_sale() instead of
  // create_sale().
  editingSale?: EditingSaleData;
}) {
  const settings = useFactorySettings(factoryId);
  const products = useQuery({
    queryKey: ["products-active", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,sku,unit,unit_price,current_stock,category_id")
        .eq("factory_id", factoryId)
        .eq("active", true)
        // Don't require a category: uncategorized finished products still sell.
        // Semi-finished items are kept out by being inactive instead.
        .order("name");
      if (error) throw error;
      return (data ?? []) as Product[];
    },
  });
  const categories = useQuery({
    queryKey: ["product-categories", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_categories")
        .select("id,name")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Category[];
    },
  });
  const customers = useQuery({
    queryKey: ["customers-brief", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("id,name,phone,address")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Customer[];
    },
  });

  const [cart, setCart] = useState<CartItem[]>([]);
  const [saleDate, setSaleDate] = useState<string>(
    () => editingSale?.sale_date ?? new Date().toISOString().slice(0, 10),
  );
  const [customerId, setCustomerId] = useState<string>(
    editingSale?.customer_id ?? presetCustomerId ?? "walkin",
  );
  const [customerName, setCustomerName] = useState(editingSale?.customer_name ?? "");
  const [customerPhone, setCustomerPhone] = useState(editingSale?.customer_phone ?? "");
  const [customerAddress, setCustomerAddress] = useState(editingSale?.customer_address ?? "");

  // customers-brief loads async, so the preset id above may resolve before
  // its name/phone/address are known — fill those in as soon as the list
  // (or a still-loading customer within it) is available.
  useEffect(() => {
    if (!presetCustomerId) return;
    const c = customers.data?.find((x) => x.id === presetCustomerId);
    if (c) {
      setCustomerName(c.name);
      setCustomerPhone(c.phone ?? "");
      setCustomerAddress(c.address ?? "");
    }
  }, [presetCustomerId, customers.data]);
  const [discountInput, setDiscountInput] = useState(editingSale?.discount ?? 0);
  const [discountType, setDiscountType] = useState<"amount" | "percent">("amount");
  const [applyVat, setApplyVat] = useState(editingSale ? editingSale.vat > 0 : true);
  const [isPr, setIsPr] = useState(editingSale?.is_pr ?? false);
  const [payments, setPayments] = useState<PaymentLine[]>(() => {
    if (editingSale?.pending_payments?.length) return editingSale.pending_payments;
    if (editingSale && editingSale.amount_paid > 0) {
      return [{ amount: editingSale.amount_paid, method: editingSale.payment_method }];
    }
    return [{ amount: 0, method: "cash" }];
  });
  const amountPaid = useMemo(() => payments.reduce((s, p) => s + (p.amount || 0), 0), [payments]);
  // The customer's real account (ledger-backed): advance they can draw on and
  // any debt they already owe. Both feed the live figures below.
  const customerAccount = useCustomerAccount(customerId);
  const availableCredit = customerAccount.data?.summary.available_advance ?? 0;
  const existingDebt = customerAccount.data?.summary.outstanding_debt ?? 0;
  const [salesPerson, setSalesPerson] = useState(editingSale?.sales_person ?? "");
  const [customerType, setCustomerType] = useState<CustomerType>(
    editingSale?.customer_type ?? "walk_in",
  );
  const [remarks, setRemarks] = useState(editingSale?.remarks ?? "");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [pickerId, setPickerId] = useState<string>("");
  const [salesRepId, setSalesRepId] = useState<string>(editingSale?.sales_rep_id ?? "none");

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
    staleTime: Infinity,
  });
  useEffect(() => {
    if (!salesPerson && currentUserName.data) setSalesPerson(currentUserName.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserName.data]);

  const reps = useQuery({
    queryKey: ["sales-reps-active", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_reps")
        .select("id,full_name")
        .eq("factory_id", factoryId)
        .eq("status", "active")
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string }[];
    },
  });
  const repStock = useQuery({
    queryKey: ["sales-rep-stock", salesRepId],
    enabled: salesRepId !== "none",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_stock")
        .select("product_id,quantity")
        .eq("sales_rep_id", salesRepId);
      if (error) throw error;
      return (data ?? []) as { product_id: string; quantity: number }[];
    },
  });
  const repMode = salesRepId !== "none";
  // When a rep is selling, the goods left the store at dispatch time, so the
  // sellable quantity is what's on the rep's van — not products.current_stock.
  const effStock = (p: { id: string; current_stock: number }) =>
    repMode
      ? Number(repStock.data?.find((r) => r.product_id === p.id)?.quantity ?? 0)
      : Number(p.current_stock);

  // Rebuilds the cart from the sale being edited once products (and rep
  // stock, if this was a rep sale) have loaded — runs once, not on every
  // render, so it doesn't fight with the user's own cart edits afterward.
  const editCartInitialized = useRef(false);
  useEffect(() => {
    if (!editingSale || editCartInitialized.current) return;
    if (!products.data) return;
    if (editingSale.sales_rep_id && repStock.isLoading) return;
    setCart(
      editingSale.items.map((it) => {
        const p = products.data?.find((x) => x.id === it.product_id);
        // The item's own quantity is already "spoken for" by this same sale
        // (nothing has been decremented for a pending sale), so it's added
        // back on top of current availability rather than excluded from it.
        const avail = (p ? effStock(p) : 0) + it.quantity;
        return {
          product_id: it.product_id,
          name: p?.name ?? "Unknown product",
          unit: p?.unit ?? "",
          quantity: it.quantity,
          unit_price: it.unit_price,
          stock: avail,
        };
      }),
    );
    editCartInitialized.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingSale, products.data, repStock.isLoading]);

  const vatRate = Number(settings.data?.vat_rate ?? 0);
  const visibleProducts = useMemo(() => {
    const all = products.data ?? [];
    return categoryFilter === "all" ? all : all.filter((p) => p.category_id === categoryFilter);
  }, [products.data, categoryFilter]);

  const totals = useMemo(() => {
    const subtotal = cart.reduce((s, i) => s + i.quantity * i.unit_price, 0);
    // Percentage discount is always taken off the subtotal, not off a
    // previously-discounted amount -- there's only ever one discount here.
    const discount =
      discountType === "percent"
        ? Math.min(subtotal * (Math.max(discountInput, 0) / 100), subtotal)
        : Math.min(Math.max(discountInput, 0), subtotal);
    // PR: stock still goes out (the cart/subtotal above is unaffected), but
    // nothing is billed, paid, or owed -- everything money-related is 0.
    if (isPr) return { subtotal, discount, vat: 0, grand: 0, balance: 0, creditApplied: 0 };
    const vat = applyVat ? Math.max(subtotal - discount, 0) * (vatRate / 100) : 0;
    const grand = Math.max(subtotal - discount + vat, 0);
    // Automatic, not something the cashier sets: whatever the customer's
    // own advance/credit balance can cover of what cash didn't, same
    // formula approve_sale() finalizes with server-side.
    const creditApplied = Math.min(Math.max(grand - amountPaid, 0), availableCredit);
    const balance = Math.max(grand - amountPaid - creditApplied, 0);
    return { subtotal, discount, vat, grand, balance, creditApplied };
  }, [cart, discountInput, discountType, amountPaid, availableCredit, vatRate, applyVat, isPr]);

  const registeredCustomer = customerId !== "walkin";
  // Same arithmetic approve_sale() finalises with, so the figures shown while
  // building the sale are the ones that get posted.
  const position = useMemo(
    () =>
      salePosition({
        grand: totals.grand,
        paid: amountPaid,
        availableAdvance: availableCredit,
        previousDebt: existingDebt,
      }),
    [totals.grand, amountPaid, availableCredit, existingDebt],
  );

  // What actually gets sold -- excludes lines the user has cleared to 0
  // while editing but hasn't removed or refilled yet.
  const sellableCart = useMemo(() => cart.filter((c) => c.quantity > 0), [cart]);

  // Ticking PR clears anything that implies money changed hands, so the form
  // can't show a half-billed, half-free sale.
  useEffect(() => {
    if (isPr) {
      setPayments([{ amount: 0, method: "cash" }]);
      setApplyVat(false);
    }
  }, [isPr]);

  const [addingProduct, setAddingProduct] = useState(false);
  const addProduct = (id: string) => {
    if (id === ADD_NEW_ITEM) {
      setAddingProduct(true);
      return;
    }
    const p = products.data?.find((x) => x.id === id);
    if (!p) return;
    const avail = effStock(p);
    setCart((prev) => {
      const existing = prev.find((c) => c.product_id === id);
      if (existing) {
        if (existing.quantity + 1 > avail) {
          toast.error(`Only ${avail} ${p.unit} ${repMode ? "on the van" : "in stock"}`);
          return prev;
        }
        return prev.map((c) => (c.product_id === id ? { ...c, quantity: c.quantity + 1 } : c));
      }
      if (avail < 1) {
        toast.error(repMode ? "Not on the van" : "Out of stock");
        return prev;
      }
      return [
        ...prev,
        {
          product_id: p.id,
          name: p.name,
          unit: p.unit,
          quantity: 1,
          unit_price: Number(p.unit_price),
          stock: avail,
        },
      ];
    });
    setPickerId("");
  };

  // Doesn't drop lines at quantity 0 -- the quantity box goes through 0
  // while the user clears it to type a new figure, and removing the row
  // out from under them mid-edit would yank the input away. Zero-qty lines
  // are excluded where it actually matters (submit, previews, invoice) via
  // sellableCart below; an explicit trash button removes a row outright.
  const updateQty = (id: string, qty: number) => {
    setCart((prev) =>
      prev.map((c) => {
        if (c.product_id !== id) return c;
        const q = Math.max(0, Math.min(qty, c.stock));
        return { ...c, quantity: q };
      }),
    );
  };
  const updatePrice = (id: string, price: number) => {
    setCart((prev) =>
      prev.map((c) => (c.product_id === id ? { ...c, unit_price: Math.max(0, price) } : c)),
    );
  };

  const submit = useMutation({
    mutationFn: async () => {
      if (sellableCart.length === 0) throw new Error("Cart is empty");
      const finalCustomer = customerId === "walkin" ? null : customerId;
      let displayName = customerName;
      if (finalCustomer) {
        const c = customers.data?.find((x) => x.id === finalCustomer);
        displayName = c?.name ?? displayName;
      }
      const payload = {
        factory_id: factoryId,
        sale_date: saleDate,
        customer_id: finalCustomer,
        customer_name: displayName || null,
        customer_phone: customerPhone || null,
        customer_address: customerAddress || null,
        discount: totals.discount,
        vat: totals.vat,
        payments: isPr ? [] : payments.filter((p) => p.amount > 0),
        sales_person: salesPerson || null,
        customer_type: customerType,
        sales_rep_id: repMode ? salesRepId : null,
        is_pr: isPr,
        remarks: remarks || null,
        items: sellableCart.map((c) => ({
          product_id: c.product_id,
          quantity: c.quantity,
          unit_price: c.unit_price,
        })),
      };
      if (editingSale) {
        const { data, error } = await supabase.rpc("edit_sale", {
          p_id: editingSale.id,
          payload: payload as any,
        });
        if (error) throw error;
        return data as any;
      }
      const { data, error } = await supabase.rpc("create_sale", { payload: payload as any });
      if (error) throw error;
      return data as any;
    },
    onSuccess: (res) => {
      toast.success(
        editingSale
          ? `${res.invoice_number} updated — awaiting accountant approval`
          : `${res.invoice_number} posted to the accountant for approval`,
      );
      logAudit({
        action: editingSale ? "edit" : "sale",
        entity: "sales",
        entityId: res.sale_id,
        factoryId,
        newValue: {
          invoice_number: res.invoice_number,
          grand_total: res.grand_total,
          balance: res.balance,
        },
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const previewInvoice = async () => {
    if (sellableCart.length === 0) {
      toast.error("Add at least one item to preview");
      return;
    }
    await generateInvoicePdf(
      {
        company: {
          name: settings.data?.company_name ?? "FMIS",
          address: settings.data?.address,
          phone: settings.data?.phone,
          email: settings.data?.email,
          logo_url: settings.data?.logo_url,
        },
        invoice_number: editingSale?.invoice_number ?? "PREVIEW",
        sale_date: saleDate,
        customer: {
          name: customerName || customers.data?.find((c) => c.id === customerId)?.name,
          phone: customerPhone,
          address: customerAddress,
        },
        items: sellableCart.map((c) => ({
          name: c.name,
          quantity: c.quantity,
          unit: c.unit,
          unit_price: c.unit_price,
          line_total: c.quantity * c.unit_price,
        })),
        subtotal: totals.subtotal,
        discount: totals.discount,
        vat: totals.vat,
        grand_total: totals.grand,
        amount_paid: amountPaid,
        balance: totals.balance,
        currency: settings.data?.currency ?? "NGN",
        remarks,
        sales_person: salesPerson,
        is_pr: isPr,
      },
      "preview",
    );
  };

  return (
    <DialogContent className="flex max-h-[92vh] w-[95vw] max-w-6xl flex-col gap-0 overflow-hidden p-0">
      <DialogHeader className="shrink-0 border-b px-6 py-4">
        <DialogTitle>
          {editingSale ? `Edit Order — ${editingSale.invoice_number}` : "New Order"}
        </DialogTitle>
      </DialogHeader>
      <div className="grid flex-1 gap-6 overflow-y-auto px-6 py-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-3">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="grid gap-1.5">
              <Label className="text-xs">Add product</Label>
              <Select value={pickerId} onValueChange={addProduct}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a product to add…" />
                </SelectTrigger>
                <SelectContent>
                  {visibleProducts.map((p) => (
                    <SelectItem key={p.id} value={p.id} disabled={effStock(p) <= 0}>
                      {p.name} · {money(Number(p.unit_price))} · {repMode ? "van" : "stock"}{" "}
                      {num(effStock(p))} {p.unit}
                    </SelectItem>
                  ))}
                  {visibleProducts.length === 0 && (
                    <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                      No products in this category.
                    </div>
                  )}
                  <SelectItem value={ADD_NEW_ITEM} className="font-medium text-primary">
                    + Add new product…
                  </SelectItem>
                </SelectContent>
              </Select>
              <QuickAddProductDialog
                open={addingProduct}
                onOpenChange={setAddingProduct}
                factoryId={factoryId}
                onCreated={() => setCategoryFilter("all")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">Category</Label>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {(categories.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="max-h-[40vh] overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[220px]">Item</TableHead>
                  <TableHead className="w-28">Qty</TableHead>
                  <TableHead className="w-36">Price</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cart.map((c) => (
                  <TableRow key={c.product_id}>
                    <TableCell>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">
                        stock {num(c.stock)} {c.unit}
                      </div>
                    </TableCell>
                    <TableCell>
                      <MoneyInput
                        min={0}
                        max={c.stock}
                        value={c.quantity}
                        onChange={(v) => updateQty(c.product_id, v)}
                        className="h-8"
                      />
                    </TableCell>
                    <TableCell>
                      <MoneyInput
                        value={c.unit_price}
                        onChange={(v) => updatePrice(c.product_id, v)}
                        className="h-8"
                      />
                    </TableCell>
                    <TableCell className="text-right">{money(c.quantity * c.unit_price)}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          setCart((prev) => prev.filter((x) => x.product_id !== c.product_id))
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {cart.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                      No items yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        <div className="min-w-0 space-y-2.5">
          <div>
            <Label className="text-xs">Order from</Label>
            <Select value={customerType} onValueChange={(v) => setCustomerType(v as CustomerType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CUSTOMER_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Sales date</Label>
              <Input type="date" value={saleDate} onChange={(e) => setSaleDate(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Customer</Label>
              <Select
                value={customerId}
                onValueChange={(v) => {
                  setCustomerId(v);
                  if (v === "walkin") {
                    setCustomerName("");
                    setCustomerPhone("");
                    setCustomerAddress("");
                  } else {
                    const c = customers.data?.find((x) => x.id === v);
                    setCustomerName(c?.name ?? "");
                    setCustomerPhone(c?.phone ?? "");
                    setCustomerAddress(c?.address ?? "");
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="walkin">Walk-in</SelectItem>
                  {(customers.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <CustomerAccountPanel
            customerId={customerId}
            customerName={
              (customers.data ?? []).find((c) => c.id === customerId)?.name ?? "This customer"
            }
          />
          {customerId === "walkin" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Customer name</Label>
                  <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
                </div>
                <div>
                  <Label className="text-xs">Phone</Label>
                  <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
                </div>
              </div>
              <div>
                <Label className="text-xs">Address</Label>
                <Input
                  value={customerAddress}
                  onChange={(e) => setCustomerAddress(e.target.value)}
                />
              </div>
            </>
          )}
          <div>
            <Label className="text-xs">Discount</Label>
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
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={applyVat}
              disabled={isPr}
              onCheckedChange={(v) => setApplyVat(!!v)}
            />
            VAT
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={isPr} onCheckedChange={(v) => setIsPr(!!v)} />
            PR
          </label>
          {!isPr && (
            <div>
              <Label className="text-xs">
                Paid — {payments.length > 1 ? "payments" : "payment"}
              </Label>
              <PaymentLinesEditor
                payments={payments}
                onChange={setPayments}
                methods={PAY_DIALOG_METHODS}
              />
            </div>
          )}
          <div>
            <Label className="text-xs">Sales rep (van stock)</Label>
            <Select
              value={salesRepId}
              onValueChange={(v) => {
                setSalesRepId(v);
                if (cart.length > 0) {
                  setCart([]);
                  toast.info("Cart cleared — stock source changed");
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Direct from store</SelectItem>
                {(reps.data ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Sales person</Label>
              <Input value={salesPerson} onChange={(e) => setSalesPerson(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Remarks</Label>
              <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>
          </div>

          <div className="rounded-lg border p-3 text-sm space-y-1 bg-muted/30">
            {isPr && (
              <div className="mb-1 rounded-md bg-warning/15 px-2 py-1 text-xs font-medium text-warning">
                PR — complimentary. Stock value below is for record only; nothing is billed.
              </div>
            )}
            <div className="flex justify-between">
              <span>{isPr ? "Value of products issued" : "Subtotal"}</span>
              <span>{money(totals.subtotal)}</span>
            </div>
            {!isPr && (
              <>
                <div className="flex justify-between">
                  <span>Discount{discountType === "percent" ? ` (${discountInput}%)` : ""}</span>
                  <span>-{money(totals.discount)}</span>
                </div>
                <div className="flex justify-between">
                  <span>VAT {applyVat ? `(${vatRate}%)` : "(not applied)"}</span>
                  <span>{money(totals.vat)}</span>
                </div>
              </>
            )}
            <div className="flex justify-between text-base font-semibold pt-1 border-t">
              <span>Total</span>
              <span>{money(totals.grand)}</span>
            </div>
            <div className="flex justify-between">
              <span>Paid</span>
              <span>{money(amountPaid)}</span>
            </div>
            {registeredCustomer && !isPr ? (
              <div className="mt-1 space-y-1 border-t pt-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Current sale vs customer advance
                </div>
                <div className="flex justify-between">
                  <span>Advance available</span>
                  <span>{money(availableCredit)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Advance applied</span>
                  <span className={position.advanceApplied > 0 ? "text-success" : ""}>
                    {money(position.advanceApplied)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Remaining advance</span>
                  <span>{money(position.remainingAdvance)}</span>
                </div>
                <div className="flex justify-between font-medium">
                  <span>Amount due</span>
                  <span className={position.amountDue > 0 ? "text-destructive" : ""}>
                    {money(position.amountDue)}
                  </span>
                </div>
                {totals.grand > 0 && position.advanceShort && (
                  <p className="rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
                    Advance exhausted. Customer owes {money(position.amountDue)}.
                  </p>
                )}
                {totals.grand > 0 && position.advanceExhausted && (
                  <p className="rounded-md bg-warning/15 px-2 py-1 text-xs font-medium text-warning">
                    This sale uses up the customer's advance — nothing is left afterwards.
                  </p>
                )}
                {totals.grand > 0 && position.advanceLow && (
                  <p className="rounded-md bg-warning/15 px-2 py-1 text-xs text-warning">
                    Advance almost exhausted — only {money(position.remainingAdvance)} left after
                    this sale.
                  </p>
                )}
                {totals.grand > 0 && availableCredit === 0 && position.amountDue > 0 && (
                  <p className="text-xs text-muted-foreground">
                    No advance on this account — the amount due becomes a debt unless it is paid
                    now.
                  </p>
                )}
                {existingDebt > 0 && (
                  <div className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
                    Existing debt {money(existingDebt)} is not part of this sale and stays on the
                    account. Total owed after this sale:{" "}
                    <strong>{money(position.debtAfter)}</strong>.
                  </div>
                )}
              </div>
            ) : (
              <>
                {totals.creditApplied > 0 && (
                  <div className="flex justify-between">
                    <span>Credit applied</span>
                    <span>{money(totals.creditApplied)}</span>
                  </div>
                )}
                <div className="flex justify-between font-medium">
                  <span>Balance</span>
                  <span className={totals.balance > 0 ? "text-destructive" : ""}>
                    {money(totals.balance)}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <DialogFooter className="shrink-0 border-t px-6 py-4">
        <Button
          variant="outline"
          disabled={sellableCart.length === 0}
          onClick={previewInvoice}
          className="gap-2"
        >
          <Eye className="h-4 w-4" /> Preview
        </Button>
        <Button
          disabled={submit.isPending || sellableCart.length === 0}
          onClick={() => submit.mutate()}
          className="gap-2"
        >
          <Send className="h-4 w-4" />
          {submit.isPending ? "Posting…" : editingSale ? "Save & Re-post" : "Post"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
