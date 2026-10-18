import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCustomerAccount } from "@/lib/customer-account";
import { money } from "@/lib/format";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type PaymentMethod = "cash" | "transfer" | "pos" | "card" | "cheque";
type Customer = { id: string; name: string; phone: string | null; address: string | null };

// Records money a registered customer pays. The server settles the customer's
// oldest debts first and only the excess becomes advance (record_customer_advance
// -> _customer_receive_money), so this dialog shows that split before saving.
export function AdvancePaymentDialog({ factoryId, onDone }: { factoryId: string; onDone: () => void }) {
  const customers = useQuery({
    queryKey: ["customers-brief", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("id,name,phone,address")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Customer[];
    },
  });

  const [customerId, setCustomerId] = useState("");
  const [amount, setAmount] = useState(0);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [remarks, setRemarks] = useState("");
  // One key per opening of this dialog: a double-click or a retry after a
  // dropped connection is recognised by the server and never posts twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const account = useCustomerAccount(customerId || undefined);
  const availableAdvance = account.data?.summary.available_advance ?? 0;
  const debt = account.data?.summary.outstanding_debt ?? 0;
  const settlesDebt = Math.min(amount, debt);
  const becomesAdvance = Math.max(amount - debt, 0);

  const submit = useMutation({
    mutationFn: async () => {
      if (!customerId) throw new Error("Select a customer");
      if (amount <= 0) throw new Error("Amount must be greater than 0");
      const { data, error } = await supabase.rpc("record_customer_advance", {
        payload: {
          factory_id: factoryId,
          customer_id: customerId,
          amount,
          payment_method: method,
          reference: reference || null,
          remarks: remarks || null,
          idempotency_key: idempotencyKey,
        } as any,
      });
      if (error) throw error;
      return data as {
        receipt_number: string;
        settled_debt?: number;
        credit_added?: number;
        duplicate?: boolean;
      };
    },
    onSuccess: (data) => {
      const settled = Number(data.settled_debt ?? 0);
      const added = Number(data.credit_added ?? 0);
      const parts = [
        settled > 0 ? `${money(settled)} cleared debt` : null,
        added > 0 ? `${money(added)} added to advance` : null,
      ].filter(Boolean);
      toast.success(
        `${data.duplicate ? "Already recorded" : "Payment recorded"} — receipt ${data.receipt_number}${
          parts.length ? ` (${parts.join(", ")})` : ""
        }`,
      );
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Record Advance Payment</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          For a customer paying ahead of picking up products. If they owe money, the oldest debts
          are settled first and only the excess becomes advance to draw on in New Order.
        </p>
        <div>
          <Label>Customer</Label>
          <Select value={customerId} onValueChange={setCustomerId}>
            <SelectTrigger>
              <SelectValue placeholder="Select a customer…" />
            </SelectTrigger>
            <SelectContent>
              {(customers.data ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {customerId && account.data && (
          <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 text-sm">
            <div>
              <span className="block text-muted-foreground">Available Advance</span>
              <span className={availableAdvance > 0 ? "font-medium text-success" : "font-medium"}>
                {money(availableAdvance)}
              </span>
            </div>
            <div>
              <span className="block text-muted-foreground">Outstanding Debt</span>
              <span className={debt > 0 ? "font-medium text-destructive" : "font-medium"}>
                {money(debt)}
              </span>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Amount</Label>
            <MoneyInput value={amount} onChange={setAmount} />
          </div>
          <div>
            <Label>Payment method</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["cash", "transfer", "pos", "card", "cheque"] as PaymentMethod[]).map((m) => (
                  <SelectItem key={m} value={m} className="capitalize">
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {customerId && amount > 0 && (
          <div className="space-y-1 rounded-md border p-3 text-sm">
            {debt > 0 && (
              <div className="flex justify-between">
                <span>Clears existing debt</span>
                <span className="text-success">{money(settlesDebt)}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>Added to advance</span>
              <span className={becomesAdvance > 0 ? "font-medium text-success" : ""}>
                {money(becomesAdvance)}
              </span>
            </div>
            <div className="flex justify-between border-t pt-1 text-xs text-muted-foreground">
              <span>Advance after this payment</span>
              <span>{money(availableAdvance + becomesAdvance)}</span>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Reference (optional)</Label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Transfer / POS / cheque no."
            />
          </div>
          <div>
            <Label>Date</Label>
            <Input value={new Date().toLocaleDateString()} disabled />
          </div>
        </div>
        <div>
          <Label>Notes (optional)</Label>
          <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? "Saving…" : "Record Payment"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
