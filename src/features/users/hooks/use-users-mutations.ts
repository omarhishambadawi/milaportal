import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import {
  adminCreateUser,
  adminDeleteUser,
  adminSendPasswordReset,
  adminSetActive,
  adminSetPassword,
  adminSetRole,
  adminUpdateProfile,
} from "@/lib/admin.functions";
import type { TempPasswordTtlHours } from "@/lib/password-policy";
import { defaultPermsForRole } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import type { AppRole } from "@/lib/roles";

import type { AdminUserRow, UserDraft } from "../types";

/** True when two permission sets contain the same keys, order-insensitively. */
function permsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((k) => set.has(k));
}

/**
 * Every write the users page can perform.
 *
 * Each returns `true` on success and `false` on failure (having already shown the
 * error), so callers close their dialog on `true` and leave it open — with the
 * user's input intact — on `false`. Throwing instead would make every call site
 * repeat the same try/catch, which is how the previous version ended up with
 * seven near-identical handlers inline in the route.
 *
 * These are the *only* writers of the admin-users cache, so the list is
 * invalidated in exactly one place per operation.
 */
export function useUsersMutations() {
  const qc = useQueryClient();
  const createFn = useServerFn(adminCreateUser);
  const setActiveFn = useServerFn(adminSetActive);
  const setRoleFn = useServerFn(adminSetRole);
  const setPwFn = useServerFn(adminSetPassword);
  const sendResetFn = useServerFn(adminSendPasswordReset);
  const updateFn = useServerFn(adminUpdateProfile);
  const deleteFn = useServerFn(adminDeleteUser);

  const reload = useCallback(
    () => qc.invalidateQueries({ queryKey: queryKeys.adminUsers.all() }),
    [qc],
  );

  const run = useCallback(
    async (action: () => Promise<void>, success: string, fallback: string) => {
      try {
        await action();
        toast.success(success);
        await reload();
        return true;
      } catch (e: any) {
        toast.error(e?.message ?? fallback);
        return false;
      }
    },
    [reload],
  );

  const createUser = useCallback(
    (input: {
      email: string; password: string; fullName: string;
      agentCode?: string; role: AppRole; temporary: boolean; expiresInHours: TempPasswordTtlHours;
    }) =>
      run(
        async () => { await createFn({ data: input }); },
        input.temporary
          ? "User created — they will set their own password at first sign-in"
          : "User created",
        "Could not create the user",
      ),
    [createFn, run],
  );

  /**
   * Save the edit dialog.
   *
   * Two server calls, because profile fields and role live in different tables
   * behind different authorization rules. The role call is skipped entirely when
   * the select was never touched, so an ordinary name edit does not trip the
   * role-assignment ceiling for a target the caller may edit but not re-role.
   *
   * Permissions are stored as an empty array when they equal the role's defaults:
   * that is what "follow the defaults" means in this schema, and it keeps a user
   * tracking future changes to their role rather than pinning today's set.
   */
  const saveUser = useCallback(
    (draft: UserDraft) =>
      run(
        async () => {
          const roleKey = (draft.role ?? "customer_care") as AppRole;
          const current = draft.permissions ?? [];
          const toStore =
            draft._usingDefaults || permsEqual(current, defaultPermsForRole(roleKey)) ? [] : current;
          await updateFn({
            data: {
              userId: draft.id,
              fullName: draft.full_name,
              agentCode: draft.agent_code ?? "",
              yeastarExt: draft.yeastar_ext ?? "",
              permissions: toStore,
            },
          });
          if (draft._roleChange) await setRoleFn({ data: { userId: draft.id, role: roleKey } });
        },
        "Changes saved",
        "Could not save the changes",
      ),
    [run, setRoleFn, updateFn],
  );

  const setActive = useCallback(
    (user: AdminUserRow, active: boolean) =>
      run(
        async () => { await setActiveFn({ data: { userId: user.id, active } }); },
        active ? `${user.full_name} reactivated` : `${user.full_name} deactivated`,
        "Could not update the account",
      ),
    [run, setActiveFn],
  );

  const setPassword = useCallback(
    (user: AdminUserRow, password: string, temporary: boolean, expiresInHours: TempPasswordTtlHours) =>
      run(
        async () => { await setPwFn({ data: { userId: user.id, password, temporary, expiresInHours } }); },
        temporary
          ? `Temporary password set — ${user.full_name} must change it within ${expiresInHours} hours`
          : "Password updated",
        "Could not reset the password",
      ),
    [run, setPwFn],
  );

  const sendResetEmail = useCallback(
    (user: AdminUserRow) =>
      run(
        async () => { await sendResetFn({ data: { userId: user.id } }); },
        `Reset link sent to ${user.email}`,
        "Could not send the reset email",
      ),
    [run, sendResetFn],
  );

  /** Grants Owner — additive, never a transfer. Password-confirmed server-side. */
  const grantOwner = useCallback(
    (user: AdminUserRow, confirmPassword: string) =>
      run(
        async () => {
          await setRoleFn({ data: { userId: user.id, role: "owner", confirmPassword } });
        },
        `${user.full_name} is now an Owner`,
        "Could not grant the Owner role",
      ),
    [run, setRoleFn],
  );

  const deleteUser = useCallback(
    (user: AdminUserRow) =>
      run(
        async () => { await deleteFn({ data: { userId: user.id } }); },
        `${user.full_name} deleted`,
        "Could not delete the user",
      ),
    [deleteFn, run],
  );

  // Memoized as a whole, not just per function: callers derive row callbacks from
  // this object (`useCallback(… , [mutations])`), so a fresh object literal every
  // render would make those callbacks unstable and silently defeat the memoized
  // table rows they are passed to.
  return useMemo(
    () => ({ createUser, saveUser, setActive, setPassword, sendResetEmail, grantOwner, deleteUser }),
    [createUser, saveUser, setActive, setPassword, sendResetEmail, grantOwner, deleteUser],
  );
}
