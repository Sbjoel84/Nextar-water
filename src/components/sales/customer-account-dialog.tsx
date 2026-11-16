import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog } from "@/components/ui/dialog";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { AddPaymentDialog } from "@/components/sales/credit-accounts-tab";
import { CustomerPendingOrders } from "@/components/sales/confirm-sale";
import { CustomerPricesPanel } from "@/components/customers/customer-prices";
import { useMakeMarketer } from "@/components/distribution/make-marketer";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
import { FileDown, HandCoins, Printer, Sheet } from "lucide-react";
import { money, num, fmtDateTime, fmtDate } from "@/lib/format";
import { exportCsv } from "@/lib/export";
import { generateCustomerStatementPdf, type PdfAction } from "@/lib/pdf";
import { logAudit } from "@/lib/audit";
import {
  STATEMENT_COLUMNS,
  buildStatement,
  periodLabel,
  salePaymentStatus,
  statementCsvRows,
  useCustomerAccount,
} from "@/lib/customer-account";
import {
  AccountLedgerTable,
  AccountStatusBadge,
  AccountSummaryCards,
  summariseItems,
} from "@/components/sales/account-ledger";
import { AccountAdjustmentsCard } from "@/components/customers/account-adjustments";
import { RefId } from "@/components/shared/ref-id";
import { DateInput } from "@/components/shared/date-input";

type CustomerSaleRow = {
  id: string;
  invoice_number: string;
  sale_date: string;
  created_at: string;
  status: string;
  is_pr: boolean;
  grand_total: number;
  amount_paid: number;
  credit_applied: number;
  balance: number;
  payment_method: string;
};
type CustomerItemRow = {
  sale_id: string;
  product_id: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  products: { name: string; unit: string } | null;
};
type CustomerReturnRow = {
  id: string;
  return_number: string;
  sale_id: string | null;
  product_id: string;
  quantity_returned: number;
  accepted_quantity: number | null;
  damaged_quantity: number;
  rejected_quantity: number;
  status: string;
  received_at: string;
  reason: string | null;
  products: { name: string; unit: string } | null;
};
type CustomerPaymentRow = {
  id: string;
  receipt_number: string;
  payment_date: string;
  created_at: string;
  amount: number;
  payment_method: string;
  sale_id: string | null;
};

// A customer's whole account in one dialog: position cards, the ledger as a
// statement (optionally for a date range), products, invoices and payments —
// with print / PDF / CSV of that statement. Used from Sales and from Finance
// so both show identical figures.
export function CustomerAccountDialog({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const account = useCustomerAccount(customerId);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [paying, setPaying] = useState(false);
  const { canCreate } = usePermissions();
  const canRecordPayment = canCreate("sales") || canCreate("payments");
  const canMakeMarketer = canCreate("distribution");

  useRealtimeInvalidate(
    ["sales", "payments_received", "sales_returns", "customer_account_transactions"],
    [
      ["customer-account", customerId],
      ["customer-sales-full", customerId],
      ["customer-payments-full", customerId],
      ["customer-returns-full", customerId],
    ],
  );

  const customer = useQuery({
    queryKey: ["customer-contact", customerId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("name,phone,address,customer_type,credit_account")
        .eq("id", customerId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const invoices = useQuery({
    queryKey: ["customer-sales-full", customerId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select(
          "id,invoice_number,sale_date,created_at,status,is_pr,grand_total,amount_paid,credit_applied,balance,payment_method",
        )
        .eq("customer_id", customerId)
        .is("deleted_at", null)
        .order("sale_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as CustomerSaleRow[];
    },
  });

  const saleIds = (invoices.data ?? []).map((s) => s.id);
  const items = useQuery({
    queryKey: ["customer-items-full", customerId, saleIds.join(",")],
    enabled: saleIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sale_items")
        .select("sale_id,product_id,quantity,unit_price,line_total,products(name,unit)")
        .in("sale_id", saleIds);
      if (error) throw error;
      return (data ?? []) as unknown as CustomerItemRow[];
    },
  });

  const payments = useQuery({
    queryKey: ["customer-payments-full", customerId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments_received")
        .select("id,receipt_number,payment_date,created_at,amount,payment_method,sale_id")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as CustomerPaymentRow[];
    },
  });

  // Goods brought back (marketers' unsold stock at close of business, or any
  // customer return). Inspection credits the account for accepted + damaged.
  const returns = useQuery({
    queryKey: ["customer-returns-full", customerId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_returns")
        .select(
          "id,return_number,sale_id,product_id,quantity_returned,accepted_quantity,damaged_quantity,rejected_quantity,status,received_at,reason,products(name,unit)",
        )
        .eq("customer_id", customerId)
        .neq("status", "cancelled")
        .order("received_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as CustomerReturnRow[];
    },
  });

  const invoiceById = useMemo(
    () => new Map((invoices.data ?? []).map((s) => [s.id, s])),
    [invoices.data],
  );
  const lookups = useMemo(() => {
    const grouped = new Map<string, CustomerItemRow[]>();
    (items.data ?? []).forEach((it) =>
      grouped.set(it.sale_id, [...(grouped.get(it.sale_id) ?? []), it]),
    );
    const itemsBySale = new Map<string, string>();
    grouped.forEach((rows, saleId) => itemsBySale.set(saleId, summariseItems(rows)));
    return {
      invoiceById,
      paymentById: new Map((payments.data ?? []).map((p) => [p.id, p])),
      itemsBySale,
    };
  }, [invoiceById, payments.data, items.data]);

  // Value of each return: what the ledger credited for it once inspected, or
  // (no ledger line found) the quantity at the price it was supplied at.
  const returnRows = useMemo(() => {
    const ledger = account.data?.ledger ?? [];
    const priceOf = (saleId: string | null, productId: string) =>
      Number(
        (items.data ?? []).find((it) => it.sale_id === saleId && it.product_id === productId)
          ?.unit_price ?? 0,
      );
    return (returns.data ?? []).map((r) => {
      const credited = ledger
        .filter((l) => l.reference_id === r.id)
        .reduce((t, l) => t + Math.abs(l.amount), 0);
      const qty =
        r.status === "completed"
          ? Number(r.accepted_quantity ?? 0) + Number(r.damaged_quantity ?? 0)
          : Number(r.quantity_returned);
      return {
        ...r,
        value: credited > 0 ? credited : qty * priceOf(r.sale_id, r.product_id),
        credited: credited > 0,
      };
    });
  }, [returns.data, items.data, account.data?.ledger]);
  const returnTotals = useMemo(
    () => ({
      qty: returnRows.reduce((t, r) => t + Number(r.quantity_returned), 0),
      value: returnRows.reduce((t, r) => t + r.value, 0),
      awaiting: returnRows.filter((r) => r.status === "received").length,
    }),
    [returnRows],
  );

  const summary = account.data?.summary;
  const isMarketer = customer.data?.customer_type === "marketer";
  const payable = isMarketer || !!customer.data?.credit_account;
  const makeMarketer = useMakeMarketer(factoryId ?? undefined);
  const pendingSales = account.data?.pendingSales ?? [];
  const hasRange = !!from || !!to;
  const rangeInvalid = !!from && !!to && from > to;
  const statement = useMemo(
    () => buildStatement(account.data?.ledger ?? [], rangeInvalid ? {} : { from, to }, lookups),
    [account.data?.ledger, from, to, rangeInvalid, lookups],
  );
  // Sales awaiting approval belong to "now", so they only appear on an
  // unfiltered statement.
  const shownPending = hasRange ? [] : pendingSales;

  const exportStatement = async (kind: PdfAction | "csv") => {
    const name = customer.data?.name ?? customerName;
    if (kind === "csv") {
      exportCsv(
        `statement-${name.replace(/\s+/g, "-")}`,
        [...STATEMENT_COLUMNS],
        statementCsvRows(statement),
      );
    } else {
      await generateCustomerStatementPdf(
        {
          company: {
            name: settings.data?.company_name ?? "FMIS",
            address: settings.data?.address,
            phone: settings.data?.phone,
            logo_url: settings.data?.logo_url,
          },
          customer: { name, phone: customer.data?.phone, address: customer.data?.address },
          statement,
          periodLabel: periodLabel(statement.range),
          pendingSales: shownPending,
          currency: settings.data?.currency ?? "NGN",
        },
        kind,
      );
    }
    logAudit({
      action: kind === "print" ? "print" : "export",
      entity: "customer_statement",
      entityId: customerId,
      factoryId,
      newValue: { format: kind, period: periodLabel(statement.range) },
    });
  };

  return (
    <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-3">
          {customerName} — Account
          {summary && <AccountStatusBadge status={summary.account_status} />}
          {isMarketer && <Badge variant="outline">Marketer</Badge>}
          {customer.data && !isMarketer && canMakeMarketer && (
            <Button
              size="sm"
              variant="outline"
              className={payable && canRecordPayment ? "" : "ml-auto mr-6"}
              disabled={makeMarketer.isPending}
              title="Move this customer onto the marketer list, keeping their sales and debts"
              onClick={() => makeMarketer.mutate(customerId)}
            >
              {makeMarketer.isPending ? "Updating…" : "Make marketer"}
            </Button>
          )}
          {payable && canRecordPayment && factoryId && (
            <Button size="sm" className="ml-auto mr-6 gap-1.5" onClick={() => setPaying(true)}>
              <HandCoins className="h-4 w-4" /> Add payment
            </Button>
          )}
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        {summary && <AccountSummaryCards summary={summary} />}

        {summary && summary.available_advance > 0 && summary.outstanding_debt > 0 && (
          <p className="rounded-md bg-warning/15 px-3 py-2 text-xs text-warning">
            This customer has both an advance and a debt on record. They are shown separately and
            are not netted against each other.
          </p>
        )}
        {pendingSales.length > 0 && (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {pendingSales.length} sale{pendingSales.length === 1 ? " is" : "s are"} awaiting
            approval ({money(pendingSales.reduce((s, p) => s + p.grand_total, 0))}). They are listed
            below but only change the balances once a manager approves them.
          </p>
        )}

        <Tabs defaultValue="ledger">
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="ledger">Account Ledger</TabsTrigger>
            <TabsTrigger value="pending">
              Awaiting confirmation{pendingSales.length > 0 ? ` (${pendingSales.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="products">
              {isMarketer ? "Products Supplied" : "Products Purchased"}
            </TabsTrigger>
            <TabsTrigger value="invoices">{isMarketer ? "Supplies" : "Invoices"}</TabsTrigger>
            <TabsTrigger value="returns">
              Returns{returnRows.length > 0 ? ` (${returnRows.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="payments">Payment History</TabsTrigger>
            <TabsTrigger value="prices">Special Prices</TabsTrigger>
            <TabsTrigger value="adjustments">Adjustments</TabsTrigger>
          </TabsList>

          <TabsContent value="ledger" className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label className="text-xs">From</Label>
                <DateInput
                  value={from}
                  max={to || undefined}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">To</Label>
                <DateInput
                  value={to}
                  min={from || undefined}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
              {hasRange && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFrom("");
                    setTo("");
                  }}
                >
                  All activity
                </Button>
              )}
              <div className="ml-auto flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={account.isLoading || rangeInvalid}
                  onClick={() => exportStatement("print")}
                >
                  <Printer className="h-4 w-4" /> Print statement
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={account.isLoading || rangeInvalid}
                  onClick={() => exportStatement("download")}
                >
                  <FileDown className="h-4 w-4" /> PDF
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={account.isLoading || rangeInvalid}
                  onClick={() => exportStatement("csv")}
                >
                  <Sheet className="h-4 w-4" /> CSV
                </Button>
              </div>
            </div>
            {rangeInvalid && (
              <p className="text-xs text-destructive">“From” must be on or before “To”.</p>
            )}

            {account.isLoading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Loading account…</p>
            ) : (
              <>
                <AccountLedgerTable
                  ledger={statement.ledger}
                  pendingSales={shownPending}
                  lookups={lookups}
                  broughtForward={from && !rangeInvalid ? statement.opening : undefined}
                />
                <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 text-sm sm:grid-cols-4">
                  <div>
                    <span className="block text-xs text-muted-foreground">
                      {hasRange ? "Advance received" : "Total advance received"}
                    </span>
                    <span className="font-medium">{money(statement.totals.advanceReceived)}</span>
                  </div>
                  <div>
                    <span className="block text-xs text-muted-foreground">Products collected</span>
                    <span className="font-medium">{money(statement.totals.goodsCollected)}</span>
                  </div>
                  <div>
                    <span className="block text-xs text-muted-foreground">Closing advance</span>
                    <span
                      className={`font-semibold ${statement.closing.credit > 0 ? "text-success" : ""}`}
                    >
                      {money(statement.closing.credit)}
                    </span>
                  </div>
                  <div>
                    <span className="block text-xs text-muted-foreground">Closing debt</span>
                    <span
                      className={`font-semibold ${statement.closing.debt > 0 ? "text-destructive" : ""}`}
                    >
                      {money(statement.closing.debt)}
                    </span>
                  </div>
                </div>
              </>
            )}
            <p className="text-xs text-muted-foreground">
              Every advance, sale, payment and reversal is recorded as its own line and never
              edited; a correction is a new line.
            </p>
          </TabsContent>

          <TabsContent value="products">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit Price</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(items.data ?? []).map((it, idx) => {
                  const inv = invoiceById.get(it.sale_id);
                  return (
                    <TableRow key={`${it.sale_id}-${idx}`}>
                      <TableCell className="font-mono text-xs">
                        {inv?.invoice_number ?? "—"}
                      </TableCell>
                      <TableCell>{fmtDate(inv?.sale_date)}</TableCell>
                      <TableCell>
                        {it.products?.name ?? "—"}
                        {it.products?.unit ? ` (${it.products.unit})` : ""}
                      </TableCell>
                      <TableCell className="text-right">{num(Number(it.quantity))}</TableCell>
                      <TableCell className="text-right">{money(Number(it.unit_price))}</TableCell>
                      <TableCell className="text-right">{money(Number(it.line_total))}</TableCell>
                      <TableCell className="capitalize text-xs text-muted-foreground">
                        {inv ? inv.status.replace(/_/g, " ") : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {(items.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                      No products purchased yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TabsContent>

          <TabsContent value="invoices">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Advance used</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Payment status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(invoices.data ?? []).map((inv) => {
                  const st = salePaymentStatus(inv);
                  return (
                    <TableRow key={inv.id}>
                      <TableCell>
                        <RefId id={inv.id} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{inv.invoice_number}</TableCell>
                      <TableCell>{fmtDate(inv.sale_date)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {inv.payment_method}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{money(Number(inv.grand_total))}</TableCell>
                      <TableCell className="text-right">{money(Number(inv.amount_paid))}</TableCell>
                      <TableCell className="text-right">
                        {Number(inv.credit_applied) > 0 ? money(Number(inv.credit_applied)) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {inv.status === "posted" && Number(inv.balance) > 0 ? (
                          <Badge variant="destructive">{money(Number(inv.balance))}</Badge>
                        ) : (
                          money(inv.status === "posted" ? Number(inv.balance) : 0)
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={st.variant} className="capitalize">
                          {st.label}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {(invoices.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                      No purchases yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TabsContent>

          <TabsContent value="prices">
            {factoryId && (
              <CustomerPricesPanel
                factoryId={factoryId}
                customerId={customerId}
                customerName={customer.data?.name ?? customerName}
              />
            )}
          </TabsContent>

          <TabsContent value="pending">
            {factoryId && <CustomerPendingOrders factoryId={factoryId} customerId={customerId} />}
          </TabsContent>

          <TabsContent value="returns" className="space-y-3">
            <div className="grid grid-cols-3 gap-3 rounded-md bg-muted/30 p-3 text-sm">
              <div>
                <span className="block text-xs text-muted-foreground">Returns logged</span>
                <span className="font-medium">{returnRows.length}</span>
              </div>
              <div>
                <span className="block text-xs text-muted-foreground">Quantity returned</span>
                <span className="font-medium">{num(returnTotals.qty)}</span>
              </div>
              <div>
                <span className="block text-xs text-muted-foreground">Value of returns</span>
                <span className="font-medium text-success">{money(returnTotals.value)}</span>
              </div>
            </div>
            {returnTotals.awaiting > 0 && (
              <p className="rounded-md bg-warning/15 px-3 py-2 text-xs text-warning">
                {returnTotals.awaiting} return{returnTotals.awaiting === 1 ? " is" : "s are"}{" "}
                awaiting inspection. The account is credited once Sales Returns inspects them.
              </p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Return</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Supply</TableHead>
                  <TableHead className="text-right">Returned</TableHead>
                  <TableHead className="text-right">Accepted / Damaged / Rejected</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {returnRows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.return_number}</TableCell>
                    <TableCell className="whitespace-nowrap">{fmtDate(r.received_at)}</TableCell>
                    <TableCell>
                      {r.products?.name ?? "—"}
                      {r.reason && <div className="text-xs text-muted-foreground">{r.reason}</div>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {(r.sale_id && invoiceById.get(r.sale_id)?.invoice_number) || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {num(Number(r.quantity_returned))} {r.products?.unit ?? ""}
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      {r.status === "completed"
                        ? `${num(Number(r.accepted_quantity ?? 0))} / ${num(Number(r.damaged_quantity))} / ${num(Number(r.rejected_quantity))}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {money(r.value)}
                      {!r.credited && (
                        <div className="text-[10px] text-muted-foreground">
                          {r.status === "completed" ? "at supply price" : "not credited yet"}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.status === "completed" ? "secondary" : "outline"}>
                        {r.status === "received"
                          ? "Awaiting inspection"
                          : r.status === "completed"
                            ? "Inspected"
                            : r.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {returnRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                      {returns.isLoading ? "Loading…" : "No returns yet."}
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
                  <TableHead>ID</TableHead>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Date & Time</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(payments.data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <RefId id={p.id} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{p.receipt_number}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {fmtDateTime(p.created_at)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {p.payment_method}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{money(Number(p.amount))}</TableCell>
                  </TableRow>
                ))}
                {(payments.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                      No payments yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TabsContent>
          <TabsContent value="adjustments">
            {factoryId && (
              <AccountAdjustmentsCard
                factoryId={factoryId}
                customerId={customerId}
                title="Adjustments for this customer"
              />
            )}
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={paying} onOpenChange={setPaying}>
        {paying && factoryId && (
          <AddPaymentDialog
            factoryId={factoryId}
            account={{
              id: customerId,
              name: customer.data?.name ?? customerName,
              kind: isMarketer ? "marketer" : "customer",
              debt: summary?.outstanding_debt ?? 0,
              credit: summary?.available_advance ?? 0,
            }}
            onDone={() => setPaying(false)}
          />
        )}
      </Dialog>
    </DialogContent>
  );
}
