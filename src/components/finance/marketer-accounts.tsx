import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileDown, HandCoins, Undo2, Users, Wallet } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { exportCsv } from "@/lib/export";
import { money, num, fmtDate } from "@/lib/format";
import { matchesSearch } from "@/lib/search";
import { CustomerAccountDialog } from "@/components/sales/customer-account-dialog";
import { AddPaymentDialog } from "@/components/sales/credit-accounts-tab";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type MarketerAccount = {
  id: string;
  name: string;
  phone: string | null;
  supplied: number;
  paid: number;
  debt: number;
  credit: number;
  returnsCount: number;
  returnsQty: number;
  returnsAwaiting: number;
  pendingCount: number;
  pendingValue: number;
  lastActivity: string | null;
};

type Filter = "all" | "owing" | "credit" | "balanced";

// Every marketer has an account: what they've been supplied, what they've
// brought back, what they've paid and what they still owe. Clicking a name
// opens that account (ledger, supplies, returns, payments) where the next
// payment can be added. Shown on Account Overview and on Payments.
export function MarketerAccountsCard({ factoryId }: { factoryId: string }) {
  const { canCreate } = usePermissions();
  const canRecordPayment = canCreate("sales") || canCreate("payments");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  const [payTarget, setPayTarget] = useState<MarketerAccount | null>(null);

  useRealtimeInvalidate(
    ["customers", "customer_account_transactions", "payments_received", "sales", "sales_returns"],
    [["marketer-accounts", factoryId]],
  );

  const accounts = useQuery({
    queryKey: ["marketer-accounts", factoryId],
    queryFn: async (): Promise<MarketerAccount[]> => {
      const { data: marketers, error } = await supabase
        .from("customers")
        .select("id,name,phone")
        .eq("factory_id", factoryId)
        .eq("customer_type", "marketer")
        .is("deleted_at", null)
        .order("name");
      if (error) throw error;
      const ids = (marketers ?? []).map((m) => m.id);
      if (ids.length === 0) return [];
      const db = supabase as any;
      const [summaries, pending, returns] = await Promise.all([
        db
          .from("customer_account_summary")
          .select(
            "customer_id,goods_collected,total_payments,outstanding_debt,available_advance,last_transaction_at",
          )
          .in("customer_id", ids),
        supabase
          .from("sales")
          .select("customer_id,subtotal")
          .in("customer_id", ids)
          .eq("status", "pending_approval")
          .is("deleted_at", null),
        supabase
          .from("sales_returns")
          .select("customer_id,quantity_returned,status")
          .in("customer_id", ids)
          .neq("status", "cancelled"),
      ]);
      if (summaries.error) throw summaries.error;
      if (pending.error) throw pending.error;
      if (returns.error) throw returns.error;
      return (marketers ?? []).map((m) => {
        const s = (summaries.data ?? []).find((x: any) => x.customer_id === m.id);
        const waiting = (pending.data ?? []).filter((p) => p.customer_id === m.id);
        const back = (returns.data ?? []).filter((r) => r.customer_id === m.id);
        return {
          id: m.id,
          name: m.name,
          phone: m.phone,
          supplied: Number(s?.goods_collected ?? 0),
          paid: Number(s?.total_payments ?? 0),
          debt: Number(s?.outstanding_debt ?? 0),
          credit: Number(s?.available_advance ?? 0),
          lastActivity: s?.last_transaction_at ?? null,
          returnsCount: back.length,
          returnsQty: back.reduce((t, r) => t + Number(r.quantity_returned), 0),
          returnsAwaiting: back.filter((r) => r.status === "received").length,
          pendingCount: waiting.length,
          pendingValue: waiting.reduce((t, p) => t + Number(p.subtotal ?? 0), 0),
        };
      });
    },
  });

  const all = useMemo(() => accounts.data ?? [], [accounts.data]);
  const rows = useMemo(
    () =>
      all.filter((a) => {
        if (!matchesSearch(q, a)) return false;
        if (filter === "owing") return a.debt > 0;
        if (filter === "credit") return a.credit > 0;
        if (filter === "balanced") return a.debt === 0 && a.credit === 0;
        return true;
      }),
    [all, q, filter],
  );
  const totals = useMemo(
    () => ({
      supplied: all.reduce((t, a) => t + a.supplied, 0),
      paid: all.reduce((t, a) => t + a.paid, 0),
      debt: all.reduce((t, a) => t + a.debt, 0),
      owing: all.filter((a) => a.debt > 0).length,
      awaiting: all.reduce((t, a) => t + a.returnsAwaiting, 0),
    }),
    [all],
  );

  const exportRows = () =>
    exportCsv(
      "marketer-accounts",
      [
        { key: "name", label: "Marketer" },
        { key: "phone", label: "Phone" },
        { key: "supplied", label: "Goods supplied" },
        { key: "returns", label: "Qty returned" },
        { key: "paid", label: "Paid" },
        { key: "debt", label: "Outstanding" },
        { key: "credit", label: "Credit" },
        { key: "last", label: "Last activity" },
      ],
      rows.map((a) => ({
        name: a.name,
        phone: a.phone ?? "",
        supplied: a.supplied.toFixed(2),
        returns: a.returnsQty,
        paid: a.paid.toFixed(2),
        debt: a.debt.toFixed(2),
        credit: a.credit.toFixed(2),
        last: a.lastActivity ? fmtDate(a.lastActivity) : "",
      })),
    );

  const FILTERS: { value: Filter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "owing", label: "Owing" },
    { value: "credit", label: "In credit" },
    { value: "balanced", label: "Balanced" },
  ];

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" /> Marketer accounts
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Each marketer's supplies, returns, payments and what they still owe. Click a name to
            open the account and add the next payment.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Search marketer…"
            className="h-9 w-48"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={rows.length === 0}
            onClick={exportRows}
          >
            <FileDown className="h-4 w-4" /> CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 text-sm sm:grid-cols-4">
          <div>
            <span className="block text-xs text-muted-foreground">Goods supplied</span>
            <span className="font-semibold">{money(totals.supplied)}</span>
          </div>
          <div>
            <span className="block text-xs text-muted-foreground">Paid</span>
            <span className="font-semibold text-success">{money(totals.paid)}</span>
          </div>
          <div>
            <span className="block text-xs text-muted-foreground">
              Outstanding ({totals.owing} owing)
            </span>
            <span className="font-semibold text-destructive">{money(totals.debt)}</span>
          </div>
          <div>
            <span className="block text-xs text-muted-foreground">Returns awaiting inspection</span>
            <span className="font-semibold">{totals.awaiting}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              type="button"
              size="sm"
              variant={filter === f.value ? "default" : "outline"}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Marketer</TableHead>
                <TableHead className="text-right">Supplied</TableHead>
                <TableHead className="text-right">Returns</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : accounts.isError ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-destructive">
                    Couldn't load marketer accounts: {(accounts.error as Error).message}
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                    {all.length ? "No marketer matches." : "No marketers yet."}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <button
                        type="button"
                        className="text-left font-medium text-primary hover:underline"
                        onClick={() => setOpen({ id: a.id, name: a.name })}
                      >
                        {a.name}
                      </button>
                      <div className="text-xs text-muted-foreground">
                        {a.phone ?? "No phone"}
                        {a.lastActivity && ` · last activity ${fmtDate(a.lastActivity)}`}
                        {a.pendingCount > 0 &&
                          ` · ${a.pendingCount} supply awaiting confirmation (${money(a.pendingValue)})`}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{money(a.supplied)}</TableCell>
                    <TableCell className="text-right">
                      {a.returnsCount > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <Undo2 className="h-3.5 w-3.5 text-muted-foreground" />
                          {num(a.returnsQty)}
                          {a.returnsAwaiting > 0 && (
                            <Badge variant="outline" className="ml-1 text-[10px] text-warning">
                              {a.returnsAwaiting} to inspect
                            </Badge>
                          )}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right">{money(a.paid)}</TableCell>
                    <TableCell
                      className={`text-right ${a.debt > 0 ? "font-medium text-destructive" : ""}`}
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
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1"
                          onClick={() => setOpen({ id: a.id, name: a.name })}
                        >
                          <Wallet className="h-4 w-4" /> Account
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <Dialog open={!!open} onOpenChange={(v) => !v && setOpen(null)}>
        {open && <CustomerAccountDialog customerId={open.id} customerName={open.name} />}
      </Dialog>
      <Dialog open={!!payTarget} onOpenChange={(v) => !v && setPayTarget(null)}>
        {payTarget && (
          <AddPaymentDialog
            factoryId={factoryId}
            account={{ ...payTarget, kind: "marketer" }}
            onDone={() => setPayTarget(null)}
          />
        )}
      </Dialog>
    </Card>
  );
}
