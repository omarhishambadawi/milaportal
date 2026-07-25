import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Plus, RefreshCw, ScrollText, ShieldAlert, Users as UsersIcon } from "lucide-react";

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
import { Button } from "@/components/ui/button";
import { isAdministrator, isOwnerRole, useAuth } from "@/lib/auth";
import { defaultPermsForRole, hasPerm } from "@/lib/permissions";
import type { AppRole } from "@/lib/roles";
import { cn } from "@/lib/utils";

import { ActivityLogDialog } from "@/features/users/components/activity-log-dialog";
import { CreateUserDialog } from "@/features/users/components/create-user-dialog";
import { EditUserDialog } from "@/features/users/components/edit-user-dialog";
import { GrantOwnerDialog } from "@/features/users/components/grant-owner-dialog";
import { PasswordDialog } from "@/features/users/components/password-dialog";
import { UsersPagination } from "@/features/users/components/users-pagination";
import { UsersStatCards } from "@/features/users/components/users-stat-cards";
import { UsersTable } from "@/features/users/components/users-table";
import { UsersToolbar } from "@/features/users/components/users-toolbar";
import { useUsersFilters } from "@/features/users/hooks/use-users-filters";
import { useUsersList } from "@/features/users/hooks/use-users-list";
import { useUsersMutations } from "@/features/users/hooks/use-users-mutations";
import type { AdminUserRow, UserDraft } from "@/features/users/types";
import { describeFilters } from "@/features/users/utils";

export const Route = createFileRoute("/_app/admin/users")({
  head: () => ({ meta: [{ title: "Users — MilaServ Portal" }] }),
  component: AdminUsers,
});

/**
 * User administration.
 *
 * The screen itself is now only wiring: which dialog is open, and which row it
 * points at. Data lives in `useUsersList`, the facets in `useUsersFilters`, the
 * writes in `useUsersMutations`, and each dialog owns its own form state — the
 * same split the orders and dashboard features already use.
 *
 * Every row-level callback is `useCallback`-stable, which is what makes the
 * memoized rows in `UsersTable` actually skip re-rendering while someone types
 * in the search box.
 */
function AdminUsers() {
  const { role, profile } = useAuth();

  // Permission-only, deliberately: Supervisor holds `manage_users` without being
  // an administrator. Mirrors the server gate (assertCanManageUsers), so UI
  // visibility and API authorization derive from the same permission.
  const canManageUsers = hasPerm(role, profile?.permissions as any, "manage_users");
  // Deleting users stays administrator-only (see adminDeleteUser). Supervisor
  // must not see delete affordances it cannot use.
  const canDeleteUsers = isAdministrator(role);
  // The audit trail is administrator-only for the same reason the RLS policy on
  // admin_activity is (20260725003000): a Supervisor's own actions are among the
  // entries, so it is not the party that should be reading them back. Mirrors the
  // `assertAdmin` gate on adminListActivity.
  const canViewActivity = isAdministrator(role);
  const callerIsOwner = isOwnerRole(role);

  const { users, isLoading, isFetching, error } = useUsersList(canManageUsers);
  const filters = useUsersFilters(users);
  const mutations = useUsersMutations();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserDraft | null>(null);
  const [passwordFor, setPasswordFor] = useState<AdminUserRow | null>(null);
  const [grantOwnerTo, setGrantOwnerTo] = useState<AdminUserRow | null>(null);
  const [deleting, setDeleting] = useState<AdminUserRow | null>(null);
  const [deactivating, setDeactivating] = useState<AdminUserRow | null>(null);
  /**
   * The audit-log dialog needs an explicit `open` flag rather than the
   * `open={!!row}` shorthand the other dialogs use: it has a legitimate
   * open-with-no-row state (the portal-wide log opened from the header), so a
   * null row cannot double as "closed".
   */
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityFor, setActivityFor] = useState<AdminUserRow | null>(null);

  /**
   * Open the edit dialog with an effective permission set.
   *
   * A stored empty array means "follow role defaults", so the dialog is seeded
   * with those defaults and remembers that it is doing so — otherwise the grid
   * would render every switch off for a user who in fact holds their whole role.
   */
  const openEdit = useCallback((user: AdminUserRow) => {
    const stored = Array.isArray(user.permissions) ? user.permissions : [];
    const usingDefaults = stored.length === 0;
    const roleKey = (user.role ?? "customer_care") as AppRole;
    setEditing({
      ...user,
      permissions: usingDefaults ? defaultPermsForRole(roleKey) : stored,
      _usingDefaults: usingDefaults,
      _originalStored: stored,
    });
  }, []);

  const openPassword = useCallback((user: AdminUserRow) => setPasswordFor(user), []);
  const openGrantOwner = useCallback((user: AdminUserRow) => setGrantOwnerTo(user), []);
  const openDelete = useCallback((user: AdminUserRow) => setDeleting(user), []);

  // Stable, like every other row callback — the memoized rows in UsersTable only
  // skip re-rendering while these keep their identity.
  const openActivity = useCallback((user: AdminUserRow) => {
    setActivityFor(user);
    setActivityOpen(true);
  }, []);

  // Reactivating is harmless and immediate; deactivating locks someone out of
  // their account, so it goes through a confirmation.
  const toggleActive = useCallback(
    (user: AdminUserRow) => {
      if (user.active) setDeactivating(user);
      else void mutations.setActive(user, true);
    },
    [mutations],
  );

  const sendResetEmail = useCallback(
    (user: AdminUserRow) => { void mutations.sendResetEmail(user); },
    [mutations],
  );

  if (!canManageUsers) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" aria-hidden />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to user management.</p>
      </div>
    );
  }

  const emptyDescription = describeFilters({
    term: filters.term, role: filters.role, status: filters.status,
  });

  return (
    <div className="animate-in space-y-4 fade-in duration-150">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <UsersIcon className="h-6 w-6 text-primary" aria-hidden /> Users
          </h1>
          <p className="text-sm text-muted-foreground">
            Accounts, roles, permissions and passwords.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Background refetches are otherwise invisible: the list is cached for
              a minute, so without this the page can look frozen after a change
              made in another tab. */}
          {isFetching && !isLoading && (
            <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Refreshing" />
          )}
          {canViewActivity && (
            <Button
              variant="outline"
              className="shadow-sm"
              onClick={() => { setActivityFor(null); setActivityOpen(true); }}
            >
              <ScrollText className="mr-2 h-4 w-4" aria-hidden />Activity log
            </Button>
          )}
          <Button className="shadow-sm" onClick={() => setCreating(true)}>
            <Plus className="mr-2 h-4 w-4" aria-hidden />Add user
          </Button>
        </div>
      </div>

      <UsersStatCards stats={filters.stats} status={filters.status} onSelect={filters.setStatus} />

      <UsersToolbar
        q={filters.q}
        onQChange={filters.setQ}
        role={filters.role}
        onRoleChange={filters.setRole}
        status={filters.status}
        onStatusChange={filters.setStatus}
        sort={filters.sort}
        onSortChange={filters.setSort}
        resultCount={filters.filtered.length}
        filtersActive={filters.filtersActive}
        onClear={filters.clearFilters}
      />

      <UsersTable
        users={filters.visible}
        isLoading={isLoading}
        error={error}
        callerIsOwner={callerIsOwner}
        canDelete={canDeleteUsers}
        canViewActivity={canViewActivity}
        emptyDescription={emptyDescription}
        onClearFilters={filters.filtersActive ? filters.clearFilters : null}
        onEdit={openEdit}
        onResetPassword={openPassword}
        onSendResetEmail={sendResetEmail}
        onToggleActive={toggleActive}
        onGrantOwner={openGrantOwner}
        onViewActivity={openActivity}
        onDelete={openDelete}
      />

      <UsersPagination
        page={filters.page}
        pageCount={filters.pageCount}
        pageSize={filters.pageSize}
        total={filters.filtered.length}
        onPageChange={filters.setPage}
        onPageSizeChange={filters.setPageSize}
      />

      <CreateUserDialog open={creating} onOpenChange={setCreating} onSubmit={mutations.createUser} />

      <EditUserDialog
        draft={editing}
        open={!!editing}
        onOpenChange={(open) => { if (!open) setEditing(null); }}
        onSave={mutations.saveUser}
      />

      <PasswordDialog
        user={passwordFor}
        open={!!passwordFor}
        onOpenChange={(open) => { if (!open) setPasswordFor(null); }}
        onSubmit={(password, temporary, expiresInHours) =>
          passwordFor
            ? mutations.setPassword(passwordFor, password, temporary, expiresInHours)
            : Promise.resolve(false)
        }
        onSendEmail={() =>
          passwordFor ? mutations.sendResetEmail(passwordFor) : Promise.resolve(false)
        }
      />

      <GrantOwnerDialog
        user={grantOwnerTo}
        open={!!grantOwnerTo}
        onOpenChange={(open) => { if (!open) setGrantOwnerTo(null); }}
        onConfirm={(password) =>
          grantOwnerTo ? mutations.grantOwner(grantOwnerTo, password) : Promise.resolve(false)
        }
      />

      <ActivityLogDialog
        open={activityOpen}
        onOpenChange={setActivityOpen}
        user={activityFor}
        enabled={canViewActivity}
      />

      {/* One dialog per destructive action, pointed at the chosen row — rather
          than one mounted inside every row's menu. */}
      <AlertDialog open={!!deactivating} onOpenChange={(open) => { if (!open) setDeactivating(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {deactivating?.full_name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They will be signed out of the portal and blocked from signing back in. Their orders
              and history are untouched, and you can reactivate them at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deactivating) void mutations.setActive(deactivating, false); }}
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.full_name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the account and signs them out. Their existing orders are
              kept for records. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn("bg-destructive text-destructive-foreground hover:bg-destructive/90")}
              onClick={() => { if (deleting) void mutations.deleteUser(deleting); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
