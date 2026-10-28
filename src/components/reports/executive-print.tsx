import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { format, startOfMonth, startOfWeek, startOfYear } from "date-fns";
import { toast } from "sonner";
import { Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useFactorySettings } from "@/lib/use-factory";
import { dayKey, fetchAll, isLowStock, sum } from "@/lib/metrics";
import { paymentRows } from "@/lib/metric-queries";
import {
  financeSummary,
  grossProfitOf,
  operatingCostsOf,
  profitOf,
  revenueOf,
  type FinanceSummary,
} from "@/lib/finance-summary";
import { generateStatementPdf, type StatementSection } from "@/lib/pdf";
import { logAudit } from "@/lib/audit";
import { money, num, fmtDate } from "@/lib/format";
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

export type ExecutiveDoc = "executive" | "pnl";

type PeriodKey = "today" | "week" | "month" | "year" | "custom";
const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
  { key: "year", label: "This Year" },
  { key: "custom", label: "Custom" },
];

const TITLES: Record<ExecutiveDoc, string> = {
  executive: "Executive Summary",
  pnl: "Profit & Loss Statement",
};

const COST_NOTE =
  "Cost of goods sold uses each product's current cost price, as sales do not record cost at the time of sale. " +
  "Revenue counts approved sales (not complimentary PR) plus Other Income and Donations. " +
  "Expenses count approved expenses, salaries paid and other cash payments.";

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
  const label = start === end ? fmtDate(start) : `${fmtDate(start)} – ${fmtDate(end)}`;
  return { start, end, label };
}

// Lines shared by both documents: the profit & loss statement itself.
function pnlSections(f: FinanceSummary, currency: string): StatementSection[] {
  const m = (n: number) => money(n, currency);
  const t = f.totals;
  const net = profitOf(t);
  return [
    {
      heading: "Revenue",
      lines: [
        { label: "Sales revenue", value: m(t.sales) },
        ...f.otherIncomeByCategory.map((c) => ({
          label: c.category,
          value: m(c.amount),
          kind: "sub" as const,
        })),
        { label: "Other income", value: m(t.otherIncome) },
        { label: "Total revenue", value: m(revenueOf(t)), kind: "total" },
      ],
    },
    {
      heading: "Cost of goods sold",
      lines: [
        { label: "Cost of goods sold", value: m(t.cogs) },
        { label: "Gross profit", value: m(grossProfitOf(t)), kind: "total" },
      ],
    },
    {
      heading: "Operating expenses",
      lines: [
        ...f.expensesByCategory.map((c) => ({
          label: c.category,
          value: m(c.amount),
          kind: "sub" as const,
        })),
        { label: "Expenses", value: m(t.expenses) },
        { label: "Salaries & wages", value: m(t.salaries) },
        { label: "Other payments", value: m(t.otherPayments) },
        { label: "Total operating expenses", value: m(operatingCostsOf(t)), kind: "total" },
      ],
    },
    {
      heading: net >= 0 ? "Net profit" : "Net loss",
      lines: [
        {
          label: net >= 0 ? "Net profit" : "Net loss",
          value: m(net),
          kind: "grand",
        },
        {
          label: "Net margin",
          value: revenueOf(t) > 0 ? `${((net / revenueOf(t)) * 100).toFixed(1)}%` : "—",
        },
      ],
    },
  ];
}

async function operationsSections(
  factoryId: string,
  start: string,
  end: string,
  f: FinanceSummary,
  currency: string,
): Promise<StatementSection[]> {
  const m = (n: number) => money(n, currency);
  const [payments, debts, production, rawMaterials, products, returns, pos] = await Promise.all([
    paymentRows(factoryId, start, end),
    fetchAll<{ outstanding: number }>(
      (a, b) =>
        supabase
          .from("debts")
          .select("outstanding")
          .eq("factory_id", factoryId)
          .neq("status", "paid")
          .order("id")
          .range(a, b) as any,
    ),
    fetchAll<{ quantity_produced: number }>(
      (a, b) =>
        supabase
          .from("production")
          .select("quantity_produced")
          .eq("factory_id", factoryId)
          .in("status", ["pending_confirmation", "confirmed", "posted"])
          .gte("production_date", start)
          .lte("production_date", end)
          .order("id")
          .range(a, b) as any,
    ),
    fetchAll<{ current_stock: number; reorder_level: number | null; current_value: number }>(
      (a, b) =>
        supabase
          .from("raw_materials")
          .select("current_stock,reorder_level,current_value")
          .eq("factory_id", factoryId)
          .eq("active", true)
          .order("id")
          .range(a, b) as any,
    ),
    fetchAll<{ current_stock: number; cost_price: number }>(
      (a, b) =>
        supabase
          .from("products")
          .select("current_stock,cost_price")
          .eq("factory_id", factoryId)
          .eq("active", true)
          .order("id")
          .range(a, b) as any,
    ),
    fetchAll<{ quantity_returned: number }>(
      (a, b) =>
        supabase
          .from("sales_returns")
          .select("quantity_returned")
          .eq("factory_id", factoryId)
          .gte("received_at", new Date(`${start}T00:00:00`).toISOString())
          .lte("received_at", new Date(`${end}T23:59:59.999`).toISOString())
          .order("id")
          .range(a, b) as any,
    ),
    fetchAll<{ quantity_ordered: number; unit_cost: number | null }>(
      (a, b) =>
        supabase
          .from("purchase_orders")
          .select("quantity_ordered,unit_cost")
          .eq("factory_id", factoryId)
          .neq("status", "cancelled")
          .gte("issued_at", new Date(`${start}T00:00:00`).toISOString())
          .lte("issued_at", new Date(`${end}T23:59:59.999`).toISOString())
          .order("id")
          .range(a, b) as any,
    ),
  ]);

  return [
    {
      heading: "Sales & collections",
      lines: [
        { label: "Approved sales", value: num(f.salesCount) },
        {
          label: "Average sale",
          value: f.salesCount ? m(f.totals.sales / f.salesCount) : "—",
        },
        { label: "Payments received", value: m(sum(payments, (p) => p.amount)) },
        { label: "Outstanding receivables (now)", value: m(sum(debts, (d) => d.outstanding)) },
      ],
    },
    {
      heading: "Production & stock",
      lines: [
        { label: "Production runs", value: num(production.length) },
        { label: "Units produced", value: num(sum(production, (p) => p.quantity_produced)) },
        { label: "Sales returns (units)", value: num(sum(returns, (r) => r.quantity_returned)) },
        {
          label: "Finished goods value (now)",
          value: m(sum(products, (p) => Number(p.current_stock) * Number(p.cost_price))),
        },
        {
          label: "Raw material value (now)",
          value: m(sum(rawMaterials, (r) => r.current_value)),
        },
        {
          label: "Raw materials at/below reorder level (now)",
          value: num(
            rawMaterials.filter((r) => isLowStock(r.current_stock, r.reorder_level)).length,
          ),
        },
      ],
    },
    {
      heading: "Purchasing",
      lines: [
        { label: "Purchase orders issued", value: num(pos.length) },
        {
          label: "Value ordered",
          value: m(sum(pos, (p) => Number(p.quantity_ordered) * Number(p.unit_cost ?? 0))),
        },
      ],
    },
  ];
}

// The statement's sections for a period (YYYY-MM-DD, inclusive). Shared by the
// print button and the Executive Summary / Profit & Loss entries in the
// Reports dropdown, so the screen, exports and printout all match.
export async function buildStatement(
  doc: ExecutiveDoc,
  factoryId: string,
  start: string,
  end: string,
  currency: string,
): Promise<StatementSection[]> {
  const finance = await financeSummary(factoryId, start, end);
  if (doc === "pnl") return pnlSections(finance, currency);
  const net = profitOf(finance.totals);
  return [
    {
      heading: "Headline figures",
      lines: [
        { label: "Total revenue", value: money(revenueOf(finance.totals), currency) },
        {
          label: "Total costs",
          value: money(finance.totals.cogs + operatingCostsOf(finance.totals), currency),
        },
        { label: net >= 0 ? "Net profit" : "Net loss", value: money(net, currency), kind: "grand" },
      ],
    },
    ...(await operationsSections(factoryId, start, end, finance, currency)),
    ...pnlSections(finance, currency),
  ];
}

export const STATEMENT_TITLES = TITLES;
export const STATEMENT_NOTE = COST_NOTE;

export function ExecutivePrintDialog({
  doc,
  factoryId,
  onClose,
}: {
  doc: ExecutiveDoc | null;
  factoryId: string | undefined;
  onClose: () => void;
}) {
  const settings = useFactorySettings(factoryId);
  const [period, setPeriod] = useState<PeriodKey>("month");
  const [from, setFrom] = useState(format(startOfMonth(new Date()), "yyyy-MM-dd"));
  const [to, setTo] = useState(format(new Date(), "yyyy-MM-dd"));
  const badRange = period === "custom" && (!from || !to || from > to);

  const print = useMutation({
    mutationFn: async () => {
      if (!doc || !factoryId) return;
      const { start, end, label } = periodBounds(period, from, to);
      const currency = settings.data?.currency ?? "NGN";
      const sections = await buildStatement(doc, factoryId, start, end, currency);

      await generateStatementPdf(
        {
          title: TITLES[doc],
          period: label,
          company: { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
          sections,
          note: COST_NOTE,
        },
        "print",
      );
      logAudit({
        action: "print",
        entity: "report",
        factoryId,
        newValue: { report: TITLES[doc], period: label },
      });
    },
    onSuccess: onClose,
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={!!doc} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Print {doc ? TITLES[doc] : ""}</DialogTitle>
          <DialogDescription>
            Choose the period, then print it or save it as a PDF from the print window.
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
            disabled={print.isPending || badRange}
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
