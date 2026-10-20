import { supabase } from "@/integrations/supabase/client";
import { fetchAll } from "@/lib/metrics";
import { cashTxnRows, expenseRows, payrollPaidRows, postedSalesRows } from "@/lib/metric-queries";

// Profit & loss figures for a period, shared by the dashboard cards/chart and
// the printed Executive Summary and Profit & Loss statement so they always
// agree. Same inclusion rules as the Sales, Expenses, Payroll and Cash Ledger
// pages (see metric-queries.ts).

export type DayMoney = {
  sales: number; // approved invoices (not PR giveaways)
  otherIncome: number; // Other Income + Donations receipts
  cogs: number; // goods sold or given away, at product cost price
  expenses: number; // approved expenses
  salaries: number; // payroll paid
  otherPayments: number; // other cash payments from the Cash Ledger
};

export const EMPTY_DAY: DayMoney = {
  sales: 0,
  otherIncome: 0,
  cogs: 0,
  expenses: 0,
  salaries: 0,
  otherPayments: 0,
};

// "Other Cash Inflow" only tops up the Expenses cash book, so it isn't income.
const INCOME_CATEGORIES = ["other_income", "donation_endowment"];

export const revenueOf = (d: DayMoney) => d.sales + d.otherIncome;
export const operatingCostsOf = (d: DayMoney) => d.expenses + d.salaries + d.otherPayments;
export const grossProfitOf = (d: DayMoney) => revenueOf(d) - d.cogs;
export const profitOf = (d: DayMoney) => grossProfitOf(d) - operatingCostsOf(d);

export function sumDays(
  days: Record<string, DayMoney> | undefined,
  from: string,
  to: string,
): DayMoney {
  const out = { ...EMPTY_DAY };
  Object.entries(days ?? {}).forEach(([day, d]) => {
    if (day < from || day > to) return;
    (Object.keys(out) as (keyof DayMoney)[]).forEach((k) => (out[k] += d[k]));
  });
  return out;
}

export type FinanceSummary = {
  days: Record<string, DayMoney>;
  totals: DayMoney;
  salesCount: number;
  expensesByCategory: { category: string; amount: number }[];
  otherIncomeByCategory: { category: string; amount: number }[];
};

const INCOME_LABEL: Record<string, string> = {
  other_income: "Other income",
  donation_endowment: "Donations / endowments",
};

// from/to are YYYY-MM-DD business dates, both inclusive. Sale lines don't
// store a cost, so cost of goods uses each product's current cost price.
export async function financeSummary(
  factoryId: string,
  from: string,
  to: string,
): Promise<FinanceSummary> {
  type SoldLine = {
    quantity: number;
    products: { cost_price: number } | null;
    sales: { sale_date: string };
  };
  const [sales, soldLines, cash, expenses, payroll] = await Promise.all([
    postedSalesRows(factoryId, "sale_date,grand_total", from, to),
    fetchAll<SoldLine>(
      (a, b) =>
        supabase
          .from("sale_items")
          .select("quantity,products(cost_price),sales!inner(sale_date)")
          .eq("sales.factory_id", factoryId)
          .eq("sales.status", "posted")
          .is("sales.deleted_at", null)
          .gte("sales.sale_date", from)
          .lte("sales.sale_date", to)
          .order("id")
          .range(a, b) as any,
    ),
    cashTxnRows(factoryId, from, to),
    expenseRows(factoryId, from, to),
    payrollPaidRows(factoryId, from, to),
  ]);

  const days: Record<string, DayMoney> = {};
  const at = (day: string | null | undefined) => (days[day ?? ""] ??= { ...EMPTY_DAY });
  const byCategory: Record<string, number> = {};
  const incomeBy: Record<string, number> = {};

  sales.forEach((r) => (at(r.sale_date).sales += Number(r.grand_total ?? 0)));
  soldLines.forEach(
    (r) => (at(r.sales.sale_date).cogs += Number(r.quantity) * Number(r.products?.cost_price ?? 0)),
  );
  cash.forEach((c) => {
    const amount = Number(c.amount);
    if (c.transaction_type === "receipt") {
      if (!INCOME_CATEGORIES.includes(c.category)) return;
      at(c.transaction_date).otherIncome += amount;
      const label = INCOME_LABEL[c.category] ?? c.category;
      incomeBy[label] = (incomeBy[label] ?? 0) + amount;
    } else {
      at(c.transaction_date).otherPayments += amount;
    }
  });
  expenses.forEach((e) => {
    at(e.expense_date).expenses += Number(e.amount);
    const label = e.expense_categories?.name ?? "Uncategorised";
    byCategory[label] = (byCategory[label] ?? 0) + Number(e.amount);
  });
  payroll.forEach((p) => (at(p.payment_date).salaries += Number(p.net_salary)));
  delete days[""];

  const sorted = (m: Record<string, number>) =>
    Object.entries(m)
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);

  return {
    days,
    totals: sumDays(days, from, to),
    salesCount: sales.length,
    expensesByCategory: sorted(byCategory),
    otherIncomeByCategory: sorted(incomeBy),
  };
}
