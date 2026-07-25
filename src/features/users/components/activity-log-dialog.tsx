import { useEffect } from "react";
import { History, RefreshCw, ScrollText, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { auditActionLabel, isSensitiveAuditAction } from "@/lib/audit-log";
import { roleLabel } from "@/lib/roles";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import { cn } from "@/lib/utils";

import { useAdminActivity } from "../hooks/use-admin-activity";
import type { AdminActivityEntry } from "../types";

/** Same format as the order and complaint timelines, in the business timezone. */
function formatBusinessTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TIMEZONE,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** The name the entry was recorded against, from the snapshot in `details`. */
function targetName(entry: AdminActivityEntry): string | null {
  const name = entry.details.targetName;
  const email = entry.details.targetEmail;
  if (typeof name === "string" && name) return name;
  if (typeof email === "string" && email) return email;
  return null;
}

/**
 * The consequential half of `details`, as a short line.
 *
 * Deliberately selective rather than a JSON dump: an audit row is read to answer
 * "what changed", and the fields that answer that differ per action. Everything
 * not covered here is still in the row's `details` column for anyone querying the
 * table directly — this is the summary, not the record.
 */
function describeDetails(entry: AdminActivityEntry): string | null {
  const d = entry.details;
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);

  switch (entry.action) {
    case "user.created": {
      const role = str("role");
      const temp = d.temporaryPassword === true;
      return [role ? `Role: ${roleLabel(role)}` : null, temp ? "issued a temporary password" : null]
        .filter(Boolean)
        .join(" · ");
    }
    case "user.deleted": {
      const role = str("role");
      return role ? `Role at deletion: ${roleLabel(role)}` : null;
    }
    case "user.role_changed":
    case "user.owner_granted": {
      const from = str("from");
      const to = str("to");
      if (!to) return null;
      return `${from ? roleLabel(from) : "—"} → ${roleLabel(to)}`;
    }
    case "user.profile_updated": {
      // Permissions are the authorization-relevant part of a profile edit, so the
      // count is surfaced; a rename is not worth a line of its own.
      const perms = Array.isArray(d.permissions) ? (d.permissions as unknown[]) : null;
      if (!perms) return null;
      return `Permissions set to ${perms.length} explicit ${perms.length === 1 ? "grant" : "grants"}`;
    }
    case "user.password_set_by_admin": {
      if (d.temporary !== true) return "Permanent password";
      const expiresAt = str("expiresAt");
      return expiresAt
        ? `Temporary, expires ${formatBusinessTime(expiresAt)}`
        : "Temporary password";
    }
    case "user.password_reset_email_sent": {
      const sentTo = str("sentTo");
      return sentTo ? `Sent to ${sentTo}` : null;
    }
    default:
      return null;
  }
}

/**
 * The administrative audit trail.
 *
 * Sprint D recorded every privileged account action into `public.admin_activity`
 * but gave no way to read it back, so the trail was visible only to someone with
 * direct database access. This is that view.
 *
 * Administrator-only in both directions: the button that opens it is rendered for
 * administrators, `adminListActivity` refuses anyone else, and the table's RLS
 * policy says the same. Supervisor manages users but does not read the log — its
 * own actions are among the entries.
 *
 * Opened from a row, it filters to that account; opened from the header, it shows
 * everything.
 */
export function ActivityLogDialog({
  open,
  onOpenChange,
  user,
  enabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the log is filtered to this account. */
  user: { id: string; full_name: string } | null;
  /** The caller's administrator gate; also what stops the fetch firing. */
  enabled: boolean;
}) {
  const activity = useAdminActivity({
    targetUserId: user?.id ?? null,
    enabled: enabled && open,
  });

  // Reopening should start at the first page rather than re-requesting whatever
  // window the previous visit had grown to.
  const { reset } = activity;
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-primary" aria-hidden />
            {user ? `Activity — ${user.full_name}` : "Administrative activity"}
          </DialogTitle>
          <DialogDescription>
            {user
              ? "Every privileged action recorded against this account, newest first."
              : "Every privileged account action across the portal, newest first."}{" "}
            Entries are append-only and cannot be edited or removed.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          {activity.isLoading && <EntrySkeletons />}

          {!activity.isLoading && activity.error && (
            <div className="py-10 text-center">
              <ShieldAlert className="mx-auto h-8 w-8 text-destructive" aria-hidden />
              <p className="mt-2 text-sm text-destructive">{activity.error.message}</p>
            </div>
          )}

          {!activity.isLoading && !activity.error && activity.entries.length === 0 && (
            <div className="py-10 text-center">
              <History className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
              <p className="mt-2 text-sm font-medium">No recorded activity</p>
              <p className="text-xs text-muted-foreground">
                {user
                  ? "Nothing has been done to this account since the audit trail was introduced."
                  : "Privileged actions appear here as they happen."}
              </p>
            </div>
          )}

          {!activity.error && activity.entries.length > 0 && (
            <ol className="space-y-3">
              {activity.entries.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} showTarget={!user} />
              ))}
            </ol>
          )}
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {activity.atCap
              ? `Showing the most recent ${activity.entries.length} entries. Open a single account to see further back.`
              : activity.entries.length > 0
                ? `${activity.entries.length} ${activity.entries.length === 1 ? "entry" : "entries"}`
                : ""}
          </p>
          <div className="flex items-center gap-2">
            {activity.isFetching && !activity.isLoading && (
              <RefreshCw
                className="h-4 w-4 animate-spin text-muted-foreground"
                aria-label="Refreshing"
              />
            )}
            {activity.hasMore && (
              <Button
                variant="outline"
                size="sm"
                onClick={activity.loadMore}
                disabled={activity.isFetching}
              >
                Load more
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActivityRow({ entry, showTarget }: { entry: AdminActivityEntry; showTarget: boolean }) {
  const sensitive = isSensitiveAuditAction(entry.action);
  const target = targetName(entry);
  const detail = describeDetails(entry);

  return (
    <li className="flex gap-3 rounded-md border bg-card/50 p-3 text-sm">
      <span
        className={cn(
          "mt-1.5 h-2 w-2 shrink-0 rounded-full",
          sensitive ? "bg-destructive" : "bg-primary/60",
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{auditActionLabel(entry.action)}</span>
          {sensitive && (
            <Badge
              variant="outline"
              className="border-destructive/30 bg-destructive/10 px-1.5 py-0 text-[10px] text-destructive"
            >
              Privileged
            </Badge>
          )}
        </div>

        {showTarget && target && (
          <div className="truncate text-xs text-muted-foreground">
            Account: <span className="text-foreground">{target}</span>
          </div>
        )}

        {detail && <div className="text-xs text-muted-foreground">{detail}</div>}

        <div className="mt-0.5 text-xs text-muted-foreground">
          {/* A null actor is a deleted administrator, not a missing record — say
              so rather than rendering a blank byline. */}
          <span className="font-medium text-foreground">
            {entry.actor_name ?? (entry.actor_id ? "Deleted account" : "System")}
          </span>{" "}
          · {formatBusinessTime(entry.created_at)}
        </div>
      </div>
    </li>
  );
}

function EntrySkeletons() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex gap-3 rounded-md border p-3">
          <Skeleton className="mt-1.5 h-2 w-2 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
      ))}
    </div>
  );
}
