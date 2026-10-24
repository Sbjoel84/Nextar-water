import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { money } from "./format";

export type InvoiceItem = {
  name: string;
  quantity: number;
  unit: string;
  unit_price: number;
  line_total: number;
};

export type InvoiceData = {
  company: {
    name: string;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
    logo_url?: string | null;
  };
  invoice_number: string;
  sale_date: string;
  customer: { name?: string | null; phone?: string | null; address?: string | null };
  items: InvoiceItem[];
  subtotal: number;
  discount: number;
  vat: number;
  grand_total: number;
  amount_paid: number;
  balance: number;
  currency?: string;
  remarks?: string | null;
  sales_person?: string | null;
  is_pr?: boolean;
};

export type PdfAction = "download" | "print" | "preview";

// "print" opens the browser's print dialog for the PDF, where the user picks
// a printer or "Save as PDF" -- nothing is downloaded straight away. The PDF
// is loaded into a hidden same-page frame rather than a new tab, so pop-up
// blockers and "always download PDFs" browser settings can't get in the way.
let printFrame: HTMLIFrameElement | null = null;

function printPdf(doc: jsPDF) {
  const url = URL.createObjectURL(doc.output("blob"));
  printFrame?.remove();
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  frame.onload = () => {
    // Give the browser's PDF viewer a moment to render before printing.
    setTimeout(() => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        // Browsers that can't print a framed PDF: show it in a tab with its
        // own print prompt instead.
        doc.autoPrint();
        window.open(doc.output("bloburl"), "_blank");
      }
    }, 300);
  };
  frame.src = url;
  document.body.appendChild(frame);
  printFrame = frame;
}

function outputPdf(doc: jsPDF, filename: string, action: PdfAction) {
  if (action === "download") doc.save(filename);
  else if (action === "print") printPdf(doc);
  else window.open(doc.output("bloburl"), "_blank");
}

// Bundled brand logo (public/assets/), served same-origin so it never taints
// the canvas. Used on every receipt/print when a factory hasn't uploaded its
// own logo in Settings, so nothing prints logo-less.
const FALLBACK_LOGO_URL = "/assets/nextar-logo.jpeg";

// jsPDF's built-in fonts have no glyph for the Naira sign (₦) -- it prints as
// a broken box on thermal/receipt output. Use a plain currency-code prefix
// for PDFs instead of the on-screen Intl currency symbol from format.ts.
export const pdfMoney = (n: number, currency: string) => {
  const v = typeof n === "number" ? n : 0;
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(v));
  return `${v < 0 ? "-" : ""}${currency} ${formatted}`;
};

// Decodes the logo into a same-origin canvas so it can be embedded via
// addImage regardless of source format (png/jpg/webp all normalize to PNG).
// Resolves to null on any failure (missing logo, CORS, bad URL) so a broken
// logo never blocks printing a sale.
async function loadLogo(
  url: string,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = "anonymous";
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("logo failed to load"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return {
      dataUrl: canvas.toDataURL("image/png"),
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
  } catch {
    return null;
  }
}

// Loads the factory's uploaded logo, falling back to the bundled brand logo
// when there's no custom one (or it fails to load). Returns null only if even
// the fallback can't be decoded, so a genuinely broken logo never blocks a
// print.
async function resolveLogo(
  url: string | null | undefined,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  if (url) {
    const custom = await loadLogo(url);
    if (custom) return custom;
  }
  return loadLogo(FALLBACK_LOGO_URL);
}

// Draws the company logo centered at the top of the page (any format/orientation)
// and returns the y-coordinate the rest of the header should start from --
// `baseTop` unchanged when there's no logo, pushed down by the logo's height
// (capped to maxW x maxH) plus a gap when there is one.
async function drawLogoHeader(
  doc: jsPDF,
  logoUrl: string | null | undefined,
  baseTop: number,
  maxW = 90,
  maxH = 34,
): Promise<number> {
  const logo = await resolveLogo(logoUrl);
  if (!logo) return baseTop;
  const ratio = Math.min(maxW / logo.width, maxH / logo.height, 1);
  const w = logo.width * ratio,
    h = logo.height * ratio;
  const pageW = doc.internal.pageSize.getWidth();
  doc.addImage(logo.dataUrl, "PNG", pageW / 2 - w / 2, 14, w, h);
  return baseTop + h + 10;
}

// 80mm thermal roll (Xprinter XP-80 and similar POS printers): the page is
// the roll's width and exactly as long as the receipt, so the printer prints
// it at full size instead of shrinking an A4 page onto the roll.
const ROLL_WIDTH_PT = 226.77; // 80mm
const ROLL_MARGIN_PT = 11; // ~4mm each side, inside the printer's 72mm print area

export async function generateInvoicePdf(data: InvoiceData, action: PdfAction = "download") {
  const currency = data.currency ?? "NGN";
  const cur = (n: number) => pdfMoney(n, currency);
  const logo = await resolveLogo(data.company.logo_url);

  const W = ROLL_WIDTH_PT;
  const M = ROLL_MARGIN_PT;
  const contentW = W - M * 2;
  const center = W / 2;

  const BODY = 10;
  const LH = 13; // line height for body text

  const draw = (doc: jsPDF): number => {
    let y = 12;

    const rule = (dashed = false) => {
      if (dashed) doc.setLineDashPattern([2, 1.5], 0);
      doc.setLineWidth(0.8);
      doc.line(M, y, W - M, y);
      doc.setLineDashPattern([], 0);
      y += 12;
    };
    const centered = (text: string, size: number, bold = false, lh = size + 3) => {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(size);
      (doc.splitTextToSize(text, contentW) as string[]).forEach((ln) => {
        doc.text(ln, center, y, { align: "center" });
        y += lh;
      });
    };
    const left = (text: string, bold = false) => {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(BODY);
      (doc.splitTextToSize(text, contentW) as string[]).forEach((ln) => {
        doc.text(ln, M, y);
        y += LH;
      });
    };
    // Label on the left, amount on the right; drops the amount to its own
    // line when the two wouldn't fit side by side on the roll.
    const pair = (label: string, value: string, bold = false, size = BODY) => {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(size);
      const fits = doc.getTextWidth(label) + doc.getTextWidth(value) + 8 <= contentW;
      doc.text(label, M, y);
      if (!fits) y += size + 3;
      doc.text(value, W - M, y, { align: "right" });
      y += size + 4;
    };

    if (logo) {
      const maxW = 150,
        maxH = 70;
      const ratio = Math.min(maxW / logo.width, maxH / logo.height, 1);
      const w = logo.width * ratio,
        h = logo.height * ratio;
      doc.addImage(logo.dataUrl, "PNG", center - w / 2, y, w, h);
      y += h + 14;
    } else {
      y += 4;
    }

    centered(data.company.name || "Company", 14, true, 17);
    if (data.company.address) centered(data.company.address, 8.5, false, 11);
    const contact = [data.company.phone, data.company.email].filter(Boolean).join(" · ");
    if (contact) centered(contact, 8.5, false, 11);

    y += 3;
    rule(true);
    centered(data.is_pr ? "PR — COMPLIMENTARY" : "SALES RECEIPT", 12, true, 15);
    if (data.is_pr) centered("NO CHARGE", 9, true, 12);
    y += 2;
    left(`Invoice: ${data.invoice_number}`);
    left(`Date: ${data.sale_date}`);
    y -= 2;
    rule(true);

    left(`Customer: ${data.customer.name || "Walk-in"}`, true);
    if (data.customer.phone) left(`Phone: ${data.customer.phone}`);
    if (data.customer.address) left(`Address: ${data.customer.address}`);
    y -= 2;
    rule(true);

    data.items.forEach((it) => {
      left(it.name, true);
      pair(`${it.quantity} ${it.unit} x ${cur(it.unit_price)}`, cur(it.line_total));
      y += 3;
    });

    y -= 2;
    rule(true);
    if (data.is_pr) {
      pair("Value issued", cur(data.subtotal));
      pair("NOT BILLED", "N/A", true, 11);
    } else {
      pair("Subtotal", cur(data.subtotal));
      if (data.discount > 0) pair("Discount", `-${cur(data.discount)}`);
      if (data.vat > 0) pair("VAT", cur(data.vat));
      y += 2;
      pair("TOTAL", cur(data.grand_total), true, 12);
      y += 2;
      pair("Amount Paid", cur(data.amount_paid));
      pair("Balance Due", cur(data.balance), data.balance > 0);
    }

    y += 1;
    rule(true);
    if (data.sales_person) left(`Sales person: ${data.sales_person}`);
    if (data.remarks) left(`Remarks: ${data.remarks}`);

    y += 8;
    centered("Thank you for your patronage!", 10, true, 13);
    y += 10;

    return y;
  };

  // Lay it out once on a long scratch page to measure, then print on a page
  // cut to exactly that length.
  const scratch = new jsPDF({ unit: "pt", format: [W, 5000] });
  const finalY = draw(scratch);
  const doc = new jsPDF({ unit: "pt", format: [W, Math.max(finalY, W + 1)] });
  draw(doc);

  outputPdf(doc, `${data.invoice_number}.pdf`, action);
}

export async function generateReceiptPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      logo_url?: string | null;
    };
    receipt_number: string;
    payment_date: string;
    customer_name?: string | null;
    invoice_number?: string | null;
    amount: number;
    payment_method: string;
    // Present when the payment was split across more than one method — one
    // receipt still covers the whole transaction, listing each method's
    // share instead of a single "Payment method: X" line.
    breakdown?: { method: string; amount: number }[];
    received_by?: string | null;
    remarks?: string | null;
    currency?: string;
  },
  action: PdfAction = "download",
) {
  // A4 (standard office printer paper) so the receipt fills the printout.
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = opts.currency ?? "NGN";
  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(16);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, top + 16);
  if (opts.company.phone) doc.text(opts.company.phone, 40, top + 30);

  doc.setFontSize(18);
  doc.text("RECEIPT", 555, top, { align: "right" });
  doc.setFontSize(10);
  doc.text(`# ${opts.receipt_number}`, 555, top + 16, { align: "right" });
  doc.text(`Date: ${opts.payment_date}`, 555, top + 30, { align: "right" });

  doc.setFontSize(11);
  let y = top + 80;
  doc.text(`Received from: ${opts.customer_name ?? "—"}`, 40, y);
  y += 18;
  if (opts.invoice_number) {
    doc.text(`Invoice: ${opts.invoice_number}`, 40, y);
    y += 18;
  }
  if (opts.breakdown && opts.breakdown.length > 1) {
    for (const line of opts.breakdown) {
      doc.text(`${line.method}: ${money(line.amount, currency)}`, 40, y);
      y += 16;
    }
    y += 8;
  } else {
    doc.text(`Payment method: ${opts.payment_method}`, 40, y);
    y += 24;
  }
  doc.setFontSize(20);
  doc.text(`Amount: ${money(opts.amount, currency)}`, 40, y);
  y += 30;
  doc.setFontSize(10);
  if (opts.received_by) {
    doc.text(`Received by: ${opts.received_by}`, 40, y);
    y += 18;
  }
  if (opts.remarks) doc.text(`Remarks: ${opts.remarks}`, 40, y);

  outputPdf(doc, `${opts.receipt_number}.pdf`, action);
}

export async function generateProductionSlipPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      logo_url?: string | null;
    };
    production_number: string;
    production_date: string;
    product_name: string;
    quantity_produced: number;
    unit: string;
    production_cost: number;
    supervisor?: string | null;
    batch_number?: string | null;
    remarks?: string | null;
    currency?: string;
    department?: string | null;
    status?: string;
    packaging_unit?: string | null;
    packaging_quantity?: number | null;
    accepted_quantity?: number | null;
    damaged_quantity?: number | null;
    rejected_quantity?: number | null;
    confirmed_at?: string | null;
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a5" });
  const currency = opts.currency ?? "NGN";
  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(16);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, top + 16);
  if (opts.company.phone) doc.text(opts.company.phone, 40, top + 30);

  doc.setFontSize(18);
  doc.text("PRODUCTION REPORT", 380, top, { align: "right" });
  doc.setFontSize(10);
  doc.text(`# ${opts.production_number}`, 380, top + 16, { align: "right" });
  doc.text(`Date: ${opts.production_date}`, 380, top + 30, { align: "right" });

  doc.setFontSize(11);
  let y = top + 80;
  const rows: [string, string][] = [
    ["Product", opts.product_name],
    ...(opts.packaging_unit && opts.packaging_quantity != null
      ? [
          [
            "Quantity produced",
            `${opts.packaging_quantity} ${opts.packaging_unit} (${opts.quantity_produced} ${opts.unit})`,
          ] as [string, string],
        ]
      : [["Quantity produced", `${opts.quantity_produced} ${opts.unit}`] as [string, string]]),
    ["Production cost", money(opts.production_cost, currency)],
    ["Department", opts.department || "—"],
    ["Status / Approval", (opts.status ?? "").replace(/_/g, " ").toUpperCase() || "—"],
    ["User", opts.supervisor || "—"],
    ["Batch number", opts.batch_number || "—"],
  ];
  rows.forEach(([l, v]) => {
    doc.text(`${l}: ${v}`, 40, y);
    y += 20;
  });
  if (opts.remarks) {
    doc.setFontSize(10);
    doc.text(`Remarks: ${opts.remarks}`, 40, y + 10);
    y += 20;
  }

  // Store confirmation — only present once Store has actually acted on this batch.
  if (opts.confirmed_at) {
    y += 12;
    doc.setFontSize(11);
    doc.text("Store Confirmation", 40, y);
    y += 16;
    doc.setFontSize(10);
    const confRows: [string, string][] = [
      ["Confirmed on", new Date(opts.confirmed_at).toLocaleString()],
      ["Accepted", opts.accepted_quantity != null ? `${opts.accepted_quantity} ${opts.unit}` : "—"],
      ["Damaged", opts.damaged_quantity ? `${opts.damaged_quantity} ${opts.unit}` : "—"],
      ["Rejected", opts.rejected_quantity ? `${opts.rejected_quantity} ${opts.unit}` : "—"],
    ];
    confRows.forEach(([l, v]) => {
      doc.text(`${l}: ${v}`, 40, y);
      y += 18;
    });
  }

  y += 24;
  doc.setFontSize(9);
  doc.line(40, y, 200, y);
  doc.line(260, y, 420, y);
  y += 12;
  doc.text("Prepared by / Date", 40, y);
  doc.text("Store Confirmed by / Date", 260, y);

  outputPdf(doc, `${opts.production_number}.pdf`, action);
}

export async function generateDebtStatementPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      logo_url?: string | null;
    };
    customer: { name: string; phone?: string | null; address?: string | null };
    invoice_number?: string | null;
    products?: { name: string; quantity: number; unit_price: number; line_total: number }[];
    total_amount: number;
    amount_paid: number;
    outstanding: number;
    status: string;
    payments: {
      amount: number;
      payment_method: string;
      payment_date: string;
      received_by?: string | null;
    }[];
    currency?: string;
  },
  action: PdfAction = "print",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = opts.currency ?? "NGN";

  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(18);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, top + 18);
  if (opts.company.phone) doc.text(opts.company.phone, 40, top + 32);

  doc.setFontSize(20);
  doc.text("DEBT STATEMENT", 555, top, { align: "right" });
  doc.setFontSize(10);
  if (opts.invoice_number)
    doc.text(`Invoice: ${opts.invoice_number}`, 555, top + 18, { align: "right" });
  doc.text(`Status: ${opts.status.toUpperCase()}`, 555, top + 32, { align: "right" });

  doc.setFontSize(11);
  doc.text("Debtor:", 40, top + 60);
  doc.setFontSize(10);
  doc.text(opts.customer.name, 40, top + 74);
  if (opts.customer.phone) doc.text(opts.customer.phone, 40, top + 88);
  if (opts.customer.address) doc.text(opts.customer.address, 40, top + 102);

  let y = top + 130;
  if (opts.products && opts.products.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [["Product", "Qty", "Unit Price", "Total"]],
      body: opts.products.map((p) => [
        p.name,
        p.quantity.toString(),
        money(p.unit_price, currency),
        money(p.line_total, currency),
      ]),
      styles: { fontSize: 10 },
      headStyles: { fillColor: [30, 41, 59] },
    });
    // @ts-expect-error autoTable augments doc
    y = doc.lastAutoTable.finalY + 20;
  }

  const summaryRows: [string, string][] = [
    ["Total amount", money(opts.total_amount, currency)],
    ["Amount paid", money(opts.amount_paid, currency)],
    ["Outstanding", money(opts.outstanding, currency)],
  ];
  summaryRows.forEach(([l, v], i) => {
    doc.setFont("helvetica", l === "Outstanding" ? "bold" : "normal");
    doc.text(l, 400, y + i * 16);
    doc.text(v, 555, y + i * 16, { align: "right" });
  });
  doc.setFont("helvetica", "normal");
  y += summaryRows.length * 16 + 24;

  if (opts.payments.length > 0) {
    doc.setFontSize(11);
    doc.text("Payment history", 40, y);
    y += 10;
    autoTable(doc, {
      startY: y,
      head: [["Date", "Amount", "Method", "Received by"]],
      body: opts.payments.map((p) => [
        p.payment_date,
        money(p.amount, currency),
        p.payment_method,
        p.received_by || "—",
      ]),
      styles: { fontSize: 10 },
      headStyles: { fillColor: [30, 41, 59] },
    });
  }

  outputPdf(doc, `Statement-${opts.customer.name.replace(/\s+/g, "-")}.pdf`, action);
}

export async function generateStockCardPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      logo_url?: string | null;
    };
    title: string;
    item_name: string;
    unit: string;
    current_stock: number;
    // Omitted on raw material cards — inventory tracks quantities, not cost.
    unit_cost?: number;
    total_value: number;
    reorder_level?: number | null;
    extra?: [string, string][];
    movements: {
      date: string;
      type: string;
      quantity: number;
      reference?: string | null;
      reason?: string | null;
      user?: string | null;
    }[];
    currency?: string;
  },
  action: PdfAction = "print",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = opts.currency ?? "NGN";

  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(18);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, top + 18);
  if (opts.company.phone) doc.text(opts.company.phone, 40, top + 32);

  doc.setFontSize(20);
  doc.text(opts.title.toUpperCase(), 555, top, { align: "right" });
  doc.setFontSize(10);
  doc.text(opts.item_name, 555, top + 18, { align: "right" });

  doc.setFontSize(11);
  doc.text("Snapshot", 40, top + 60);
  doc.setFontSize(10);
  const rows: [string, string][] = [
    ["Current stock", `${opts.current_stock} ${opts.unit}`],
    ...(opts.unit_cost != null
      ? [["Unit cost", money(opts.unit_cost, currency)] as [string, string]]
      : []),
    ["Total value", money(opts.total_value, currency)],
    ...(opts.reorder_level != null
      ? [["Reorder level", `${opts.reorder_level} ${opts.unit}`] as [string, string]]
      : []),
    ...(opts.extra ?? []),
  ];
  let y = top + 74;
  rows.forEach(([l, v]) => {
    doc.text(`${l}: ${v}`, 40, y);
    y += 16;
  });

  y += 16;
  if (opts.movements.length > 0) {
    doc.setFontSize(11);
    doc.text("Stock movement history", 40, y);
    y += 10;
    autoTable(doc, {
      startY: y,
      head: [["Date", "Type", "Qty", "Reference", "Reason", "User"]],
      body: opts.movements.map((m) => [
        m.date,
        m.type,
        m.quantity.toString(),
        m.reference || "—",
        m.reason || "—",
        m.user || "—",
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
    });
  }

  outputPdf(
    doc,
    `${opts.title.replace(/\s+/g, "-")}-${opts.item_name.replace(/\s+/g, "-")}.pdf`,
    action,
  );
}

export async function generateExpenseVoucherPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      logo_url?: string | null;
    };
    expense_date: string;
    category?: string | null;
    description?: string | null;
    vendor?: string | null;
    receipt_number?: string | null;
    payment_method: string;
    amount: number;
    requested_by?: string | null;
    approval_status?: string;
    approved_by?: string | null;
    recorded_by?: string | null;
    remarks?: string | null;
    currency?: string;
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a5" });
  const currency = opts.currency ?? "NGN";

  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(16);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, top + 16);
  if (opts.company.phone) doc.text(opts.company.phone, 40, top + 30);

  doc.setFontSize(18);
  doc.text("EXPENSE VOUCHER", 380, top, { align: "right" });
  doc.setFontSize(10);
  if (opts.receipt_number)
    doc.text(`Ref: ${opts.receipt_number}`, 380, top + 16, { align: "right" });
  doc.text(`Date: ${opts.expense_date}`, 380, top + 30, { align: "right" });

  doc.setFontSize(11);
  let y = top + 80;
  const rows: [string, string][] = [
    ["Category", opts.category || "—"],
    ["Description", opts.description || "—"],
    ["Vendor", opts.vendor || "—"],
    ["Payment method", opts.payment_method],
    ["Requested by", opts.requested_by || "—"],
    ["Approval status", (opts.approval_status ?? "pending").toUpperCase()],
  ];
  rows.forEach(([l, v]) => {
    doc.text(`${l}: ${v}`, 40, y);
    y += 18;
  });

  doc.setFontSize(20);
  y += 10;
  doc.text(`Amount: ${money(opts.amount, currency)}`, 40, y);
  y += 30;

  doc.setFontSize(10);
  if (opts.approved_by) {
    doc.text(`Approved by: ${opts.approved_by}`, 40, y);
    y += 18;
  }
  if (opts.recorded_by) {
    doc.text(`Recorded by: ${opts.recorded_by}`, 40, y);
    y += 18;
  }
  if (opts.remarks) doc.text(`Remarks: ${opts.remarks}`, 40, y);

  outputPdf(doc, `Expense-${opts.receipt_number || opts.expense_date}.pdf`, action);
}

export async function generatePayslipPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      logo_url?: string | null;
    };
    employee: {
      code: string | null;
      name: string;
      department?: string | null;
      position?: string | null;
      bank_name?: string | null;
      account_number?: string | null;
    };
    period: string;
    payment_date?: string | null;
    payment_method?: string | null;
    basic_salary: number;
    housing_allowance: number;
    transport_allowance: number;
    meal_allowance: number;
    medical_allowance: number;
    utilities_allowance: number;
    other_allowances: number;
    overtime: number;
    gross_salary: number;
    paye: number;
    pension: number;
    loans: number;
    advance: number;
    other_deductions: number;
    net_salary: number;
    currency?: string;
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = opts.currency ?? "NGN";

  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(18);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  if (opts.company.address) doc.text(opts.company.address, 40, top + 18);
  if (opts.company.phone) doc.text(opts.company.phone, 40, top + 32);

  doc.setFontSize(20);
  doc.text("PAYSLIP", 555, top, { align: "right" });
  doc.setFontSize(10);
  doc.text(`Period: ${opts.period}`, 555, top + 18, { align: "right" });
  if (opts.payment_date) doc.text(`Paid: ${opts.payment_date}`, 555, top + 32, { align: "right" });

  doc.setFontSize(11);
  doc.text("Employee", 40, top + 60);
  doc.setFontSize(10);
  const empRows: [string, string][] = [
    ["Employee ID", opts.employee.code || "—"],
    ["Name", opts.employee.name],
    ["Department", opts.employee.department || "—"],
    ["Position", opts.employee.position || "—"],
    ["Bank", `${opts.employee.bank_name || "—"} · ${opts.employee.account_number || "—"}`],
  ];
  let y = top + 76;
  empRows.forEach(([l, v]) => {
    doc.text(`${l}: ${v}`, 40, y);
    y += 15;
  });

  autoTable(doc, {
    startY: y + 16,
    head: [["Earnings", "Amount", "Deductions", "Amount"]],
    body: [
      ["Basic salary", money(opts.basic_salary, currency), "PAYE", money(opts.paye, currency)],
      [
        "Housing allowance",
        money(opts.housing_allowance, currency),
        "Pension",
        money(opts.pension, currency),
      ],
      [
        "Transport allowance",
        money(opts.transport_allowance, currency),
        "Loans",
        money(opts.loans, currency),
      ],
      [
        "Productivity allowance",
        money(opts.meal_allowance, currency),
        "Advance",
        money(opts.advance, currency),
      ],
      [
        "Inconvenience allowance",
        money(opts.medical_allowance, currency),
        "Other deductions",
        money(opts.other_deductions, currency),
      ],
      ["Utilities allowance", money(opts.utilities_allowance, currency), "", ""],
      ["Other allowances", money(opts.other_allowances, currency), "", ""],
      ["Overtime", money(opts.overtime, currency), "", ""],
    ],
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  // @ts-expect-error autoTable augments doc
  const endY: number = doc.lastAutoTable.finalY + 20;
  doc.setFont("helvetica", "bold");
  doc.text(`Gross Salary: ${money(opts.gross_salary, currency)}`, 40, endY);
  doc.text(`Net Salary: ${money(opts.net_salary, currency)}`, 300, endY);
  doc.setFont("helvetica", "normal");
  if (opts.payment_method) doc.text(`Payment method: ${opts.payment_method}`, 40, endY + 20);

  outputPdf(doc, `Payslip-${opts.employee.name.replace(/\s+/g, "-")}-${opts.period}.pdf`, action);
}

export async function generateProductionRequestPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      logo_url?: string | null;
    };
    request_number: string;
    request_date: string;
    requested_by_name: string;
    department?: string | null;
    product_name: string;
    quantity_requested: number;
    unit: string;
    approval_status: string;
    approved_by_name?: string | null;
    approval_date?: string | null;
    materials_issued: boolean;
    issued_by_name?: string | null;
    issued_at?: string | null;
    production_status: string;
    materials: {
      name: string;
      quantity_requested: number;
      unit: string;
      quantity_issued: number;
    }[];
    remarks?: string | null;
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(18);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  let y = top + 18;
  if (opts.company.address) {
    doc.text(opts.company.address, 40, y);
    y += 14;
  }
  if (opts.company.phone) {
    doc.text(opts.company.phone, 40, y);
    y += 14;
  }

  doc.setFontSize(18);
  doc.text("PRODUCTION REQUEST / MATERIAL ISSUE", 555, top, { align: "right" });
  doc.setFontSize(10);
  doc.text(`# ${opts.request_number}`, 555, top + 18, { align: "right" });
  doc.text(`Date: ${opts.request_date}`, 555, top + 32, { align: "right" });

  y = Math.max(y, top + 60);
  doc.setFontSize(11);
  doc.text("Request Details", 40, y);
  y += 16;
  doc.setFontSize(10);
  const headerRows: [string, string][] = [
    ["Requested by", opts.requested_by_name],
    ["Department", opts.department || "—"],
    ["Product to be produced", opts.product_name],
    ["Quantity requested", `${opts.quantity_requested} ${opts.unit}`],
    ["Approval status", opts.approval_status.toUpperCase()],
    ["Approved by", opts.approved_by_name || "—"],
    [
      "Approval date/time",
      opts.approval_date ? new Date(opts.approval_date).toLocaleString() : "—",
    ],
    ["Materials issued", opts.materials_issued ? "Yes" : "No"],
    ["Issued by", opts.issued_by_name || "—"],
    ["Issued date/time", opts.issued_at ? new Date(opts.issued_at).toLocaleString() : "—"],
    ["Production status", opts.production_status.replace(/_/g, " ").toUpperCase()],
  ];
  headerRows.forEach(([l, v]) => {
    doc.text(`${l}:`, 40, y);
    doc.text(v, 220, y);
    y += 16;
  });

  y += 10;
  doc.setFontSize(11);
  doc.text("Raw Materials Required", 40, y);
  y += 8;
  autoTable(doc, {
    startY: y,
    head: [["#", "Material", "Qty Requested", "Qty Issued", "Unit"]],
    body: opts.materials.map((m, i) => [
      String(i + 1),
      m.name,
      m.quantity_requested.toString(),
      m.quantity_issued.toString(),
      m.unit,
    ]),
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  // @ts-expect-error autoTable augments doc
  let endY: number = doc.lastAutoTable.finalY + 24;
  if (opts.remarks) {
    doc.setFontSize(10);
    doc.text(`Remarks: ${opts.remarks}`, 40, endY);
    endY += 24;
  }

  endY += 20;
  doc.setFontSize(10);
  doc.text("Requested by: ____________________", 40, endY);
  doc.text("Approved by: ____________________", 320, endY);
  endY += 40;
  doc.text("Materials issued by: ____________________", 40, endY);
  doc.text("Received by: ____________________", 320, endY);

  outputPdf(doc, `${opts.request_number}.pdf`, action);
}

export async function generatePurchaseOrderPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      email?: string | null;
      logo_url?: string | null;
    };
    po_number: string;
    issued_at: string;
    issued_by_name: string;
    supplier: { name: string; phone?: string | null; address?: string | null } | null;
    material_name: string;
    quantity_ordered: number;
    quantity_received: number;
    unit: string;
    unit_cost: number | null;
    expected_delivery_date?: string | null;
    status: string;
    notes?: string | null;
    currency?: string;
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const currency = opts.currency ?? "NGN";

  const top = await drawLogoHeader(doc, opts.company.logo_url, 50);
  doc.setFontSize(18);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(10);
  let y = top + 18;
  if (opts.company.address) {
    doc.text(opts.company.address, 40, y);
    y += 14;
  }
  const contact = [opts.company.phone, opts.company.email].filter(Boolean).join(" · ");
  if (contact) {
    doc.text(contact, 40, y);
    y += 14;
  }

  doc.setFontSize(18);
  doc.text("PURCHASE ORDER", 555, top, { align: "right" });
  doc.setFontSize(10);
  doc.text(`# ${opts.po_number}`, 555, top + 18, { align: "right" });
  doc.text(`Date: ${opts.issued_at}`, 555, top + 32, { align: "right" });
  doc.text(`Status: ${opts.status.replace(/_/g, " ").toUpperCase()}`, 555, top + 46, {
    align: "right",
  });

  y = Math.max(y, top + 70);
  doc.setFontSize(11);
  doc.text("Supplier", 40, y);
  y += 16;
  doc.setFontSize(10);
  doc.text(opts.supplier?.name ?? "—", 40, y);
  y += 14;
  if (opts.supplier?.phone) {
    doc.text(opts.supplier.phone, 40, y);
    y += 14;
  }
  if (opts.supplier?.address) {
    doc.text(opts.supplier.address, 40, y);
    y += 14;
  }

  y += 16;
  doc.setFontSize(11);
  doc.text("Order Details", 40, y);
  y += 8;
  autoTable(doc, {
    startY: y,
    head: [["Material", "Qty Ordered", "Qty Received", "Unit", "Unit Cost", "Line Total"]],
    body: [
      [
        opts.material_name,
        opts.quantity_ordered.toString(),
        opts.quantity_received.toString(),
        opts.unit,
        opts.unit_cost != null ? pdfMoney(opts.unit_cost, currency) : "—",
        opts.unit_cost != null ? pdfMoney(opts.unit_cost * opts.quantity_ordered, currency) : "—",
      ],
    ],
    styles: { fontSize: 10 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  // @ts-expect-error autoTable augments doc
  let endY: number = doc.lastAutoTable.finalY + 20;
  doc.setFontSize(10);
  doc.text(`Expected delivery: ${opts.expected_delivery_date ?? "—"}`, 40, endY);
  endY += 16;
  doc.text(`Issued by: ${opts.issued_by_name}`, 40, endY);
  endY += 16;
  if (opts.notes) {
    doc.text(`Notes: ${opts.notes}`, 40, endY);
    endY += 16;
  }

  endY += 30;
  doc.text("Authorized by: ____________________", 40, endY);
  doc.text("Supplier acknowledgement: ____________________", 320, endY);

  outputPdf(doc, `${opts.po_number}.pdf`, action);
}

export async function generateReportPdf(
  title: string,
  columns: { key: string; label: string }[],
  rows: Record<string, unknown>[],
  action: PdfAction = "download",
  company?: { name?: string | null; logo_url?: string | null } | null,
) {
  const doc = new jsPDF({
    unit: "pt",
    format: "a4",
    orientation: columns.length > 6 ? "landscape" : "portrait",
  });
  const top = await drawLogoHeader(doc, company?.logo_url, 40);
  let y = top;
  if (company?.name) {
    doc.setFontSize(10);
    doc.text(company.name, 40, y);
    y += 16;
  }
  doc.setFontSize(16);
  doc.text(title, 40, y);
  y += 16;
  doc.setFontSize(9);
  doc.text(`Generated ${new Date().toLocaleString()}`, 40, y);
  y += 16;

  autoTable(doc, {
    startY: y,
    head: [columns.map((c) => c.label)],
    body: rows.map((r) => columns.map((c) => (r[c.key] == null ? "—" : String(r[c.key])))),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [30, 41, 59] },
  });

  outputPdf(doc, `${title.replace(/\s+/g, "-")}.pdf`, action);
}

// A titled statement made of sections of "label ...... value" lines, for the
// Executive Summary and the Profit & Loss statement.
export type StatementLine = {
  label: string;
  value: string;
  // total: bold with a rule above; sub: indented detail line
  kind?: "total" | "sub" | "grand";
};
export type StatementSection = { heading: string; lines: StatementLine[] };

export async function generateStatementPdf(
  opts: {
    title: string;
    period: string;
    company?: { name?: string | null; logo_url?: string | null } | null;
    sections: StatementSection[];
    note?: string;
  },
  action: PdfAction = "print",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const top = await drawLogoHeader(doc, opts.company?.logo_url, 40);
  let y = top;
  if (opts.company?.name) {
    doc.setFontSize(11);
    doc.text(opts.company.name, 40, y);
    y += 18;
  }
  doc.setFontSize(18);
  doc.text(opts.title, 40, y);
  y += 18;
  doc.setFontSize(10);
  doc.text(`Period: ${opts.period}`, 40, y);
  y += 14;
  doc.setFontSize(8);
  doc.setTextColor(110);
  doc.text(`Generated ${new Date().toLocaleString()}`, 40, y);
  doc.setTextColor(0);
  y += 14;

  opts.sections.forEach((section) => {
    autoTable(doc, {
      startY: y + 8,
      head: [[section.heading, ""]],
      body: section.lines.map((l) => [l.kind === "sub" ? `    ${l.label}` : l.label, l.value]),
      theme: "plain",
      styles: { fontSize: 10, cellPadding: { top: 3, bottom: 3, left: 4, right: 4 } },
      headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: "bold" },
      columnStyles: { 1: { halign: "right", cellWidth: 160 } },
      didParseCell: (data) => {
        if (data.section !== "body") return;
        const line = section.lines[data.row.index];
        if (line?.kind === "total" || line?.kind === "grand") data.cell.styles.fontStyle = "bold";
        if (line?.kind === "sub") data.cell.styles.textColor = 80;
        if (line?.kind === "grand") {
          data.cell.styles.fillColor = [241, 245, 249];
          data.cell.styles.fontSize = 11;
        }
      },
      didDrawCell: (data) => {
        const line = section.lines[data.row.index];
        if (data.section === "body" && (line?.kind === "total" || line?.kind === "grand")) {
          doc.setDrawColor(150);
          doc.line(data.cell.x, data.cell.y, data.cell.x + data.cell.width, data.cell.y);
        }
      },
    });
    // @ts-expect-error autoTable augments doc
    y = doc.lastAutoTable.finalY + 6;
  });

  if (opts.note) {
    doc.setFontSize(8);
    doc.setTextColor(110);
    doc.text(doc.splitTextToSize(opts.note, 515), 40, y + 14);
    doc.setTextColor(0);
  }

  outputPdf(
    doc,
    `${opts.title.replace(/\s+/g, "-")}-${opts.period.replace(/\s+/g, "-")}.pdf`,
    action,
  );
}

// Sales activity for a period: headline totals, units/value per product, then
// every transaction in the period (any status) with the products it carried.
export type SalesReportTransaction = {
  sale_date: string;
  invoice_number: string;
  customer: string;
  customer_type: string;
  sales_person: string | null;
  items: { name: string; quantity: number; unit: string }[];
  grand_total: number;
  amount_paid: number;
  balance: number;
  status: string;
  is_pr: boolean;
};

export async function generateSalesReportPdf(
  opts: {
    period: string;
    company?: { name?: string | null; logo_url?: string | null } | null;
    currency: string;
    summary: { label: string; value: string }[];
    products: { name: string; quantity: number; unit: string; value: number }[];
    transactions: SalesReportTransaction[];
  },
  action: PdfAction = "print",
) {
  const m = (n: number) => pdfMoney(n, opts.currency);
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const top = await drawLogoHeader(doc, opts.company?.logo_url, 40);
  let y = top;
  if (opts.company?.name) {
    doc.setFontSize(11);
    doc.text(opts.company.name, 40, y);
    y += 18;
  }
  doc.setFontSize(18);
  doc.text("Sales Report", 40, y);
  y += 18;
  doc.setFontSize(10);
  doc.text(`Period: ${opts.period}`, 40, y);
  y += 14;
  doc.setFontSize(8);
  doc.setTextColor(110);
  doc.text(`Generated ${new Date().toLocaleString()}`, 40, y);
  doc.setTextColor(0);
  y += 14;

  const lastY = () => {
    // @ts-expect-error autoTable augments doc
    return doc.lastAutoTable.finalY as number;
  };

  autoTable(doc, {
    startY: y + 8,
    head: [["Summary", ""]],
    body: opts.summary.map((s) => [s.label, s.value]),
    theme: "plain",
    tableWidth: 360,
    styles: { fontSize: 10, cellPadding: { top: 3, bottom: 3, left: 4, right: 4 } },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: "bold" },
    columnStyles: { 1: { halign: "right" } },
  });

  if (opts.products.length > 0) {
    autoTable(doc, {
      startY: lastY() + 14,
      head: [["Product (approved sales)", "Quantity", "Value"]],
      body: opts.products.map((p) => [p.name, `${p.quantity} ${p.unit}`, m(p.value)]),
      tableWidth: 480,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 41, 59] },
      columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
    });
  }

  autoTable(doc, {
    startY: lastY() + 14,
    head: [
      [
        "Date",
        "Invoice",
        "Customer",
        "Type",
        "Sales person",
        "Products",
        "Total",
        "Paid",
        "Balance",
        "Status",
      ],
    ],
    body:
      opts.transactions.length > 0
        ? opts.transactions.map((t) => [
            t.sale_date,
            t.invoice_number,
            t.customer,
            t.is_pr ? `${t.customer_type} (PR)` : t.customer_type,
            t.sales_person ?? "—",
            t.items.map((i) => `${i.name} × ${i.quantity} ${i.unit}`).join("\n"),
            m(t.grand_total),
            m(t.amount_paid),
            m(t.balance),
            t.status.replace(/_/g, " "),
          ])
        : [[{ content: "No sales in this period.", colSpan: 10 }]],
    styles: { fontSize: 8, valign: "top" },
    headStyles: { fillColor: [30, 41, 59] },
    columnStyles: {
      5: { cellWidth: 190 },
      6: { halign: "right" },
      7: { halign: "right" },
      8: { halign: "right" },
    },
  });

  outputPdf(doc, `Sales-Report-${opts.period.replace(/\s+/g, "-")}.pdf`, action);
}

// Customer account statement: advance / debt position for a period, with every
// ledger line (a sale and the advance drawn for it are one line). Built from the
// same Statement object the screen and CSV use, so all three always agree.
export async function generateCustomerStatementPdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      logo_url?: string | null;
    };
    customer: { name: string; phone?: string | null; address?: string | null };
    statement: import("./customer-account").Statement;
    periodLabel: string;
    pendingSales?: { invoice_number: string; grand_total: number }[];
    currency?: string;
  },
  action: PdfAction = "download",
) {
  const currency = opts.currency ?? "NGN";
  const cur = (n: number) => pdfMoney(n, currency);
  const st = opts.statement;
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const pageW = doc.internal.pageSize.getWidth();
  const right = pageW - 40;

  const top = await drawLogoHeader(doc, opts.company.logo_url, 44);
  doc.setFontSize(16);
  doc.text(opts.company.name, 40, top);
  doc.setFontSize(9);
  if (opts.company.address) doc.text(opts.company.address, 40, top + 14);
  if (opts.company.phone) doc.text(opts.company.phone, 40, top + 26);

  doc.setFontSize(18);
  doc.text("CUSTOMER ACCOUNT STATEMENT", right, top, { align: "right" });
  doc.setFontSize(9);
  doc.text(`Period: ${opts.periodLabel}`, right, top + 14, { align: "right" });
  doc.text(`Generated ${new Date().toLocaleString()}`, right, top + 26, { align: "right" });

  let y = top + 52;
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text(opts.customer.name, 40, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  if (opts.customer.phone) doc.text(opts.customer.phone, 40, y + 13);
  if (opts.customer.address) doc.text(opts.customer.address, 40, y + 25);

  // Position summary. Advance and debt are always separate lines — never netted.
  const summary: [string, string][] = [
    ["Advance brought forward", cur(st.opening.credit)],
    ["Debt brought forward", cur(st.opening.debt)],
    ["Advance received", cur(st.totals.advanceReceived)],
    ["Products collected", cur(st.totals.goodsCollected)],
    ["Advance used", cur(st.totals.advanceUsed)],
    ["Debt paid off", cur(st.totals.debtSettled)],
    ["Closing advance", cur(st.closing.credit)],
    ["Closing debt", cur(st.closing.debt)],
  ];
  const colW = 200;
  summary.forEach(([label, value], i) => {
    const col = Math.floor(i / 4);
    const row = i % 4;
    const x = 360 + col * colW;
    const isClosing = i >= 6;
    doc.setFont("helvetica", isClosing ? "bold" : "normal");
    doc.setFontSize(9);
    doc.text(label, x, y + row * 14);
    doc.text(value, x + colW - 20, y + row * 14, { align: "right" });
  });
  doc.setFont("helvetica", "normal");
  y += 4 * 14 + 14;

  const dateStr = (iso: string) => new Date(iso).toLocaleDateString("en-GB");
  const body: string[][] = [];
  if (opts.statement.range.from) {
    body.push([
      dateStr(`${opts.statement.range.from}T00:00:00`),
      "",
      "Balance brought forward",
      "",
      "",
      "",
      cur(st.opening.credit),
      cur(st.opening.debt),
    ]);
  }
  st.rows.forEach((r) =>
    body.push([
      dateStr(r.date),
      r.reference === "—" ? "" : r.reference,
      r.description,
      `${r.sign === "-" ? "-" : r.sign === "+" ? "+" : ""}${cur(r.amount)}`,
      r.paid && r.paid > 0 ? cur(r.paid) : "",
      r.advanceUsed && r.advanceUsed > 0 ? cur(r.advanceUsed) : "",
      r.creditAfter === null ? "" : cur(r.creditAfter),
      r.debtAfter === null ? "" : cur(r.debtAfter),
    ]),
  );
  body.push(["", "", "Closing balance", "", "", "", cur(st.closing.credit), cur(st.closing.debt)]);

  autoTable(doc, {
    startY: y,
    head: [
      [
        "Date",
        "Reference",
        "Description",
        "Amount",
        "Paid",
        "Advance used",
        "Advance balance",
        "Debt balance",
      ],
    ],
    body,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [30, 41, 59] },
    columnStyles: {
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right" },
      6: { halign: "right" },
      7: { halign: "right" },
    },
    didParseCell: (d) => {
      if (d.section === "body" && d.row.index === body.length - 1) d.cell.styles.fontStyle = "bold";
    },
    didDrawPage: () => {
      const n = doc.getNumberOfPages();
      doc.setFontSize(8);
      doc.text(`Page ${n}`, right, doc.internal.pageSize.getHeight() - 20, { align: "right" });
    },
  });

  // @ts-expect-error autoTable augments doc
  let after: number = doc.lastAutoTable.finalY + 16;
  const pending = opts.pendingSales ?? [];
  if (pending.length > 0) {
    doc.setFontSize(8);
    doc.text(
      `${pending.length} sale(s) awaiting approval are not included above: ${pending
        .map((p) => `${p.invoice_number} (${cur(p.grand_total)})`)
        .join(", ")}.`,
      40,
      after,
      { maxWidth: pageW - 80 },
    );
    after += 14;
  }
  doc.setFontSize(8);
  doc.text(
    "Advance is money the customer has paid that has not yet been used against products. Debt is the value of products collected that has not yet been paid for. The two are shown separately.",
    40,
    after,
    { maxWidth: pageW - 80 },
  );

  outputPdf(doc, `Statement-${opts.customer.name.replace(/\s+/g, "-")}.pdf`, action);
}

export type GoodsReceivedNoteLine = {
  description: string;
  quantity_ordered: number | null;
  quantity_received: number;
  quantity_rejected: number;
  condition?: string | null;
  remark?: string | null;
  unit: string;
};

// Laid out like the printed Nextar GRN booklet: delivery details, items,
// quality inspection, discrepancies and the four signatory boxes.
export async function generateGoodsReceivedNotePdf(
  opts: {
    company: {
      name: string;
      address?: string | null;
      phone?: string | null;
      email?: string | null;
      logo_url?: string | null;
    };
    grn_number: string;
    date_received: string;
    time_received?: string | null;
    lpo_number?: string | null;
    supplier_name: string;
    supplier_phone?: string | null;
    vehicle_number?: string | null;
    driver_name?: string | null;
    delivery_note_number?: string | null;
    items: GoodsReceivedNoteLine[];
    overall_condition?: string | null;
    packaging_condition?: string | null;
    expiry_date?: string | null;
    discrepancies?: string | null;
    received_by_name: string;
    received_by_designation?: string | null;
    inspected_by_name?: string | null;
    inspected_by_designation?: string | null;
    delivered_by_name?: string | null;
    verified_by_name?: string | null;
    verified_by_designation?: string | null;
    status?: string | null;
  },
  action: PdfAction = "download",
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const left = 40;
  const right = pageW - 40;
  const navy: [number, number, number] = [16, 42, 112];

  const top = await drawLogoHeader(doc, opts.company.logo_url, 40, 150, 46);
  doc.setFontSize(9);
  doc.setTextColor(60);
  const contact = [opts.company.address, opts.company.phone, opts.company.email]
    .filter(Boolean)
    .join(" | ");
  if (contact) doc.text(contact, pageW / 2, top - 8, { align: "center" });
  doc.setTextColor(0);

  // Title band
  let y = top;
  doc.setFillColor(250, 204, 21);
  doc.rect(left, y, right - left, 24, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("GOODS RECEIVED NOTE (GRN)", pageW / 2, y + 16, { align: "center" });
  doc.setFontSize(10);
  doc.text(`GRN No. ${opts.grn_number}`, right - 8, y + 16, { align: "right" });
  doc.setFont("helvetica", "normal");
  y += 40;

  const field = (label: string, value: string | null | undefined, x: number, w: number) => {
    doc.setFontSize(8);
    doc.setTextColor(90);
    doc.text(label, x, y);
    doc.setTextColor(0);
    doc.setDrawColor(170);
    doc.roundedRect(x, y + 4, w, 20, 3, 3);
    doc.setFontSize(10);
    doc.text(value || "", x + 6, y + 18, { maxWidth: w - 12 });
  };

  const third = (right - left - 20) / 3;
  field("Date Received", opts.date_received, left, third);
  field("LPO No.", opts.lpo_number, left + third + 10, third);
  field("Time Received", opts.time_received, left + 2 * (third + 10), third);
  y += 40;

  const section = (title: string) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...navy);
    doc.text(title, left, y);
    doc.setTextColor(0);
    doc.setFont("helvetica", "normal");
    y += 10;
  };

  section("SUPPLIER DETAILS");
  const half = (right - left - 10) / 2;
  field("Supplier Name", opts.supplier_name, left, half);
  field("Phone", opts.supplier_phone, left + half + 10, half);
  y += 34;
  field("Vehicle No.", opts.vehicle_number, left, third);
  field("Driver / Delivery Person", opts.driver_name, left + third + 10, third);
  field("Delivery Note / Invoice No.", opts.delivery_note_number, left + 2 * (third + 10), third);
  y += 40;

  section("ITEMS RECEIVED");
  const qty = (n: number | null) => (n == null ? "" : n.toLocaleString());
  autoTable(doc, {
    startY: y,
    margin: { left, right: pageW - right },
    head: [
      [
        "S/No.",
        "Item Description",
        "Qty Ordered",
        "Qty Received",
        "Qty Rejected",
        "Condition",
        "Remark",
        "Unit",
      ],
    ],
    body: opts.items.map((it, i) => [
      String(i + 1),
      it.description,
      qty(it.quantity_ordered),
      qty(it.quantity_received),
      qty(it.quantity_rejected),
      it.condition ?? "",
      it.remark ?? "",
      it.unit,
    ]),
    styles: { fontSize: 9, cellPadding: 5 },
    headStyles: { fillColor: navy, fontSize: 8 },
    columnStyles: {
      0: { cellWidth: 34 },
      2: { halign: "right" },
      3: { halign: "right" },
      4: { halign: "right" },
    },
  });
  // @ts-expect-error autoTable augments doc
  y = doc.lastAutoTable.finalY + 20;

  const checkboxes = (
    label: string,
    options: string[],
    selected: string | null | undefined,
    x: number,
  ) => {
    doc.setFontSize(9);
    doc.text(label, x, y);
    let cx = x;
    options.forEach((o) => {
      doc.setDrawColor(90);
      doc.rect(cx, y + 6, 9, 9);
      if (selected && selected.toLowerCase() === o.toLowerCase()) {
        doc.line(cx + 1.5, y + 7.5, cx + 7.5, y + 13.5);
        doc.line(cx + 7.5, y + 7.5, cx + 1.5, y + 13.5);
      }
      doc.text(o, cx + 13, y + 14);
      cx += doc.getTextWidth(o) + 28;
    });
  };

  section("QUALITY INSPECTION");
  checkboxes(
    "Overall Condition",
    ["Excellent", "Good", "Fair", "Poor"],
    opts.overall_condition,
    left,
  );
  checkboxes(
    "Packaging Condition",
    ["Intact", "Damaged", "Open"],
    opts.packaging_condition,
    left + 230,
  );
  doc.setFontSize(9);
  doc.text("Expiry Date", left + 420, y);
  doc.setFontSize(10);
  doc.text(opts.expiry_date || "DD / MM / YYYY", left + 420, y + 14);
  y += 34;

  section("DISCREPANCIES / OBSERVATIONS");
  doc.setFontSize(9);
  const notes = doc.splitTextToSize(opts.discrepancies || "", right - left - 12) as string[];
  const boxH = Math.max(36, notes.length * 12 + 12);
  doc.setDrawColor(170);
  doc.roundedRect(left, y, right - left, boxH, 3, 3);
  doc.text(notes, left + 6, y + 14);
  y += boxH + 16;

  // Signatories: two rows of two boxes, like the booklet.
  const sigBox = (
    title: string,
    name: string | null | undefined,
    designation: string | null | undefined,
    x: number,
  ) => {
    const h = 62;
    doc.setDrawColor(170);
    doc.roundedRect(x, y, half, h, 3, 3);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(title, x + 6, y + 13);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text("Name & Designation:", x + 6, y + 29);
    doc.setFontSize(9);
    doc.text([name, designation].filter(Boolean).join(" — "), x + 92, y + 29, {
      maxWidth: half - 98,
    });
    doc.setFontSize(8);
    doc.text("Sign / Date:", x + 6, y + 50);
    doc.line(x + 60, y + 51, x + half - 10, y + 51);
  };
  if (y + 140 > doc.internal.pageSize.getHeight() - 30) {
    doc.addPage();
    y = 40;
  }
  sigBox("Received by (Store Keeper)", opts.received_by_name, opts.received_by_designation, left);
  sigBox(
    "Inspected by (Internal Control)",
    opts.inspected_by_name,
    opts.inspected_by_designation,
    left + half + 10,
  );
  y += 72;
  sigBox("Delivered by (Supplier / Driver)", opts.delivered_by_name, null, left);
  sigBox(
    "Verified by (Security)",
    opts.verified_by_name,
    opts.verified_by_designation,
    left + half + 10,
  );
  y += 80;

  if (opts.status) {
    doc.setFontSize(8);
    doc.setTextColor(110);
    doc.text(`System status: ${opts.status}`, left, y);
    doc.setTextColor(0);
  }

  outputPdf(doc, `GRN-${opts.grn_number}.pdf`, action);
}
