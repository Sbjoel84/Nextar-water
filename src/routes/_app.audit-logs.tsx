import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { RequireAccess } from "@/components/layout/require-access";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Search, Eye, ScrollText, History, X } from "lucide-react";
import { matchesSearch, useSearchQuery } from "@/lib/search";
import { refHex, uuidPrefix, uuidRange } from "@/lib/ref";
import { auditRecordLabel, RECORD_LABEL_KEYS } from "@/lib/audit";
import { RefId } from "@/components/shared/ref-id";
import { fmtDateTime } from "@/lib/format";
import { DateInput } from "@/components/shared/date-input";

// Everything that touches a customer's advance / debt account. The quick
// filter below narrows the trail to exactly these, server-side, so it isn't
// limited to whatever happens to be in the latest page of general activity.
const CUSTOMER_ACCOUNT_ACTIONS = [
  "record_customer_advance",
  "record_payment",
  "approve_sale",
  "approve_delete",
  "reverse_payment",
  "post_debt_writeoff",
  "reverse_debt_writeoff",
  "request_customer_adjustment",
  "approve_customer_adjustment",
  "reject_customer_adjustment",
  "cancel_customer_adjustment",
  "customer_advance_restored",
  "customer_ledger_reversal",
  "customer_ledger_opening_balances",
];

const ACTION_LABEL: Record<string, string> = {
  record_customer_advance: "Advance payment recorded",
  record_payment: "Customer payment recorded",
  approve_sale: "Sale approved",
  approve_delete: "Deletion approved",
  reverse_payment: "Payment reversed",
  post_debt_writeoff: "Debt written off",
  reverse_debt_writeoff: "Write-off reversed",
  request_customer_adjustment: "Adjustment requested",
  approve_customer_adjustment: "Adjustment approved",
  reject_customer_adjustment: "Adjustment rejected",
  cancel_customer_adjustment: "Adjustment cancelled",
  customer_advance_restored: "Advance restored (sale reversed)",
  customer_ledger_reversal: "Account entry reversed",
  customer_ledger_opening_balances: "Opening balances seeded",
  record_created: "Created",
  record_updated: "Updated",
  record_deleted: "Deleted",
};
const actionLabel = (a: string) => ACTION_LABEL[a] ?? a.replace(/_/g, " ");

export const Route = createFileRoute("/_app/audit-logs")({
  head: () => ({ meta: [{ title: "Audit Logs — FMIS" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <RequireAccess module="audit-logs">
      <AuditLogsPage />
    </RequireAccess>
  ),
});

type LogRow = {
  id: string;
  user_id: string | null;
  factory_id: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  old_value: unknown;
  new_value: unknown;
  ip_address: string | null;
  created_at: string;
};

const actionTone: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  create: "secondary",
  update: "outline",
  delete: "destructive",
  login: "secondary",
  logout: "outline",
  payment: "secondary",
  production: "secondary",
  sale: "secondary",
  print: "outline",
  export: "outline",
  record_created: "secondary",
  record_updated: "outline",
  record_deleted: "destructive",
};

// PostgREST or=() treats these specially; they can't be matched server-side.
const cleanTerm = (t: string) => t.replace(/[,()"\\%*]/g, " ").trim();

export function AuditLogsPage() {
  const [q, setQ] = useSearchQuery();
  const [actionFilter, setActionFilter] = useState("all");
  const [detail, setDetail] = useState<LogRow | null>(null);
  const [historyFor, setHistoryFor] = useState<LogRow | null>(null);
  const [scope, setScope] = useState<"all" | "customers">("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // The search also runs server-side (a moment after typing stops), so an ID
  // or a deleted record's name is found however old it is — not just within
  // the latest 500 entries.
  const [serverQ, setServerQ] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setServerQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Audit rows point at a customer by id; show the name instead.
  const customerNames = useQuery({
    queryKey: ["audit-customer-names"],
    queryFn: async () => {
      const { data, error } = await supabase.from("customers").select("id,name");
      if (error) throw error;
      const map: Record<string, string> = {};
      (data ?? []).forEach((c) => {
        map[c.id] = c.name;
      });
      return map;
    },
  });

  const profiles = useQuery({
    queryKey: ["profiles-map"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id,full_name,email");
      if (error) throw error;
      const map: Record<string, string> = {};
      (data ?? []).forEach((p) => {
        map[p.id] = p.full_name || p.email || p.id;
      });
      return map;
    },
  });

  const factories = useQuery({
    queryKey: ["factories-name-map"],
    queryFn: async () => {
      const { data, error } = await supabase.from("factories").select("id,name");
      if (error) throw error;
      const map: Record<string, string> = {};
      (data ?? []).forEach((f) => {
        map[f.id] = f.name;
      });
      return map;
    },
  });

  const logs = useQuery({
    queryKey: ["audit-logs", scope, from, to, serverQ, !!profiles.data, !!customerNames.data],
    queryFn: async () => {
      let query = supabase
        .from("audit_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      // Each entry is one or=() group; several are ANDed in a single filter.
      const groups: string[] = [];
      const words = serverQ.split(/\s+/).filter(Boolean);
      const hex = words.length === 1 ? refHex(words[0]) : null;
      if (hex) {
        // A record ID → that record's whole trail; an audit entry's own ID → that entry.
        const [lo, hi] = uuidRange(hex);
        groups.push(`entity_id.like.${uuidPrefix(hex)}*,and(id.gte.${lo},id.lte.${hi})`);
      } else if (words.length > 0) {
        // Narrow server-side by the longest word; the rest is matched below.
        const w = cleanTerm(words.reduce((a, b) => (b.length > a.length ? b : a)));
        if (w) {
          const lw = w.toLowerCase();
          const idsNamed = (map: Record<string, string> | undefined) =>
            Object.entries(map ?? {})
              .filter(([, n]) => n?.toLowerCase().includes(lw))
              .map(([id]) => id)
              .slice(0, 50);
          const userIds = idsNamed(profiles.data);
          const customerIds = idsNamed(customerNames.data);
          const labelled = Object.keys(ACTION_LABEL).filter((a) =>
            ACTION_LABEL[a].toLowerCase().includes(lw),
          );
          groups.push(
            [
              `action.ilike.*${w}*`,
              `entity.ilike.*${w}*`,
              `entity_id.ilike.*${w}*`,
              ...RECORD_LABEL_KEYS.flatMap((k) => [
                `old_value->>${k}.ilike.*${w}*`,
                `new_value->>${k}.ilike.*${w}*`,
              ]),
              ...(labelled.length ? [`action.in.(${labelled.join(",")})`] : []),
              ...(userIds.length ? [`user_id.in.(${userIds.join(",")})`] : []),
              ...(customerIds.length ? [`entity_id.in.(${customerIds.join(",")})`] : []),
            ].join(","),
          );
        }
      }
      if (scope === "customers") {
        groups.push(
          `action.in.(${CUSTOMER_ACCOUNT_ACTIONS.join(",")}),entity.eq.customer_statement`,
        );
      }
      if (groups.length === 1) query = query.or(groups[0]);
      else if (groups.length > 1)
        query = query.or(`and(${groups.map((g) => `or(${g})`).join(",")})`);
      if (from) query = query.gte("created_at", new Date(`${from}T00:00:00`).toISOString());
      if (to) query = query.lte("created_at", new Date(`${to}T23:59:59`).toISOString());
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as LogRow[];
    },
  });

  const actions = useMemo(
    () => Array.from(new Set((logs.data ?? []).map((l) => l.action))).sort(),
    [logs.data],
  );

  const filtered = useMemo(() => {
    let rows = logs.data ?? [];
    if (actionFilter !== "all") rows = rows.filter((r) => r.action === actionFilter);
    if (q.trim()) {
      rows = rows.filter((r) =>
        matchesSearch(
          q,
          r,
          r.entity_id,
          customerNames.data?.[r.entity_id ?? ""],
          actionLabel(r.action),
          auditRecordLabel(r),
          profiles.data?.[r.user_id ?? ""],
          factories.data?.[r.factory_id ?? ""],
        ),
      );
    }
    return rows;
  }, [logs.data, actionFilter, q, profiles.data, customerNames.data, factories.data]);

  const tracing = q.trim().split(/\s+/).length === 1 ? refHex(q.trim()) : null;
  const recordName = (l: LogRow) => customerNames.data?.[l.entity_id ?? ""] ?? auditRecordLabel(l);
  const userName = (id: string | null) =>
    id ? (profiles.data?.[id] ?? "Unknown user") : "System / anonymous";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit Logs</h1>
        <p className="text-sm text-muted-foreground">
          System-wide trail of every activity: who, when, from where, and what changed. Every record
          has a transaction ID — paste one (or a deleted record's name) in the search to trace its
          full history, even after it's been deleted.
        </p>
      </div>

      {tracing && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/40 px-4 py-2 text-sm">
          <History className="h-4 w-4" />
          Tracing ID{" "}
          <span className="font-mono font-medium">#{tracing.slice(0, 8).toUpperCase()}</span>—{" "}
          {filtered.length} entr{filtered.length === 1 ? "y" : "ies"}, oldest last.
          <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={() => setQ("")}>
            <X className="mr-1 h-3.5 w-3.5" /> Clear
          </Button>
        </div>
      )}

      <Card className="rounded-2xl">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="h-4 w-4" /> Activity ({filtered.length})
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={scope} onValueChange={(v) => setScope(v as "all" | "customers")}>
              <SelectTrigger className="h-9 w-[190px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All activity</SelectItem>
                <SelectItem value="customers">Customer accounts only</SelectItem>
              </SelectContent>
            </Select>
            <DateInput
              className="h-9 w-[150px]"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="From date"
            />
            <DateInput
              className="h-9 w-[150px]"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              aria-label="To date"
            />
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search name, user or #ID…"
                className="pl-8 h-9 w-60"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger className="h-9 w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actions</SelectItem>
                {actions.map((a) => (
                  <SelectItem key={a} value={a} className="capitalize">
                    {actionLabel(a)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Factory</TableHead>
                <TableHead>IP</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <RefId id={l.id} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {fmtDateTime(l.created_at)}
                  </TableCell>
                  <TableCell>
                    {l.user_id ? (
                      (profiles.data?.[l.user_id] ?? "—")
                    ) : (
                      <span className="text-muted-foreground">Anonymous</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={actionTone[l.action] ?? "outline"} className="capitalize">
                      {actionLabel(l.action)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="capitalize">
                      {(l.entity ?? "—").replace(/_/g, " ")}
                      {recordName(l) ? (
                        <span className="normal-case"> · {recordName(l)}</span>
                      ) : null}
                    </div>
                    {l.entity_id && (
                      <div className="flex items-center gap-1">
                        <RefId id={l.entity_id} className="px-0" />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 px-1 text-[11px]"
                          title="Show everything that happened to this record"
                          onClick={() => setHistoryFor(l)}
                        >
                          <History className="mr-0.5 h-3 w-3" /> History
                        </Button>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {l.factory_id ? (factories.data?.[l.factory_id] ?? "—") : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {l.ip_address ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="View full details"
                      onClick={() => setDetail(l)}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    {logs.isLoading
                      ? "Loading…"
                      : q.trim()
                        ? "No activity matches this search."
                        : "No activity recorded yet."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        {detail && (
          <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="capitalize">
                {actionLabel(detail.action)} — {(detail.entity ?? "record").replace(/_/g, " ")}
                {recordName(detail) ? (
                  <span className="normal-case"> · {recordName(detail)}</span>
                ) : null}
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>
                Entry ID <RefId id={detail.id} />
              </span>
              {detail.entity_id && (
                <span>
                  Record ID <RefId id={detail.entity_id} />
                </span>
              )}
              <span>{fmtDateTime(detail.created_at)}</span>
              <span>By {userName(detail.user_id)}</span>
              {detail.ip_address && <span>IP {detail.ip_address}</span>}
            </div>
            <ChangeDetails log={detail} />
            {detail.entity_id && (
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setHistoryFor(detail);
                    setDetail(null);
                  }}
                >
                  <History className="mr-1 h-3.5 w-3.5" /> Full history of this record
                </Button>
              </div>
            )}
          </DialogContent>
        )}
      </Dialog>

      <RecordHistoryDialog
        target={historyFor}
        onClose={() => setHistoryFor(null)}
        userName={userName}
        title={recordName}
      />
    </div>
  );
}

// ---------------------------------------------------------------- details ---

const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UUID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fieldLabel = (k: string) =>
  k
    .replace(/_id$/, "")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());

function FieldValue({ value }: { value: unknown }) {
  if (value === undefined) return <span className="text-muted-foreground/60">—</span>;
  if (value === null || value === "") return <span className="text-muted-foreground">empty</span>;
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (typeof value === "string") {
    if (UUID_VALUE_RE.test(value)) return <RefId id={value} className="px-0" />;
    if (ISO_TS_RE.test(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return <>{fmtDateTime(d)}</>;
    }
    return <span className="whitespace-pre-wrap break-words">{value}</span>;
  }
  if (typeof value === "number") return <>{value.toLocaleString()}</>;
  return (
    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Field-by-field view of an audit entry: every field of the record with its
 * value before and after, changed fields highlighted and listed first. A
 * "record_updated" entry's new_value holds only the changed fields, so the
 * unchanged ones are carried over from old_value.
 */
function ChangeDetails({ log, changedOnly = false }: { log: LogRow; changedOnly?: boolean }) {
  const [showAll, setShowAll] = useState(!changedOnly);
  const oldObj = asObject(log.old_value);
  const newObj = asObject(log.new_value);

  // Not key/value data (e.g. a plain string or a list) — show it as-is.
  if ((log.old_value != null && !oldObj) || (log.new_value != null && !newObj)) {
    return (
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Before</div>
          <FieldValue value={log.old_value ?? undefined} />
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">After</div>
          <FieldValue value={log.new_value ?? undefined} />
        </div>
      </div>
    );
  }
  if (!oldObj && !newObj) {
    return (
      <p className="text-sm text-muted-foreground">
        No field details were recorded for this entry.
      </p>
    );
  }

  const isDiff = log.action === "record_updated";
  const keys = Array.from(new Set([...Object.keys(oldObj ?? {}), ...Object.keys(newObj ?? {})]));
  const rows = keys.map((k) => {
    const before = oldObj && k in oldObj ? oldObj[k] : undefined;
    const after = newObj && k in newObj ? newObj[k] : isDiff ? before : undefined;
    const changed = !!oldObj && !!newObj && JSON.stringify(before) !== JSON.stringify(after);
    return { k, before, after, changed };
  });
  rows.sort((a, b) => Number(b.changed) - Number(a.changed));
  const changedCount = rows.filter((r) => r.changed).length;
  const twoCols = !!oldObj && !!newObj;
  const shown = showAll || !twoCols ? rows : rows.filter((r) => r.changed);

  return (
    <div className="space-y-2">
      <div className="max-h-[50vh] overflow-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 font-medium">Field</th>
              {twoCols ? (
                <>
                  <th className="px-2 py-1.5 font-medium">Before</th>
                  <th className="px-2 py-1.5 font-medium">After</th>
                </>
              ) : (
                <th className="px-2 py-1.5 font-medium">
                  {oldObj ? "Value (when deleted)" : "Value"}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.k} className={`border-t align-top ${r.changed ? "bg-amber-500/10" : ""}`}>
                <td className="whitespace-nowrap px-2 py-1.5 font-medium">{fieldLabel(r.k)}</td>
                {twoCols ? (
                  <>
                    <td className={`px-2 py-1.5 ${r.changed ? "text-destructive" : ""}`}>
                      <FieldValue value={r.before} />
                    </td>
                    <td className={`px-2 py-1.5 ${r.changed ? "font-medium" : ""}`}>
                      <FieldValue value={r.after} />
                    </td>
                  </>
                ) : (
                  <td className="px-2 py-1.5">
                    <FieldValue value={oldObj ? r.before : r.after} />
                  </td>
                )}
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={3} className="px-2 py-3 text-center text-muted-foreground">
                  No field values changed.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {twoCols && rows.length > changedCount && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll
            ? `Show only the ${changedCount} changed field${changedCount === 1 ? "" : "s"}`
            : `Show all ${rows.length} fields`}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- history ---

const DELETE_ACTIONS = ["record_deleted", "delete", "approve_delete"];

/**
 * Everything that ever happened to one record, oldest first — each step with
 * who, when and exactly what changed. Works for deleted records too: their
 * trail, including the full row at deletion, stays in audit_logs.
 */
function RecordHistoryDialog({
  target,
  onClose,
  userName,
  title,
}: {
  target: LogRow | null;
  onClose: () => void;
  userName: (id: string | null) => string;
  title: (l: LogRow) => string | null;
}) {
  const entityId = target?.entity_id ?? null;
  const history = useQuery({
    queryKey: ["audit-record-history", entityId],
    enabled: !!entityId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_logs")
        .select("*")
        .eq("entity_id", entityId!)
        .order("created_at", { ascending: true })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as LogRow[];
    },
  });
  const entries = history.data ?? [];
  const name =
    entries
      .slice()
      .reverse()
      .map((e) => title(e))
      .find(Boolean) ?? (target ? title(target) : null);
  const deleted = entries.some((e) => DELETE_ACTIONS.includes(e.action));

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      {target && (
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <History className="h-4 w-4" />
              <span className="capitalize">{(target.entity ?? "record").replace(/_/g, " ")}</span>
              {name && <span>· {name}</span>}
              {deleted && <Badge variant="destructive">Deleted</Badge>}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Record ID <RefId id={entityId} />
            </span>
            <span>
              {history.isLoading
                ? "Loading history…"
                : `${entries.length} entr${entries.length === 1 ? "y" : "ies"}, oldest first`}
            </span>
          </div>
          {history.isError && (
            <p className="text-sm text-destructive">
              Couldn&apos;t load this record&apos;s history: {(history.error as Error).message}
            </p>
          )}
          <ol className="relative ml-1 space-y-5 border-l pl-5">
            {entries.map((e) => (
              <li key={e.id} className="relative">
                <span className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary" />
                <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={actionTone[e.action] ?? "outline"} className="capitalize">
                    {actionLabel(e.action)}
                  </Badge>
                  <span className="font-medium">{userName(e.user_id)}</span>
                  <span className="text-xs text-muted-foreground">{fmtDateTime(e.created_at)}</span>
                  {e.ip_address && (
                    <span className="text-xs text-muted-foreground">· {e.ip_address}</span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    Entry <RefId id={e.id} />
                  </span>
                </div>
                <ChangeDetails log={e} changedOnly={e.action === "record_updated"} />
              </li>
            ))}
          </ol>
        </DialogContent>
      )}
    </Dialog>
  );
}
