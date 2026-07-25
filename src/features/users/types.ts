/** A row as returned by `adminListUsers` — a profile joined to its role and email. */
export interface AdminUserRow {
  id: string;
  full_name: string;
  email: string;
  agent_code: string | null;
  active: boolean;
  permissions: string[] | null;
  created_at: string;
  yeastar_ext: string | null;
  avatar_url: string | null;
  /** True while the account still holds an administrator-issued password.
   *  Read together with the deadline via `temporaryPasswordState()`. */
  must_change_password: boolean;
  must_change_password_expires_at: string | null;
  role: string | null;
}

/**
 * Status facet. `pending` is not a status of the *account* but of its credential
 * — "was handed a temporary password and has not replaced it yet" — and it earns
 * a place here because it is the one thing an administrator needs to chase after
 * a reset. It is deliberately a filter rather than only a badge, so the follow-up
 * list is one click away.
 */
export type UserStatusFilter = "all" | "active" | "inactive" | "pending";

export type UserSort = "recent" | "name" | "role";

/** Headline counts for the stat cards. */
export interface UserStats {
  total: number;
  active: number;
  inactive: number;
  pending: number;
}

/**
 * The edit dialog's working copy of a row.
 *
 * The underscore-prefixed fields are dialog state, not columns: whether the user
 * is still tracking role defaults, what was stored before the dialog opened, and
 * whether the role select has been touched. They travel with the draft so the
 * save can decide between "store the exact set" and "store nothing and keep
 * following defaults" — a distinction the permissions array alone cannot carry.
 */
export interface UserDraft extends AdminUserRow {
  _usingDefaults: boolean;
  _originalStored: string[];
  _roleChange?: boolean;
}
