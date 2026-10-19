import { useEffect, useRef, useState } from "react";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { useIsAdmin } from "@/lib/permissions";
import { purgeRecycleBin } from "@/lib/recycle-bin";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

// Everything under /_app needs a signed-in user. Without this guard an expired
// or cleared session rendered the full shell with an empty sidebar and an
// "Access restricted" card on every page, and a fresh sign-in could still see
// the previous (signed-out) permissions from the query cache.
function AppLayout() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);
  const userId = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const goToLogin = () => navigate({ to: "/", replace: true });

    // A valid session is not enough: a suspended, deactivated or deleted
    // account keeps its session until it expires. Re-checked on every sign-in
    // and hourly token refresh, so a suspension takes effect mid-session too.
    // Local sign-out never needs the network, so a bad connection can't leave
    // the user bouncing between "/" and the shell.
    const admit = async (uid: string) => {
      const { data, error } = await supabase
        .from("profiles")
        .select("status")
        .eq("id", uid)
        .maybeSingle();
      if (!active) return;
      // Couldn't check (e.g. offline): let them in; the database still refuses
      // inactive accounts.
      if (error) return setReady(true);
      if (data?.status !== "active") {
        toast.error("Your account is not active. Contact an administrator.");
        userId.current = null;
        qc.clear();
        setReady(false);
        await supabase.auth.signOut({ scope: "local" });
        return goToLogin();
      }
      setReady(true);
    };

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (!data.session) return goToLogin();
      userId.current = data.session.user.id;
      admit(data.session.user.id);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!session) {
        if (event === "SIGNED_OUT") {
          userId.current = null;
          qc.clear();
          setReady(false);
          goToLogin();
        }
        return;
      }
      // A different person signed in (or first sign-in): drop everything
      // cached for the previous user, including permissions and roles.
      if (userId.current !== session.user.id) {
        userId.current = session.user.id;
        qc.clear();
      }
      // Supabase calls made inside this callback can deadlock the auth client,
      // so the status check runs on the next tick.
      setTimeout(() => admit(session.user.id), 0);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [navigate, qc]);

  if (!ready) return null;

  return (
    <SidebarProvider>
      <RecycleBinAutoPurge />
      <AppSidebar />
      <SidebarInset>
        <TopBar />
        <main className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

// Removes Recycle Bin entries past their 30 days once per session when an
// admin opens the app. There's no scheduler in this project, so this (plus the
// Recycle Bin tab itself) is what makes the 30-day purge actually happen.
function RecycleBinAutoPurge() {
  const isAdmin = useIsAdmin();
  const done = useRef(false);
  useEffect(() => {
    if (!isAdmin.data || done.current) return;
    done.current = true;
    purgeRecycleBin().catch(() => {
      // Retried on the next visit; nothing for the user to do.
    });
  }, [isAdmin.data]);
  return null;
}
