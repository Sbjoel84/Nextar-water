import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { beep, unlockAudioOnInteraction } from "@/lib/beep";

// Beeps and pops a toast whenever a notification addressed to the signed-in
// user arrives: a request sent to them, a reply on their thread, a decision,
// an approval waiting for them. Factory-wide broadcasts (user_id NULL) don't
// need anyone to act, so they stay silent.
export function NotificationAlerts() {
  const navigate = useNavigate();

  useEffect(() => {
    const unlock = unlockAudioOnInteraction();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let active = true;

    supabase.auth.getUser().then(({ data }) => {
      const uid = data.user?.id;
      if (!active || !uid) return;
      channel = supabase
        .channel(`alerts:${uid}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "notifications",
            filter: `user_id=eq.${uid}`,
          },
          (payload) => {
            const n = payload.new as { title?: string; body?: string | null };
            beep();
            const toRequests = /request|proposal|reply on PRP-/i.test(n.title ?? "");
            toast(n.title ?? "New notification", {
              description: n.body ?? undefined,
              action: toRequests
                ? { label: "Open", onClick: () => navigate({ to: "/updates" }) }
                : undefined,
            });
          },
        )
        .subscribe();
    });

    return () => {
      active = false;
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      if (channel) supabase.removeChannel(channel);
    };
  }, [navigate]);

  return null;
}
