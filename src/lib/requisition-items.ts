// The 22 printed lines of the Nextar Water "Store Requisition Note
// (Production)". Costing offers these as its material dropdown so a sheet is
// built from the same items production requisitions from the store.
//
// Each item is linked to the matching Raw Materials entry by name (`match`,
// minus `exclude`), which is where its live unit cost comes from.

// How a material's quantity is entered: for the whole batch (bags of preform,
// kg of shrink nylon), per finished unit (one cap per bottle), or per pack
// (one packing bag per 20 sachets).
export type QtyBasis = "batch" | "per_unit" | "per_pack";

export type RequisitionItem = {
  key: string;
  sn: number;
  name: string;
  unit: string;
  basis: QtyBasis;
  match: RegExp;
  exclude?: RegExp;
};

export const REQUISITION_ITEMS: RequisitionItem[] = [
  {
    key: "preform_33cl",
    sn: 1,
    name: "Preforms 33cl",
    unit: "bags",
    basis: "batch",
    match: /preform.*33|33\s*cl.*preform/i,
  },
  {
    key: "preform_50cl",
    sn: 2,
    name: "Preforms 50cl",
    unit: "bags",
    basis: "batch",
    match: /preform.*50|50\s*cl.*preform/i,
  },
  {
    key: "preform_75cl",
    sn: 3,
    name: "Preforms 75cl",
    unit: "bags",
    basis: "batch",
    match: /preform.*(75|7\s*cl)|75\s*cl.*preform/i,
  },
  {
    key: "shrink_nylon",
    sn: 4,
    name: "Shrink wrapping nylon",
    unit: "kg",
    basis: "batch",
    match: /shrink|wrap/i,
  },
  {
    key: "cap_bottle",
    sn: 5,
    name: "Caps (bottle)",
    unit: "pcs",
    basis: "per_unit",
    match: /\bcaps?\b/i,
    exclude: /dispenser/i,
  },
  {
    key: "label_bottle",
    sn: 6,
    name: "Labels (bottle)",
    unit: "pcs",
    basis: "per_unit",
    match: /label/i,
    exclude: /dispenser|top|side/i,
  },
  {
    key: "flier_bottle",
    sn: 7,
    name: "Fliers (bottle)",
    unit: "pcs",
    basis: "per_unit",
    match: /flier|flyer/i,
  },
  {
    key: "dispenser_bottle",
    sn: 8,
    name: "Dispenser (bottle)",
    unit: "pcs",
    basis: "per_unit",
    match: /dispenser|jar|keg|gallon/i,
    exclude: /label|bag|cap|tamper/i,
  },
  {
    key: "top_label_dispenser",
    sn: 9,
    name: "Top Label Dispenser",
    unit: "pcs",
    basis: "per_unit",
    match: /top\s*label/i,
  },
  {
    key: "tamper_proof",
    sn: 10,
    name: "Tamper Proof",
    unit: "pcs",
    basis: "per_unit",
    match: /tamper/i,
  },
  {
    key: "packing_bag_dispenser",
    sn: 11,
    name: "Packing Bag Dispenser",
    unit: "pcs",
    basis: "per_unit",
    match: /bag.*dispenser|dispenser.*bag/i,
  },
  {
    key: "side_label_dispenser",
    sn: 12,
    name: "Side Label Dispenser",
    unit: "pcs",
    basis: "per_unit",
    match: /side\s*label/i,
  },
  {
    key: "nylon_roll_sachet",
    sn: 13,
    name: "Nylon Rolls (Sachet Water)",
    unit: "rolls",
    basis: "batch",
    match: /roll|sachet.*(film|nylon)/i,
    exclude: /shrink|wrap/i,
  },
  {
    key: "packing_bag_sachet",
    sn: 14,
    name: "Packing Bag (Sachet Water)",
    unit: "pcs",
    basis: "per_pack",
    match: /packing\s*bag|sachet.*bag/i,
    exclude: /dispenser/i,
  },
  {
    key: "filter_arrow",
    sn: 15,
    name: "Filters (Arrow Filter)",
    unit: "pcs",
    basis: "batch",
    match: /arrow/i,
  },
  {
    key: "filter_carbon",
    sn: 16,
    name: "Filters (Carbon Filter)",
    unit: "pcs",
    basis: "batch",
    match: /carbon/i,
  },
  { key: "ribbon", sn: 17, name: "Ribbon", unit: "pcs", basis: "batch", match: /ribbon/i },
  {
    key: "cotton_rubber",
    sn: 18,
    name: "Cotton rubber",
    unit: "pcs",
    basis: "batch",
    match: /cotton/i,
  },
  { key: "grease", sn: 19, name: "Grease", unit: "kg", basis: "batch", match: /grease/i },
  {
    key: "engine_oil",
    sn: 20,
    name: "Engine Oil",
    unit: "litres",
    basis: "batch",
    match: /engine\s*oil|\blube/i,
  },
  {
    key: "diesel",
    sn: 21,
    name: "Diesel",
    unit: "litres",
    basis: "batch",
    match: /diesel|\bago\b/i,
  },
  { key: "elements", sn: 22, name: "Elements", unit: "pcs", basis: "batch", match: /element/i },
];

export const requisitionItem = (key: string) => REQUISITION_ITEMS.find((i) => i.key === key);

export const matchesRequisitionItem = (item: RequisitionItem, materialName: string) =>
  item.match.test(materialName) && !item.exclude?.test(materialName);

// The requisition line a stock item most likely is, for sheets saved before
// lines were tagged with a requisition key.
export const requisitionItemForMaterial = (materialName: string) =>
  REQUISITION_ITEMS.find((i) => matchesRequisitionItem(i, materialName));
