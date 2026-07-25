import { memo } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { Clock, KeyRound, SearchX, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { RoleBadge } from "@/components/role-badge";
import { UserAvatar } from "@/components/user-avatar";
import { isOwnerRole } from "@/lib/auth";
import { temporaryPasswordState } from "@/lib/password-policy";
import { cn } from "@/lib/utils";

import type { AdminUserRow } from "../types";
import { UserRowActions } from "./user-row-actions";

const COLUMN_COUNT = 6;

interface RowCallbacks {
  onEdit: (user: AdminUserRow) => void;
  onResetPassword: (user: AdminUserRow) => void;
  onSendResetEmail: (user: AdminUserRow) => void;
  onToggleActive: (user: AdminUserRow) => void;
  onGrantOwner: (user: AdminUserRow) => void;
  onDelete: (user: AdminUserRow) => void;
}

/**
 * One row, memoized.
 *
 * The table re-renders on every keystroke in the search box and on every page
 * change; without this, each of those re-renders rebuilds every visible row's
 * avatar, badges and dropdown. The memo only pays off because the callbacks it
 * receives are stable (`useCallback` in the page) — a fresh closure per render
 * would defeat the comparison entirely.
 */
const UserRow = memo(function UserRow({
  user, callerIsOwner, canDelete, ...callbacks
}: { user: AdminUserRow; callerIsOwner: boolean; canDelete: boolean } & RowCallbacks) {
  const rowIsOwner = isOwnerRole(user.role);
  // Owner rows may only be touched by another Owner. The server enforces this
  // independently (admin.functions.ts); this keeps the UI honest about it.
  const mayActOnRow = !rowIsOwner || callerIsOwner;

  return (
    <TableRow className={cn("group", !user.active && "opacity-70")}>
      <TableCell>
        <div className="flex min-w-0 items-center gap-3">
          <UserAvatar name={user.full_name} url={user.avatar_url} size="sm" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium">{user.full_name}</span>
              <PendingPasswordBadge user={user} />
            </div>
            <div className="truncate text-xs text-muted-foreground">{user.email || "—"}</div>
          </div>
        </div>
      </TableCell>

      <TableCell className="hidden lg:table-cell">
        <RoleBadge role={user.role} />
      </TableCell>

      <TableCell className="hidden font-mono text-xs md:table-cell">
        {user.agent_code || <span className="text-muted-foreground">—</span>}
      </TableCell>

      <TableCell className="hidden xl:table-cell text-xs text-muted-foreground">
        {user.created_at ? format(new Date(user.created_at), "PP") : "—"}
      </TableCell>

      <TableCell>
        <div className="flex items-center gap-2">
          <span
            className={cn("h-2 w-2 shrink-0 rounded-full", user.active ? "bg-emerald-500" : "bg-muted-foreground/40")}
            aria-hidden
          />
          <span className="text-xs">{user.active ? "Active" : "Inactive"}</span>
        </div>
        {/* Role is a column of its own from `lg` up; below that it collapses in
            here so the identity of the row is never lost on a phone. */}
        <div className="mt-1 lg:hidden">
          <RoleBadge role={user.role} className="text-[10px]" showIcon={false} />
        </div>
      </TableCell>

      <TableCell className="text-right">
        <UserRowActions
          user={user}
          rowIsOwner={rowIsOwner}
          mayActOnRow={mayActOnRow}
          callerIsOwner={callerIsOwner}
          canDelete={canDelete}
          {...callbacks}
        />
      </TableCell>
    </TableRow>
  );
});

/**
 * Temporary-password state, when there is one.
 *
 * Two visually distinct cases rather than one "Temp" chip, because they call for
 * opposite responses: a live temporary password is simply waiting on the user,
 * while an expired one means the account is locked out and needs the
 * administrator to act.
 */
function PendingPasswordBadge({ user }: { user: AdminUserRow }) {
  const state = temporaryPasswordState(user);
  if (state === "none") return null;

  const expired = state === "expired";
  const deadline = user.must_change_password_expires_at;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 gap-1 px-1.5 py-0 text-[10px] font-medium",
              expired
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-amber-500/30 bg-amber-500/10 text-[var(--badge-amber)]",
            )}
          >
            {expired ? <Clock className="h-2.5 w-2.5" aria-hidden /> : <KeyRound className="h-2.5 w-2.5" aria-hidden />}
            {expired ? "Expired" : "Temp"}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {expired
            ? "Their temporary password passed its deadline and no longer works. They can email themselves a reset link, or you can issue a new password."
            : `Holding an administrator-issued password${deadline ? `, expiring ${formatDistanceToNow(new Date(deadline), { addSuffix: true })}` : ""}. They must replace it before using the app.`}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The users table.
 *
 * Renders only the current page of rows (see `DEFAULT_PAGE_SIZE`), and shows a
 * skeleton on the first load rather than a bare "Loading…" line — the table's
 * shape is known before the data arrives, so reserving it stops the page jumping
 * when rows land.
 */
export function UsersTable({
  users, isLoading, error, callerIsOwner, canDelete, emptyDescription, onClearFilters, ...callbacks
}: {
  users: AdminUserRow[];
  isLoading: boolean;
  error: Error | null;
  callerIsOwner: boolean;
  canDelete: boolean;
  emptyDescription: string;
  onClearFilters: (() => void) | null;
} & RowCallbacks) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead className="hidden lg:table-cell">Role</TableHead>
            <TableHead className="hidden md:table-cell">Agent code</TableHead>
            <TableHead className="hidden xl:table-cell">Added</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && <SkeletonRows />}

          {!isLoading && error && (
            <TableRow>
              <TableCell colSpan={COLUMN_COUNT} className="py-12 text-center">
                <ShieldAlert className="mx-auto h-8 w-8 text-destructive" aria-hidden />
                <p className="mt-2 text-sm text-destructive">{error.message}</p>
              </TableCell>
            </TableRow>
          )}

          {!isLoading && !error && users.length === 0 && (
            <TableRow>
              <TableCell colSpan={COLUMN_COUNT} className="py-12 text-center">
                <SearchX className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
                <p className="mt-2 text-sm font-medium">No users {emptyDescription || "yet"}</p>
                {onClearFilters && (
                  <Button variant="ghost" size="sm" className="mt-2" onClick={onClearFilters}>
                    Clear filters
                  </Button>
                )}
              </TableCell>
            </TableRow>
          )}

          {!isLoading && !error && users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              callerIsOwner={callerIsOwner}
              canDelete={canDelete}
              {...callbacks}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <TableRow key={i}>
          <TableCell>
            <div className="flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-44" />
              </div>
            </div>
          </TableCell>
          <TableCell className="hidden lg:table-cell"><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
          <TableCell className="hidden md:table-cell"><Skeleton className="h-3.5 w-12" /></TableCell>
          <TableCell className="hidden xl:table-cell"><Skeleton className="h-3.5 w-20" /></TableCell>
          <TableCell><Skeleton className="h-3.5 w-16" /></TableCell>
          <TableCell className="text-right"><Skeleton className="ml-auto h-8 w-8 rounded-md" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}
