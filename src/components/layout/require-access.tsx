import type { ReactNode } from "react";
import { Navigate } from "@tanstack/react-router";
import { usePermissions, type ModuleKey } from "@/lib/permissions";
import { nav } from "@/lib/nav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";

export function RequireAccess({ module, children }: { module: ModuleKey; children: ReactNode }) {
  const { can, loading, loadFailed, reload } = usePermissions();
  if (loading) return null;
  if (loadFailed) {
    return (
      <Card className="rounded-2xl border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" /> Couldn&apos;t load your permissions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>This is a connection problem, not a restriction on your account.</p>
          <Button size="sm" onClick={() => reload()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!can(module, "view")) {
    // Sign-in always lands on /dashboard. A user limited to their own
    // department's page (new accounts are, by default) goes straight there
    // instead of to an "Access restricted" card.
    // Updates & Requests is open to everyone, so it's only the fallback: the
    // user's own work page (e.g. Account Overview for a cashier) comes first.
    if (module === "dashboard") {
      const items = nav.flatMap((g) => g.items);
      const canOpen = (it: (typeof items)[number]) =>
        (it.modules ?? [it.module]).some((m) => m && can(m, "view"));
      const home = items.find((it) => it.url !== "/updates" && canOpen(it)) ?? items.find(canOpen);
      if (home) return <Navigate to={home.url} replace />;
    }
    return (
      <div className="space-y-4">
        <Card className="rounded-2xl border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" /> Access restricted
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Your role doesn't have access to this module. Contact an Admin or Factory Manager if you
            believe this is a mistake.
          </CardContent>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}
