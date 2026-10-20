import { useAccountsAdmin } from "@/lib/use-accounts-admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Factory } from "lucide-react";

// Factories are a fixed table baked into migrations (water only), not a
// user-editable concept -- so this is a read-only summary rather than a CRUD
// screen.
export function FactoryTab() {
  const { accounts, factories } = useAccountsAdmin();
  const activeUsers = (accounts.data ?? []).filter((a) => a.status === "active").length;
  const list = factories.data ?? [];

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {(list.length ? list : [{ id: "water", name: "Water Factory" }]).map((f) => (
        <Card key={f.id} className="rounded-2xl">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{f.name}</CardTitle>
            <Factory className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{activeUsers}</div>
            <p className="text-xs text-muted-foreground">active users</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
