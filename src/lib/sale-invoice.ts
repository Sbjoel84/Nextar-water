import { supabase } from "@/integrations/supabase/client";
import { generateInvoicePdf, type PdfAction } from "@/lib/pdf";
import { toast } from "sonner";

type FactorySettings =
  | {
      company_name?: string | null;
      address?: string | null;
      phone?: string | null;
      email?: string | null;
      logo_url?: string | null;
      currency?: string | null;
    }
  | null
  | undefined;

// Loads a sale with its lines and renders its invoice/receipt. Shared by the
// Sales page and the accountant's confirmation on the Finance page.
export async function openSaleInvoice(
  saleId: string,
  settings: FactorySettings,
  action: PdfAction,
) {
  const { data, error } = await supabase
    .from("sales")
    .select("*, sale_items(quantity,unit_price,line_total,products(name,unit))")
    .eq("id", saleId)
    .single();
  if (error) {
    toast.error(error.message);
    return;
  }
  const s = data as any;
  await generateInvoicePdf(
    {
      company: {
        name: settings?.company_name ?? "FMIS",
        address: settings?.address,
        phone: settings?.phone,
        email: settings?.email,
        logo_url: settings?.logo_url,
      },
      invoice_number: s.invoice_number,
      sale_date: s.sale_date,
      customer: { name: s.customer_name, phone: s.customer_phone, address: s.customer_address },
      items: (s.sale_items ?? []).map((it: any) => ({
        name: it.products?.name ?? "-",
        quantity: Number(it.quantity),
        unit: it.products?.unit ?? "",
        unit_price: Number(it.unit_price),
        line_total: Number(it.line_total),
      })),
      subtotal: Number(s.subtotal),
      discount: Number(s.discount),
      vat: Number(s.vat),
      grand_total: Number(s.grand_total),
      amount_paid: Number(s.amount_paid),
      balance: Number(s.balance),
      currency: settings?.currency ?? "NGN",
      remarks: s.remarks,
      sales_person: s.sales_person,
      is_pr: s.is_pr,
    },
    action,
  );
}
