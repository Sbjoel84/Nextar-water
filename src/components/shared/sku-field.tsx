import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PRODUCT_VARIANTS, needsSku, skuLabelFor } from "@/lib/product-lines";

// The SKU box of the product forms: a dropdown of the product type's fixed
// variants (Bottle Water: 75cl, 50cl x 12, ...), otherwise free text.
export function SkuField({
  productLine,
  value,
  onChange,
}: {
  productLine: string;
  value: string;
  onChange: (v: string) => void;
}) {
  // Dispenser / Sachet Water: no SKU at all.
  if (!needsSku(productLine)) return null;
  const label = skuLabelFor(productLine);
  const variants = PRODUCT_VARIANTS[productLine];
  return (
    <div>
      <Label>{label}</Label>
      {variants ? (
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue placeholder={`Select ${label.toLowerCase()}…`} />
          </SelectTrigger>
          <SelectContent>
            {variants.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
            {/* An older product's own SKU stays selectable when editing it. */}
            {value && !variants.includes(value) && <SelectItem value={value}>{value}</SelectItem>}
          </SelectContent>
        </Select>
      ) : (
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. 19L" />
      )}
    </div>
  );
}
