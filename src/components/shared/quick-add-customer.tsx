import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Sentinel for the "+ Add new customer" entry at the bottom of a customer
// dropdown. Selects intercept it before touching state.
export const ADD_NEW_CUSTOMER = "__add_new_customer__";

// Creates the customer straight away (quick_add_customer RPC) so a payment
// can be recorded for someone who hasn't bought anything yet. If a customer
// with the same phone — or, with no phone, the same name — already exists,
// that one is returned instead of creating a duplicate.
export function QuickAddCustomerDialog({
  open,
  onOpenChange,
  factoryId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  factoryId: string;
  onCreated: (customer: { id: string; name: string }) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");

  const reset = () => {
    setName("");
    setPhone("");
    setAddress("");
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Enter the customer's name");
      const { data, error } = await supabase.rpc(
        "quick_add_customer" as any,
        {
          payload: { factory_id: factoryId, name: name.trim(), phone, address },
        } as any,
      );
      if (error) throw error;
      return data as { id: string; existing: boolean };
    },
    onSuccess: (res) => {
      toast.success(
        res.existing ? `${name.trim()} is already a customer — selected` : "Customer added",
      );
      qc.invalidateQueries({
        predicate: (q) => String(q.queryKey[0] ?? "").startsWith("customers"),
      });
      onCreated({ id: res.id, name: name.trim() });
      reset();
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add new customer</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label>Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <Label>Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div>
            <Label>Address</Label>
            <Input value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">
            The customer is saved to the Customers page right away.
          </p>
        </div>
        <DialogFooter>
          <Button disabled={save.isPending || !name.trim()} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Add customer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
