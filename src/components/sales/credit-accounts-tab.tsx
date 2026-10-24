import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  HandCoins,
  History,
  PackagePlus,
  Plus,
  Search,
  Store,
  UserPlus,
  Wallet,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { logAudit } from "@/lib/audit";
import { money } from "@/lib/format";
import { matchesSearch } from "@/lib/search";
import {
  PAY_DIALOG_METHODS,
  PaymentLinesEditor,
  type PaymentLine,
} from "@/components/sales/confirm-sale";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Kind = "marketer" | "customer";
type AccountRow = {
  id: string;
  name: string;
  phone: string | null;
  kind: Kind;
  supplied: number;
  paid: number;
  debt: number;
  credit: number;
  pendingCount: number;
  pendingValue: number;
};

const FILTERS: { value: "all" | Kind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "marketer", label: "Marketers" },
  { value: "customer", label: "Credit customers" },
];

// Accounts that are supplied now and pay later: every marketer (supplied in
// the morning, settles after close of business; unsold goods come back via
// Store → Return Product) plus customers flagged as credit accounts, such as
// Nextar Supermarket. Each payment is added to the account as it comes in.
export function CreditAccountsTab({
  factoryId,
  onSupply,
  onAccount,
}: {
  factoryId: string;
  onSupply: (customerId: string) => void;
  onAccount: (customer: { id: string; name: string }) => void;
}) {
  const { canWrite, canCreate } = usePermissions();
  const canSupply = canWrite("sales");
  const canRecordPayment = canCreate("sales") || canCreate("payments");
  const canAddMarketer = canCreate("distribution");
  const canAddCustomer = canCreate("customers");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | Kind>("all");
  const [payTarget, setPayTarget] = useState<AccountRow | null>(null);
  const [adding, setAdding] = useState<Kind | null>(null);

  useRealtimeInvalidate(
    ["customers", "customer_account_transactions", "payments_received", "sales"],
    [["credit-accounts", factoryId]],
  );

  const accounts = useQuery({
    queryKey: ["credit-accounts", factoryId],
    queryFn: async (): Promise<AccountRow[]> => {
      const { data: customers, error } = await supabase
        .from("customers")
        .select("id,name,phone,customer_type")
        .eq("factory_id", factoryId)
        .or("customer_type.eq.marketer,credit_account.eq.true")
        .is("deleted_at", null)
        .order("name");
      if (error) throw error;
      const ids = (customers ?? []).map((c) => c.id);
      if (ids.length === 0) return [];
      const [summaries, pending] = await Promise.all([
        supabase
          .from("customer_account_summary")
          .select("customer_id,goods_collected,total_payments,outstanding_debt,available_advance")
          .in("customer_id", ids),
        supabase
          .from("sales")
          .select("customer_id,subtotal")
          .in("customer_id", ids)
          .eq("status", "pending_approval")
          .is("deleted_at", null),
      ]);
      if (summaries.error) throw summaries.error;
      if (pending.error) throw pending.error;
      return (customers ?? []).map((c) => {
        const s = summaries.data?.find((x) => x.customer_id === c.id);
        const waiting = (pending.data ?? []).filter((p) => p.customer_id === c.id);
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          kind: c.customer_type === "marketer" ? "marketer" : "customer",
          supplied: Number(s?.goods_collected ?? 0),
          paid: Number(s?.total_payments ?? 0),
          debt: Number(s?.outstanding_debt ?? 0),
          credit: Number(s?.available_advance ?? 0),
          pendingCount: waiting.length,
          pendingValue: waiting.reduce((t, p) => t + Number(p.subtotal ?? 0), 0),
        };
      });
    },
  });

  const rows = useMemo(
    () =>
      (accounts.data ?? []).filter(
        (a) => (filter === "all" || a.kind === filter) && matchesSearch(q, a),
      ),
    [accounts.data, q, filter],
  );
  const totals = useMemo(() => {
    const all = accounts.data ?? [];
    return {
      debt: all.reduce((t, a) => t + a.debt, 0),
      credit: all.reduce((t, a) => t + a.credit, 0),
      owing: all.filter((a) => a.debt > 0).length,
    };
  }, [accounts.data]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryTile label="Credit accounts" value={String(accounts.data?.length ?? 0)} />
        <SummaryTile
          label="Outstanding (owed to us)"
          value={money(totals.debt)}
          hint={`${totals.owing} account${totals.owing === 1 ? "" : "s"} owing`}
          tone={totals.debt > 0 ? "destructive" : undefined}
        />
        <SummaryTile label="Credit held on accounts" value={money(totals.credit)} />
      </div>

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5" /> Credit Accounts
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Marketers and customers like Nextar Supermarket are supplied now and pay later. Add
              each payment to their account as it comes in. Marketers' unsold goods come back
              through Store → Return Product.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search account…"
                className="h-9 w-44 pl-8"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            {canAddMarketer && (
              <Button variant="outline" className="gap-2" onClick={() => setAdding("marketer")}>
                <UserPlus className="h-4 w-4" /> Add marketer
              </Button>
            )}
            {canAddCustomer && (
              <Button variant="outline" className="gap-2" onClick={() => setAdding("customer")}>
                <Plus className="h-4 w-4" /> Add credit customer
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 overflow-x-auto">
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <Button
                key={f.value}
                type="button"
                size="sm"
                variant={filter === f.value ? "default" : "outline"}
                onClick={() => setFilter(f.value)}
              >
                {f.label} (
                {
                  (accounts.data ?? []).filter((a) => f.value === "all" || a.kind === f.value)
                    .length
                }
                )
              </Button>
            ))}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Goods supplied</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : accounts.isError ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-destructive">
                    Couldn't load accounts: {(accounts.error as Error).message}
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                    {accounts.data?.length ? "No account matches." : "No credit accounts yet."}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <div className="flex items-center gap-2 font-medium">
                        {a.kind === "customer" && (
                          <Store className="h-4 w-4 text-muted-foreground" />
                        )}
                        {a.name}
                        <Badge variant="outline" className="text-[10px] font-normal">
                          {a.kind === "marketer" ? "Marketer" : "Credit customer"}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {a.phone ?? "No phone"}
                        {a.pendingCount > 0 &&
                          ` · ${a.pendingCount} supply awaiting confirmation (${money(a.pendingValue)})`}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{money(a.supplied)}</TableCell>
                    <TableCell className="text-right">{money(a.paid)}</TableCell>
                    <TableCell
                      className={
                        a.debt > 0 ? "text-right font-medium text-destructive" : "text-right"
                      }
                    >
                      {money(a.debt)}
                    </TableCell>
                    <TableCell className="text-right">{money(a.credit)}</TableCell>
                    <TableCell>
                      {a.debt > 0 ? (
                        <Badge variant="destructive">Owing</Badge>
                      ) : a.credit > 0 ? (
                        <Badge variant="secondary">In credit</Badge>
                      ) : (
                        <Badge variant="outline">Balanced</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {canRecordPayment && (
                          <Button size="sm" className="gap-1" onClick={() => setPayTarget(a)}>
                            <HandCoins className="h-4 w-4" /> Add payment
                          </Button>
                        )}
                        {canSupply && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1"
                            title="Supply products on credit (goes to the cashier to confirm)"
                            onClick={() => onSupply(a.id)}
                          >
                            <PackagePlus className="h-4 w-4" /> Supply
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1"
                          onClick={() => onAccount({ id: a.id, name: a.name })}
                        >
                          <History className="h-4 w-4" /> Statement
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!payTarget} onOpenChange={(v) => !v && setPayTarget(null)}>
        {payTarget && (
          <AddPaymentDialog
            factoryId={factoryId}
            account={payTarget}
            onDone={() => setPayTarget(null)}
          />
        )}
      </Dialog>
      <Dialog open={!!adding} onOpenChange={(v) => !v && setAdding(null)}>
        {adding && (
          <AddAccountDialog factoryId={factoryId} kind={adding} onDone={() => setAdding(null)} />
        )}
      </Dialog>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "destructive";
}) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-5">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
        <div
          className={`mt-2 text-2xl font-semibold ${tone === "destructive" ? "text-destructive" : ""}`}
        >
          {value}
        </div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function AddPaymentDialog({
  factoryId,
  account,
  onDone,
}: {
  factoryId: string;
  account: AccountRow;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const today = new Date().toLocaleDateString("en-CA");
  const [payments, setPayments] = useState<PaymentLine[]>([
    { amount: account.debt, method: "cash" },
  ]);
  const [date, setDate] = useState(today);
  const [remarks, setRemarks] = useState("");
  const total = payments.reduce((t, p) => t + (Number(p.amount) || 0), 0);

  const submit = useMutation({
    mutationFn: async () => {
      if (total <= 0) throw new Error("Enter the amount paid");
      const { data, error } = await supabase.rpc("record_marketer_payment", {
        payload: {
          factory_id: factoryId,
          customer_id: account.id,
          payment_date: date,
          remarks: remarks || null,
          payments: payments.filter((p) => Number(p.amount) > 0),
        },
      });
      if (error) throw error;
      return data as { receipt_number?: string; settled_debt?: number; credit_added?: number };
    },
    onSuccess: (res) => {
      const parts = [
        Number(res?.settled_debt ?? 0) > 0 && `${money(Number(res.settled_debt))} off the debt`,
        Number(res?.credit_added ?? 0) > 0 && `${money(Number(res.credit_added))} kept as credit`,
      ].filter(Boolean);
      toast.success(
        `Payment ${res?.receipt_number ?? ""} added to ${account.name}${parts.length ? ` — ${parts.join(", ")}` : ""}`,
      );
      logAudit({
        action: "create",
        entity: "payments_received",
        factoryId,
        newValue: { account: account.name, total, receipt: res?.receipt_number },
      });
      qc.invalidateQueries({ queryKey: ["credit-accounts", factoryId] });
      qc.invalidateQueries({ queryKey: ["customer-account", account.id] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Add payment — {account.name}</DialogTitle>
        <DialogDescription>
          Outstanding: <span className="font-medium text-foreground">{money(account.debt)}</span>
          {account.credit > 0 && ` · Credit: ${money(account.credit)}`}. Part payments are fine —
          the oldest debts are paid off first and anything extra stays on the account as credit. The
          cashier/accountant confirms it under Record &amp; Approve Payments.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <PaymentLinesEditor
          payments={payments}
          onChange={setPayments}
          methods={PAY_DIALOG_METHODS}
        />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Payment date</Label>
            <Input
              type="date"
              value={date}
              max={today}
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
          </div>
          <div className="flex items-end justify-end text-sm">
            Total:&nbsp;<span className="font-semibold">{money(total)}</span>
          </div>
        </div>
        <div>
          <Label className="text-xs">Remarks</Label>
          <Textarea
            rows={2}
            value={remarks}
            placeholder={
              account.kind === "marketer" ? "e.g. Close of business payment" : "e.g. Part payment"
            }
            onChange={(e) => setRemarks(e.target.value)}
          />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={submit.isPending || total <= 0} onClick={() => submit.mutate()}>
          {submit.isPending ? "Saving…" : "Add payment"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function AddAccountDialog({
  factoryId,
  kind,
  onDone,
}: {
  factoryId: string;
  kind: Kind;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const label = kind === "marketer" ? "marketer" : "credit customer";

  const submit = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error(`Enter the ${label}'s name`);
      if (kind === "marketer") {
        // A sales rep row; a trigger creates the matching marketer customer
        // account (sync_sales_rep_customer).
        const { error } = await supabase.from("sales_reps").insert({
          factory_id: factoryId,
          full_name: name.trim(),
          phone: phone.trim() || null,
          status: "active",
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.from("customers").insert({
          factory_id: factoryId,
          name: name.trim(),
          phone: phone.trim() || null,
          customer_type: "other",
          registered: true,
          credit_account: true,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(`${name.trim()} added as a ${label}`);
      logAudit({
        action: "create",
        entity: kind === "marketer" ? "sales_reps" : "customers",
        factoryId,
        newValue: { name, credit_account: true },
      });
      qc.invalidateQueries({ queryKey: ["credit-accounts", factoryId] });
      qc.invalidateQueries({ queryKey: ["pos-customers", factoryId] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Add {label}</DialogTitle>
        <DialogDescription>
          {kind === "marketer"
            ? "Creates the marketer and their account, ready to be supplied."
            : "A customer supplied on credit who pays later, like Nextar Supermarket."}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Phone</Label>
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={submit.isPending || !name.trim()} onClick={() => submit.mutate()}>
          {submit.isPending ? "Adding…" : `Add ${label}`}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
