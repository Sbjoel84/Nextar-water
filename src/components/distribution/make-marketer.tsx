import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";
import { money } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type MakeResult = { result: "already" | "linked" | "created" | "second_account"; name: string };

const RESULT_TEXT: Record<MakeResult["result"], (n: string) => string> = {
  already: (n) => `${n} is already a marketer`,
  linked: (n) => `${n} is now on the marketer list, linked to the existing marketer ${n}`,
  created: (n) => `${n} added to the marketer list`,
  second_account: (n) =>
    `${n} is now a marketer account. The existing marketer ${n} already has its own history, so both accounts are kept`,
};

// Turns a customer record into a marketer's account (make_customer_marketer()):
// their sales, payments and debts stay where they are and now show on the
// marketer list and pages.
export function useMakeMarketer(factoryId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (customerId: string) => {
      const { data, error } = await (supabase as any).rpc("make_customer_marketer", {
        p_customer_id: customerId,
      });
      if (error) {
        if (/function .*make_customer_marketer/i.test(error.message))
          throw new Error("This needs the latest database update (make_customer_marketer).");
        throw error;
      }
      return data as MakeResult;
    },
    onSuccess: (res, customerId) => {
      toast.success(RESULT_TEXT[res.result](res.name));
      logAudit({
        action: "update",
        entity: "customers",
        entityId: customerId,
        factoryId,
        newValue: { customer_type: "marketer", result: res.result },
      });
      for (const key of [
        "dist-reps",
        "dist-marketer-accounts",
        "marketer-accounts",
        "credit-accounts",
        "customer-contact",
        "customers",
        "pos-customers",
      ])
        qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

// Marketers tab: pick any customer that isn't a marketer yet and add them.
export function AddCustomerAsMarketerDialog({
  factoryId,
  onDone,
}: {
  factoryId: string;
  onDone: () => void;
}) {
  const [q, setQ] = useState("");
  const make = useMakeMarketer(factoryId);

  const customers = useQuery({
    queryKey: ["customers", factoryId, "non-marketers"],
    queryFn: async () => {
      const db = supabase as any;
      const { data, error } = await db
        .from("customers")
        .select("id,name,phone,customer_type")
        .eq("factory_id", factoryId)
        .neq("customer_type", "marketer")
        .is("deleted_at", null)
        .order("name");
      if (error) throw error;
      const ids = (data ?? []).map((c: any) => c.id);
      const debts = ids.length
        ? await db
            .from("customer_account_summary")
            .select("customer_id,outstanding_debt")
            .in("customer_id", ids)
        : { data: [] };
      const owed = new Map<string, number>(
        (debts.data ?? []).map((d: any) => [d.customer_id, Number(d.outstanding_debt ?? 0)]),
      );
      return (data ?? []).map((c: any) => ({ ...c, debt: owed.get(c.id) ?? 0 })) as {
        id: string;
        name: string;
        phone: string | null;
        customer_type: string;
        debt: number;
      }[];
    },
  });

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (customers.data ?? []).filter(
      (c) => !t || c.name.toLowerCase().includes(t) || (c.phone ?? "").includes(t),
    );
  }, [customers.data, q]);

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Add existing customer as marketer</DialogTitle>
        <DialogDescription>
          For a marketer whose orders were posted under an ordinary customer record. Their sales,
          payments and debts stay on that account and will show on the marketer list. If a marketer
          with the same name already exists, the two are linked.
        </DialogDescription>
      </DialogHeader>
      <Input placeholder="Search customer…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="max-h-80 divide-y overflow-y-auto rounded-md border">
        {customers.isLoading ? (
          <p className="p-4 text-center text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">No customers match.</p>
        ) : (
          rows.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <div>
                <div className="font-medium">{c.name}</div>
                <div className="text-xs capitalize text-muted-foreground">
                  {c.customer_type.replace(/_/g, " ")}
                  {c.phone ? ` · ${c.phone}` : ""}
                  {c.debt > 0 && <span className="text-destructive"> · owes {money(c.debt)}</span>}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={make.isPending}
                onClick={() => make.mutate(c.id, { onSuccess: onDone })}
              >
                Make marketer
              </Button>
            </div>
          ))
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
