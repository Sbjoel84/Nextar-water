import { createFileRoute, Outlet, Link, useLocation } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PiggyBank } from "lucide-react";
import { useFactoryId } from "@/lib/use-factory";
import { usePermissions } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { AdvancePaymentDialog } from "@/components/finance/advance-payment-dialog";

export const Route = createFileRoute("/_app/cash-ledger")({
  head: () => ({
    meta: [{ title: "Cash & Receivables — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: CashLedgerLayout,
});

const TABS = [
  { to: "/cash-ledger", label: "Overview" },
  { to: "/cash-ledger/ledger", label: "Ledger" },
  { to: "/cash-ledger/debts", label: "Debts" },
];

function CashLedgerLayout() {
  const location = useLocation();
  const qc = useQueryClient();
  const { data: factoryId } = useFactoryId();
  const { canWrite } = usePermissions();
  // Same guard as record_customer_advance() server-side: the accountant
  // (payments/debts writer) takes customers' advance payments.
  const canRecordAdvance = canWrite("payments") || canWrite("debts");
  const [advanceOpen, setAdvanceOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cash & Receivables</h1>
          <p className="text-sm text-muted-foreground">
            Receipts, payments, cash flow, and outstanding debts in one place.
          </p>
        </div>
        {canRecordAdvance && (
          <Button variant="outline" className="gap-2" onClick={() => setAdvanceOpen(true)}>
            <PiggyBank className="h-4 w-4" /> Record Advance Payment
          </Button>
        )}
      </div>
      <div className="flex gap-1 border-b">
        {TABS.map((t) => {
          const active = location.pathname === t.to;
          return (
            <Link
              key={t.to}
              to={t.to}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? "text-foreground border-primary"
                  : "text-muted-foreground border-transparent hover:text-foreground"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
      <Outlet />

      <Dialog open={advanceOpen} onOpenChange={setAdvanceOpen}>
        {advanceOpen && factoryId && (
          <AdvancePaymentDialog
            factoryId={factoryId}
            onDone={() => {
              setAdvanceOpen(false);
              // The advance touches the customer account, payments_received and
              // debts, which every tab here (and the customer views) reads.
              qc.invalidateQueries();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
