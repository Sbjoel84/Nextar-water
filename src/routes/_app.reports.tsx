import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FileDown, FileSpreadsheet, Printer, FileText, Scale } from "lucide-react";
import {
  buildStatement,
  ExecutivePrintDialog,
  STATEMENT_NOTE,
  STATEMENT_TITLES,
  type ExecutiveDoc,
} from "@/components/reports/executive-print";
import { generateReportPdf, generateStatementPdf, type StatementSection } from "@/lib/pdf";
import { dayKey } from "@/lib/metrics";
import { exportCsv, exportExcel, type ReportColumn } from "@/lib/export";
import { monthlyAccumulated, saleAmountRows } from "@/lib/sales-revenue";
import { logAudit } from "@/lib/audit";
import {
  CUSTOMER_REPORTS,
  CUSTOMER_SNAPSHOT_REPORTS,
  fetchCustomerReport,
  isCustomerReport,
  type CustomerReportKey,
} from "@/lib/customer-reports";
import {
  startOfDay,
  endOfDay,
  subDays,
  startOfWeek,
  startOfMonth,
  startOfYear,
  format,
} from "date-fns";

export const Route = createFileRoute("/_app/reports")({
  head: () => ({ meta: [{ title: "Reports — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="reports">
      <ReportsPage />
    </RequireAccess>
  ),
});

type ReportKey =
  | "executive_summary"
  | "profit_loss"
  | "sales"
  | "monthly_accumulated_sales"
  | "production"
  | "inventory"
  | "raw_materials"
  | "purchase_orders"
  | "expenses"
  | "payroll"
  | "debts"
  | "payments"
  | "customers"
  | "employees"
  | "suppliers"
  | "damage"
  | "sales_returns"
  | CustomerReportKey;

const REPORTS: { key: ReportKey; label: string }[] = [
  { key: "executive_summary", label: "Executive Summary" },
  { key: "profit_loss", label: "Profit & Loss" },
  { key: "sales", label: "Sales" },
  { key: "monthly_accumulated_sales", label: "Monthly Accumulated Sales" },
  { key: "production", label: "Production" },
  { key: "inventory", label: "Inventory (Finished Products Movements)" },
  { key: "raw_materials", label: "Raw Materials Movements" },
  { key: "purchase_orders", label: "Purchase Orders" },
  { key: "damage", label: "Damage Records" },
  { key: "sales_returns", label: "Sales Returns" },
  { key: "expenses", label: "Expenses" },
  { key: "payroll", label: "Payroll" },
  { key: "debts", label: "Debts" },
  { key: "payments", label: "Payments Received" },
  { key: "customers", label: "Customers" },
  { key: "employees", label: "Employees" },
  { key: "suppliers", label: "Suppliers" },
  ...CUSTOMER_REPORTS,
];

type RangeKey =
  "today" | "yesterday" | "daily" | "weekly" | "monthly" | "yearly" | "custom" | "all";
const RANGES: { key: RangeKey; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "daily", label: "Last 24h" },
  { key: "weekly", label: "Current Week" },
  { key: "monthly", label: "Current Month" },
  { key: "yearly", label: "This Year" },
  { key: "custom", label: "Custom Date" },
];

function rangeBounds(
  key: RangeKey,
  from: string,
  to: string,
): { start: string | null; end: string | null } {
  const now = new Date();
  if (key === "today")
    return { start: startOfDay(now).toISOString(), end: endOfDay(now).toISOString() };
  if (key === "yesterday") {
    const y = subDays(now, 1);
    return { start: startOfDay(y).toISOString(), end: endOfDay(y).toISOString() };
  }
  if (key === "daily") return { start: startOfDay(now).toISOString(), end: null };
  if (key === "weekly") return { start: startOfWeek(now).toISOString(), end: null };
  if (key === "monthly") return { start: startOfMonth(now).toISOString(), end: null };
  if (key === "yearly") return { start: startOfYear(now).toISOString(), end: null };
  if (key === "custom")
    return {
      start: from ? new Date(from).toISOString() : null,
      end: to ? new Date(to + "T23:59:59").toISOString() : null,
    };
  return { start: null, end: null };
}

type ProductionReportFilters = {
  department?: string;
  supervisor?: string;
  status?: string;
  productId?: string;
  batchNumber?: string;
};

async function fetchReport(
  key: ReportKey,
  factoryId: string,
  dateField: string,
  start: string | null,
  end: string | null,
  productionFilters?: ProductionReportFilters,
  currency = "NGN",
): Promise<{
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  sections?: StatementSection[];
}> {
  if (key === "executive_summary" || key === "profit_loss") {
    const sections = await buildStatement(
      key === "profit_loss" ? "pnl" : "executive",
      factoryId,
      start ? dayKey(new Date(start)) : "2000-01-01",
      end ? dayKey(new Date(end)) : dayKey(new Date()),
      currency,
    );
    return {
      columns: [
        { key: "section", label: "Section" },
        { key: "item", label: "Item" },
        { key: "amount", label: "Amount" },
      ],
      rows: sections.flatMap((sec) =>
        sec.lines.map((l) => ({
          section: sec.heading,
          item: l.kind === "sub" ? `   ${l.label}` : l.label,
          amount: l.value,
        })),
      ),
      sections,
    };
  }
  if (isCustomerReport(key)) return fetchCustomerReport(key, factoryId, start, end);
  if (key === "monthly_accumulated_sales") {
    // Approved, non-PR sales grouped by month of sale_date, with the running
    // total across the selected range. "All time" starts at the first sale.
    const toDay = end ? dayKey(new Date(end)) : dayKey(new Date());
    const rows = await saleAmountRows(
      factoryId,
      start ? dayKey(new Date(start)) : "2000-01-01",
      toDay,
    );
    const firstMonth = start
      ? dayKey(new Date(start)).slice(0, 7)
      : (rows[0]?.sale_date.slice(0, 7) ?? toDay.slice(0, 7));
    return {
      columns: [
        { key: "month", label: "Month" },
        { key: "sales", label: "Approved Sales" },
        { key: "revenue", label: "Sales Revenue" },
        { key: "change", label: "vs Prior Month" },
        { key: "accumulated", label: "Accumulated" },
      ],
      rows: monthlyAccumulated(rows, firstMonth, toDay.slice(0, 7)).map((m) => ({
        month: m.label,
        sales: m.salesCount,
        revenue: m.revenue.toFixed(2),
        change: m.changePct == null ? "" : `${m.changePct.toFixed(1)}%`,
        accumulated: m.accumulated.toFixed(2),
      })),
    };
  }

  const applyRange = <T,>(q: T): T => {
    let query = q as any;
    if (start) query = query.gte(dateField, start);
    if (end) query = query.lte(dateField, end);
    return query;
  };

  switch (key) {
    case "sales": {
      const { data, error } = await applyRange(
        supabase
          .from("sales")
          .select(
            "invoice_number,sale_date,customer_name,grand_total,amount_paid,balance,payment_method,sales_person",
          )
          .eq("factory_id", factoryId)
          .order("sale_date", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "invoice_number", label: "Invoice" },
          { key: "sale_date", label: "Date" },
          { key: "customer_name", label: "Customer" },
          { key: "grand_total", label: "Total" },
          { key: "amount_paid", label: "Paid" },
          { key: "balance", label: "Balance" },
          { key: "payment_method", label: "Method" },
          { key: "sales_person", label: "Sales Person" },
        ],
        rows: data ?? [],
      };
    }
    case "production": {
      let q = supabase
        .from("production")
        .select(
          "production_number,production_date,created_at,quantity_produced,unit,production_cost,supervisor,batch_number,department,status,product_id,products(name)",
        )
        .eq("factory_id", factoryId);
      if (productionFilters?.department)
        q = q.ilike("department", `%${productionFilters.department}%`) as any;
      if (productionFilters?.supervisor)
        q = q.ilike("supervisor", `%${productionFilters.supervisor}%`) as any;
      if (productionFilters?.status) q = q.eq("status", productionFilters.status) as any;
      if (productionFilters?.productId) q = q.eq("product_id", productionFilters.productId) as any;
      if (productionFilters?.batchNumber)
        q = q.ilike("batch_number", `%${productionFilters.batchNumber}%`) as any;
      const { data, error } = await applyRange(q.order("production_date", { ascending: false }));
      if (error) throw error;
      return {
        columns: [
          { key: "production_number", label: "Reference" },
          { key: "product", label: "Product" },
          { key: "quantity_produced", label: "Qty" },
          { key: "unit", label: "Unit" },
          { key: "production_date", label: "Production Date" },
          { key: "supervisor", label: "Production Manager" },
          { key: "created_at", label: "Created" },
          { key: "status", label: "Status" },
          { key: "batch_number", label: "Batch/Ref" },
          { key: "production_cost", label: "Cost" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r,
          product: r.products?.name ?? "—",
          created_at: new Date(r.created_at).toLocaleString(),
          status: String(r.status ?? "").replace(/_/g, " "),
        })),
      };
    }
    case "inventory": {
      const { data, error } = await applyRange(
        supabase
          .from("inventory_movements")
          .select("created_at,movement_type,quantity,reference,reason,products(name)")
          .eq("factory_id", factoryId)
          .order("created_at", { ascending: false })
          .limit(500),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "created_at", label: "Date" },
          { key: "product", label: "Product" },
          { key: "movement_type", label: "Type" },
          { key: "quantity", label: "Qty" },
          { key: "reference", label: "Reference" },
          { key: "reason", label: "Reason" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r,
          product: r.products?.name ?? "—",
          created_at: new Date(r.created_at).toLocaleString(),
        })),
      };
    }
    case "raw_materials": {
      const { data, error } = await applyRange(
        supabase
          .from("raw_material_movements")
          .select(
            "created_at,movement_type,quantity,unit_cost,reference,reason,raw_materials(name,unit)",
          )
          .eq("factory_id", factoryId)
          .order("created_at", { ascending: false })
          .limit(500),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "created_at", label: "Date" },
          { key: "material", label: "Material" },
          { key: "movement_type", label: "Type" },
          { key: "quantity", label: "Qty" },
          { key: "unit_cost", label: "Unit Cost" },
          { key: "reference", label: "Reference" },
          { key: "reason", label: "Reason" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r,
          material: r.raw_materials?.name ?? "—",
          created_at: new Date(r.created_at).toLocaleString(),
        })),
      };
    }
    case "purchase_orders": {
      const { data, error } = await applyRange(
        supabase
          .from("purchase_orders")
          .select(
            "po_number,issued_at,quantity_ordered,quantity_received,unit,unit_cost,status,expected_delivery_date,raw_materials(name),suppliers(name)",
          )
          .eq("factory_id", factoryId)
          .order("issued_at", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "po_number", label: "PO Number" },
          { key: "issued_at", label: "Issued" },
          { key: "material", label: "Material" },
          { key: "supplier", label: "Supplier" },
          { key: "quantity_ordered", label: "Ordered" },
          { key: "quantity_received", label: "Received" },
          { key: "unit", label: "Unit" },
          { key: "unit_cost", label: "Unit Cost" },
          { key: "status", label: "Status" },
          { key: "expected_delivery_date", label: "Expected Delivery" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r,
          material: r.raw_materials?.name ?? "—",
          supplier: r.suppliers?.name ?? "—",
          issued_at: new Date(r.issued_at).toLocaleDateString(),
        })),
      };
    }
    case "damage": {
      const { data, error } = await applyRange(
        supabase
          .from("damage_records")
          .select(
            "reference_number,source_type,source_reference,quantity,unit,reason,status,created_at,products(name),raw_materials(name)",
          )
          .eq("factory_id", factoryId)
          .order("created_at", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "reference_number", label: "Reference" },
          { key: "created_at", label: "Date" },
          { key: "source_type", label: "Source" },
          { key: "source_reference", label: "Source Ref" },
          { key: "item", label: "Item" },
          { key: "quantity", label: "Qty" },
          { key: "unit", label: "Unit" },
          { key: "reason", label: "Reason" },
          { key: "status", label: "Status" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r,
          item: r.products?.name ?? r.raw_materials?.name ?? "—",
          created_at: new Date(r.created_at).toLocaleString(),
        })),
      };
    }
    case "sales_returns": {
      const { data, error } = await applyRange(
        supabase
          .from("sales_returns")
          .select(
            "return_number,received_at,quantity_returned,unit,accepted_quantity,damaged_quantity,rejected_quantity,status,reason,products(name),customers(name),sales(invoice_number)",
          )
          .eq("factory_id", factoryId)
          .order("received_at", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "return_number", label: "Return #" },
          { key: "received_at", label: "Date" },
          { key: "product", label: "Product" },
          { key: "customer", label: "Customer" },
          { key: "invoice", label: "Invoice" },
          { key: "quantity_returned", label: "Returned" },
          { key: "accepted_quantity", label: "Accepted" },
          { key: "damaged_quantity", label: "Damaged" },
          { key: "rejected_quantity", label: "Rejected" },
          { key: "status", label: "Status" },
          { key: "reason", label: "Reason" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r,
          product: r.products?.name ?? "—",
          customer: r.customers?.name ?? "—",
          invoice: r.sales?.invoice_number ?? "—",
          received_at: new Date(r.received_at).toLocaleDateString(),
        })),
      };
    }
    case "expenses": {
      const { data, error } = await applyRange(
        supabase
          .from("expenses")
          .select(
            "expense_date,description,vendor,payment_method,amount,approved_by,expense_categories(name)",
          )
          .eq("factory_id", factoryId)
          .order("expense_date", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "expense_date", label: "Date" },
          { key: "category", label: "Category" },
          { key: "description", label: "Description" },
          { key: "vendor", label: "Vendor" },
          { key: "payment_method", label: "Method" },
          { key: "amount", label: "Amount" },
          { key: "approved_by", label: "Approved By" },
        ],
        rows: (data ?? []).map((r: any) => ({ ...r, category: r.expense_categories?.name ?? "—" })),
      };
    }
    case "payroll": {
      const { data, error } = await applyRange(
        supabase
          .from("payroll")
          .select(
            "period_month,period_year,gross_salary,net_salary,status,payment_date,employees(full_name,department)",
          )
          .eq("factory_id", factoryId)
          .order("created_at", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "employee", label: "Employee" },
          { key: "department", label: "Department" },
          { key: "period", label: "Period" },
          { key: "gross_salary", label: "Gross" },
          { key: "net_salary", label: "Net" },
          { key: "status", label: "Status" },
          { key: "payment_date", label: "Payment Date" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r,
          employee: r.employees?.full_name ?? "—",
          department: r.employees?.department ?? "—",
          period: `${r.period_month}/${r.period_year}`,
        })),
      };
    }
    case "debts": {
      const { data, error } = await applyRange(
        supabase
          .from("debts")
          .select(
            "created_at,total_amount,amount_paid,outstanding,status,customers(name),sales(invoice_number)",
          )
          .eq("factory_id", factoryId)
          .order("created_at", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "created_at", label: "Date" },
          { key: "customer", label: "Customer" },
          { key: "invoice", label: "Invoice" },
          { key: "total_amount", label: "Total" },
          { key: "amount_paid", label: "Paid" },
          { key: "outstanding", label: "Outstanding" },
          { key: "status", label: "Status" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r,
          customer: r.customers?.name ?? "—",
          invoice: r.sales?.invoice_number ?? "—",
          created_at: new Date(r.created_at).toLocaleDateString(),
        })),
      };
    }
    case "payments": {
      const { data, error } = await applyRange(
        supabase
          .from("payments_received")
          .select(
            "receipt_number,payment_date,amount,payment_method,customers(name),sales(invoice_number)",
          )
          .eq("factory_id", factoryId)
          .order("payment_date", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "receipt_number", label: "Receipt" },
          { key: "payment_date", label: "Date" },
          { key: "customer", label: "Customer" },
          { key: "invoice", label: "Invoice" },
          { key: "payment_method", label: "Method" },
          { key: "amount", label: "Amount" },
        ],
        rows: (data ?? []).map((r: any) => ({
          ...r,
          customer: r.customers?.name ?? "—",
          invoice: r.sales?.invoice_number ?? "—",
        })),
      };
    }
    case "customers": {
      const { data, error } = await applyRange(
        supabase
          .from("customers")
          .select("name,phone,email,total_purchases,outstanding_balance")
          .eq("factory_id", factoryId)
          .order("total_purchases", { ascending: false }),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "name", label: "Name" },
          { key: "phone", label: "Phone" },
          { key: "email", label: "Email" },
          { key: "total_purchases", label: "Total Purchases" },
          { key: "outstanding_balance", label: "Outstanding" },
        ],
        rows: data ?? [],
      };
    }
    case "employees": {
      const { data, error } = await applyRange(
        supabase
          .from("employees")
          .select("employee_code,full_name,department,position,basic_salary,status")
          .eq("factory_id", factoryId)
          .order("full_name"),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "employee_code", label: "ID" },
          { key: "full_name", label: "Name" },
          { key: "department", label: "Department" },
          { key: "position", label: "Position" },
          { key: "basic_salary", label: "Basic Salary" },
          { key: "status", label: "Status" },
        ],
        rows: data ?? [],
      };
    }
    case "suppliers": {
      const { data, error } = await applyRange(
        supabase
          .from("suppliers")
          .select("name,phone,materials_supplied,outstanding_balance")
          .eq("factory_id", factoryId)
          .order("name"),
      );
      if (error) throw error;
      return {
        columns: [
          { key: "name", label: "Name" },
          { key: "phone", label: "Phone" },
          { key: "materials_supplied", label: "Materials Supplied" },
          { key: "outstanding_balance", label: "Outstanding" },
        ],
        rows: data ?? [],
      };
    }
  }
}

const DATE_FIELDS: Record<ReportKey, string> = {
  // Statements use each source's own business date (see finance-summary.ts).
  executive_summary: "",
  profit_loss: "",
  sales: "sale_date",
  monthly_accumulated_sales: "sale_date",
  production: "production_date",
  inventory: "created_at",
  raw_materials: "created_at",
  purchase_orders: "issued_at",
  damage: "created_at",
  sales_returns: "received_at",
  expenses: "expense_date",
  payroll: "created_at",
  debts: "created_at",
  payments: "payment_date",
  customers: "created_at",
  employees: "created_at",
  suppliers: "created_at",
  // Customer-account reports read the ledger's created_at (or submitted_at).
  customer_balances: "created_at",
  customer_credit: "created_at",
  customer_debt: "created_at",
  advance_payments: "created_at",
  advance_consumption: "created_at",
  customer_ledger: "created_at",
  customer_adjustments: "submitted_at",
};

function ReportsPage() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);
  const [reportKey, setReportKey] = useState<ReportKey>("sales");
  const [range, setRange] = useState<RangeKey>("monthly");
  const [customFrom, setCustomFrom] = useState(format(new Date(), "yyyy-MM-01"));
  const [customTo, setCustomTo] = useState(format(new Date(), "yyyy-MM-dd"));
  const [prodDepartment, setProdDepartment] = useState("");
  const [prodUser, setProdUser] = useState("");
  const [prodStatus, setProdStatus] = useState("all");
  const [prodProduct, setProdProduct] = useState("all");
  const [prodBatch, setProdBatch] = useState("");
  const [execDoc, setExecDoc] = useState<ExecutiveDoc | null>(null);

  const bounds = useMemo(
    () => rangeBounds(range, customFrom, customTo),
    [range, customFrom, customTo],
  );
  const productionFilters: ProductionReportFilters = useMemo(
    () => ({
      department: prodDepartment || undefined,
      supervisor: prodUser || undefined,
      status: prodStatus === "all" ? undefined : prodStatus,
      productId: prodProduct === "all" ? undefined : prodProduct,
      batchNumber: prodBatch || undefined,
    }),
    [prodDepartment, prodUser, prodStatus, prodProduct, prodBatch],
  );

  const productsForFilter = useQuery({
    queryKey: ["report-products", factoryId],
    enabled: !!factoryId && reportKey === "production",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name")
        .eq("factory_id", factoryId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });
  const report = useQuery({
    queryKey: [
      "report",
      reportKey,
      factoryId,
      bounds.start,
      bounds.end,
      reportKey === "production" ? productionFilters : null,
    ],
    enabled: !!factoryId,
    queryFn: () =>
      fetchReport(
        reportKey,
        factoryId!,
        DATE_FIELDS[reportKey],
        bounds.start,
        bounds.end,
        reportKey === "production" ? productionFilters : undefined,
        settings.data?.currency ?? "NGN",
      ),
  });

  const isSnapshot = (CUSTOMER_SNAPSHOT_REPORTS as string[]).includes(reportKey);
  const reportLabel = REPORTS.find((r) => r.key === reportKey)?.label ?? "Report";
  const columns = report.data?.columns ?? [];
  const rows = report.data?.rows ?? [];

  const periodLabel =
    range === "custom"
      ? `${customFrom} to ${customTo}`
      : (RANGES.find((r) => r.key === range)?.label ?? "");

  const doExport = (type: "csv" | "excel" | "pdf" | "print") => {
    if (columns.length === 0) return;
    const name = `${reportLabel}-${format(new Date(), "yyyy-MM-dd")}`;
    if (type === "csv") exportCsv(name, columns, rows);
    else if (type === "excel") exportExcel(name, columns, rows);
    else if ((type === "pdf" || type === "print") && report.data?.sections)
      generateStatementPdf(
        {
          title: STATEMENT_TITLES[reportKey === "profit_loss" ? "pnl" : "executive"],
          period: periodLabel,
          company: { name: settings.data?.company_name, logo_url: settings.data?.logo_url },
          sections: report.data.sections,
          note: STATEMENT_NOTE,
        },
        type === "pdf" ? "download" : "print",
      );
    else if (type === "pdf")
      generateReportPdf(reportLabel, columns, rows, "download", {
        name: settings.data?.company_name,
        logo_url: settings.data?.logo_url,
      });
    else
      generateReportPdf(reportLabel, columns, rows, "print", {
        name: settings.data?.company_name,
        logo_url: settings.data?.logo_url,
      });
    logAudit({
      action: type === "print" ? "print" : "export",
      entity: "report",
      factoryId,
      newValue: { report: reportLabel, format: type, rows: rows.length },
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Cross-module reports with Excel, PDF, and CSV export.
        </p>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="mr-auto">
            <div className="text-sm font-medium">Print for management</div>
            <p className="text-xs text-muted-foreground">
              One-page summaries across all reports — today, this week, this month, this year or
              custom dates.
            </p>
          </div>
          <Button className="gap-2" onClick={() => setExecDoc("executive")}>
            <Printer className="h-4 w-4" /> Executive Summary
          </Button>
          <Button variant="outline" className="gap-2" onClick={() => setExecDoc("pnl")}>
            <Scale className="h-4 w-4" /> Profit &amp; Loss
          </Button>
        </CardContent>
      </Card>
      <ExecutivePrintDialog doc={execDoc} factoryId={factoryId} onClose={() => setExecDoc(null)} />

      <Card className="rounded-2xl">
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div>
            <Label className="mb-1 block text-xs">Report</Label>
            <Select value={reportKey} onValueChange={(v) => setReportKey(v as ReportKey)}>
              <SelectTrigger className="w-[260px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPORTS.map((r) => (
                  <SelectItem key={r.key} value={r.key}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {isSnapshot ? (
            <p className="max-w-[240px] pb-2 text-xs text-muted-foreground">
              Current balances as of now — a date range doesn't apply.
            </p>
          ) : (
            <div>
              <Label className="mb-1 block text-xs">Range</Label>
              <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RANGES.map((r) => (
                    <SelectItem key={r.key} value={r.key}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {!isSnapshot && range === "custom" && (
            <>
              <div>
                <Label className="mb-1 block text-xs">From</Label>
                <Input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
              </div>
              <div>
                <Label className="mb-1 block text-xs">To</Label>
                <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
              </div>
            </>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="gap-2" onClick={() => doExport("csv")}>
              <FileDown className="h-4 w-4" /> CSV
            </Button>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => doExport("excel")}>
              <FileSpreadsheet className="h-4 w-4" /> Excel
            </Button>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => doExport("pdf")}>
              <FileText className="h-4 w-4" /> PDF
            </Button>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => doExport("print")}>
              <Printer className="h-4 w-4" /> Print
            </Button>
          </div>
        </CardContent>
        {reportKey === "production" && (
          <CardContent className="p-4 pt-0 flex flex-wrap items-end gap-3 border-t">
            <div>
              <Label className="mb-1 block text-xs">Product</Label>
              <Select value={prodProduct} onValueChange={setProdProduct}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All products</SelectItem>
                  {(productsForFilter.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1 block text-xs">Status</Label>
              <Select value={prodStatus} onValueChange={setProdStatus}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="pending_confirmation">Pending confirmation</SelectItem>
                  <SelectItem value="confirmed">Confirmed</SelectItem>
                  <SelectItem value="posted">Posted</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1 block text-xs">Department</Label>
              <Input
                className="w-[140px]"
                value={prodDepartment}
                onChange={(e) => setProdDepartment(e.target.value)}
                placeholder="Any"
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs">User</Label>
              <Input
                className="w-[140px]"
                value={prodUser}
                onChange={(e) => setProdUser(e.target.value)}
                placeholder="Supervisor name"
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs">Batch</Label>
              <Input
                className="w-[140px]"
                value={prodBatch}
                onChange={(e) => setProdBatch(e.target.value)}
                placeholder="Any"
              />
            </div>
          </CardContent>
        )}
      </Card>

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>
            {reportLabel} ({rows.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHead key={c.key}>{c.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  {columns.map((c) => (
                    <TableCell key={c.key}>{String(r[c.key] ?? "—")}</TableCell>
                  ))}
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={columns.length || 1}
                    className="text-center text-muted-foreground py-8"
                  >
                    No data for this range.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
