import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { usePermissions } from "@/lib/permissions";
import { money } from "@/lib/format";
import { matchesSearch, useSearchQuery } from "@/lib/search";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Pencil } from "lucide-react";
import { RefId } from "@/components/shared/ref-id";
import { SearchBox } from "@/components/shared/search-box";

type Distributor = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  contact_person: string | null;
  area: string | null;
  outstanding_balance: number;
  credit_balance: number;
  total_purchases: number;
};

// Distributors are customers with customer_type 'distributor' — registered
// here, they're what the Sales & POS box lists when "Distributor" is picked.
// Reads/writes go through list_distributors()/save_distributor() so a
// distribution user doesn't also need Customers page permissions.
export function DistributorsTab({ factoryId }: { factoryId: string }) {
  const qc = useQueryClient();
  const perms = usePermissions();
  const canCreate = perms.canCreate("distribution") || perms.canWrite("customers");
  const canEdit = perms.canEdit("distribution") || perms.canWrite("customers");
  const [q, setQ] = useSearchQuery();
  const [editing, setEditing] = useState<Distributor | null>(null);
  const [open, setOpen] = useState(false);

  const list = useQuery({
    queryKey: ["distributors", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_distributors", {
        p_factory_id: factoryId,
      });
      if (error) throw error;
      return (data ?? []) as Distributor[];
    },
  });
  const rows = (list.data ?? []).filter((d) => matchesSearch(q, d));

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Distributors</CardTitle>
        {canCreate && (
          <Button
            size="sm"
            className="gap-2"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> Add Distributor
          </Button>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <SearchBox value={q} onChange={setQ} className="mb-3" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Contact person</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Area</TableHead>
              <TableHead>Address</TableHead>
              <TableHead className="text-right">Purchases</TableHead>
              <TableHead className="text-right">Owes</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isLoading ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                  {list.data?.length ? "No distributors match." : "No distributors yet."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <RefId id={d.id} />
                  </TableCell>
                  <TableCell className="font-medium">
                    {d.name}
                    {d.email && <div className="text-xs text-muted-foreground">{d.email}</div>}
                  </TableCell>
                  <TableCell>{d.contact_person ?? "—"}</TableCell>
                  <TableCell>{d.phone ?? "—"}</TableCell>
                  <TableCell>{d.area ?? "—"}</TableCell>
                  <TableCell className="max-w-[220px] truncate" title={d.address ?? undefined}>
                    {d.address ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">{money(Number(d.total_purchases))}</TableCell>
                  <TableCell className="text-right">
                    <span className={Number(d.outstanding_balance) > 0 ? "text-destructive" : ""}>
                      {money(Number(d.outstanding_balance))}
                    </span>
                  </TableCell>
                  <TableCell>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Edit"
                        onClick={() => {
                          setEditing(d);
                          setOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <DistributorForm
            factoryId={factoryId}
            editing={editing}
            onDone={() => {
              setOpen(false);
              qc.invalidateQueries({ queryKey: ["distributors"] });
              qc.invalidateQueries({ queryKey: ["customers-brief"] });
              qc.invalidateQueries({ queryKey: ["pos-customers"] });
              qc.invalidateQueries({ queryKey: ["customers"] });
            }}
          />
        )}
      </Dialog>
    </Card>
  );
}

function DistributorForm({
  factoryId,
  editing,
  onDone,
}: {
  factoryId: string;
  editing: Distributor | null;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    name: editing?.name ?? "",
    contact_person: editing?.contact_person ?? "",
    phone: editing?.phone ?? "",
    email: editing?.email ?? "",
    area: editing?.area ?? "",
    address: editing?.address ?? "",
  });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error("Distributor name is required");
      const { error } = await supabase.rpc("save_distributor", {
        p_id: editing?.id ?? null,
        payload: { factory_id: factoryId, ...form },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(editing ? "Distributor updated" : "Distributor added");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{editing ? "Edit Distributor" : "Add Distributor"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label>Distributor / business name</Label>
          <Input value={form.name} onChange={(e) => set("name")(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Contact person</Label>
            <Input
              value={form.contact_person}
              onChange={(e) => set("contact_person")(e.target.value)}
            />
          </div>
          <div>
            <Label>Phone</Label>
            <Input value={form.phone} onChange={(e) => set("phone")(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Email</Label>
            <Input type="email" value={form.email} onChange={(e) => set("email")(e.target.value)} />
          </div>
          <div>
            <Label>Area / territory</Label>
            <Input value={form.area} onChange={(e) => set("area")(e.target.value)} />
          </div>
        </div>
        <div>
          <Label>Address</Label>
          <Textarea
            rows={2}
            value={form.address}
            onChange={(e) => set("address")(e.target.value)}
          />
        </div>
      </div>
      <DialogFooter>
        <Button disabled={save.isPending || !form.name.trim()} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : editing ? "Save Changes" : "Add Distributor"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
