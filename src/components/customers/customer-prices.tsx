import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { money, fmtDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
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

type PriceRow = {
  product_id: string;
  unit_price: number;
  updated_at: string;
  products: { name: string; unit: string; unit_price: number } | null;
};

// A customer's own prices: what they're charged per product instead of the
// regular price (a surcharge or a special rate). Filled in automatically when
// the accountant confirms that customer's orders; managed here or saved from
// the confirm screen.
export function CustomerPricesPanel({
  factoryId,
  customerId,
  customerName,
}: {
  factoryId: string;
  customerId: string;
  customerName: string;
}) {
  const qc = useQueryClient();
  const canEdit = usePermissions().canApprove("sales");
  const [productId, setProductId] = useState("");
  const [price, setPrice] = useState(0);

  const prices = useQuery({
    queryKey: ["customer-prices", customerId, "list"],
    retry: false,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("customer_product_prices")
        .select("product_id,unit_price,updated_at,products(name,unit,unit_price)")
        .eq("customer_id", customerId);
      if (error) throw error;
      return ((data ?? []) as PriceRow[]).sort((a, b) =>
        (a.products?.name ?? "").localeCompare(b.products?.name ?? ""),
      );
    },
  });

  const products = useQuery({
    queryKey: ["customer-prices-products", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id,name,unit,unit_price")
        .eq("factory_id", factoryId)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["customer-prices"] });

  const save = useMutation({
    mutationFn: async () => {
      if (!productId) throw new Error("Select a product");
      if (!(price > 0)) throw new Error("Enter a price above zero");
      const { error } = await (supabase as any).rpc("set_customer_price", {
        p_customer_id: customerId,
        p_product_id: productId,
        p_unit_price: price,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      const name = products.data?.find((p) => p.id === productId)?.name ?? "Product";
      toast.success(`${name}: ${money(price)} saved for ${customerName}`);
      logAudit({
        action: "update",
        entity: "customer_product_prices",
        entityId: customerId,
        factoryId,
        newValue: { product_id: productId, unit_price: price },
      });
      setProductId("");
      setPrice(0);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (pid: string) => {
      const { error } = await (supabase as any).rpc("remove_customer_price", {
        p_customer_id: customerId,
        p_product_id: pid,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Back to the regular price");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (prices.isError) {
    return (
      <p className="rounded-md bg-warning/15 px-3 py-2 text-sm text-warning">
        Customer prices aren't set up on the database yet.
      </p>
    );
  }

  const regularOf = (pid: string) =>
    Number(products.data?.find((p) => p.id === pid)?.unit_price ?? 0);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Prices {customerName} pays instead of the regular price. When their order is confirmed,
        these are filled in automatically, and the accountant can still change them.
      </p>

      {canEdit && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
          <div className="min-w-48 flex-1">
            <Label className="text-xs">Product</Label>
            <Select
              value={productId || undefined}
              onValueChange={(v) => {
                setProductId(v);
                const existing = prices.data?.find((r) => r.product_id === v);
                setPrice(existing ? Number(existing.unit_price) : regularOf(v));
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select product…" />
              </SelectTrigger>
              <SelectContent>
                {(products.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} · regular {money(Number(p.unit_price))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-36">
            <Label className="text-xs">Price for this customer</Label>
            <MoneyInput value={price} onChange={setPrice} />
          </div>
          <Button disabled={save.isPending || !productId} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save price"}
          </Button>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Regular price</TableHead>
            <TableHead className="text-right">Customer price</TableHead>
            <TableHead className="text-right">Difference</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {(prices.data ?? []).map((r) => {
            const regular = Number(r.products?.unit_price ?? 0);
            const diff = Math.round((Number(r.unit_price) - regular) * 100) / 100;
            return (
              <TableRow key={r.product_id}>
                <TableCell>
                  {r.products?.name ?? "—"}
                  {r.products?.unit ? ` (${r.products.unit})` : ""}
                </TableCell>
                <TableCell className="text-right">{money(regular)}</TableCell>
                <TableCell className="text-right font-medium">
                  {money(Number(r.unit_price))}
                </TableCell>
                <TableCell
                  className={`text-right text-xs ${diff > 0 ? "text-warning" : diff < 0 ? "text-success" : ""}`}
                >
                  {diff === 0 ? "—" : `${diff > 0 ? "+" : "−"}${money(Math.abs(diff))}`}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {fmtDate(r.updated_at)}
                </TableCell>
                <TableCell className="text-right">
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Remove — back to the regular price"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(r.product_id)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
          {(prices.data ?? []).length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                {prices.isLoading
                  ? "Loading…"
                  : "No special prices. This customer pays regular prices."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
