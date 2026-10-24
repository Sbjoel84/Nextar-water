import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { Pin } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId } from "@/lib/use-factory";
import { useRealtimeInvalidate } from "@/lib/realtime";

// updates isn't in the generated Supabase types yet.
const db = supabase as any;

// A pinned update shows at the top of every page for this long after posting.
const PIN_WINDOW_MS = 24 * 60 * 60 * 1000;

type PinnedUpdate = {
  id: string;
  title: string;
  body: string;
  posted_by_name: string | null;
  created_at: string;
};

export function PinnedUpdatesBanner() {
  const { data: factoryId } = useFactoryId();
  useRealtimeInvalidate(["updates"], [["pinned-updates"]]);

  // Ticks every minute so an update drops off once its 24 hours are up,
  // without waiting for a refetch.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const pinned = useQuery({
    queryKey: ["pinned-updates", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const since = new Date(Date.now() - PIN_WINDOW_MS).toISOString();
      const { data, error } = await db
        .from("updates")
        .select("id,title,body,posted_by_name,created_at")
        .eq("factory_id", factoryId)
        .eq("pinned", true)
        .gte("created_at", since)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PinnedUpdate[];
    },
  });

  const live = (pinned.data ?? []).filter(
    (u) => now - new Date(u.created_at).getTime() < PIN_WINDOW_MS,
  );
  if (live.length === 0) return null;

  return (
    <div className="space-y-2 px-4 pt-4 md:px-6">
      {live.map((u) => (
        <Link
          key={u.id}
          to="/updates"
          className="flex items-start gap-3 rounded-2xl border border-primary/40 bg-primary/5 px-4 py-3 text-sm transition-colors hover:bg-primary/10"
        >
          <Pin className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{u.title}</p>
            <p className="line-clamp-2 whitespace-pre-wrap text-muted-foreground">{u.body}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {u.posted_by_name ?? "—"} ·{" "}
              {formatDistanceToNow(new Date(u.created_at), { addSuffix: true })}
            </p>
          </div>
        </Link>
      ))}
    </div>
  );
}
