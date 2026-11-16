import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { salePaymentStatus } from "@/lib/customer-account";
import { CustomerPendingOrders } from "@/components/sales/confirm-sale";
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type WalkInSale = {
  id: string;
  invoice_number: string;
  sale_date: string;
  created_at: string;
  status: string;
  is_pr: boolean;
  grand_total: number;
  subtotal: number;
  amount_paid: number;
  credit_applied: number;
  balance: number;
  payment_method: string | null;
  sales_person: string | null;
};
type WalkInPayment = {
  id: string;
  receipt_number: string;
  payment_date: string;
  created_at: string;
  amount: number;
  payment_method: string;
  status: string;
  sale_id: string | null;
};

// A walk-in / POS buyer has no customer account — sales just carry the name
// the sales person typed. This gathers every order under that name: what is
// waiting to be confirmed (with Confirm & Print), past orders, and payments.
export function WalkInCustomerDialog({
  factoryId,
  customerName,
}: {
  factoryId: string;
  customerName: string;
}) {
  useRealtimeInvalidate(["sales", "payments_received"], [["walk-in-sales", factoryId, customerName]]);

  const sales = useQuery({
    queryKey: ["walk-in-sales", factoryId, customerName],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select(
          "id,invoice_number,sale_date,created_at,status,is_pr,grand_total,subtotal,amount_paid,credit_applied,balance,payment_method,sales_person",
        )
        .eq("factory_id", factoryId)
        .is("customer_id", null)
        .eq("customer_name", customerName)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as WalkInSale[];
    },
  });

  const saleIds = (sales.data ?? []).map((s) => s.id);
  const payments = useQuery({
    queryKey: ["walk-in-sales", factoryId, customerName, "payments", saleIds.join(",")],
    enabled: saleIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select("id,receipt_number,payment_date,created_at,amount,payment_method,status,sale_id")
        .in("sale_id", saleIds)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as WalkInPayment[];
    },
  });

  const invoiceOf = useMemo(
    () => new Map((sales.data ?? []).map((s) => [s.id, s.invoice_number])),
    [sales.data],
  );
  const posted = (sales.data ?? []).filter((s) => s.status === "posted" && !s.is_pr);
  const pendingCount = (sales.data ?? []).filter((s) => s.status === "pending_approval").length;
  const totals = {
    bought: posted.reduce((t, s) => t + Number(s.grand_total), 0),
    paid: posted.reduce((t, s) => t + Number(s.amount_paid), 0),
    owing: posted.reduce((t, s) => t + Math.max(Number(s.balance), 0), 0),
  };

  return (
    <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-3">
          {customerName} — Transactions
          <Badge variant="outline">Walk-in / POS</Badge>
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 text-sm sm:grid-cols-4">
          <div>
            <span className="block text-xs text-muted-foreground">Confirmed purchases</span>
            <span className="font-semibold">{money(totals.bought)}</span>
          </div>
          <div>
            <span className="block text-xs text-muted-foreground">Paid</span>
            <span className="font-semibold text-success">{money(totals.paid)}</span>
          </div>
          <div>
            <span className="block text-xs text-muted-foreground">Unpaid balance</span>
            <span className={`font-semibold ${totals.owing > 0 ? "text-destructive" : ""}`}>
              {money(totals.owing)}
            </span>
          </div>
          <div>
            <span className="block text-xs text-muted-foreground">Awaiting confirmation</span>
            <span className="font-semibold">{pendingCount}</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Walk-in sales aren't on a customer account, so this lists every order posted under the
          name “{customerName}”. To keep a running account for this buyer, register them under
          Customers. Unpaid balances are collected under Payments → Debts.
        </p>

        <Tabs defaultValue={pendingCount > 0 ? "pending" : "orders"}>
          <TabsList>
            <TabsTrigger value="pending">Awaiting confirmation ({pendingCount})</TabsTrigger>
            <TabsTrigger value="orders">Orders</TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
          </TabsList>

          <TabsContent value="pending">
            <CustomerPendingOrders factoryId={factoryId} customerName={customerName} />
          </TabsContent>

          <TabsContent value="orders">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Sales person</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(sales.data ?? []).map((s) => {
                  const st = salePaymentStatus(s);
                  const isPosted = s.status === "posted";
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">{s.invoice_number}</TableCell>
                      <TableCell>{fmtDate(s.sale_date)}</TableCell>
                      <TableCell>{s.sales_person ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {money(Number(isPosted ? s.grand_total : s.subtotal))}
                      </TableCell>
                      <TableCell className="text-right">
                        {isPosted ? money(Number(s.amount_paid)) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {isPosted && Number(s.balance) > 0 ? (
                          <Badge variant="destructive">{money(Number(s.balance))}</Badge>
                        ) : isPosted ? (
                          money(0)
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={st.variant} className="capitalize">
                          {s.status === "pending_approval" ? "Awaiting confirmation" : st.label}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {(sales.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                      {sales.isLoading ? "Loading…" : "No orders under this name."}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TabsContent>

          <TabsContent value="payments">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date & Time</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(payments.data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{p.receipt_number}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {(p.sale_id && invoiceOf.get(p.sale_id)) || "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {fmtDateTime(p.created_at)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {p.payment_method}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs capitalize text-muted-foreground">
                      {p.status.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell className="text-right">{money(Number(p.amount))}</TableCell>
                  </TableRow>
                ))}
                {(payments.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                      No payments yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TabsContent>
        </Tabs>
      </div>
    </DialogContent>
  );
}
