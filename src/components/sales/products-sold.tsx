import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { endOfMonth, startOfMonth, startOfWeek, startOfYear, subMonths } from "date-fns";
import { Droplets, FileDown, Package, ShoppingBag, Snowflake, GlassWater } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAll } from "@/lib/metrics";
import { exportCsv } from "@/lib/export";
import { money, num, fmtDate } from "@/lib/format";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { PRODUCT_LINES, splitProductName } from "@/lib/product-lines";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { DateInput } from "@/components/shared/date-input";

type SaleRow = {
  id: string;
  sale_date: string;
  status: string;
  is_pr: boolean;
  customer_type: string | null;
  sale_items: {
    product_id: string;
    quantity: number;
    line_total: number;
    products: { name: string; unit: string | null } | null;
  }[];
};

type ProductLine = {
  product_id: string;
  name: string;
  unit: string;
  type: string;
  sold: number; // confirmed (posted), not PR
  value: number;
  awaiting: number; // posted by sales, not yet confirmed by the accountant
  awaitingValue: number;
  pr: number; // complimentary
  orders: Set<string>;
};

const TYPE_ICON: Record<string, React.ElementType> = {
  "Bottle Water": GlassWater,
  "Sachet Water": Droplets,
  Dispenser: Package,
  "Ice Block": Snowflake,
};

const BUYERS = [
  { value: "all", label: "All buyers" },
  { value: "walk_in", label: "Walk-in / POS" },
  { value: "marketer", label: "Marketers" },
  { value: "distributor", label: "Distributors" },
  { value: "other", label: "Other customers" },
];

const ymd = (d: Date) => d.toLocaleDateString("en-CA");

// Account Overview → Products Sold: how much of each product, and of each
// product type (bottle water by size, dispenser, sachet water, ice block),
// went out in a period. Confirmed sales are the sales; orders still awaiting
// the accountant's confirmation and PR (complimentary) are shown beside them.
export function ProductsSoldCard({ factoryId }: { factoryId: string }) {
  const today = ymd(new Date());
  const PRESETS: { key: string; label: string; range: () => [string, string] }[] = [
    { key: "today", label: "Today", range: () => [today, today] },
    { key: "week", label: "This week", range: () => [ymd(startOfWeek(new Date())), today] },
    { key: "month", label: "This month", range: () => [ymd(startOfMonth(new Date())), today] },
    {
      key: "last-month",
      label: "Last month",
      range: () => {
        const m = subMonths(new Date(), 1);
        return [ymd(startOfMonth(m)), ymd(endOfMonth(m))];
      },
    },
    { key: "year", label: "This year", range: () => [ymd(startOfYear(new Date())), today] },
  ];
  const [from, setFrom] = useState(() => ymd(startOfMonth(new Date())));
  const [to, setTo] = useState(today);
  const [buyer, setBuyer] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const valid = !!from && !!to && from <= to;
  const activePreset = PRESETS.find((p) => {
    const [f, t] = p.range();
    return f === from && t === to;
  })?.key;

  useRealtimeInvalidate(["sales", "sale_items"], [["products-sold", factoryId]]);

  const sales = useQuery({
    queryKey: ["products-sold", factoryId, from, to],
    enabled: valid,
    queryFn: () =>
      fetchAll<SaleRow>(
        (a, b) =>
          supabase
            .from("sales")
            .select(
              "id,sale_date,status,is_pr,customer_type,sale_items(product_id,quantity,line_total,products(name,unit))",
            )
            .eq("factory_id", factoryId)
            .in("status", ["posted", "pending_approval"])
            .is("deleted_at", null)
            .gte("sale_date", from)
            .lte("sale_date", to)
            .order("sale_date")
            .order("id")
            .range(a, b) as any,
      ),
  });

  const lines = useMemo(() => {
    const map = new Map<string, ProductLine>();
    for (const s of sales.data ?? []) {
      if (buyer !== "all" && (s.customer_type ?? "walk_in") !== buyer) continue;
      for (const it of s.sale_items ?? []) {
        const name = it.products?.name ?? "Unknown product";
        let l = map.get(it.product_id);
        if (!l) {
          const { line, whole } = splitProductName(name, "");
          l = {
            product_id: it.product_id,
            name,
            unit: it.products?.unit ?? "",
            type: !whole && PRODUCT_LINES.includes(line) ? line : "Other",
            sold: 0,
            value: 0,
            awaiting: 0,
            awaitingValue: 0,
            pr: 0,
            orders: new Set(),
          };
          map.set(it.product_id, l);
        }
        const qty = Number(it.quantity);
        if (s.is_pr) l.pr += qty;
        else if (s.status === "posted") {
          l.sold += qty;
          l.value += Number(it.line_total);
        } else {
          l.awaiting += qty;
          l.awaitingValue += Number(it.line_total);
        }
        l.orders.add(s.id);
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [sales.data, buyer]);

  const types = useMemo(() => {
    const order = [...PRODUCT_LINES, "Other"];
    const byType = new Map<string, ProductLine[]>();
    for (const l of lines) byType.set(l.type, [...(byType.get(l.type) ?? []), l]);
    return order
      .filter((t) => byType.has(t))
      .map((t) => {
        const rows = byType.get(t)!;
        const units = [...new Set(rows.map((r) => r.unit).filter(Boolean))];
        return {
          type: t,
          rows,
          unit: units.length === 1 ? units[0] : "units",
          sold: rows.reduce((x, r) => x + r.sold, 0),
          value: rows.reduce((x, r) => x + r.value, 0),
          awaiting: rows.reduce((x, r) => x + r.awaiting, 0),
          pr: rows.reduce((x, r) => x + r.pr, 0),
        };
      });
  }, [lines]);

  const totals = {
    sold: lines.reduce((x, r) => x + r.sold, 0),
    value: lines.reduce((x, r) => x + r.value, 0),
    awaiting: lines.reduce((x, r) => x + r.awaiting, 0),
    awaitingValue: lines.reduce((x, r) => x + r.awaitingValue, 0),
    pr: lines.reduce((x, r) => x + r.pr, 0),
  };
  const shownTypes = typeFilter === "all" ? types : types.filter((t) => t.type === typeFilter);

  const exportRows = () =>
    exportCsv(
      `products-sold-${from}_to_${to}`,
      [
        { key: "type", label: "Product type" },
        { key: "product", label: "Product" },
        { key: "unit", label: "Unit" },
        { key: "sold", label: "Sold (confirmed)" },
        { key: "value", label: "Sales value" },
        { key: "awaiting", label: "Awaiting confirmation" },
        { key: "pr", label: "PR (free)" },
        { key: "orders", label: "Orders" },
      ],
      shownTypes.flatMap((t) =>
        t.rows.map((r) => ({
          type: t.type,
          product: r.name,
          unit: r.unit,
          sold: r.sold,
          value: r.value.toFixed(2),
          awaiting: r.awaiting,
          pr: r.pr,
          orders: r.orders.size,
        })),
      ),
    );

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={activePreset === p.key ? "default" : "outline"}
                onClick={() => {
                  const [f, t] = p.range();
                  setFrom(f);
                  setTo(t);
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <div>
            <Label className="text-xs">From</Label>
            <DateInput value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <DateInput value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="w-44">
            <Label className="text-xs">Buyer</Label>
            <Select value={buyer} onValueChange={setBuyer}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BUYERS.map((b) => (
                  <SelectItem key={b.value} value={b.value}>
                    {b.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto gap-2"
            disabled={lines.length === 0}
            onClick={exportRows}
          >
            <FileDown className="h-4 w-4" /> CSV
          </Button>
          {!valid && (
            <p className="w-full text-xs text-destructive">"From" must be on or before "To".</p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          icon={ShoppingBag}
          label="Total products sold"
          value={num(totals.sold)}
          hint={`${money(totals.value)} · ${fmtDate(`${from}T00:00:00`)} – ${fmtDate(`${to}T00:00:00`)}`}
          active={typeFilter === "all"}
          onClick={() => setTypeFilter("all")}
        />
        {types.map((t) => {
          const Icon = TYPE_ICON[t.type] ?? Package;
          return (
            <Tile
              key={t.type}
              icon={Icon}
              label={t.type}
              value={`${num(t.sold)} ${t.unit}`}
              hint={money(t.value)}
              active={typeFilter === t.type}
              onClick={() => setTypeFilter(typeFilter === t.type ? "all" : t.type)}
            />
          );
        })}
      </div>
      {(totals.awaiting > 0 || totals.pr > 0) && (
        <p className="text-xs text-muted-foreground">
          Not counted as sold: {num(totals.awaiting)} awaiting the accountant's confirmation (
          {money(totals.awaitingValue)}){totals.pr > 0 && `, ${num(totals.pr)} given out as PR`}.
        </p>
      )}

      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle>Products sold{typeFilter !== "all" ? ` — ${typeFilter}` : ""}</CardTitle>
          <p className="text-sm text-muted-foreground">
            Confirmed sales by product and type. Click a type above to show only that type.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Sold</TableHead>
                <TableHead className="text-right">Sales value</TableHead>
                <TableHead className="text-right">Avg. price</TableHead>
                <TableHead className="text-right">Awaiting confirmation</TableHead>
                <TableHead className="text-right">PR (free)</TableHead>
                <TableHead className="text-right">Orders</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sales.isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : sales.isError ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-destructive">
                    {(sales.error as Error).message}
                  </TableCell>
                </TableRow>
              ) : shownTypes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                    No products sold in this period.
                  </TableCell>
                </TableRow>
              ) : (
                shownTypes.flatMap((t) => [
                  <TableRow key={`type-${t.type}`} className="bg-muted/40 hover:bg-muted/40">
                    <TableCell className="font-semibold">
                      {t.type}{" "}
                      <Badge variant="outline" className="ml-1 font-normal">
                        {t.rows.length} product{t.rows.length === 1 ? "" : "s"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {num(t.sold)} {t.unit}
                    </TableCell>
                    <TableCell className="text-right font-semibold">{money(t.value)}</TableCell>
                    <TableCell />
                    <TableCell className="text-right">
                      {t.awaiting ? num(t.awaiting) : "—"}
                    </TableCell>
                    <TableCell className="text-right">{t.pr ? num(t.pr) : "—"}</TableCell>
                    <TableCell />
                  </TableRow>,
                  ...t.rows.map((r) => (
                    <TableRow key={r.product_id}>
                      <TableCell className="pl-6">{r.name}</TableCell>
                      <TableCell className="text-right">
                        {num(r.sold)} {r.unit}
                      </TableCell>
                      <TableCell className="text-right">{money(r.value)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {r.sold > 0 ? money(r.value / r.sold) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.awaiting ? num(r.awaiting) : "—"}
                      </TableCell>
                      <TableCell className="text-right">{r.pr ? num(r.pr) : "—"}</TableCell>
                      <TableCell className="text-right">{r.orders.size}</TableCell>
                    </TableRow>
                  )),
                ])
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
  active,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  hint?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-2xl border bg-card p-4 text-left transition-colors hover:bg-muted/40 ${
        active ? "border-primary bg-primary/5" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2 text-xl font-semibold">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </button>
  );
}
