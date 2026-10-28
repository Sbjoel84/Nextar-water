import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { logAudit } from "@/lib/audit";
import { money, num } from "@/lib/format";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Eye, Plus, Trash2, Undo2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateInput } from "@/components/shared/date-input";

type Supplied = {
  sale_id: string;
  invoice_number: string;
  product_id: string;
  product_name: string;
  unit: string | null;
  quantity: number;
  unit_price: number;
  created_at: string;
};
type Returned = {
  id: string;
  return_number: string;
  product_id: string;
  product_name: string;
  unit: string | null;
  quantity: number;
  accepted: number | null;
  damaged: number;
  rejected: number;
  status: string;
  received_at: string;
};
type RepDay = {
  sales_rep_id: string;
  customer_id: string;
  name: string;
  phone: string | null;
  status: string;
  supplied: Supplied[];
  pending_orders: number;
  returned: Returned[];
};

// Per product: what the rep took out today (posted sales), what has come
// back (logged returns, any status but cancelled), and what is still out.
type ProductLine = {
  product_id: string;
  name: string;
  unit: string;
  supplied: number;
  value: number;
  returned: number;
  outstanding: number;
  // Latest supply sale for the product — the return is logged against it so
  // inspection credits the rep at the price they were charged.
  sale_id: string;
};

function productLines(rep: RepDay): ProductLine[] {
  const map = new Map<string, ProductLine>();
  const lineFor = (id: string, name: string, unit: string | null) => {
    let l = map.get(id);
    if (!l) {
      l = {
        product_id: id,
        name,
        unit: unit ?? "",
        supplied: 0,
        value: 0,
        returned: 0,
        outstanding: 0,
        sale_id: "",
      };
      map.set(id, l);
    }
    return l;
  };
  for (const s of rep.supplied) {
    const l = lineFor(s.product_id, s.product_name, s.unit);
    l.supplied += Number(s.quantity);
    l.value += Number(s.quantity) * Number(s.unit_price);
    l.sale_id = s.sale_id;
  }
  for (const r of rep.returned) {
    lineFor(r.product_id, r.product_name, r.unit).returned += Number(r.quantity);
  }
  for (const l of map.values()) l.outstanding = Math.max(l.supplied - l.returned, 0);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const returnStatusLabel = (s: string) =>
  s === "received" ? "Awaiting inspection" : s === "completed" ? "Inspected" : s;

// Store page: the day's sales-rep activity. Sales supplies a rep (a sale,
// confirmed by the accountant); at close of business the store logs what the
// rep brings back. Each return goes through the normal sales-return
// inspection, which puts accepted stock back and credits the rep's account.
export function RepActivityCard({ factoryId }: { factoryId: string }) {
  const { canSubmit } = usePermissions();
  const canLogReturn = canSubmit("sales-returns");
  const [day, setDay] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [detail, setDetail] = useState<RepDay | null>(null);
  const [returnTarget, setReturnTarget] = useState<RepDay | null>(null);

  useRealtimeInvalidate(["sales", "sales_returns", "sales_reps"], [["store-rep-activity"]]);

  const activity = useQuery({
    queryKey: ["store-rep-activity", factoryId, day],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("store_rep_activity", {
        p_factory_id: factoryId,
        p_date: day,
      });
      if (error) throw error;
      return (data ?? []) as unknown as RepDay[];
    },
  });

  // Reps with something happening that day; the rest are noise here.
  const reps = (activity.data ?? []).filter(
    (r) => r.supplied.length > 0 || r.returned.length > 0 || r.pending_orders > 0,
  );

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>Sales-Rep Activity</CardTitle>
          <p className="text-sm text-muted-foreground">
            Products supplied to sales-reps and what they bring back at close of business.
          </p>
        </div>
        <DateInput
          className="h-9 w-auto"
          value={day}
          onChange={(e) => e.target.value && setDay(e.target.value)}
        />
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sales-Rep</TableHead>
              <TableHead className="text-right">Supplied</TableHead>
              <TableHead className="text-right">Value</TableHead>
              <TableHead className="text-right">Returned</TableHead>
              <TableHead className="text-right">Still with rep</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {activity.isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : activity.isError ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-destructive">
                  {(activity.error as Error).message}
                </TableCell>
              </TableRow>
            ) : reps.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                  No sales-rep supplies or returns on this day.
                </TableCell>
              </TableRow>
            ) : (
              reps.map((r) => {
                const lines = productLines(r);
                const supplied = lines.reduce((s, l) => s + l.supplied, 0);
                const value = lines.reduce((s, l) => s + l.value, 0);
                const returned = lines.reduce((s, l) => s + l.returned, 0);
                const outstanding = lines.reduce((s, l) => s + l.outstanding, 0);
                const awaiting = r.returned.filter((x) => x.status === "received").length;
                return (
                  <TableRow key={r.sales_rep_id}>
                    <TableCell>
                      <div className="font-medium">{r.name}</div>
                      <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                        {r.phone}
                        {r.pending_orders > 0 && (
                          <Badge variant="outline">
                            {r.pending_orders} order{r.pending_orders === 1 ? "" : "s"} awaiting
                            accountant
                          </Badge>
                        )}
                        {awaiting > 0 && (
                          <Badge variant="outline" className="text-warning">
                            {awaiting} return{awaiting === 1 ? "" : "s"} awaiting inspection
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{num(supplied)}</TableCell>
                    <TableCell className="text-right">{money(value)}</TableCell>
                    <TableCell className="text-right">{num(returned)}</TableCell>
                    <TableCell className="text-right font-medium">
                      <span className={outstanding > 0 ? "text-warning" : ""}>
                        {num(outstanding)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="View activity"
                          onClick={() => setDetail(r)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {canLogReturn && outstanding > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1"
                            onClick={() => setReturnTarget(r)}
                          >
                            <Undo2 className="h-4 w-4" /> Log Return
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        <p className="mt-3 text-xs text-muted-foreground">
          Supplied counts orders the accountant has confirmed. Logged returns are inspected under{" "}
          <Link to="/sales-returns" className="text-primary hover:underline">
            Sales Returns
          </Link>{" "}
          — accepted products go back into stock and the rep's account is credited.
        </p>
      </CardContent>

      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        {detail && <RepDayDialog rep={detail} day={day} />}
      </Dialog>
      <Dialog open={!!returnTarget} onOpenChange={(v) => !v && setReturnTarget(null)}>
        {returnTarget && (
          <LogRepReturnDialog
            factoryId={factoryId}
            rep={returnTarget}
            onDone={() => setReturnTarget(null)}
          />
        )}
      </Dialog>
    </Card>
  );
}

function RepDayDialog({ rep, day }: { rep: RepDay; day: string }) {
  const lines = productLines(rep);
  return (
    <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>
          {rep.name} · {day}
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Supplied</TableHead>
              <TableHead className="text-right">Returned</TableHead>
              <TableHead className="text-right">Still with rep</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => (
              <TableRow key={l.product_id}>
                <TableCell>{l.name}</TableCell>
                <TableCell className="text-right">
                  {num(l.supplied)} {l.unit}
                </TableCell>
                <TableCell className="text-right">
                  {num(l.returned)} {l.unit}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {num(l.outstanding)} {l.unit}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Supplies (invoices)
          </div>
          {rep.supplied.length === 0 ? (
            <p className="text-sm text-muted-foreground">None confirmed yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {rep.supplied.map((s, i) => (
                <li key={i} className="flex justify-between gap-2 py-1.5">
                  <span>
                    <span className="font-mono text-xs">{s.invoice_number}</span> · {s.product_name}
                  </span>
                  <span className="whitespace-nowrap">
                    {num(Number(s.quantity))} {s.unit} ·{" "}
                    {new Date(s.created_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Returns
          </div>
          {rep.returned.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing returned yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {rep.returned.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 py-1.5">
                  <span>
                    <span className="font-mono text-xs">{r.return_number}</span> · {r.product_name}{" "}
                    · {num(Number(r.quantity))} {r.unit}
                    {r.status === "completed" && (
                      <span className="text-xs text-muted-foreground">
                        {" "}
                        (accepted {num(Number(r.accepted ?? 0))}, damaged {num(Number(r.damaged))},
                        rejected {num(Number(r.rejected))})
                      </span>
                    )}
                  </span>
                  <Badge variant={r.status === "completed" ? "secondary" : "outline"}>
                    {returnStatusLabel(r.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </DialogContent>
  );
}

type ReturnRow = { key: number; product_id: string; good: number; damaged: number };
const blankRow = (): ReturnRow => ({
  key: Date.now() + Math.random(),
  product_id: "",
  good: 0,
  damaged: 0,
});

function LogRepReturnDialog({
  factoryId,
  rep,
  onDone,
  picker,
}: {
  factoryId: string;
  rep: RepDay;
  onDone: () => void;
  // Set by ReturnProductDialog: the Sales-Rep chooser shown above the lines.
  picker?: ReactNode;
}) {
  const qc = useQueryClient();
  const lines = useMemo(() => productLines(rep).filter((l) => l.outstanding > 0), [rep]);
  // One row per product brought back: pick the product from the dropdown,
  // then enter the good and damaged quantities. Together they are what the
  // rep handed back. Damaged units are still credited to the rep's account at
  // inspection (inspect_sales_return()), they just don't go back into stock.
  const [rows, setRows] = useState<ReturnRow[]>(() => [blankRow()]);
  // Switching Sales-Rep in Return Product starts the rows afresh.
  useEffect(() => {
    setRows([blankRow()]);
  }, [rep.sales_rep_id]);
  const updateRow = (key: number, patch: Partial<ReturnRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const [reason, setReason] = useState("Unsold — returned at close of business");
  // The day the rep brought the goods back; defaults to today, can be backdated.
  const today = new Date().toLocaleDateString("en-CA");
  const [returnDate, setReturnDate] = useState(today);

  const lineOf = (id: string) => lines.find((l) => l.product_id === id);
  const totalOf = (r: ReturnRow) => r.good + r.damaged;
  const filled = rows.filter((r) => r.product_id && totalOf(r) > 0);
  const over = filled.filter((r) => totalOf(r) > (lineOf(r.product_id)?.outstanding ?? 0));
  const toReturn = filled.map((r) => ({ row: r, line: lineOf(r.product_id)! }));
  const unpicked = rows.some((r) => !r.product_id && totalOf(r) > 0);

  const submit = useMutation({
    mutationFn: async () => {
      if (unpicked) throw new Error("Select the product for each quantity entered");
      if (toReturn.length === 0)
        throw new Error("Select a product and enter the quantity returned");
      if (over.length > 0)
        throw new Error(`${lineOf(over[0].product_id)?.name}: more than the rep still holds`);
      // One sales_returns row per product, same as the Sales Returns page.
      const results: { id: string; return_number: string }[] = [];
      for (const { row, line: l } of toReturn) {
        const { data, error } = await supabase.rpc("create_sales_return", {
          payload: {
            factory_id: factoryId,
            sale_id: l.sale_id || undefined,
            customer_id: rep.customer_id,
            product_id: l.product_id,
            quantity_returned: totalOf(row),
            damaged_quantity: row.damaged,
            return_date: returnDate,
            reason: reason || undefined,
          } as never,
        });
        if (error) throw error;
        results.push(data as unknown as { id: string; return_number: string });
      }
      return results;
    },
    onSuccess: (results) => {
      toast.success(
        `${results.length} return${results.length === 1 ? "" : "s"} logged for ${rep.name} — awaiting inspection`,
      );
      results.forEach((r) =>
        logAudit({ action: "create", entity: "sales_returns", entityId: r.id, factoryId }),
      );
      qc.invalidateQueries({ queryKey: ["store-rep-activity"] });
      qc.invalidateQueries({ queryKey: ["store-rep-returnables"] });
      qc.invalidateQueries({ queryKey: ["sales-returns-list"] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{picker ? "Return Product" : `Log Return — ${rep.name}`}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        {picker}
        <p className="text-xs text-muted-foreground">
          Enter what the rep brought back, good and damaged separately. Both are credited to the
          rep's account after inspection; only good units go back into stock.
        </p>
        {rep.customer_id && lines.length === 0 && (
          <p className="rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {rep.name} has no supplied products left to return.
          </p>
        )}
        {lines.length > 0 &&
          rows.map((r) => {
            const l = lineOf(r.product_id);
            const tooMany = !!l && totalOf(r) > l.outstanding;
            const bad = tooMany ? "border-destructive text-destructive" : undefined;
            // A product already picked on another row isn't offered again.
            const taken = new Set(
              rows.filter((x) => x.key !== r.key && x.product_id).map((x) => x.product_id),
            );
            return (
              <div key={r.key} className="grid gap-2 rounded-md border p-2">
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Label className="text-xs">Product</Label>
                    <Select
                      value={r.product_id || undefined}
                      onValueChange={(v) => updateRow(r.key, { product_id: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select product returned…" />
                      </SelectTrigger>
                      <SelectContent>
                        {lines
                          .filter((x) => !taken.has(x.product_id))
                          .map((x) => (
                            <SelectItem key={x.product_id} value={x.product_id}>
                              {x.name} · with rep {num(x.outstanding)} {x.unit}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {rows.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Remove this product"
                      onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="flex items-end gap-2">
                  <div className="w-36">
                    <Label className="text-xs">Quantity returned</Label>
                    <MoneyInput
                      min={0}
                      value={r.good}
                      onChange={(n) => updateRow(r.key, { good: n })}
                      className={bad}
                    />
                  </div>
                  <div className="w-28">
                    <Label className="text-xs">Damaged</Label>
                    <MoneyInput
                      min={0}
                      value={r.damaged}
                      onChange={(n) => updateRow(r.key, { damaged: n })}
                      className={bad}
                    />
                  </div>
                  {l && (
                    <div
                      className={`pb-2 text-xs ${tooMany ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {tooMany
                        ? `Only ${num(l.outstanding)} ${l.unit} with rep`
                        : `Still with rep: ${num(l.outstanding)} ${l.unit}`}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        {lines.length > 0 && rows.length < lines.length && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit gap-1"
            onClick={() => setRows((rs) => [...rs, blankRow()])}
          >
            <Plus className="h-4 w-4" /> Add another product
          </Button>
        )}
        <div>
          <Label>Return date</Label>
          <DateInput
            className="w-auto"
            value={returnDate}
            max={today}
            onChange={(e) => e.target.value && setReturnDate(e.target.value)}
          />
        </div>
        <div>
          <Label>Reason</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button
          disabled={submit.isPending || toReturn.length === 0 || over.length > 0 || unpicked}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? "Logging…" : "Log Return"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

type Returnable = {
  sales_rep_id: string;
  customer_id: string;
  name: string;
  products: {
    product_id: string;
    product_name: string;
    unit: string | null;
    supplied: number;
    returned: number;
    sale_id: string;
  }[];
};

const NO_REP: RepDay = {
  sales_rep_id: "",
  customer_id: "",
  name: "",
  phone: null,
  status: "active",
  supplied: [],
  pending_orders: 0,
  returned: [],
};

// Store page header "Return Product": pick a Sales-Rep, then log what they
// brought back out of everything they've been supplied (any day).
export function ReturnProductDialog({
  factoryId,
  onDone,
}: {
  factoryId: string;
  onDone: () => void;
}) {
  const [repId, setRepId] = useState("");
  const returnables = useQuery({
    queryKey: ["store-rep-returnables", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("store_rep_returnables", {
        p_factory_id: factoryId,
      });
      if (error) throw error;
      return (data ?? []) as unknown as Returnable[];
    },
  });

  // Shaped like a day of activity so the Log Return form can be reused as is.
  const rep: RepDay = useMemo(() => {
    const r = returnables.data?.find((x) => x.sales_rep_id === repId);
    if (!r) return NO_REP;
    return {
      ...NO_REP,
      sales_rep_id: r.sales_rep_id,
      customer_id: r.customer_id,
      name: r.name,
      supplied: r.products.map((p) => ({
        sale_id: p.sale_id,
        invoice_number: "",
        product_id: p.product_id,
        product_name: p.product_name,
        unit: p.unit,
        quantity: Number(p.supplied),
        unit_price: 0,
        created_at: "",
      })),
      returned: r.products
        .filter((p) => Number(p.returned) > 0)
        .map((p) => ({
          id: p.product_id,
          return_number: "",
          product_id: p.product_id,
          product_name: p.product_name,
          unit: p.unit,
          quantity: Number(p.returned),
          accepted: null,
          damaged: 0,
          rejected: 0,
          status: "received",
          received_at: "",
        })),
    };
  }, [returnables.data, repId]);

  const picker = (
    <div>
      <Label>Sales-Rep</Label>
      <Select value={repId || undefined} onValueChange={setRepId}>
        <SelectTrigger>
          <SelectValue
            placeholder={returnables.isLoading ? "Loading…" : "Select the sales-rep returning…"}
          />
        </SelectTrigger>
        <SelectContent>
          {(returnables.data ?? []).map((r) => {
            const out = r.products.reduce(
              (s, p) => s + Math.max(Number(p.supplied) - Number(p.returned), 0),
              0,
            );
            return (
              <SelectItem key={r.sales_rep_id} value={r.sales_rep_id}>
                {r.name} · {num(out)} still with them
              </SelectItem>
            );
          })}
          {returnables.data?.length === 0 && (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">
              No sales-reps yet — add them under Distribution → Sales Reps.
            </div>
          )}
        </SelectContent>
      </Select>
    </div>
  );

  return <LogRepReturnDialog factoryId={factoryId} rep={rep} onDone={onDone} picker={picker} />;
}
