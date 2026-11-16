import { createFileRoute } from "@tanstack/react-router";
import { RequireAccess } from "@/components/layout/require-access";
import { useFactoryId } from "@/lib/use-factory";
import { MarketerAccountsCard } from "@/components/finance/marketer-accounts";

export const Route = createFileRoute("/_app/cash-ledger/marketers")({
  head: () => ({
    meta: [{ title: "Marketer Accounts — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="debts">
      <MarketerAccountsPage />
    </RequireAccess>
  ),
});

function MarketerAccountsPage() {
  const { data: factoryId } = useFactoryId();
  if (!factoryId) return null;
  return <MarketerAccountsCard factoryId={factoryId} />;
}
