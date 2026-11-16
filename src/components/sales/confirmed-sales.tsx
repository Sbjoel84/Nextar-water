import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { startOfWeek, startOfMonth } from "date-fns";
import { FileDown, Printer, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAll } from "@/lib/metrics";
import { useFactorySettings } from "@/lib/use-factory";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { openSaleInvoice } from "@/lib/sale-invoice";
import { salePaymentStatus } from "@/lib/customer-account";
import { logAudit } from "@/lib/audit";
import { money, fmtDateTime } from "@/lib/format";
import { matchesSearch } from "@/lib/search";
import { customerTypeLabel } from "@/components/sales/confirm-sale";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RefId } from "@/components/shared/ref-id";
import { DateInput } from "@/components/shared/date-input";

type ConfirmedSale = {
  id: string;
  invoice_number: string;
  sale_date: string;
  approved_at: string | null;
  created_at: string;
  customer_name: string | null;
  customer_type: string | null;
  grand_total: number;
  amount_paid: number;
  credit_applied: number;
  balance: number;
  status: string;
  is_pr: boolean;
  sales_person: string | null;
};

const ymd = (d: Date) => d.toLocaleDateString("en-CA");

// Account Overview: orders the accountant has already confirmed, each with a
// reprint button for when a customer asks for another copy of the receipt.
export function ConfirmedSalesCard({ factoryId }: { factoryId: string }) {
  const settings = useFactorySettings(factoryId);
  const today = ymd(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [q, setQ] = useState("");
  const [printing, setPrinting] = useState<string | null>(null);
  const valid = !!from && !!to && from <= to;

  useRealtimeInvalidate(["sales"], [["confirmed-sales", factoryId]]);

  const sales = useQuery({
    queryKey: ["confirmed-sales", factoryId, from, to],
    enabled: valid,
    queryFn: () =>
      fetchAll<ConfirmedSale>(
        (a, b) =>
          supabase
            .from("sales")
            .select(
              "id,invoice_number,sale_date,approved_at,created_at,customer_name,customer_type,grand_total,amount_paid,credit_applied,balance,status,is_pr,sales_person",
            )
            .eq("factory_id", factoryId)
            .eq("status", "posted")
            .is("deleted_at", null)
            .gte("sale_date", from)
            .lte("sale_date", to)
            .order("sale_date", { ascending: false })
            .order("id")
            .range(a, b) as any,
      ),
  });

  const rows = useMemo(
    () =>
      (sales.data ?? [])
        .filter((s) => matchesSearch(q, s))
        .sort((a, b) =>
          (b.approved_at ?? b.created_at).localeCompare(a.approved_at ?? a.created_at),
        ),
    [sales.data, q],
  );

  const reprint = async (s: ConfirmedSale, action: "print" | "download") => {
    if (!settings.data) return;
    setPrinting(s.id);
    try {
      await openSaleInvoice(s.id, settings.data, action);
      logAudit({
        action: action === "print" ? "print" : "export",
        entity: "sales",
        entityId: s.id,
        factoryId,
        newValue: { reprint: true, invoice_number: s.invoice_number },
      });
    } finally {
      setPrinting(null);
    }
  };

  const presets: { label: string; from: string }[] = [
    { label: "Today", from: today },
    { label: "This week", from: ymd(startOfWeek(new Date())) },
    { label: "This month", from: ymd(startOfMonth(new Date())) },
  ];

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <CardTitle>
            Confirmed orders
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({sales.data?.length ?? 0})
            </span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Orders already confirmed. Use the printer to reprint a receipt when a customer asks for
            another copy.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {presets.map((p) => (
            <Button
              key={p.label}
              size="sm"
              variant={from === p.from && to === today ? "default" : "outline"}
              onClick={() => {
                setFrom(p.from);
                setTo(today);
              }}
            >
              {p.label}
            </Button>
          ))}
          <div>
            <Label className="text-xs">From</Label>
            <DateInput value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <DateInput value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
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
              <TableHead>Confirmed</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Sales person</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Payment</TableHead>
              <TableHead className="text-right">Reprint</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!valid ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-destructive">
                  "From" must be on or before "To".
                </TableCell>
              </TableRow>
            ) : sales.isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : sales.isError ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-destructive">
                  {(sales.error as Error).message}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                  {sales.data?.length ? "No orders match." : "No confirmed orders in this period."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((s) => {
                const st = salePaymentStatus(s);
                return (
                  <TableRow key={s.id}>
                    <TableCell>
                      <RefId id={s.id} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{s.invoice_number}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {fmtDateTime(s.approved_at ?? s.created_at)}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{s.customer_name ?? "Walk-in"}</div>
                      <div className="text-xs text-muted-foreground">
                        {customerTypeLabel(s.customer_type)}
                      </div>
                    </TableCell>
                    <TableCell>{s.sales_person ?? "—"}</TableCell>
                    <TableCell className="text-right">{money(Number(s.grand_total))}</TableCell>
                    <TableCell>
                      <Badge variant={st.variant} className="capitalize">
                        {st.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1"
                          disabled={printing === s.id || !settings.data}
                          title="Reprint receipt"
                          onClick={() => reprint(s, "print")}
                        >
                          <Printer className="h-4 w-4" /> Reprint
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={printing === s.id || !settings.data}
                          title="Download receipt as PDF"
                          onClick={() => reprint(s, "download")}
                        >
                          <FileDown className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
