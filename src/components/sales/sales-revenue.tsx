import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, startOfMonth, startOfYear, subMonths } from "date-fns";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  CalendarRange,
  FileDown,
  FileSpreadsheet,
  FileText,
  LineChart,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { KPI } from "@/lib/dashboard-kit";
import { dayKey, sum } from "@/lib/metrics";
import { money } from "@/lib/format";
import { exportCsv, exportExcel } from "@/lib/export";
import { generateReportPdf } from "@/lib/pdf";
import { useFactorySettings } from "@/lib/use-factory";
import { dailyAccumulated, monthlyAccumulated, saleAmountRows } from "@/lib/sales-revenue";

const pct = (v: number | null) =>
  v == null ? "—" : `${v >= 0 ? "▲" : "▼"} ${Math.abs(v).toFixed(1)}%`;
const pctTone = (v: number | null) =>
  v == null ? "text-muted-foreground" : v >= 0 ? "text-success" : "text-destructive";

const tooltipStyle = {
  background: "var(--color-card)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
};

// Sales Revenue KPIs: today, month and year to date, daily average.
export function SalesRevenuePanel({ factoryId }: { factoryId: string }) {
  const now = new Date();
  const today = dayKey(now);
  const thisYear = now.getFullYear();
  const thisMonth = today.slice(0, 7);

  // ---------- KPIs: always relative to today ----------
  // Reaches back to the start of last month so the month-to-date comparison
  // works in January too.
  const kpiFrom = dayKey(
    new Date(Math.min(startOfYear(now).getTime(), startOfMonth(subMonths(now, 1)).getTime())),
  );
  const kpiRows = useQuery({
    queryKey: ["sales-revenue", "kpi", factoryId, kpiFrom, today],
    queryFn: () => saleAmountRows(factoryId, kpiFrom, today),
  });
  const kpi = useMemo(() => {
    const rows = kpiRows.data ?? [];
    const total = (pred: (d: string) => boolean) =>
      sum(
        rows.filter((r) => pred(r.sale_date)),
        (r) => r.grand_total,
      );
    const lastMonth = dayKey(subMonths(now, 1)).slice(0, 7);
    // Same point last month: day 1 up to today's day number (capped by that
    // month's length, e.g. 31 Mar compares with 28/29 Feb).
    const lastMonthSamePoint = `${lastMonth}-${today.slice(8, 10)}`;
    const mtd = total((d) => d.startsWith(thisMonth));
    const lastMtd = total((d) => d.startsWith(lastMonth) && d <= lastMonthSamePoint);
    const dayOfMonth = Number(today.slice(8, 10));
    return {
      today: total((d) => d === today),
      todayCount: rows.filter((r) => r.sale_date === today).length,
      mtd,
      lastMtd,
      mtdChange: lastMtd ? ((mtd - lastMtd) / lastMtd) * 100 : null,
      ytd: total((d) => d.startsWith(String(thisYear))),
      dailyAvg: mtd / dayOfMonth,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kpiRows.data, today]);

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">Sales Revenue</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KPI
          icon={Wallet}
          label="Sales Revenue · Today"
          value={money(kpi.today)}
          hint={`${kpi.todayCount} approved sale${kpi.todayCount === 1 ? "" : "s"}`}
        />
        <KPI
          icon={TrendingUp}
          label="Accumulated · This Month"
          value={money(kpi.mtd)}
          hint={
            kpi.mtdChange == null
              ? `Same point last month: ${money(kpi.lastMtd)}`
              : `${pct(kpi.mtdChange)} vs same point last month (${money(kpi.lastMtd)})`
          }
          tone={kpi.mtdChange == null || kpi.mtdChange >= 0 ? "success" : "destructive"}
        />
        <KPI
          icon={CalendarRange}
          label={`Accumulated · ${thisYear} to date`}
          value={money(kpi.ytd)}
          hint="Jan 1 to today"
          tone="success"
        />
        <KPI
          icon={LineChart}
          label="Daily Average · This Month"
          value={money(kpi.dailyAvg)}
          hint={`Over ${Number(today.slice(8, 10))} day${today.endsWith("-01") ? "" : "s"} so far`}
          tone="warning"
        />
      </div>
    </div>
  );
}

// Monthly Accumulated Sales: each month's revenue and the running total for
// the year, with a day-by-day drill-down into any month.
export function MonthlyAccumulatedSalesCard({ factoryId }: { factoryId: string }) {
  const today = dayKey(new Date());
  const thisYear = Number(today.slice(0, 4));
  const thisMonth = today.slice(0, 7);

  const settings = useFactorySettings(factoryId);
  const [year, setYear] = useState(thisYear);
  const yearRows = useQuery({
    queryKey: ["sales-revenue", "year", factoryId, year],
    queryFn: () => saleAmountRows(factoryId, `${year}-01-01`, `${year}-12-31`),
  });
  const months = useMemo(
    () => monthlyAccumulated(yearRows.data ?? [], `${year}-01`, `${year}-12`, today),
    [yearRows.data, year, today],
  );
  const [month, setMonth] = useState<string>("year");
  const days = useMemo(
    () => (month === "year" ? [] : dailyAccumulated(yearRows.data ?? [], month, today)),
    [yearRows.data, month, today],
  );
  const pastMonths = months.filter((m) => !m.future);
  const yearTotal = months[months.length - 1]?.accumulated ?? 0;
  const yearCount = sum(months, (m) => m.salesCount);
  const best = pastMonths.reduce<(typeof months)[number] | null>(
    (b, m) => (m.revenue > 0 && (!b || m.revenue > b.revenue) ? m : b),
    null,
  );

  const chartData =
    month === "year"
      ? months.map((m) => ({
          label: format(new Date(`${m.key}-01T00:00:00`), "MMM"),
          revenue: m.future ? null : m.revenue,
          accumulated: m.future ? null : m.accumulated,
        }))
      : days.map((d) => ({
          label: d.key.slice(8, 10),
          revenue: d.future ? null : d.revenue,
          accumulated: d.future ? null : d.accumulated,
        }));

  const years = Array.from({ length: 6 }, (_, i) => thisYear - i);

  const doExport = (type: "csv" | "excel" | "pdf") => {
    const name =
      month === "year" ? `Monthly-Accumulated-Sales-${year}` : `Daily-Accumulated-Sales-${month}`;
    const columns = [
      { key: "period", label: month === "year" ? "Month" : "Day" },
      { key: "sales", label: "Approved Sales" },
      { key: "revenue", label: "Sales Revenue" },
      { key: "accumulated", label: month === "year" ? "Accumulated (YTD)" : "Accumulated (MTD)" },
    ];
    const rows = (month === "year" ? pastMonths : days.filter((d) => !d.future)).map((r) => ({
      period: r.label,
      sales: r.salesCount,
      revenue: r.revenue.toFixed(2),
      accumulated: r.accumulated.toFixed(2),
    }));
    if (type === "pdf") {
      // Opens in a new tab to view, print or save, with a total line and money
      // shown in the factory currency.
      const currency = settings.data?.currency ?? "NGN";
      const total = month === "year" ? yearTotal : (days[days.length - 1]?.accumulated ?? 0);
      generateReportPdf(
        month === "year"
          ? `Monthly Accumulated Sales ${year}`
          : `Daily Accumulated Sales ${format(new Date(`${month}-01T00:00:00`), "MMMM yyyy")}`,
        columns,
        [
          ...rows.map((r) => ({
            ...r,
            revenue: money(Number(r.revenue), currency),
            accumulated: money(Number(r.accumulated), currency),
          })),
          {
            period: "Total",
            sales: sum(rows, (r) => r.sales),
            revenue: money(total, currency),
            accumulated: money(total, currency),
          },
        ],
        "preview",
        { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
      );
      return;
    }
    (type === "csv" ? exportCsv : exportExcel)(name, columns, rows);
  };

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>
            {month === "year"
              ? `Monthly Accumulated Sales · ${year}`
              : `Daily Accumulated Sales · ${format(new Date(`${month}-01T00:00:00`), "MMMM yyyy")}`}
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Approved sales only (excludes PR and deleted sales), by sale date. The accumulated
            column is the running total{" "}
            {month === "year" ? "from January" : "from the 1st of the month"}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={String(year)}
            onValueChange={(v) => {
              setYear(Number(v));
              setMonth("year");
            }}
          >
            <SelectTrigger className="h-9 w-28" aria-label="Year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger className="h-9 w-40" aria-label="Month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="year">Whole year</SelectItem>
              {pastMonths.map((m) => (
                <SelectItem key={m.key} value={m.key}>
                  {format(new Date(`${m.key}-01T00:00:00`), "MMMM")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="gap-1" onClick={() => doExport("csv")}>
            <FileDown className="h-4 w-4" /> CSV
          </Button>
          <Button variant="outline" size="sm" className="gap-1" onClick={() => doExport("excel")}>
            <FileSpreadsheet className="h-4 w-4" /> Excel
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => doExport("pdf")}
            title="Preview as PDF"
          >
            <FileText className="h-4 w-4" /> PDF
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {month === "year" && (
          <div className="grid gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-xl border p-3">
              <div className="text-xs text-muted-foreground">Accumulated for {year}</div>
              <div className="mt-1 text-lg font-semibold">{money(yearTotal)}</div>
            </div>
            <div className="rounded-xl border p-3">
              <div className="text-xs text-muted-foreground">Approved sales</div>
              <div className="mt-1 text-lg font-semibold">{yearCount}</div>
            </div>
            <div className="rounded-xl border p-3">
              <div className="text-xs text-muted-foreground">Best month</div>
              <div className="mt-1 text-lg font-semibold">
                {best ? `${best.label.slice(0, 3)} · ${money(best.revenue)}` : "—"}
              </div>
            </div>
          </div>
        )}

        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="label" stroke="var(--color-muted-foreground)" fontSize={12} />
              <YAxis
                stroke="var(--color-muted-foreground)"
                fontSize={12}
                width={80}
                tickFormatter={(v: number) =>
                  Intl.NumberFormat("en", { notation: "compact" }).format(v)
                }
              />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => money(v)} />
              <Legend />
              <Bar
                dataKey="revenue"
                name={month === "year" ? "Monthly revenue" : "Daily revenue"}
                fill="var(--color-primary)"
                radius={[4, 4, 0, 0]}
              />
              <Line
                type="monotone"
                dataKey="accumulated"
                name="Accumulated"
                stroke="var(--color-success)"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{month === "year" ? "Month" : "Day"}</TableHead>
                <TableHead className="text-right">Approved Sales</TableHead>
                <TableHead className="text-right">Sales Revenue</TableHead>
                {month === "year" && <TableHead className="text-right">vs Prior Month</TableHead>}
                <TableHead className="text-right">Accumulated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {yearRows.isLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {month === "year"
                ? months.map((m) => (
                    <TableRow
                      key={m.key}
                      className={m.future ? "text-muted-foreground" : "cursor-pointer"}
                      onClick={() => !m.future && setMonth(m.key)}
                      title={m.future ? undefined : "Show this month day by day"}
                    >
                      <TableCell>
                        {m.label}
                        {m.key === thisMonth && (
                          <span className="ml-2 text-xs text-muted-foreground">(so far)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{m.future ? "—" : m.salesCount}</TableCell>
                      <TableCell className="text-right">
                        {m.future ? "—" : money(m.revenue)}
                      </TableCell>
                      <TableCell className={`text-right text-xs ${pctTone(m.changePct)}`}>
                        {m.future ? "—" : pct(m.changePct)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {m.future ? "—" : money(m.accumulated)}
                      </TableCell>
                    </TableRow>
                  ))
                : days
                    .filter((d) => !d.future)
                    .map((d) => (
                      <TableRow key={d.key}>
                        <TableCell>{d.label}</TableCell>
                        <TableCell className="text-right">{d.salesCount}</TableCell>
                        <TableCell className="text-right">{money(d.revenue)}</TableCell>
                        <TableCell className="text-right font-medium">
                          {money(d.accumulated)}
                        </TableCell>
                      </TableRow>
                    ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>Total</TableCell>
                <TableCell className="text-right">
                  {month === "year" ? yearCount : sum(days, (d) => d.salesCount)}
                </TableCell>
                <TableCell className="text-right">
                  {money(month === "year" ? yearTotal : (days[days.length - 1]?.accumulated ?? 0))}
                </TableCell>
                {month === "year" && <TableCell />}
                <TableCell className="text-right font-semibold">
                  {money(month === "year" ? yearTotal : (days[days.length - 1]?.accumulated ?? 0))}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
        {month !== "year" && (
          <Button variant="ghost" size="sm" onClick={() => setMonth("year")}>
            ← Back to {year} by month
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
