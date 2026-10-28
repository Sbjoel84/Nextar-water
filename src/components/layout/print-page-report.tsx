import { Printer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { fmtDateTime } from "@/lib/format";

// "Print report" for whatever page is open: the page title, its summary
// figures and every table currently on screen (so the period, tab, search and
// filters the user picked carry over), laid out as a plain black-on-white
// report. Buttons, icons and the empty action columns are dropped. Printing
// goes through a hidden iframe, so the browser's dialog can also "Save as PDF".

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;

// Card title above a table, if there is one.
function tableHeading(table: Element, root: Element): string {
  let node: Element | null = table.parentElement;
  while (node && node !== root) {
    const title = node.querySelector(".leading-none.tracking-tight, h2, h3");
    if (title && title.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) {
      return title.textContent?.trim() ?? "";
    }
    node = node.parentElement;
  }
  return "";
}

function cleanTable(table: HTMLTableElement): string | null {
  const copy = table.cloneNode(true) as HTMLTableElement;
  copy.querySelectorAll("input, select, textarea").forEach((el) => {
    const v = (el as HTMLInputElement).value ?? "";
    el.replaceWith(document.createTextNode(v));
  });
  // Icons go; a button keeps its text (the #ID tags are buttons), so the
  // icon-only action buttons end up empty and their column is dropped below.
  copy.querySelectorAll("svg, [role=checkbox]").forEach((el) => el.remove());
  copy.querySelectorAll("button").forEach((el) => {
    el.replaceWith(document.createTextNode(el.textContent?.trim() ?? ""));
  });

  const rows = Array.from(copy.rows);
  if (rows.length === 0) return null;
  // Drop columns that are empty from top to bottom (the action-button column).
  const width = Math.max(...rows.map((r) => r.cells.length));
  for (let c = width - 1; c >= 0; c--) {
    const empty = rows.every((r) => !r.cells[c] || !r.cells[c].textContent?.trim());
    if (empty) rows.forEach((r) => r.cells[c] && r.deleteCell(c));
  }
  const bodyRows = Array.from(copy.tBodies).flatMap((b) => Array.from(b.rows));
  if (bodyRows.length === 0) return null;

  const cell = (td: HTMLTableCellElement, tag: "th" | "td") => {
    const align = td.className.includes("text-right") ? ' class="r"' : "";
    const span = td.colSpan > 1 ? ` colspan="${td.colSpan}"` : "";
    return `<${tag}${align}${span}>${esc(td.textContent?.replace(/\s+/g, " ").trim() ?? "")}</${tag}>`;
  };
  const head = copy.tHead
    ? Array.from(copy.tHead.rows)
        .map(
          (r) =>
            `<tr>${Array.from(r.cells)
              .map((c) => cell(c, "th"))
              .join("")}</tr>`,
        )
        .join("")
    : "";
  const body = bodyRows
    .map(
      (r) =>
        `<tr>${Array.from(r.cells)
          .map((c) => cell(c, "td"))
          .join("")}</tr>`,
    )
    .join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function buildReport(company: string): string | null {
  const root = document.querySelector("main");
  if (!root) return null;
  const title = root.querySelector("h1")?.textContent?.trim() || document.title;

  // Summary tiles: an uppercase label with the figure right below it.
  const figures = Array.from(root.querySelectorAll(".uppercase.tracking-wider"))
    .filter((l) => visible(l) && !l.closest("table"))
    .map((l) => ({
      label: l.textContent?.trim() ?? "",
      value: l.nextElementSibling?.textContent?.trim() ?? "",
    }))
    .filter((f) => f.label && f.value);

  const sections = Array.from(root.querySelectorAll("table"))
    .filter(visible)
    .map((t) => {
      const html = cleanTable(t as HTMLTableElement);
      return html ? { heading: tableHeading(t, root), html } : null;
    })
    .filter((s): s is { heading: string; html: string } => !!s);

  if (figures.length === 0 && sections.length === 0) return null;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; margin: 24px; font-size: 11px; }
  header { border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 16px; }
  .company { font-size: 12px; font-weight: bold; }
  h1 { font-size: 18px; margin: 4px 0; }
  .meta { color: #444; }
  .figures { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; }
  .fig { border: 1px solid #999; padding: 6px 8px; }
  .fig .l { font-size: 9px; text-transform: uppercase; color: #444; }
  .fig .v { font-size: 13px; font-weight: bold; margin-top: 2px; }
  h2 { font-size: 13px; margin: 18px 0 6px; }
  table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #eee; }
  .r { text-align: right; }
  @page { margin: 12mm; }
</style></head><body>
<header>
  ${company ? `<div class="company">${esc(company)}</div>` : ""}
  <h1>${esc(title)}</h1>
  <div class="meta">Printed ${esc(fmtDateTime(new Date()))}</div>
</header>
${
  figures.length
    ? `<div class="figures">${figures
        .map(
          (f) =>
            `<div class="fig"><div class="l">${esc(f.label)}</div><div class="v">${esc(f.value)}</div></div>`,
        )
        .join("")}</div>`
    : ""
}
${sections.map((s) => `${s.heading ? `<h2>${esc(s.heading)}</h2>` : ""}${s.html}`).join("\n")}
</body></html>`;
}

export function PrintPageReport() {
  const { data: factoryId } = useFactoryId();
  const settings = useFactorySettings(factoryId);

  const print = () => {
    const html = buildReport(settings.data?.company_name ?? "");
    if (!html) {
      toast.error("Nothing on this page to print yet");
      return;
    }
    const frame = document.createElement("iframe");
    frame.style.position = "fixed";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(html);
    doc.close();
    const win = frame.contentWindow!;
    win.onafterprint = () => frame.remove();
    win.focus();
    win.print();
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-2"
      onClick={print}
      title="Print a report of this page"
    >
      <Printer className="h-4 w-4" />
      <span className="hidden sm:inline">Print report</span>
    </Button>
  );
}
