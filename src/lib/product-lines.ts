// The factory's product types, same as the Costing page's templates. A
// product is saved as "<product type> <SKU>" (e.g. "Bottle Water 35cl") so
// every list that only shows the name still tells the sizes apart.
export const PRODUCT_LINES = ["Bottle Water", "Dispenser", "Sachet Water", "Ice Block"];

// Bottle Water sizes are its product types (35cl, 50cl, ...).
export const skuLabelFor = (productLine: string) =>
  productLine === "Bottle Water" ? "Product Type" : "SKU";

export const productNameFor = (productLine: string, sku: string) =>
  [productLine, sku.trim()].filter(Boolean).join(" ");

// Recovers the product type from a saved "<product> <SKU>" name; an older
// free-typed name that matches no type is kept whole (whole: true).
export function splitProductName(name: string, sku: string): { line: string; whole: boolean } {
  const trimmed = name.trim();
  if (!trimmed) return { line: "", whole: false };
  const line = PRODUCT_LINES.find((p) => trimmed.toLowerCase().startsWith(p.toLowerCase()));
  if (line) return { line, whole: false };
  const s = sku.trim();
  if (s && trimmed.toLowerCase().endsWith(` ${s.toLowerCase()}`)) {
    return { line: trimmed.slice(0, -(s.length + 1)), whole: false };
  }
  return { line: trimmed, whole: true };
}

// Fixed variants offered as a dropdown for a product type; any other type
// keeps a free-typed SKU.
export const PRODUCT_VARIANTS: Record<string, string[]> = {
  "Bottle Water": ["75cl", "50cl x 12", "50cl x 20", "33cl x 20"],
};

// Product types sold as a single product, with no SKU/size to pick: the
// product is just "Dispenser", "Sachet Water" or "Ice Block".
export const NO_SKU_LINES = ["Dispenser", "Sachet Water", "Ice Block"];
export const needsSku = (productLine: string) => !NO_SKU_LINES.includes(productLine);

// The unit a product type is counted in; everything else is counted in pieces.
const LINE_UNITS: Record<string, string> = { "Sachet Water": "Bag" };
export const unitFor = (productLine: string) => LINE_UNITS[productLine] ?? "Piece";
