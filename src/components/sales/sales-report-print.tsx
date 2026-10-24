import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { format, startOfMonth, startOfWeek, startOfYear } from "date-fns";
import { toast } from "sonner";
import { Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useFactorySettings } from "@/lib/use-factory";
import { dayKey, fetchAll, sum } from "@/lib/metrics";
import { generateSalesReportPdf, pdfMoney, type SalesReportTransaction } from "@/lib/pdf";
import { logAudit } from "@/lib/audit";
import { num } from "@/lib/format";
import { customerTypeLabel } from "@/components/sales/confirm-sale";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type PeriodKey = "today" | "week" | "month" | "year" | "custom";
const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "today", label: "Daily" },
  { key: "week", label: "Weekly" },
  { key: "month", label: "Monthly" },
  { key: "year", label: "Yearly" },
  { key: "custom", label: "Custom" },
];

function periodBounds(key: PeriodKey, from: string, to: string) {
  const now = new Date();
  const today = dayKey(now);
  const start =
    key === "today"
      ? today
      : key === "week"
        ? dayKey(startOfWeek(now))
        : key === "month"
          ? dayKey(startOfMonth(now))
          : key === "year"
            ? dayKey(startOfYear(now))
            : from;
  const end = key === "custom" ? to : today;
  const label =
    start === end
      ? format(new Date(`${start}T00:00:00`), "d MMM yyyy")
      : `${format(new Date(`${start}T00:00:00`), "d MMM yyyy")} – ${format(new Date(`${end}T00:00:00`), "d MMM yyyy")}`;
  return { start, end, label };
}

type SaleRow = {
  sale_date: string;
  invoice_number: string;
  customer_name: string | null;
  customer_type: string;
  sales_person: string | null;
  grand_total: number;
  amount_paid: number;
  balance: number;
  status: string;
  is_pr: boolean;
  sale_items: {
    quantity: number;
    line_total: number;
    products: { name: string; unit: string } | null;
  }[];
};

// Every sale in the period (any status, not deleted), oldest first. Totals
// count approved ("posted") sales only -- pending/rejected orders are listed
// so the activity is complete, but never added to the money figures.
export function SalesReportPrintDialog({
  open,
  factoryId,
  onClose,
}: {
  open: boolean;
  factoryId: string | undefined;
  onClose: () => void;
}) {
  const settings = useFactorySettings(factoryId);
  const [period, setPeriod] = useState<PeriodKey>("today");
  const [from, setFrom] = useState(format(startOfMonth(new Date()), "yyyy-MM-dd"));
  const [to, setTo] = useState(format(new Date(), "yyyy-MM-dd"));
  const badRange = period === "custom" && (!from || !to || from > to);

  const print = useMutation({
    mutationFn: async () => {
      if (!factoryId) return;
      const { start, end, label } = periodBounds(period, from, to);
      const currency = settings.data?.currency ?? "NGN";

      const rows = await fetchAll<SaleRow>(
        (a, b) =>
          supabase
            .from("sales")
            .select(
              "sale_date,invoice_number,customer_name,customer_type,sales_person,grand_total,amount_paid,balance,status,is_pr,sale_items(quantity,line_total,products(name,unit))",
            )
            .eq("factory_id", factoryId)
            .is("deleted_at", null)
            .gte("sale_date", start)
            .lte("sale_date", end)
            .order("sale_date")
            .order("invoice_number")
            .range(a, b) as unknown as PromiseLike<{ data: SaleRow[] | null; error: unknown }>,
      );

      const posted = rows.filter((r) => r.status === "posted");
      const sold = posted.filter((r) => !r.is_pr);
      const pr = posted.filter((r) => r.is_pr);
      const lines = sold.flatMap((r) => r.sale_items);

      const byProduct = new Map<
        string,
        { name: string; unit: string; quantity: number; value: number }
      >();
      for (const it of lines) {
        const name = it.products?.name ?? "Unknown product";
        const row = byProduct.get(name) ?? {
          name,
          unit: it.products?.unit ?? "",
          quantity: 0,
          value: 0,
        };
        row.quantity += Number(it.quantity);
        row.value += Number(it.line_total);
        byProduct.set(name, row);
      }

      const m = (n: number) => pdfMoney(n, currency);
      const summary = [
        { label: "Transactions in period", value: num(rows.length) },
        { label: "Approved", value: num(posted.length) },
        {
          label: "Pending approval",
          value: num(rows.filter((r) => r.status === "pending_approval").length),
        },
        {
          label: "Rejected / cancelled",
          value: num(
            rows.filter((r) => r.status === "rejected" || r.status === "cancelled").length,
          ),
        },
        { label: "Units sold (approved)", value: num(sum(lines, (l) => l.quantity)) },
        { label: "Sales value (approved)", value: m(sum(sold, (r) => r.grand_total)) },
        { label: "Amount paid", value: m(sum(sold, (r) => r.amount_paid)) },
        { label: "Outstanding balance", value: m(sum(sold, (r) => r.balance)) },
        {
          label: "PR / giveaways",
          value: `${num(pr.length)} · ${m(
            sum(
              pr.flatMap((r) => r.sale_items),
              (l) => l.line_total,
            ),
          )}`,
        },
      ];

      const transactions: SalesReportTransaction[] = rows.map((r) => ({
        sale_date: r.sale_date,
        invoice_number: r.invoice_number,
        customer: r.customer_name ?? "Walk-in",
        customer_type: customerTypeLabel(r.customer_type),
        sales_person: r.sales_person,
        items: r.sale_items.map((i) => ({
          name: i.products?.name ?? "Unknown product",
          quantity: Number(i.quantity),
          unit: i.products?.unit ?? "",
        })),
        grand_total: Number(r.grand_total),
        amount_paid: Number(r.amount_paid),
        balance: Number(r.balance),
        status: r.status,
        is_pr: r.is_pr,
      }));

      await generateSalesReportPdf(
        {
          period: label,
          company: { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
          currency,
          summary,
          products: [...byProduct.values()].sort((a, b) => b.value - a.value),
          transactions,
        },
        "print",
      );
      logAudit({
        action: "print",
        entity: "report",
        factoryId,
        newValue: { report: "Sales Report", period: label },
      });
    },
    onSuccess: onClose,
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Print Sales Report</DialogTitle>
          <DialogDescription>
            Every sale in the period with the products on each transaction, plus totals. Print it or
            save it as a PDF from the print window.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-2">
            {PERIODS.map((p) => (
              <Button
                key={p.key}
                type="button"
                size="sm"
                variant={period === p.key ? "default" : "outline"}
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {period === "custom" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">From</Label>
                <Input
                  type="date"
                  value={from}
                  max={to}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">To</Label>
                <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
              </div>
              {badRange && (
                <p className="col-span-2 text-xs text-destructive">
                  "From" must be on or before "To".
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="gap-2"
            disabled={print.isPending || badRange || !factoryId}
            onClick={() => print.mutate()}
          >
            <Printer className="h-4 w-4" />
            {print.isPending ? "Preparing…" : "Print"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
