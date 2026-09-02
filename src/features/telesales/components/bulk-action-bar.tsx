import { useState } from "react";
import { Archive, ArchiveRestore, Loader2, UserCheck, UserMinus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The bulk action bar.
 *
 * Appears only when something is selected, and only for a viewer who holds
 * `manage_telesales` — the queue does not render checkboxes for anyone else, so
 * this bar has no path to appear without the permission behind it.
 *
 * Sticky at the bottom rather than at the top of the list: a supervisor selects
 * rows by working down the page, and a bar that scrolls away with the header
 * would be gone by the time they finished choosing.
 *
 * Assign is a one-step control — pick an agent, it applies — because the
 * confirm-then-apply pattern is friction on an action that is trivially
 * reversible. Archive is not reversible from the queue, so it asks.
 */

export interface BulkActionBarProps {
  count: number;
  agents: { id: string; name: string }[];
  busy: boolean;
  onAssign: (agentId: string) => void;
  onUnassign: () => void;
  onArchive: (reason: string) => void;
  /**
   * Which side of the archive the selection is on.
   *
   * `archived` swaps Archive for Restore and drops assignment: an archived lead
   * is not work, and handing it to an agent would put it in a queue it is
   * excluded from. Restore first, then assign.
   */
  mode?: "active" | "archived";
  onRestore?: () => void;
  onClear: () => void;
}

export function BulkActionBar({
  count,
  agents,
  busy,
  onAssign,
  onUnassign,
  onArchive,
  mode = "active",
  onRestore,
  onClear,
}: BulkActionBarProps) {
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const archived = mode === "archived";

  if (count === 0) return null;

  return (
    <>
      <div className="sticky bottom-4 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-lg">
        <span className="text-sm font-medium">
          {count} lead{count === 1 ? "" : "s"} selected
        </span>

        <span className="mx-1 h-5 w-px bg-border" aria-hidden />

        {archived ? null : (
          <Select disabled={busy} onValueChange={onAssign}>
            <SelectTrigger className="h-8 w-[190px]">
              <UserCheck className="mr-1.5 h-4 w-4" />
              <SelectValue placeholder="Assign to…" />
            </SelectTrigger>
            <SelectContent>
              {agents.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No active agents</div>
              ) : (
                agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        )}

        {archived ? null : (
          <Button size="sm" variant="outline" disabled={busy} onClick={onUnassign}>
            <UserMinus className="mr-1.5 h-4 w-4" />
            Unassign
          </Button>
        )}

        {archived ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setConfirmRestore(true)}
          >
            <ArchiveRestore className="mr-1.5 h-4 w-4" />
            Restore
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setConfirmArchive(true)}
          >
            <Archive className="mr-1.5 h-4 w-4" />
            Archive
          </Button>
        )}

        {busy ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}

        <Button size="sm" variant="ghost" onClick={onClear} disabled={busy}>
          <X className="h-4 w-4" />
          <span className="sr-only">Clear selection</span>
        </Button>
      </div>

      <AlertDialog open={confirmRestore} onOpenChange={setConfirmRestore}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Restore {count} lead{count === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {/*
               * Says the part a supervisor would otherwise assume wrongly.
               * Restoring returns a lead to the queue; it does not make it
               * current. A lead whose refill was due in January comes back
               * stale, because its due date is a fact and restoring is not an
               * event that changes it.
               */}
              They return to the queue unassigned, with their history intact. Their refill dates are
              unchanged, so a lead whose opportunity already expired comes back as stale rather than
              as new work.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => onRestore?.()}>Restore {count}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Archive {count} lead{count === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {/*
               * Precise about what survives. "Delete" would be a lie — the
               * activity log is append-only and archiving does not touch it —
               * and a supervisor who believes they have erased a customer's
               * call history has been misled.
               */}
              They leave the operational queue immediately. Nothing is deleted: the customer, their
              call history and their follow-up records are all kept, other leads for the same
              customer are untouched, and a team lead can restore these from the Archived filter.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => onArchive("Archived from the queue")}>
              Archive {count}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
