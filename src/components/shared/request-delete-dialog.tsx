import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Shared reason-capture dialog used everywhere a delete now goes to Admin for
// approval instead of happening immediately — the reason field doubles as
// the "are you sure" confirmation, so callers don't need a separate
// AlertDialog in front of this.
export function RequestDeleteDialog({
  open,
  onOpenChange,
  onConfirm,
  isPending,
  title = "Request deletion",
  description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  isPending?: boolean;
  title?: string;
  description?: string;
}) {
  const [reason, setReason] = useState("");

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setReason("");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            This won't delete the record right away — an admin has to approve it first. Approved
            deletions stay in the Recycle Bin for 30 days before they're removed for good.
          </p>
          {description && <p className="text-sm text-destructive">{description}</p>}
          <Label>Reason for deletion *</Label>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain why this record should be deleted…"
          />
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={!reason.trim() || !!isPending}
            onClick={() => onConfirm(reason.trim())}
          >
            {isPending ? "Submitting…" : "Request deletion"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
