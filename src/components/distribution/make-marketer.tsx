import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";
import { money } from "@/lib/format";
import { idMatches, refHex, shortRef } from "@/lib/ref";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type MakeResult = {
  result: "already" | "linked" | "created" | "second_account" | "account_only";
  name: string;
};

const RESULT_TEXT: Record<MakeResult["result"], (n: string) => string> = {
  already: (n) => `${n} is already a marketer`,
  linked: (n) => `${n} is now on the marketer list, linked to the existing marketer ${n}`,
  created: (n) => `${n} added to the marketer list`,
  second_account: (n) =>
    `${n} is now the marketer's account. ${n}'s older marketer account also had history, so it is kept and listed as "account only"`,
  account_only: (n) => `${n} is now on the marketer list`,
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
        // Database update 20261116100000 not applied yet: fall back to marking
        // the customer a marketer directly. Their sales, payments and debts
        // stay on the account and it shows on every marketer list ("account
        // only": not linked to a dispatch profile until the update is applied
        // and "Make marketer" is run again).
        const missing =
          error.code === "PGRST202" || /function .*make_customer_marketer/i.test(error.message);
        if (!missing) throw error;
        const { data: row, error: upErr } = await supabase
          .from("customers")
          .update({ customer_type: "marketer", registered: true })
          .eq("id", customerId)
          .select("name")
          .single();
        if (upErr) throw upErr;
        return { result: "account_only", name: row?.name ?? "Customer" } as MakeResult;
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
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
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

  // Several IDs or names can be pasted at once ("#A1E5F64F, #2C535A4B ..."):
  // a customer matches any one of them.
  const rows = useMemo(() => {
    const terms = q
      .split(/[s,;]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (terms.length === 0) return customers.data ?? [];
    return (customers.data ?? []).filter((c) =>
      terms.some((t) => {
        const hex = refHex(t);
        if (hex && idMatches(c.id, hex)) return true;
        return c.name.toLowerCase().includes(t) || (c.phone ?? "").includes(t);
      }),
    );
  }, [customers.data, q]);
  const pickedRows = (customers.data ?? []).filter((c) => picked.has(c.id));

  // One at a time, so each customer's result (linked / created) is reported.
  const makeAll = async () => {
    setRunning(true);
    let ok = 0;
    for (const c of pickedRows) {
      try {
        await make.mutateAsync(c.id);
        ok++;
      } catch {
        // useMakeMarketer already showed the error for this customer.
      }
    }
    setRunning(false);
    setPicked(new Set());
    if (ok > 0 && ok === pickedRows.length) onDone();
  };

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
      <Input
        placeholder="Search name, phone or ID, e.g. #A1E5F64F (paste several)…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="max-h-80 divide-y overflow-y-auto rounded-md border">
        {customers.isLoading ? (
          <p className="p-4 text-center text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">No customers match.</p>
        ) : (
          rows.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <Checkbox
                checked={picked.has(c.id)}
                onCheckedChange={(v) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(c.id);
                    else next.delete(c.id);
                    return next;
                  })
                }
              />
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {c.name}{" "}
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {shortRef(c.id)}
                  </span>
                </div>
                <div className="text-xs capitalize text-muted-foreground">
                  {c.customer_type.replace(/_/g, " ")}
                  {c.phone ? ` · ${c.phone}` : ""}
                  {c.debt > 0 && <span className="text-destructive"> · owes {money(c.debt)}</span>}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={make.isPending || running}
                onClick={() => make.mutate(c.id)}
              >
                Make marketer
              </Button>
            </div>
          ))
        )}
      </div>
      <DialogFooter className="gap-2">
        {rows.length > 0 && (
          <Button
            variant="ghost"
            onClick={() => setPicked(new Set(rows.map((c) => c.id)))}
            disabled={running}
          >
            Select all shown ({rows.length})
          </Button>
        )}
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
        <Button disabled={pickedRows.length === 0 || running} onClick={makeAll}>
          {running
            ? "Updating…"
            : `Make ${pickedRows.length || ""} marketer${pickedRows.length === 1 ? "" : "s"}`}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
