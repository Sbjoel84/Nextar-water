import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { usePendingAttention } from "@/lib/pending-attention";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GlobalSearch } from "./global-search";
import { useTheme } from "@/lib/theme";
import { Moon, Sun, LogOut, User as UserIcon, Bell } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

function NotificationsBell() {
  const { data: factoryId } = useFactoryId();
  const qc = useQueryClient();
  const { items: pendingItems, total: pendingTotal } = usePendingAttention();

  const notifications = useQuery({
    queryKey: ["notifications", factoryId],
    enabled: !!factoryId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications")
        .select("id,title,body,read,created_at")
        .eq("factory_id", factoryId!)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
  });

  // A factory-wide notification (user_id NULL) has one shared `read` flag
  // nobody can set, so each user's read state for those lives in
  // notification_reads. Resolves to an empty set if that migration isn't
  // applied yet.
  const broadcastReads = useQuery({
    queryKey: ["notifications", "reads"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("notification_reads")
        .select("notification_id");
      if (error) return new Set<string>();
      return new Set<string>(
        (data ?? []).map((r: { notification_id: string }) => r.notification_id),
      );
    },
  });

  // Approving/rejecting elsewhere resolves the matching approval notification
  // server-side. A resolved row is hidden by RLS, so its own change event never
  // reaches the other approvers — listen on the request tables as well.
  useRealtimeInvalidate(
    ["notifications", "stock_adjustment_requests", "delete_requests", "proposals"],
    [["notifications"]],
  );

  const isRead = (n: { id: string; read: boolean }) =>
    n.read || (broadcastReads.data?.has(n.id) ?? false);
  const unreadCount = (notifications.data ?? []).filter((n) => !isRead(n)).length;
  const badgeCount = unreadCount + pendingTotal;

  const markAllRead = async () => {
    const unreadIds = (notifications.data ?? []).filter((n) => !isRead(n)).map((n) => n.id);
    if (unreadIds.length === 0) return;
    const { error } = await supabase.rpc(
      "mark_notifications_read" as any,
      {
        p_ids: unreadIds,
      } as any,
    );
    if (error) {
      // Migration not applied yet: fall back to marking the user's own rows.
      const { error: updateError } = await supabase
        .from("notifications")
        .update({ read: true })
        .in("id", unreadIds);
      if (updateError) {
        toast.error(updateError.message);
        return;
      }
    }
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) markAllRead();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell className="h-4 w-4" />
          {badgeCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -right-1 -top-1 h-4 min-w-4 justify-center rounded-full px-1 text-[10px]"
            >
              {badgeCount > 99 ? "99+" : badgeCount}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        {pendingItems.length > 0 && (
          <>
            <DropdownMenuLabel>Needs Your Attention</DropdownMenuLabel>
            <div className="space-y-1 p-1">
              {pendingItems.map((item) => (
                <DropdownMenuItem key={item.key} asChild>
                  <Link to={item.to} className="flex items-center justify-between gap-2 text-sm">
                    <span>{item.label}</span>
                    <Badge variant="destructive" className="shrink-0">
                      {item.count}
                    </Badge>
                  </Link>
                </DropdownMenuItem>
              ))}
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="flex items-center justify-between">
          Notifications
          <Link to="/updates" className="text-xs font-normal text-primary hover:underline">
            See all
          </Link>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(notifications.data?.length ?? 0) === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">No notifications.</p>
        ) : (
          <ScrollArea className="h-80">
            <div className="space-y-1 p-1">
              {notifications.data!.map((n) => (
                <div
                  key={n.id}
                  className={`rounded-md p-2 text-sm ${isRead(n) ? "" : "bg-accent/50"}`}
                >
                  <div className="font-medium">{n.title}</div>
                  {n.body && <div className="text-xs text-muted-foreground">{n.body}</div>}
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TopBar() {
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const [email, setEmail] = useState<string>("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    toast.success("Signed out");
    navigate({ to: "/", replace: true });
  };

  const initials = (email || "?").slice(0, 2).toUpperCase();

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background/80 px-3 backdrop-blur">
      <SidebarTrigger className="h-9 w-9 shrink-0 border" title="Collapse / expand menu (Ctrl+B)" />
      <div className="ml-2 hidden md:flex items-center gap-2 max-w-sm w-full">
        <GlobalSearch />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <NotificationsBell />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-9 gap-2 px-2">
              <Avatar className="h-7 w-7">
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <span className="hidden md:inline text-sm">{email || "Account"}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>{email || "Signed in"}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate({ to: "/settings" })}>
              <UserIcon className="mr-2 h-4 w-4" /> Profile & settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut}>
              <LogOut className="mr-2 h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
