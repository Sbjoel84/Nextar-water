// Standard Nextar store items offered as a dropdown when adding a raw
// material, so the same item isn't entered under several spellings. `unit`
// is set only where the store list states one; the form matches it against
// the configured units of measure (see presetUnitOption).

export type MaterialPreset = { name: string; unit?: "bags" | "kg" | "pcs" | "litres" };

export const MATERIAL_PRESETS: MaterialPreset[] = [
  { name: "Preforms 33cl", unit: "bags" },
  { name: "Preforms 50cl", unit: "bags" },
  { name: "Preforms 75cl", unit: "bags" },
  { name: "Shrink Wrapping Nylon", unit: "kg" },
  { name: "Caps (bottle)" },
  { name: "Labels (bottle)", unit: "pcs" },
  { name: "Fliers (bottle)", unit: "pcs" },
  { name: "Dispenser (bottle)", unit: "pcs" },
  { name: "Top Label Dispenser", unit: "pcs" },
  { name: "Tamper Proof", unit: "pcs" },
  { name: "Packing Bag Dispenser", unit: "pcs" },
  { name: "Side Label Dispenser", unit: "pcs" },
  { name: "Nylon Rolls (Sachet Water)" },
  { name: "Packing Bag (Sachet Water)" },
  { name: "Filters (Arrow Filter)" },
  { name: "Filters (Carbon Filter)" },
  { name: "Ribbon", unit: "pcs" },
  { name: "Cotton Rubber", unit: "pcs" },
  { name: "Grease" },
  { name: "Engine Oil", unit: "litres" },
  { name: "Diesel", unit: "litres" },
  { name: "Elements", unit: "pcs" },
];

// Ways each preset unit may be spelled in Settings > Units of Measure.
const UNIT_ALIASES: Record<NonNullable<MaterialPreset["unit"]>, string[]> = {
  bags: ["bag"],
  kg: ["kg", "kilogram"],
  pcs: ["pcs", "piece", "pc"],
  litres: ["litre", "liter", "lit", "ltr"],
};

// The configured unit option that means the preset's unit, or null if none
// does (the form then falls back to a custom unit).
export function presetUnitOption(
  unit: NonNullable<MaterialPreset["unit"]>,
  options: string[],
): string | null {
  const aliases = UNIT_ALIASES[unit];
  return options.find((o) => aliases.some((a) => o.toLowerCase().startsWith(a))) ?? null;
}
