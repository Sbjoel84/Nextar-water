import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PRODUCT_UNITS, productUnitOf } from "@/lib/units";

// The Unit box of the product forms. A product's existing unit that isn't in
// the list stays selectable when editing it.
export function ProductUnitSelect({
  value,
  onChange,
  disabled,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const choice = productUnitOf(value);
  return (
    <div>
      <Label>Unit</Label>
      <Select value={choice || undefined} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="Select unit…" />
        </SelectTrigger>
        <SelectContent>
          {PRODUCT_UNITS.map((u) => (
            <SelectItem key={u} value={u}>
              {u}
            </SelectItem>
          ))}
          {choice && !PRODUCT_UNITS.includes(choice) && (
            <SelectItem value={choice}>{choice}</SelectItem>
          )}
        </SelectContent>
      </Select>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
