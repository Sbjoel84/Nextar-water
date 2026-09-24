import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions, useIsSuperAdmin } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { useFactoryId } from "@/lib/use-factory";

// Mirrors the queue definitions on the Approval Center page
// (src/routes/_app.approvals.tsx) as lightweight counts, so the same "what's
// waiting on YOU, excluding your own submissions" logic can also drive the
// sidebar badges and the notification bell without duplicating 15 full-row
// queries. Each entry's `to` matches a real sidebar URL (src/lib/nav.ts) so
// counts can be grouped per nav item.
function useCurrentUserId() {
  return useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });
}

type PendingCountResult = { count: number | null; error: unknown };

// Each call site is a fixed, unconditional useQuery — `enabled` varies, the
// call itself never does, which is what the rules of hooks require. (Calling
// this from inside a .map() over a defs array would violate that rule even
// though the array is always the same length/order, so each category below
// gets its own explicit call instead of being generated in a loop.)
// Counts are scoped to the factory selected in the top bar, like the pages
// they link to -- otherwise a badge can point at an item that only exists in
// the other factory and the page shows nothing to act on.
type CountScope = { uid: string | null | undefined; factoryId: string | undefined };

function useCount(
  key: string,
  enabled: boolean,
  scope: CountScope,
  run: () => PromiseLike<PendingCountResult>,
) {
  return useQuery({
    queryKey: ["pending-attention", key, scope.uid, scope.factoryId],
    enabled: enabled && scope.uid !== undefined && !!scope.factoryId,
    queryFn: async () => {
      const { count, error } = await run();
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 15_000,
  });
}

export function usePendingAttention() {
  const { canApprove, canConfirm, canPost } = usePermissions();
  const { data: uid } = useCurrentUserId();
  const { data: factoryId } = useFactoryId();
  const scope: CountScope = { uid, factoryId };
  // approve_sale()/reject_sale() exempt an admin (super_admin) from the
  // self-approval block every other approver role is still under -- mirror
  // that here instead of hiding an admin's own sale from their own count.
  const isSuperAdmin = useIsSuperAdmin().data ?? false;

  const sales = useCount("sales", canApprove("sales"), scope, () => {
    const q = supabase
      .from("sales")
      .select("id", { count: "exact", head: true })
      .eq("factory_id", scope.factoryId ?? "")
      .eq("status", "pending_approval");
    return isSuperAdmin ? q : q.neq("created_by", uid ?? "");
  });
  const expenses = useCount("expenses", canApprove("expenses"), scope, () =>
    supabase
      .from("expenses")
      .select("id", { count: "exact", head: true })
      .eq("factory_id", scope.factoryId ?? "")
      .eq("status", "pending_approval")
      .neq("submitted_by", uid ?? ""),
  );
  // Write-offs waiting on this user's step: approve (pending_approval) and/or
  // post (approved).
  const debtStatuses = [
    ...(canApprove("debts") ? ["pending_approval"] : []),
    ...(canPost("debts") ? ["approved"] : []),
  ];
  const debts = useCount(`debts-${debtStatuses.join(",")}`, debtStatuses.length > 0, scope, () =>
    supabase
      .from("debts")
      .select("id", { count: "exact", head: true })
      .eq("factory_id", scope.factoryId ?? "")
      .in("writeoff_status", debtStatuses)
      .neq("writeoff_requested_by", uid ?? ""),
  );
  const payments = useCount("payments", canApprove("payments"), scope, () =>
    supabase
      .from("payments_received")
      .select("id", { count: "exact", head: true })
      .eq("factory_id", scope.factoryId ?? "")
      .eq("review_status", "pending")
      .neq("received_by", uid ?? ""),
  );
  const payroll = useCount("payroll", canApprove("payroll"), scope, () =>
    supabase
      .from("payroll")
      .select("id", { count: "exact", head: true })
      .eq("factory_id", scope.factoryId ?? "")
      .eq("status", "pending_approval")
      .neq("submitted_by", uid ?? ""),
  );
  const stockRaw = useCount("stock-raw", canApprove("raw-materials"), scope, () =>
    supabase
      .from("stock_adjustment_requests")
      .select("id", { count: "exact", head: true })
      .eq("factory_id", scope.factoryId ?? "")
      .eq("entity_type", "raw_material")
      .eq("status", "pending_approval")
      .neq("submitted_by", uid ?? ""),
  );
  const stockFinished = useCount("stock-finished", canApprove("finished-goods"), scope, () =>
    supabase
      .from("stock_adjustment_requests")
      .select("id", { count: "exact", head: true })
      .eq("factory_id", scope.factoryId ?? "")
      .eq("entity_type", "finished_good")
      .eq("status", "pending_approval")
      .neq("submitted_by", uid ?? ""),
  );
  const roleGrants = useCount("role-grants", canApprove("users"), scope, () =>
    supabase
      .from("role_grant_requests")
      .select("id", { count: "exact", head: true })
      .eq("review_status", "pending")
      .neq("requested_by", uid ?? ""),
  );
  const goodsReceipts = useCount("goods-receipts", canConfirm("goods-receiving"), scope, () =>
    supabase
      .from("goods_receipts")
      .select("id", { count: "exact", head: true })
      .eq("factory_id", scope.factoryId ?? "")
      .eq("status", "pending_confirmation")
      .neq("submitted_by", uid ?? ""),
  );
  const productionBatches = useCount("production-batches", canConfirm("production"), scope, () =>
    supabase
      .from("production")
      .select("id", { count: "exact", head: true })
      .eq("factory_id", scope.factoryId ?? "")
      .eq("status", "pending_confirmation")
      .neq("created_by", uid ?? ""),
  );
  const costingSheets = useCount("costing-sheets", canApprove("costing"), scope, () =>
    supabase
      .from("costing_sheets")
      .select("id", { count: "exact", head: true })
      .eq("factory_id", scope.factoryId ?? "")
      .eq("status", "pending_approval")
      .neq("created_by", uid ?? ""),
  );
  const productionRequests = useCount(
    "production-requests",
    canApprove("production-requests"),
    scope,
    () =>
      supabase
        .from("production_requests")
        .select("id", { count: "exact", head: true })
        .eq("factory_id", scope.factoryId ?? "")
        .eq("approval_status", "pending")
        .eq("request_type", "production_material")
        .neq("requested_by", uid ?? ""),
  );
  const purchaseRequests = useCount(
    "purchase-requests",
    canApprove("production-requests"),
    scope,
    () =>
      supabase
        .from("production_requests")
        .select("id", { count: "exact", head: true })
        .eq("factory_id", scope.factoryId ?? "")
        .eq("approval_status", "pending")
        .eq("request_type", "purchase")
        .neq("requested_by", uid ?? ""),
  );
  const staffDeductions = useCount("staff-deductions", canApprove("payroll"), scope, () =>
    supabase
      .from("staff_deductions")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .neq("submitted_by", uid ?? ""),
  );
  const staffLoans = useCount("staff-loans", canApprove("payroll"), scope, () =>
    supabase
      .from("staff_loans")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .neq("submitted_by", uid ?? ""),
  );

  const customerAdjustments = useCount("customer-adjustments", canApprove("customers"), scope, () =>
    (supabase as any)
      .from("customer_account_adjustments")
      .select("id", { count: "exact", head: true })
      .eq("factory_id", scope.factoryId ?? "")
      .eq("status", "pending_approval")
      .neq("submitted_by", uid ?? ""),
  );

  useRealtimeInvalidate(
    [
      "customer_account_adjustments",
      "sales",
      "expenses",
      "debts",
      "payments_received",
      "payroll",
      "stock_adjustment_requests",
      "role_grant_requests",
      "goods_receipts",
      "production",
      "costing_sheets",
      "production_requests",
      "staff_deductions",
      "staff_loans",
    ],
    [["pending-attention"]],
  );

  const results: { key: string; label: string; to: string; query: typeof expenses }[] = [
    {
      key: "customer-adjustments",
      label: "Customer account adjustments pending",
      to: "/customers",
      query: customerAdjustments,
    },
    { key: "sales", label: "Sales awaiting approval", to: "/sales", query: sales },
    { key: "expenses", label: "Expenses awaiting approval", to: "/expenses", query: expenses },
    { key: "debts", label: "Debt write-offs pending", to: "/cash-ledger/debts", query: debts },
    {
      key: "payments",
      label: "Payments awaiting confirmation",
      to: "/cash-ledger",
      query: payments,
    },
    { key: "payroll", label: "Payroll runs awaiting approval", to: "/payroll", query: payroll },
    {
      key: "stock-raw",
      label: "Raw material write-offs pending",
      to: "/raw-materials",
      query: stockRaw,
    },
    {
      key: "stock-finished",
      label: "Finished products write-offs pending",
      to: "/finished-goods",
      query: stockFinished,
    },
    { key: "role-grants", label: "Role changes pending", to: "/admin", query: roleGrants },
    {
      key: "goods-receipts",
      label: "Item receipts awaiting confirmation",
      to: "/raw-materials",
      query: goodsReceipts,
    },
    {
      key: "production-batches",
      label: "Production batches awaiting confirmation",
      to: "/finished-goods",
      query: productionBatches,
    },
    {
      key: "costing-sheets",
      label: "Costing sheets awaiting approval",
      to: "/costing",
      query: costingSheets,
    },
    {
      key: "production-requests",
      label: "Production requests awaiting approval",
      to: "/production-requests",
      query: productionRequests,
    },
    {
      key: "purchase-requests",
      label: "Purchase requests awaiting approval",
      to: "/procurement",
      query: purchaseRequests,
    },
    {
      key: "staff-deductions",
      label: "Staff deductions awaiting approval",
      to: "/employees",
      query: staffDeductions,
    },
    {
      key: "staff-loans",
      label: "Staff loans awaiting approval",
      to: "/employees",
      query: staffLoans,
    },
  ];

  const items = results
    .map((r) => ({ key: r.key, label: r.label, to: r.to, count: r.query.data ?? 0 }))
    .filter((i) => i.count > 0);

  const byUrl = new Map<string, number>();
  for (const item of items) byUrl.set(item.to, (byUrl.get(item.to) ?? 0) + item.count);

  const total = items.reduce((s, i) => s + i.count, 0);

  return { items, byUrl, total };
}
