import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { RotateCcw, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { matchesSearch } from "@/lib/search";
import { purgeRecycleBin, purgeRecycleBinNow, RECYCLE_BIN_RETENTION_DAYS } from "@/lib/recycle-bin";
import { RefId } from "@/components/shared/ref-id";
import { fmtDateTime } from "@/lib/format";

type BinRow = {
  id: string;
  table_name: string;
  entity_id: string;
  entity_label: string;
  reason: string | null;
  details: Record<string, unknown>;
  deleted_by: string | null;
  deleted_at: string;
  purge_after: string;
};

const TYPE_LABELS: Record<string, string> = {
  employees: "Employee",
  employee_documents: "Employee document",
  sales_reps: "Sales rep",
  vehicles: "Vehicle",
  drivers: "Driver",
  expenses: "Expense",
  cash_transactions: "Cash transaction",
  product_units: "Packaging rule",
  suppliers: "Supplier",
  sales: "Sale",
  customers: "Customer",
  products: "Finished product",
};

function daysRemaining(purgeAfter: string): number {
  const ms = new Date(purgeAfter).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

// What went into the bin with a customer, e.g. "3 sales, 2 payments".
function customerContents(details: Record<string, unknown>): string {
  const parts: [string, string][] = [
    ["sales", "sale"],
    ["payments", "payment"],
    ["debts", "debt"],
    ["sales_returns", "sales return"],
    ["deliveries", "delivery"],
  ];
  return parts
    .map(([key, word]) => {
      const n = Number(details?.[key] ?? 0);
      if (!n) return null;
      const plural = word === "delivery" ? "deliveries" : `${word}s`;
      return `${n} ${n === 1 ? word : plural}`;
    })
    .filter(Boolean)
    .join(", ");
}

// Every approved deletion lands here (approve_delete() in
// 20260930090000_recycle_bin_and_customer_delete.sql). Admins can restore an
// entry; anything older than 30 days is purged for good.
export function RecycleBinTab() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  // What the "delete permanently" confirmation is for: one entry, or "all".
  const [wipeTarget, setWipeTarget] = useState<BinRow | "all" | null>(null);

  const purge = useMutation({
    mutationFn: purgeRecycleBin,
    onSuccess: (data) => {
      if (data.purged > 0) qc.invalidateQueries({ queryKey: ["recycle-bin"] });
    },
  });

  useEffect(() => {
    purge.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useQuery({
    queryKey: ["recycle-bin"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("recycle_bin")
        .select(
          "id,table_name,entity_id,entity_label,reason,details,deleted_by,deleted_at,purge_after",
        )
        .order("deleted_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as BinRow[];
    },
  });

  const deleterIds = [
    ...new Set((rows.data ?? []).map((r) => r.deleted_by).filter(Boolean)),
  ] as string[];
  const deleters = useQuery({
    queryKey: ["recycle-bin-deleters", deleterIds],
    enabled: deleterIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,email")
        .in("id", deleterIds);
      if (error) throw error;
      const map: Record<string, string> = {};
      for (const p of data ?? []) map[p.id] = p.full_name ?? p.email ?? p.id;
      return map;
    },
  });

  const restore = useMutation({
    mutationFn: async (row: BinRow) => {
      const { error } = await supabase.rpc(
        "restore_from_recycle_bin" as any,
        { p_id: row.id } as any,
      );
      if (error) throw error;
    },
    onSuccess: (_d, row) => {
      toast.success(`${TYPE_LABELS[row.table_name] ?? "Record"} "${row.entity_label}" restored`);
      // A restore can touch almost any list (sales, stock, customers, debts…).
      qc.invalidateQueries();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const wipe = useMutation({
    mutationFn: (target: BinRow | "all") =>
      purgeRecycleBinNow(target === "all" ? undefined : target.id),
    onSuccess: (data) => {
      if (data.skipped > 0) {
        toast.warning(
          `${data.purged} deleted permanently; ${data.skipped} couldn't be removed yet because other records still depend on them.`,
        );
      } else {
        toast.success(
          data.purged === 1 ? "Deleted permanently" : `${data.purged} items deleted permanently`,
        );
      }
      setWipeTarget(null);
      qc.invalidateQueries({ queryKey: ["recycle-bin"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const list = (rows.data ?? []).filter((r) =>
    matchesSearch(
      search,
      { label: r.entity_label, reason: r.reason, entity_id: r.entity_id, id: r.id },
      TYPE_LABELS[r.table_name] ?? r.table_name,
    ),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {rows.data?.length ?? 0} item{rows.data?.length === 1 ? "" : "s"} — each is permanently
          removed {RECYCLE_BIN_RETENTION_DAYS} days after deletion unless restored first.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="max-w-xs"
            placeholder="Search the recycle bin or #ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button
            variant="destructive"
            className="gap-2"
            disabled={(rows.data?.length ?? 0) === 0 || wipe.isPending}
            onClick={() => setWipeTarget("all")}
          >
            <Trash2 className="h-4 w-4" /> Empty recycle bin
          </Button>
        </div>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Record</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Deleted</TableHead>
                <TableHead>Removed for good in</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => {
                const remaining = daysRemaining(r.purge_after);
                const contents =
                  r.table_name === "customers"
                    ? customerContents(r.details)
                    : r.table_name === "products" && Number(r.details?.stock_written_off ?? 0) !== 0
                      ? `${Number(r.details.stock_written_off).toLocaleString()} ${String(r.details.unit ?? "")} written off (put back on restore)`
                      : "";
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <RefId id={r.entity_id} />
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{TYPE_LABELS[r.table_name] ?? r.table_name}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{r.entity_label}</div>
                      {contents && (
                        <div className="text-xs text-muted-foreground">With: {contents}</div>
                      )}
                    </TableCell>
                    <TableCell className="max-w-xs text-sm text-muted-foreground">
                      {r.reason ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {fmtDateTime(r.deleted_at)}
                      {r.deleted_by && (
                        <div className="text-muted-foreground">
                          by {deleters.data?.[r.deleted_by] ?? "…"}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={remaining <= 3 ? "destructive" : "outline"}>
                        {remaining} day{remaining === 1 ? "" : "s"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1"
                        disabled={restore.isPending}
                        onClick={() => restore.mutate(r)}
                      >
                        <RotateCcw className="h-4 w-4" /> Restore
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-destructive"
                        disabled={wipe.isPending}
                        onClick={() => setWipeTarget(r)}
                      >
                        <Trash2 className="h-4 w-4" /> Delete now
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {list.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    {rows.isLoading ? "Loading…" : "The recycle bin is empty."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AlertDialog open={!!wipeTarget} onOpenChange={(v) => !v && setWipeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {wipeTarget === "all"
                ? `Empty the recycle bin (${rows.data?.length ?? 0} items)?`
                : `Delete "${wipeTarget?.entity_label ?? ""}" permanently?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {wipeTarget === "all" ? "Everything in the recycle bin" : "This item"} is removed for
              good right now, with any attached files. It can no longer be restored.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={wipe.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={wipe.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (wipeTarget) wipe.mutate(wipeTarget);
              }}
            >
              {wipe.isPending ? "Deleting…" : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
