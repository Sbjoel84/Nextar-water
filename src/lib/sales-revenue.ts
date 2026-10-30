import { format } from "date-fns";
import { pendingSalesRows, postedSalesRows } from "@/lib/metric-queries";

// Sales revenue and month-by-month accumulated (running) totals. Built on
// postedSalesRows(), so the figures follow the same rule as every other sales
// card: approved (posted), not deleted, not a complimentary PR giveaway, and
// bucketed by sale_date (the business date), not created_at.

export type SaleAmountRow = { sale_date: string; grand_total: number };

export type MonthTotal = {
  key: string; // yyyy-MM
  label: string; // "Jan 2026"
  salesCount: number;
  revenue: number;
  // Running total from the first month in the list up to and including this one.
  accumulated: number;
  // Change against the month before (null for the first month or when that month had no revenue).
  changePct: number | null;
  // Month hasn't started yet — no figures to show.
  future: boolean;
};

export type DayTotal = {
  key: string; // yyyy-MM-dd
  label: string; // "Oct 5"
  salesCount: number;
  revenue: number;
  accumulated: number;
  future: boolean;
};

export const saleAmountRows = (factoryId: string, fromDay: string, toDay: string) =>
  postedSalesRows(factoryId, "sale_date,grand_total", fromDay, toDay) as Promise<SaleAmountRow[]>;

// Same shape, for orders still awaiting the accountant's confirmation.
export const pendingSaleAmountRows = (factoryId: string, fromDay: string, toDay: string) =>
  pendingSalesRows(factoryId, "sale_date,grand_total", fromDay, toDay) as Promise<
    SaleAmountRow[]
  >;

const monthKeysBetween = (fromMonth: string, toMonth: string) => {
  const out: string[] = [];
  let [y, m] = fromMonth.split("-").map(Number);
  const [ty, tm] = toMonth.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
};

// One row per calendar month from fromMonth to toMonth (yyyy-MM, inclusive),
// with each month's revenue and the accumulated total so far.
export function monthlyAccumulated(
  rows: SaleAmountRow[],
  fromMonth: string,
  toMonth: string,
  today = format(new Date(), "yyyy-MM-dd"),
): MonthTotal[] {
  const byMonth = new Map<string, { revenue: number; count: number }>();
  for (const r of rows) {
    const k = r.sale_date.slice(0, 7);
    const b = byMonth.get(k) ?? { revenue: 0, count: 0 };
    b.revenue += Number(r.grand_total ?? 0);
    b.count += 1;
    byMonth.set(k, b);
  }
  let running = 0;
  let prev: number | null = null;
  return monthKeysBetween(fromMonth, toMonth).map((key) => {
    const b = byMonth.get(key) ?? { revenue: 0, count: 0 };
    const future = key > today.slice(0, 7);
    running += b.revenue;
    const changePct = !future && prev ? ((b.revenue - prev) / prev) * 100 : null;
    prev = future ? prev : b.revenue;
    return {
      key,
      label: format(new Date(`${key}-01T00:00:00`), "MMM yyyy"),
      salesCount: b.count,
      revenue: b.revenue,
      accumulated: running,
      changePct,
      future,
    };
  });
}

// One row per day of a month (yyyy-MM), with the month-to-date running total.
export function dailyAccumulated(
  rows: SaleAmountRow[],
  month: string,
  today = format(new Date(), "yyyy-MM-dd"),
): DayTotal[] {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(y, m, 0).getDate();
  const byDay = new Map<string, { revenue: number; count: number }>();
  for (const r of rows) {
    if (!r.sale_date.startsWith(month)) continue;
    const b = byDay.get(r.sale_date) ?? { revenue: 0, count: 0 };
    b.revenue += Number(r.grand_total ?? 0);
    b.count += 1;
    byDay.set(r.sale_date, b);
  }
  let running = 0;
  return Array.from({ length: days }, (_, i) => {
    const key = `${month}-${String(i + 1).padStart(2, "0")}`;
    const b = byDay.get(key) ?? { revenue: 0, count: 0 };
    running += b.revenue;
    return {
      key,
      label: format(new Date(`${key}T00:00:00`), "dd/MM/yyyy"),
      salesCount: b.count,
      revenue: b.revenue,
      accumulated: running,
      future: key > today,
    };
  });
}
