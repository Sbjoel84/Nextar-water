import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Pencil, Plus, Save, Tag } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { logAudit } from "@/lib/audit";
import { money } from "@/lib/format";
import { matchesSearch } from "@/lib/search";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/ui/money-input";
import { Badge } from "@/components/ui/badge";
import { SearchBox } from "@/components/shared/search-box";
import { QuickAddProductDialog } from "@/components/shared/quick-add-item";
import { ProductUnitSelect } from "@/components/shared/unit-select";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type PriceRow = {
  id: string;
  name: string;
  sku: string | null;
  product_code: string | null;
  unit: string;
  unit_price: number;
  cost_price: number;
  current_stock: number;
};

// The selling price list. Sales & POS takes each line's unit price from here,
// so the sales person only enters the quantity.
export function ProductPricesTab({ factoryId }: { factoryId: string }) {
  const qc = useQueryClient();
  const { canEdit, canApprove } = usePermissions();
  const canSetPrice = canEdit("costing") || canApprove("costing");
  const [q, setQ] = useState("");
  // Prices typed but not saved yet, by product id.
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<PriceRow | null>(null);
  const [adding, setAdding] = useState(false);

  useRealtimeInvalidate(["products"], [["product-prices", factoryId]]);

  const products = useQuery({
    queryKey: ["product-prices", factoryId],
    queryFn: async (): Promise<PriceRow[]> => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,sku,product_code,unit,unit_price,cost_price,current_stock")
        .eq("factory_id", factoryId)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as PriceRow[];
    },
  });

  const rows = useMemo(
    () => (products.data ?? []).filter((p) => matchesSearch(q, p)),
    [products.data, q],
  );
  const unpriced = (products.data ?? []).filter((p) => Number(p.unit_price) <= 0).length;
  const changed = Object.entries(draft).filter(([id, v]) => {
    const p = products.data?.find((x) => x.id === id);
    return p && Number(p.unit_price) !== v;
  });

  const save = useMutation({
    mutationFn: async (items: [string, number][]) => {
      for (const [id, price] of items) {
        const { error } = await supabase.rpc("set_product_price", {
          p_product_id: id,
          p_price: price,
        });
        if (error) throw error;
      }
      return items;
    },
    onSuccess: (items) => {
      toast.success(`${items.length} price${items.length === 1 ? "" : "s"} saved`);
      items.forEach(([id, price]) =>
        logAudit({
          action: "update",
          entity: "products",
          entityId: id,
          factoryId,
          newValue: { unit_price: price },
        }),
      );
      setDraft((d) => {
        const next = { ...d };
        items.forEach(([id]) => delete next[id]);
        return next;
      });
      qc.invalidateQueries({ queryKey: ["product-prices", factoryId] });
      qc.invalidateQueries({ queryKey: ["products-active"] });
      qc.invalidateQueries({ queryKey: ["finished-goods"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Tag className="h-5 w-5" /> Product Prices
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            The selling price of each product. Sales & POS fills the unit price in from this list —
            the sales person only enters the quantity, and the total is worked out automatically.
          </p>
          {unpriced > 0 && (
            <p className="mt-1 text-sm font-medium text-destructive">
              {unpriced} product{unpriced === 1 ? " has" : "s have"} no price yet and can't be sold
              until one is set.
            </p>
          )}
        </div>
        {canSetPrice && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="gap-2" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add product
            </Button>
            <Button
              className="gap-2"
              disabled={changed.length === 0 || save.isPending}
              onClick={() => save.mutate(changed)}
            >
              <Save className="h-4 w-4" />
              {save.isPending
                ? "Saving…"
                : `Save ${changed.length || ""} change${changed.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <SearchBox value={q} onChange={setQ} className="mb-3" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead className="text-right">Cost price</TableHead>
              <TableHead className="w-44">Selling price (per unit)</TableHead>
              <TableHead className="text-right">Margin</TableHead>
              {canSetPrice && <TableHead className="w-10"></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : products.isError ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-destructive">
                  Couldn't load products: {(products.error as Error).message}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                  No products found.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((p) => {
                const price = draft[p.id] ?? Number(p.unit_price);
                const cost = Number(p.cost_price);
                const dirty = draft[p.id] !== undefined && draft[p.id] !== Number(p.unit_price);
                return (
                  <TableRow key={p.id} className={dirty ? "bg-primary/5" : undefined}>
                    <TableCell>
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {[p.product_code, p.sku].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </TableCell>
                    <TableCell>{p.unit}</TableCell>
                    <TableCell className="text-right">{cost > 0 ? money(cost) : "—"}</TableCell>
                    <TableCell>
                      {canSetPrice ? (
                        <MoneyInput
                          min={0}
                          value={price}
                          onChange={(v) => setDraft((d) => ({ ...d, [p.id]: v }))}
                          className={price <= 0 ? "h-9 border-destructive" : "h-9"}
                        />
                      ) : price > 0 ? (
                        money(price)
                      ) : (
                        <Badge variant="destructive">No price</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {price > 0 && cost > 0 ? (
                        <span className={price < cost ? "text-destructive" : "text-success"}>
                          {money(price - cost)} ({Math.round(((price - cost) / price) * 100)}%)
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    {canSetPrice && (
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Edit product — name, size/type, unit and price"
                          aria-label={`Edit ${p.name}`}
                          onClick={() => setEditing(p)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        {editing && (
          <EditProductDialog
            factoryId={factoryId}
            product={editing}
            onDone={() => {
              setDraft((d) => {
                const next = { ...d };
                delete next[editing.id];
                return next;
              });
              setEditing(null);
            }}
          />
        )}
      </Dialog>
      <QuickAddProductDialog
        open={adding}
        onOpenChange={setAdding}
        factoryId={factoryId}
        onCreated={() => qc.invalidateQueries({ queryKey: ["product-prices", factoryId] })}
      />
    </Card>
  );
}

function EditProductDialog({
  factoryId,
  product,
  onDone,
}: {
  factoryId: string;
  product: PriceRow;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(product.name);
  const [sku, setSku] = useState(product.sku ?? "");
  const [unit, setUnit] = useState(product.unit);
  const [price, setPrice] = useState(Number(product.unit_price));

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Enter the product name");
      if (!unit.trim()) throw new Error("Select the unit");
      const { error } = await supabase.rpc("update_product_details", {
        p_id: product.id,
        p_name: name.trim(),
        p_sku: sku.trim(),
        p_unit: unit.trim(),
        p_price: price,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${name.trim()} updated`);
      logAudit({
        action: "update",
        entity: "products",
        entityId: product.id,
        factoryId,
        oldValue: {
          name: product.name,
          sku: product.sku,
          unit: product.unit,
          unit_price: product.unit_price,
        },
        newValue: { name: name.trim(), sku: sku.trim(), unit, unit_price: price },
      });
      // Name/price show up across Store, Sales & POS and reports.
      qc.invalidateQueries({
        predicate: (q) => {
          const k = String(q.queryKey[0] ?? "");
          return k.startsWith("product") || k === "finished-goods" || k === "pos-customers";
        },
      });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Edit product</DialogTitle>
        <DialogDescription>
          {product.product_code ? `${product.product_code} · ` : ""}Stock and cost price aren't
          changed here.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Product name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Size / type</Label>
            <Input
              value={sku}
              placeholder="e.g. 50cl x 12"
              onChange={(e) => setSku(e.target.value)}
            />
          </div>
          <ProductUnitSelect value={unit} onChange={setUnit} />
        </div>
        <div>
          <Label>Selling price (per {unit || "unit"})</Label>
          <MoneyInput min={0} value={price} onChange={setPrice} />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
