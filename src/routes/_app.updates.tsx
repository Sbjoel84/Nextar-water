import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import {
  Bell,
  Check,
  Eye,
  Megaphone,
  MessageSquare,
  Pin,
  Plus,
  Reply,
  Send,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { RequireAccess } from "@/components/layout/require-access";
import { supabase } from "@/integrations/supabase/client";
import { useFactoryId, useFactorySettings } from "@/lib/use-factory";
import { useIsChairman, useIsAdmin, usePermissions } from "@/lib/permissions";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { money } from "@/lib/format";
import { PageHeader } from "@/lib/dashboard-kit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { MoneyInput } from "@/components/ui/money-input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_app/updates")({
  head: () => ({
    meta: [{ title: "Updates & Requests — FMIS" }, { name: "robots", content: "noindex" }],
  }),
  component: () => (
    <RequireAccess module="updates">
      <UpdatesPage />
    </RequireAccess>
  ),
});

// updates / proposals aren't in the generated Supabase types yet.
const db = supabase as any;

type UpdateRow = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  posted_by: string | null;
  posted_by_name: string | null;
  created_at: string;
};

type NotificationRow = {
  id: string;
  title: string;
  body: string | null;
  read: boolean;
  created_at: string;
};

type ProposalStatus = "pending" | "approved" | "rejected" | "cancelled";
type Priority = "low" | "normal" | "high" | "urgent";
type ProposalRow = {
  id: string;
  reference: string;
  kind: "request" | "proposal";
  title: string;
  details: string;
  amount: number | null;
  priority: Priority;
  status: ProposalStatus;
  requested_by: string;
  requested_by_name: string | null;
  requested_at: string;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_comment: string | null;
  recipients: string[];
  recipient_names: string[];
};

type MessageRow = {
  id: string;
  author_id: string;
  author_name: string | null;
  body: string;
  created_at: string;
};

const STATUS_BADGE: Record<ProposalStatus, "default" | "secondary" | "outline" | "destructive"> = {
  pending: "outline",
  approved: "secondary",
  rejected: "destructive",
  cancelled: "outline",
};
const PRIORITY_CLASS: Record<Priority, string> = {
  low: "text-muted-foreground",
  normal: "",
  high: "text-warning",
  urgent: "text-destructive font-semibold",
};

const ago = (d: string) => formatDistanceToNow(new Date(d), { addSuffix: true });
const when = (d: string) => format(new Date(d), "d MMM yyyy, HH:mm");

function useCurrentUserId() {
  return useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });
}

function UpdatesPage() {
  const { data: factoryId } = useFactoryId();
  const isChairman = useIsChairman().data ?? false;
  const { canSubmit } = usePermissions();
  useRealtimeInvalidate(
    ["updates", "proposals", "proposal_messages", "notifications"],
    [["updates-feed"], ["proposals"], ["proposal-messages"], ["notifications"]],
  );

  // Anyone a request was sent to gets the tab, not just senders and the Chairman.
  const visibleCount = useQuery({
    queryKey: ["proposals", "visible-count", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { count, error } = await db
        .from("proposals")
        .select("id", { count: "exact", head: true })
        .eq("factory_id", factoryId);
      if (error) throw error;
      return (count ?? 0) as number;
    },
  });

  const pendingCount = useQuery({
    queryKey: ["proposals", "pending-count", factoryId],
    enabled: !!factoryId,
    queryFn: async () => {
      const { count, error } = await db
        .from("proposals")
        .select("id", { count: "exact", head: true })
        .eq("factory_id", factoryId)
        .eq("status", "pending");
      if (error) throw error;
      return (count ?? 0) as number;
    },
  });

  // The chairman lands on what's waiting for them; everyone else on updates.
  const [tab, setTab] = useState<string | null>(null);

  if (!factoryId) return null;
  const showRequests = isChairman || canSubmit("updates") || (visibleCount.data ?? 0) > 0;
  const currentTab = tab ?? (isChairman && (pendingCount.data ?? 0) > 0 ? "requests" : "updates");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Updates & Requests"
        hint="Factory announcements, your notifications, and requests or proposals sent to the Chairman for approval."
      />
      <Tabs value={currentTab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="updates" className="gap-1.5">
            <Megaphone className="h-4 w-4" /> Updates
          </TabsTrigger>
          <TabsTrigger value="notifications" className="gap-1.5">
            <Bell className="h-4 w-4" /> Notifications
          </TabsTrigger>
          {showRequests && (
            <TabsTrigger value="requests" className="gap-1.5">
              <Send className="h-4 w-4" /> Requests &amp; Proposals
              {(pendingCount.data ?? 0) > 0 && (
                <Badge variant="destructive" className="ml-1 h-5 min-w-5 justify-center px-1">
                  {pendingCount.data}
                </Badge>
              )}
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="updates" className="mt-4">
          <UpdatesTab factoryId={factoryId} />
        </TabsContent>
        <TabsContent value="notifications" className="mt-4">
          <NotificationsTab factoryId={factoryId} />
        </TabsContent>
        {showRequests && (
          <TabsContent value="requests" className="mt-4">
            <RequestsTab factoryId={factoryId} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ============================================================================
// Updates
// ============================================================================
function UpdatesTab({ factoryId }: { factoryId: string }) {
  const qc = useQueryClient();
  const { canCreate } = usePermissions();
  const isAdmin = useIsAdmin().data ?? false;
  const { data: uid } = useCurrentUserId();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);

  const feed = useQuery({
    queryKey: ["updates-feed", factoryId],
    queryFn: async () => {
      const { data, error } = await db
        .from("updates")
        .select("id,title,body,pinned,posted_by,posted_by_name,created_at")
        .eq("factory_id", factoryId)
        .order("pinned", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as UpdateRow[];
    },
  });

  const post = useMutation({
    mutationFn: async () => {
      const { error } = await db.rpc("post_update", {
        payload: { factory_id: factoryId, title, body, pinned },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Update posted");
      setTitle("");
      setBody("");
      setPinned(false);
      qc.invalidateQueries({ queryKey: ["updates-feed"] });
      qc.invalidateQueries({ queryKey: ["pinned-updates"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.rpc("delete_update", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Update removed");
      qc.invalidateQueries({ queryKey: ["updates-feed"] });
      qc.invalidateQueries({ queryKey: ["pinned-updates"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      {canCreate("updates") && (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle>Post an update</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div>
              <Label>Title</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Factory closed on Monday for maintenance"
              />
            </div>
            <div>
              <Label>Update</Label>
              <Textarea
                rows={4}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="What does everyone need to know?"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={pinned} onCheckedChange={(v) => setPinned(v === true)} />
                Pin to the top of every page for 24 hours
              </label>
              <Button
                className="gap-2"
                disabled={post.isPending || !title.trim() || !body.trim()}
                onClick={() => post.mutate()}
              >
                <Megaphone className="h-4 w-4" />
                {post.isPending ? "Posting…" : "Post update"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Everyone in this factory sees it here and gets a notification.
            </p>
          </CardContent>
        </Card>
      )}

      {feed.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (feed.data?.length ?? 0) === 0 ? (
        <Card className="rounded-2xl border-dashed">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No updates yet.
          </CardContent>
        </Card>
      ) : (
        feed.data!.map((u) => (
          <Card key={u.id} className={`rounded-2xl ${u.pinned ? "border-primary/40" : ""}`}>
            <CardContent className="space-y-2 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  {u.pinned && <Pin className="h-4 w-4 text-primary" />}
                  <h3 className="font-semibold">{u.title}</h3>
                </div>
                {(u.posted_by === uid || isAdmin) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive"
                    title="Remove update"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (confirm(`Remove "${u.title}"?`)) remove.mutate(u.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm">{u.body}</p>
              <p className="text-xs text-muted-foreground" title={when(u.created_at)}>
                {u.posted_by_name ?? "—"} · {ago(u.created_at)}
              </p>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

// ============================================================================
// Notifications — the bell's notifications, in full
// ============================================================================
function NotificationsTab({ factoryId }: { factoryId: string }) {
  const qc = useQueryClient();
  const notifications = useQuery({
    queryKey: ["notifications", "page", factoryId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications")
        .select("id,title,body,read,created_at")
        .eq("factory_id", factoryId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as NotificationRow[];
    },
  });
  // Factory-wide (broadcast) notifications keep each user's read state here.
  const broadcastReads = useQuery({
    queryKey: ["notifications", "reads"],
    queryFn: async () => {
      const { data, error } = await db.from("notification_reads").select("notification_id");
      if (error) return new Set<string>();
      return new Set<string>(
        (data ?? []).map((r: { notification_id: string }) => r.notification_id),
      );
    },
  });
  const isRead = (n: NotificationRow) => n.read || (broadcastReads.data?.has(n.id) ?? false);
  const unread = (notifications.data ?? []).filter((n) => !isRead(n));

  const markAllRead = useMutation({
    mutationFn: async () => {
      const { error } = await db.rpc("mark_notifications_read", {
        p_ids: unread.map((n) => n.id),
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle>
          Notifications
          {unread.length > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({unread.length} unread)
            </span>
          )}
        </CardTitle>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={unread.length === 0 || markAllRead.isPending}
          onClick={() => markAllRead.mutate()}
        >
          <Check className="h-4 w-4" /> Mark all read
        </Button>
      </CardHeader>
      <CardContent>
        {notifications.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (notifications.data?.length ?? 0) === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No notifications.</p>
        ) : (
          <ul className="divide-y">
            {notifications.data!.map((n) => (
              <li
                key={n.id}
                className={`flex gap-3 rounded-md px-2 py-3 ${isRead(n) ? "" : "bg-accent/40"}`}
              >
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    isRead(n) ? "bg-transparent" : "bg-primary"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{n.title}</div>
                  {n.body && <div className="text-sm text-muted-foreground">{n.body}</div>}
                  <div className="mt-1 text-xs text-muted-foreground" title={when(n.created_at)}>
                    {ago(n.created_at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Requests & Proposals — sent to chosen people, discussed in a reply thread,
// decided by the Chairman
// ============================================================================
function useMessageCounts(factoryId: string) {
  return useQuery({
    queryKey: ["proposal-messages", "counts", factoryId],
    queryFn: async () => {
      const { data, error } = await db
        .from("proposal_messages")
        .select("proposal_id, proposals!inner(factory_id)")
        .eq("proposals.factory_id", factoryId);
      if (error) throw error;
      const counts = new Map<string, number>();
      for (const m of (data ?? []) as { proposal_id: string }[]) {
        counts.set(m.proposal_id, (counts.get(m.proposal_id) ?? 0) + 1);
      }
      return counts;
    },
  });
}

function RequestsTab({ factoryId }: { factoryId: string }) {
  const qc = useQueryClient();
  const settings = useFactorySettings(factoryId);
  const currency = settings.data?.currency ?? "NGN";
  const { canSubmit, canCancel } = usePermissions();
  const isChairman = useIsChairman().data ?? false;
  const { data: uid } = useCurrentUserId();
  const [filter, setFilter] = useState<"all" | ProposalStatus>(isChairman ? "pending" : "all");
  const [box, setBox] = useState<"all" | "inbox" | "sent">("all");
  const [newOpen, setNewOpen] = useState(false);
  const [thread, setThread] = useState<{ id: string; reply: boolean } | null>(null);
  const [decide, setDecide] = useState<{
    row: ProposalRow;
    decision: "approved" | "rejected";
  } | null>(null);

  const proposals = useQuery({
    queryKey: ["proposals", "list", factoryId],
    queryFn: async () => {
      const { data, error } = await db
        .from("proposals")
        .select("*")
        .eq("factory_id", factoryId)
        .order("requested_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as ProposalRow[];
    },
  });
  const messageCounts = useMessageCounts(factoryId);
  const rows = (proposals.data ?? []).filter(
    (p) =>
      (filter === "all" || p.status === filter) &&
      (box === "all" || (box === "sent" ? p.requested_by === uid : p.requested_by !== uid)),
  );
  const threadRow = thread ? (proposals.data ?? []).find((p) => p.id === thread.id) : undefined;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["proposals"] });
    qc.invalidateQueries({ queryKey: ["proposal-messages"] });
    qc.invalidateQueries({ queryKey: ["pending-attention"] });
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };

  const cancel = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.rpc("cancel_proposal", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Request withdrawn");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Select value={box} onValueChange={(v) => setBox(v as typeof box)}>
            <SelectTrigger className="h-9 w-36" aria-label="Mailbox">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Inbox &amp; sent</SelectItem>
              <SelectItem value="inbox">Inbox</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <SelectTrigger className="h-9 w-44" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="pending">Awaiting review</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="cancelled">Withdrawn</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {canSubmit("updates") && (
          <Button className="gap-2" onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" /> New request / proposal
          </Button>
        )}
      </div>

      {proposals.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <Card className="rounded-2xl border-dashed">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {filter === "pending" ? "Nothing awaiting review." : "No requests or proposals yet."}
          </CardContent>
        </Card>
      ) : (
        rows.map((p) => {
          const replies = messageCounts.data?.get(p.id) ?? 0;
          return (
            <Card key={p.id} className="rounded-2xl">
              <CardContent className="space-y-3 p-5">
                <ProposalHeader p={p} currency={currency} />
                <p className="line-clamp-3 whitespace-pre-wrap text-sm">{p.details}</p>
                <p className="text-xs text-muted-foreground" title={when(p.requested_at)}>
                  From {p.requested_by_name ?? "—"} to {recipientsLabel(p)} · {ago(p.requested_at)}
                </p>
                {(p.status === "approved" || p.status === "rejected") && <DecisionBox p={p} />}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <MessageSquare className="h-3.5 w-3.5" />
                    {replies === 0
                      ? "No replies"
                      : `${replies} ${replies === 1 ? "reply" : "replies"}`}
                  </span>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1"
                      onClick={() => setThread({ id: p.id, reply: false })}
                    >
                      <Eye className="h-4 w-4" /> View
                    </Button>
                    {p.status !== "cancelled" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1"
                        onClick={() => setThread({ id: p.id, reply: true })}
                      >
                        <Reply className="h-4 w-4" /> Reply
                      </Button>
                    )}
                    {p.status === "pending" && p.requested_by === uid && canCancel("updates") && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1"
                        disabled={cancel.isPending}
                        onClick={() => {
                          if (confirm(`Withdraw ${p.reference}?`)) cancel.mutate(p.id);
                        }}
                      >
                        <Undo2 className="h-4 w-4" /> Withdraw
                      </Button>
                    )}
                    {p.status === "pending" && isChairman && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1 text-destructive"
                          onClick={() => setDecide({ row: p, decision: "rejected" })}
                        >
                          <X className="h-4 w-4" /> Reject
                        </Button>
                        <Button
                          size="sm"
                          className="gap-1"
                          onClick={() => setDecide({ row: p, decision: "approved" })}
                        >
                          <Check className="h-4 w-4" /> Approve
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })
      )}

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        {newOpen && (
          <NewProposalDialog
            factoryId={factoryId}
            onDone={() => {
              setNewOpen(false);
              refresh();
            }}
          />
        )}
      </Dialog>
      <Dialog open={!!threadRow} onOpenChange={(v) => !v && setThread(null)}>
        {threadRow && (
          <ThreadDialog
            row={threadRow}
            currency={currency}
            focusReply={thread!.reply}
            canDecide={isChairman && threadRow.status === "pending"}
            onDecide={(decision) => {
              setThread(null);
              setDecide({ row: threadRow, decision });
            }}
            onReplied={refresh}
          />
        )}
      </Dialog>
      <Dialog open={!!decide} onOpenChange={(v) => !v && setDecide(null)}>
        {decide && (
          <DecideDialog
            row={decide.row}
            decision={decide.decision}
            onDone={() => {
              setDecide(null);
              refresh();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

const recipientsLabel = (p: ProposalRow) =>
  p.recipient_names?.length ? p.recipient_names.join(", ") : "the Chairman";

function ProposalHeader({ p, currency }: { p: ProposalRow; currency: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{p.reference}</span>
          <Badge variant="outline" className="capitalize">
            {p.kind}
          </Badge>
          <Badge variant={STATUS_BADGE[p.status]} className="capitalize">
            {p.status === "pending"
              ? "Awaiting review"
              : p.status === "cancelled"
                ? "Withdrawn"
                : p.status}
          </Badge>
          <span className={`text-xs capitalize ${PRIORITY_CLASS[p.priority]}`}>
            {p.priority} priority
          </span>
        </div>
        <h3 className="font-semibold">{p.title}</h3>
      </div>
      {p.amount != null && (
        <div className="text-right">
          <div className="text-xs text-muted-foreground">Amount</div>
          <div className="font-semibold">{money(Number(p.amount), currency)}</div>
        </div>
      )}
    </div>
  );
}

function DecisionBox({ p }: { p: ProposalRow }) {
  return (
    <div
      className={`rounded-md border p-3 text-sm ${
        p.status === "approved"
          ? "border-success/40 bg-success/5"
          : "border-destructive/40 bg-destructive/5"
      }`}
    >
      <div className="font-medium capitalize">
        {p.status} by {p.decided_by_name ?? "the Chairman"}
        {p.decided_at && (
          <span className="font-normal text-muted-foreground"> · {when(p.decided_at)}</span>
        )}
      </div>
      {p.decision_comment && <p className="mt-1 whitespace-pre-wrap">{p.decision_comment}</p>}
    </div>
  );
}

// The full request with its reply thread, like an email conversation.
function ThreadDialog({
  row,
  currency,
  focusReply,
  canDecide,
  onDecide,
  onReplied,
}: {
  row: ProposalRow;
  currency: string;
  focusReply: boolean;
  canDecide: boolean;
  onDecide: (decision: "approved" | "rejected") => void;
  onReplied: () => void;
}) {
  const { data: uid } = useCurrentUserId();
  const [body, setBody] = useState("");
  const messages = useQuery({
    queryKey: ["proposal-messages", "thread", row.id],
    queryFn: async () => {
      const { data, error } = await db
        .from("proposal_messages")
        .select("id,author_id,author_name,body,created_at")
        .eq("proposal_id", row.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as MessageRow[];
    },
  });

  const reply = useMutation({
    mutationFn: async () => {
      const { error } = await db.rpc("reply_proposal", { p_id: row.id, p_body: body });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Reply sent");
      setBody("");
      onReplied();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{row.reference}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <ProposalHeader p={row} currency={currency} />
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <div className="mb-2 text-xs text-muted-foreground" title={when(row.requested_at)}>
            <span className="font-medium text-foreground">{row.requested_by_name ?? "—"}</span> to{" "}
            {recipientsLabel(row)} · {when(row.requested_at)}
          </div>
          <p className="whitespace-pre-wrap">{row.details}</p>
        </div>
        {(row.status === "approved" || row.status === "rejected") && <DecisionBox p={row} />}

        <div className="space-y-2">
          <div className="text-sm font-medium">
            Replies{messages.data?.length ? ` (${messages.data.length})` : ""}
          </div>
          {messages.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (messages.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No replies yet.</p>
          ) : (
            messages.data!.map((m) => (
              <div
                key={m.id}
                className={`rounded-md border p-3 text-sm ${
                  m.author_id === uid ? "ml-6 border-primary/30 bg-primary/5" : "mr-6"
                }`}
              >
                <div className="mb-1 text-xs text-muted-foreground" title={when(m.created_at)}>
                  <span className="font-medium text-foreground">
                    {m.author_id === uid ? "You" : (m.author_name ?? "—")}
                  </span>{" "}
                  · {ago(m.created_at)}
                </div>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </div>
            ))
          )}
        </div>

        {row.status !== "cancelled" ? (
          <div className="space-y-2">
            <Label>Reply</Label>
            <Textarea
              rows={4}
              autoFocus={focusReply}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your response…"
            />
            <p className="text-xs text-muted-foreground">
              Everyone on this {row.kind} is notified of your reply.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">This {row.kind} was withdrawn.</p>
        )}
      </div>
      <DialogFooter className="flex-wrap gap-2">
        {canDecide && (
          <>
            <Button
              variant="outline"
              className="gap-1 text-destructive"
              onClick={() => onDecide("rejected")}
            >
              <X className="h-4 w-4" /> Reject
            </Button>
            <Button variant="outline" className="gap-1" onClick={() => onDecide("approved")}>
              <Check className="h-4 w-4" /> Approve
            </Button>
          </>
        )}
        {row.status !== "cancelled" && (
          <Button
            className="gap-2"
            disabled={reply.isPending || !body.trim()}
            onClick={() => reply.mutate()}
          >
            <Send className="h-4 w-4" />
            {reply.isPending ? "Sending…" : "Send reply"}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

type Recipient = { id: string; full_name: string; roles: string; is_chairman: boolean };

function NewProposalDialog({ factoryId, onDone }: { factoryId: string; onDone: () => void }) {
  const [step, setStep] = useState<"compose" | "recipients">("compose");
  const [kind, setKind] = useState<"request" | "proposal">("request");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [amount, setAmount] = useState(0);
  const [priority, setPriority] = useState<Priority>("normal");
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<Set<string> | null>(null);

  const people = useQuery({
    queryKey: ["message-recipients", factoryId],
    queryFn: async () => {
      const { data, error } = await db.rpc("list_message_recipients", { p_factory: factoryId });
      if (error) throw error;
      return (data ?? []) as Recipient[];
    },
  });
  // The Chairman is picked by default; the sender can add or remove anyone.
  const selected =
    chosen ?? new Set((people.data ?? []).filter((p) => p.is_chairman).map((p) => p.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };
  const q = search.trim().toLowerCase();
  const visible = (people.data ?? []).filter(
    (p) => !q || p.full_name.toLowerCase().includes(q) || p.roles.toLowerCase().includes(q),
  );

  const submit = useMutation({
    mutationFn: async () => {
      const { data, error } = await db.rpc("submit_proposal", {
        payload: {
          factory_id: factoryId,
          kind,
          title,
          details,
          amount: amount > 0 ? amount : null,
          priority,
          recipients: [...selected],
        },
      });
      if (error) throw error;
      return data as { reference: string; recipients?: string[] };
    },
    onSuccess: (r) => {
      toast.success(`${r.reference} sent to ${r.recipients?.join(", ") ?? "the Chairman"}`);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (step === "recipients") {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Who should receive this {kind}?</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or role"
          />
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
            {people.isLoading ? (
              <p className="p-2 text-sm text-muted-foreground">Loading…</p>
            ) : visible.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">No one found.</p>
            ) : (
              visible.map((p) => (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-accent"
                >
                  <Checkbox checked={selected.has(p.id)} onCheckedChange={() => toggle(p.id)} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{p.full_name}</div>
                    {p.roles && <div className="text-xs text-muted-foreground">{p.roles}</div>}
                  </div>
                </label>
              ))
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {selected.size === 0
              ? "Choose at least one person."
              : `${selected.size} selected. Each gets a notification and can reply.`}{" "}
            Only the Chairman can approve or reject.
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setStep("compose")}>
            Back
          </Button>
          <Button
            className="gap-2"
            disabled={submit.isPending || selected.size === 0}
            onClick={() => submit.mutate()}
          >
            <Send className="h-4 w-4" />
            {submit.isPending ? "Sending…" : `Send to ${selected.size}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>New request or proposal</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="request">Request</SelectItem>
                <SelectItem value="proposal">Proposal</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Priority</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="urgent">Urgent</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label>Title</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Replace the sachet sealing machine"
          />
        </div>
        <div>
          <Label>Details</Label>
          <Textarea
            rows={6}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="What is needed, why, and what happens if it isn't approved."
          />
        </div>
        <div>
          <Label>Amount involved (optional)</Label>
          <MoneyInput min={0} value={amount} onChange={setAmount} />
        </div>
      </div>
      <DialogFooter>
        <Button
          className="gap-2"
          disabled={!title.trim() || !details.trim()}
          onClick={() => setStep("recipients")}
        >
          <Send className="h-4 w-4" /> Send…
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function DecideDialog({
  row,
  decision,
  onDone,
}: {
  row: ProposalRow;
  decision: "approved" | "rejected";
  onDone: () => void;
}) {
  const [comment, setComment] = useState("");
  const approving = decision === "approved";
  const decide = useMutation({
    mutationFn: async () => {
      const { error } = await db.rpc("decide_proposal", {
        p_id: row.id,
        p_decision: decision,
        p_comment: comment,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${row.reference} ${decision}`);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          {approving ? "Approve" : "Reject"} {row.reference}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <p className="text-sm">
          <span className="font-medium">{row.title}</span>
          <span className="text-muted-foreground"> — from {row.requested_by_name ?? "—"}</span>
        </p>
        <div>
          <Label>{approving ? "Comment (optional)" : "Reason for rejecting"}</Label>
          <Textarea
            rows={4}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={approving ? "Any conditions or notes" : "Why it can't go ahead"}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          The sender is notified of your decision{comment.trim() ? " and comment" : ""}.
        </p>
      </div>
      <DialogFooter>
        <Button
          variant={approving ? "default" : "destructive"}
          className="gap-2"
          disabled={decide.isPending || (!approving && !comment.trim())}
          onClick={() => decide.mutate()}
        >
          {approving ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
          {decide.isPending ? "Saving…" : approving ? "Approve" : "Reject"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
