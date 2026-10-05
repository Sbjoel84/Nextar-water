import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions, type ModuleKey } from "@/lib/permissions";
import { Input } from "@/components/ui/input";
import { Search, Loader2 } from "lucide-react";
import { refHex, shortRef, uuidPrefix, uuidRange } from "@/lib/ref";
import { auditRecordLabel, RECORD_LABEL_KEYS } from "@/lib/audit";

type Hit = { key: string; label: string; sub: string | null; to: string; q: string };

// Where the top bar looks, and the page each hit opens (pre-filtered with ?q=).
// Typing a transaction ID (#A1B2C3D4) looks it up by id in every source
// instead, and in the audit trail — which still holds deleted records.
// `columns: []` sources are only searched by ID.
type Source = {
  group: string;
  module: ModuleKey;
  table: string;
  columns: string[];
  select: string;
  to: string;
  toHit: (r: any) => Omit<Hit, "key" | "to">;
  extra?: (q: any) => any;
};

const SOURCES: Source[] = [
  {
    group: "Customers",
    module: "customers",
    table: "customers",
    columns: ["name", "phone", "email"],
    select: "id,name,phone,email",
    to: "/customers",
    toHit: (r) => ({ label: r.name, sub: r.phone ?? r.email, q: r.name }),
  },
  {
    group: "Sales",
    module: "sales",
    table: "sales",
    columns: ["invoice_number", "customer_name", "customer_phone", "sales_person"],
    select: "id,invoice_number,customer_name,sale_date",
    to: "/sales",
    toHit: (r) => ({
      label: r.invoice_number,
      sub: [r.customer_name, r.sale_date].filter(Boolean).join(" · ") || null,
      q: r.invoice_number,
    }),
    extra: (q) => q.is("deleted_at", null),
  },
  {
    group: "Finished products",
    module: "finished-goods",
    table: "products",
    columns: ["name", "sku", "barcode"],
    select: "id,name,sku",
    to: "/finished-goods",
    toHit: (r) => ({ label: r.name, sub: r.sku, q: r.name }),
  },
  {
    group: "Raw materials",
    module: "raw-materials",
    table: "raw_materials",
    columns: ["name"],
    select: "id,name",
    to: "/raw-materials",
    toHit: (r) => ({ label: r.name, sub: null, q: r.name }),
  },
  {
    group: "Suppliers",
    module: "suppliers",
    table: "suppliers",
    columns: ["name", "contact_person", "phone", "email"],
    select: "id,name,contact_person,phone",
    to: "/suppliers",
    toHit: (r) => ({ label: r.name, sub: r.contact_person ?? r.phone, q: r.name }),
  },
  {
    group: "Employees",
    module: "employees",
    table: "employees",
    columns: ["full_name", "employee_code", "phone", "email"],
    select: "id,full_name,employee_code,phone",
    to: "/employees",
    toHit: (r) => ({ label: r.full_name, sub: r.employee_code ?? r.phone, q: r.full_name }),
  },
  {
    group: "Expenses",
    module: "expenses",
    table: "expenses",
    columns: ["description", "vendor", "receipt_number", "requested_by_name"],
    select: "id,description,vendor,receipt_number,amount",
    to: "/expenses",
    toHit: (r) => ({
      label: r.description ?? r.vendor ?? r.receipt_number ?? "Expense",
      sub: [r.vendor, r.receipt_number].filter(Boolean).join(" · ") || null,
      q: r.receipt_number ?? r.description ?? r.vendor ?? "",
    }),
  },
  {
    group: "Payments",
    module: "receipts-payments",
    table: "payments_received",
    columns: ["receipt_number", "remarks"],
    select: "id,receipt_number,payment_date,amount",
    to: "/cash-ledger/ledger",
    toHit: (r) => ({ label: r.receipt_number, sub: r.payment_date, q: r.receipt_number }),
  },
  {
    group: "Production",
    module: "production",
    table: "production",
    columns: ["production_number", "batch_number"],
    select: "id,production_number,batch_number,production_date",
    to: "/production",
    toHit: (r) => ({
      label: r.production_number ?? r.batch_number ?? "Production batch",
      sub: r.production_date,
      q: r.production_number ?? r.batch_number ?? "",
    }),
  },
  {
    group: "Production requests",
    module: "production-requests",
    table: "production_requests",
    columns: ["request_number", "po_number", "requested_by_name"],
    select: "id,request_number,po_number,request_date",
    to: "/production-requests",
    toHit: (r) => ({
      label: r.request_number ?? r.po_number ?? "Request",
      sub: r.request_date,
      q: r.request_number ?? r.po_number ?? "",
    }),
  },
  {
    group: "Purchase orders",
    module: "purchase-orders",
    table: "purchase_orders",
    columns: ["po_number"],
    select: "id,po_number,status",
    to: "/procurement",
    toHit: (r) => ({ label: r.po_number ?? "Purchase order", sub: r.status, q: r.po_number ?? "" }),
  },
  {
    group: "Goods received",
    module: "goods-receiving",
    table: "goods_receipts",
    columns: ["receipt_number", "delivery_reference"],
    select: "id,receipt_number,status",
    to: "/procurement",
    toHit: (r) => ({
      label: r.receipt_number ?? "Goods receipt",
      sub: r.status,
      q: r.receipt_number ?? "",
    }),
  },
  {
    group: "Sales returns",
    module: "sales-returns",
    table: "sales_returns",
    columns: ["return_number"],
    select: "id,return_number,status",
    to: "/sales-returns",
    toHit: (r) => ({
      label: r.return_number ?? "Sales return",
      sub: r.status,
      q: r.return_number ?? "",
    }),
  },
  {
    group: "Deliveries",
    module: "logistics",
    table: "deliveries",
    columns: ["delivery_number"],
    select: "id,delivery_number,scheduled_date",
    to: "/logistics",
    toHit: (r) => ({
      label: r.delivery_number ?? "Delivery",
      sub: r.scheduled_date,
      q: r.delivery_number ?? "",
    }),
  },
  {
    group: "Dispatches",
    module: "distribution",
    table: "stock_dispatches",
    columns: ["dispatch_number"],
    select: "id,dispatch_number,dispatch_date",
    to: "/distribution",
    toHit: (r) => ({
      label: r.dispatch_number ?? "Dispatch",
      sub: r.dispatch_date,
      q: r.dispatch_number ?? "",
    }),
  },
  {
    group: "Costing sheets",
    module: "costing",
    table: "costing_sheets",
    columns: ["sheet_number"],
    select: "id,sheet_number,status",
    to: "/costing",
    toHit: (r) => ({
      label: r.sheet_number ?? "Costing sheet",
      sub: r.status,
      q: r.sheet_number ?? "",
    }),
  },
  {
    group: "Cash transactions",
    module: "cash-flow",
    table: "cash_transactions",
    columns: ["transaction_number", "description", "related_reference"],
    select: "id,transaction_number,description,transaction_date",
    to: "/cash-ledger",
    toHit: (r) => ({
      label: r.transaction_number ?? r.description ?? "Cash transaction",
      sub: [r.description, r.transaction_date].filter(Boolean).join(" · ") || null,
      q: r.transaction_number ?? r.description ?? "",
    }),
  },
  {
    group: "Debts",
    module: "debts",
    table: "debts",
    columns: [],
    select: "id,status",
    to: "/cash-ledger/debts",
    toHit: (r) => ({ label: "Customer debt", sub: r.status, q: "" }),
  },
  {
    group: "Payroll",
    module: "payroll",
    table: "payroll",
    columns: [],
    select: "id,period_month,period_year,status",
    to: "/payroll",
    toHit: (r) => ({
      label: `Payroll ${r.period_month ?? ""}/${r.period_year ?? ""}`,
      sub: r.status,
      q: "",
    }),
  },
];

const PER_GROUP = 5;

const DELETE_ACTIONS = ["record_deleted", "delete", "approve_delete"];

// The audit trail: by ID, every logged activity on that record (or the log
// entry itself); by text, deleted records whose name matches — they're gone
// from their own pages, so this is where they can still be traced.
async function searchTrail(term: string, hex: string | null) {
  let q: any = supabase
    .from("audit_logs")
    .select("id,action,entity,entity_id,old_value,new_value,created_at")
    .order("created_at", { ascending: false });
  if (hex) {
    const [lo, hi] = uuidRange(hex);
    q = q.or(`entity_id.like.${uuidPrefix(hex)}*,and(id.gte.${lo},id.lte.${hi})`);
  } else {
    q = q
      .in("action", DELETE_ACTIONS)
      .or(RECORD_LABEL_KEYS.map((k) => `old_value->>${k}.ilike.*${term}*`).join(","));
  }
  const { data, error } = await q.limit(hex ? 20 : PER_GROUP);
  const hits: Hit[] = [];
  if (!error) {
    const seen = new Set<string>();
    for (const r of data ?? []) {
      // One hit per record — its full history is on the Audit Logs page.
      const target = r.entity_id ?? r.id;
      if (seen.has(target) || hits.length >= PER_GROUP) continue;
      seen.add(target);
      const deleted = DELETE_ACTIONS.includes(r.action);
      hits.push({
        key: `audit-${r.id}`,
        label:
          auditRecordLabel(r) ?? `${(r.entity ?? "record").replace(/_/g, " ")} ${shortRef(target)}`,
        sub: [
          deleted ? "Deleted" : r.action.replace(/_/g, " "),
          r.entity?.replace(/_/g, " "),
          new Date(r.created_at).toLocaleDateString(),
        ]
          .filter(Boolean)
          .join(" · "),
        to: "/audit-logs",
        q: hex ? `#${hex.slice(0, 8).toUpperCase()}` : shortRef(target),
      });
    }
  }
  return { group: hex ? "Activity trail" : "Deleted records (audit trail)", hits };
}

// PostgREST's or=() syntax treats , ( ) " \ specially; they can't be matched
// server-side, so drop them from the typed text.
const clean = (t: string) => t.replace(/[,()"\\%*]/g, " ").trim();

export function GlobalSearch() {
  const { data: factoryId } = useFactoryId();
  const { canView } = usePermissions();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // Search as the user types, a moment after they pause.
  useEffect(() => {
    const t = setTimeout(() => setTerm(clean(text)), 200);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const sources = SOURCES.filter((src) => canView(src.module));
  const canAudit = canView("audit-logs");

  const results = useQuery({
    queryKey: ["global-search", factoryId, term, sources.map((x) => x.table).join(), canAudit],
    enabled: !!factoryId && term.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const hex = term.includes(" ") ? null : refHex(term);
      const groups = await Promise.all(
        sources.map(async (src) => {
          if (!hex && src.columns.length === 0) return { group: src.group, hits: [] as Hit[] };
          let q: any = supabase
            .from(src.table as any)
            .select(src.select)
            .eq("factory_id", factoryId!);
          if (hex) {
            const [lo, hi] = uuidRange(hex);
            q = q.gte("id", lo).lte("id", hi);
          } else {
            q = q.or(src.columns.map((c) => `${c}.ilike.%${term}%`).join(","));
            if (src.extra) q = src.extra(q);
          }
          const { data, error } = await q.limit(PER_GROUP);
          if (error) return { group: src.group, hits: [] as Hit[] };
          return {
            group: src.group,
            hits: (data ?? []).map((r: any) => ({
              key: `${src.table}-${r.id}`,
              to: src.to,
              ...src.toHit(r),
              // An ID search opens the page filtered to exactly that record.
              ...(hex ? { q: shortRef(r.id) } : {}),
            })) as Hit[],
          };
        }),
      );
      if (canAudit) groups.push(await searchTrail(term, hex));
      return groups.filter((g) => g.hits.length > 0);
    },
  });

  const flat = (results.data ?? []).flatMap((g) => g.hits);
  useEffect(() => setActive(0), [term]);

  const go = (hit: Hit) => {
    setOpen(false);
    setText("");
    navigate({ to: hit.to as any, search: { q: hit.q } as any });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && flat[active]) {
      e.preventDefault();
      go(flat[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showPanel = open && text.trim().length > 0;
  let index = -1;

  return (
    <div ref={boxRef} className="relative w-full">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input
        placeholder="Search anything, or paste a transaction ID (#A1B2C3D4)…"
        className="pl-8 h-9"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label="Search the system"
      />
      {showPanel && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[70vh] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {(results.isFetching || term !== clean(text)) && flat.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching…
            </div>
          ) : flat.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">No matches.</div>
          ) : (
            (results.data ?? []).map((g) => (
              <div key={g.group} className="py-1">
                <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {g.group}
                </div>
                {g.hits.map((h) => {
                  index += 1;
                  const i = index;
                  return (
                    <button
                      key={h.key}
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => go(h)}
                      className={`flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left text-sm ${
                        i === active ? "bg-accent text-accent-foreground" : ""
                      }`}
                    >
                      <span className="truncate w-full">{h.label}</span>
                      {h.sub && (
                        <span className="truncate w-full text-xs text-muted-foreground">
                          {h.sub}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
