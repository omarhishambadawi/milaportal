import { Crown, KeyRound, Mail, MoreHorizontal, Pencil, Power, ScrollText, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { AdminUserRow } from "../types";

/**
 * Row action menu.
 *
 * Every destructive or irreversible action opens a confirmation owned by the
 * page — deliberately not rendered here. The previous version nested an
 * `AlertDialog` inside each row's menu, which mounted one dialog *per row*: on a
 * hundred users that is a hundred portals' worth of components standing by for a
 * click that happens once. The page now keeps a single dialog per action and
 * points it at whichever row was chosen.
 *
 * What is hidden versus disabled follows a rule: a permission the caller does not
 * hold at all (deleting, as a Supervisor) removes the item, since offering it
 * teaches the wrong model of what the role can do; a permission they hold but
 * cannot use on *this* row (an Owner's account) leaves it visible and disabled,
 * with a line explaining why. The server enforces both independently.
 */
export function UserRowActions({
  user,
  rowIsOwner,
  mayActOnRow,
  callerIsOwner,
  canDelete,
  canViewActivity,
  onEdit,
  onResetPassword,
  onSendResetEmail,
  onToggleActive,
  onGrantOwner,
  onViewActivity,
  onDelete,
}: {
  user: AdminUserRow;
  rowIsOwner: boolean;
  mayActOnRow: boolean;
  callerIsOwner: boolean;
  canDelete: boolean;
  /** Reading the audit trail is administrator-only; Supervisor never sees it. */
  canViewActivity: boolean;
  onEdit: (user: AdminUserRow) => void;
  onResetPassword: (user: AdminUserRow) => void;
  onSendResetEmail: (user: AdminUserRow) => void;
  onToggleActive: (user: AdminUserRow) => void;
  onGrantOwner: (user: AdminUserRow) => void;
  onViewActivity: (user: AdminUserRow) => void;
  onDelete: (user: AdminUserRow) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 opacity-70 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
          aria-label={`Actions for ${user.full_name}`}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
          {user.email || user.full_name}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => onEdit(user)} disabled={!mayActOnRow}>
          <Pencil className="mr-2 h-4 w-4" aria-hidden />Edit &amp; permissions
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={() => onSendResetEmail(user)} disabled={!mayActOnRow || !user.email}>
          <Mail className="mr-2 h-4 w-4" aria-hidden />Email a reset link
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={() => onResetPassword(user)} disabled={!mayActOnRow}>
          <KeyRound className="mr-2 h-4 w-4" aria-hidden />Set a password…
        </DropdownMenuItem>

        {/* Deliberately not gated on `mayActOnRow`: this reads the audit trail
            rather than changing the account, and the portal-wide log an
            administrator can already open contains the same entries. Hiding it on
            Owner rows would be theatre. */}
        {canViewActivity && (
          <DropdownMenuItem onSelect={() => onViewActivity(user)}>
            <ScrollText className="mr-2 h-4 w-4" aria-hidden />View activity
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        {/* Owner accounts can never be deactivated — by anyone, including another
            Owner. Mirrors the protect_owner_profile trigger. */}
        <DropdownMenuItem onSelect={() => onToggleActive(user)} disabled={rowIsOwner || !mayActOnRow}>
          <Power className="mr-2 h-4 w-4" aria-hidden />
          {user.active ? "Deactivate" : "Reactivate"}
        </DropdownMenuItem>

        {rowIsOwner && (
          <p className="px-2 py-1 text-[10px] leading-snug text-muted-foreground">
            Owner accounts cannot be deactivated, deleted or re-roled.
          </p>
        )}

        {callerIsOwner && !rowIsOwner && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onGrantOwner(user)}>
              <Crown className="mr-2 h-4 w-4" aria-hidden />Grant Owner…
            </DropdownMenuItem>
          </>
        )}

        {canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => onDelete(user)}
              disabled={rowIsOwner}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" aria-hidden />Delete user
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
