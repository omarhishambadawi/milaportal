import type { AppRole } from "@/lib/auth";
import { isAdministrator } from "@/lib/auth";
import { CALL_CENTER_VIEW_PERMISSIONS } from "@/lib/call-center-permissions";
import { callsPageAllowedForRole, type CallsPage } from "@/lib/calls-access";

export type PermissionGroup =
  | "Orders"
  | "Complaints"
  | "Dashboard"
  | "Invoice Verification"
  | "Branches"
  | "Shams MIS"
  | "CRM"
  | "Administration";

export interface PermissionDef {
  key: string;
  label: string;
  group: PermissionGroup;
}

export const ALL_PERMISSIONS: PermissionDef[] = [
  // Orders
  { key: "view_orders", label: "View Orders", group: "Orders" },
  { key: "create_orders", label: "Create Orders", group: "Orders" },
  { key: "edit_orders", label: "Edit Own Orders", group: "Orders" },
  { key: "edit_all_orders", label: "Edit All Orders", group: "Orders" },
  { key: "delete_orders", label: "Delete Orders", group: "Orders" },
  // Complaints
  { key: "view_complaints", label: "View Complaints", group: "Complaints" },
  { key: "create_complaints", label: "Create Complaints", group: "Complaints" },
  { key: "edit_complaints", label: "Edit Own Complaints", group: "Complaints" },
  { key: "edit_all_complaints", label: "Edit All Complaints", group: "Complaints" },
  { key: "delete_complaints", label: "Delete Complaints", group: "Complaints" },
  { key: "resolve_complaints", label: "Resolve Own Complaints", group: "Complaints" },
  { key: "resolve_all_complaints", label: "Resolve All Complaints", group: "Complaints" },
  // Dashboard
  { key: "view_dashboard", label: "View Dashboard", group: "Dashboard" },
  { key: "view_team_analytics", label: "View Team Analytics", group: "Dashboard" },
  { key: "view_all_agents", label: "View All Agents", group: "Dashboard" },
  { key: "view_call_center", label: "View Call Center Analytics", group: "Dashboard" },
  { key: "export_reports", label: "Export Reports", group: "Dashboard" },
  // Invoice Verification
  { key: "verify_own_orders", label: "Verify Own Orders", group: "Invoice Verification" },
  { key: "verify_all_orders", label: "Verify All Orders", group: "Invoice Verification" },
  { key: "view_invoice_analytics", label: "View Invoice Analytics", group: "Invoice Verification" },
  // Branches
  { key: "view_branches", label: "View Branches", group: "Branches" },
  // Shams MIS — one page-level key. The page is a single read-only window onto
  // the pharmacy's own system; splitting it per tab would gate parts of one
  // screen against each other for no operational reason.
  { key: "view_shams_mis", label: "View Shams MIS", group: "Shams MIS" },
  /*
   * The CRM — three keys, because the module has three audiences.
   *
   * Labelled "CRM" here and in the sidebar because that is what the desk calls
   * it. The keys stay `*_telesales`: they are the RLS predicates on eleven
   * tables and the argument to `has_permission()` in SQL, so renaming them
   * would be a migration and a re-grant of every user, to change a string
   * nobody outside the code reads.
   *
   * `view_` is also the RLS read boundary on every telesales table, so the page
   * appears exactly when the data would load. `work_` is the verbs an agent
   * performs, split out so a manager or an auditor can hold the board without
   * becoming a caller on it. `manage_` is everything whose blast radius is the
   * whole desk — importing, generating, reassigning somebody else's lead, and
   * editing the product catalogue or the date windows.
   *
   * `manage_telesales` is absent from the telesales role's *allowed* ceiling as
   * well as its defaults, so it cannot be granted per user: an agent who could
   * reassign leads to themselves is the ownership problem the module exists to
   * remove.
   */
  { key: "view_telesales", label: "View CRM", group: "CRM" },
  { key: "work_telesales", label: "Work CRM Leads", group: "CRM" },
  {
    key: "manage_telesales",
    label: "Manage CRM (import, generate, assign)",
    group: "CRM",
  },
  // Administration
  { key: "view_reports", label: "View All Reports", group: "Administration" },
  { key: "manage_users", label: "Manage Users", group: "Administration" },
  // `manage_roles` was removed: it was declared here (so it rendered a
  // checkbox) but enforced nowhere. Role changes go through adminSetRole,
  // which gates on assertAdmin/is_administrator -- and has_permission()
  // short-circuits to true for owner/admin, so the flag could never evaluate
  // false for anyone able to reach that function. Leaving it in place was
  // actively misleading: unticking it looked like it revoked role management
  // while changing nothing. Role management remains administrator-only.
  { key: "admin_access", label: "Admin Access (edit branches, system)", group: "Administration" },
] as const;

export type PermKey = string;

const AUDITOR_PERMS: PermKey[] = [
  "view_orders",
  "view_complaints",
  "view_dashboard",
  "view_team_analytics",
  "view_all_agents",
  "view_call_center",
  "view_invoice_analytics",
  "view_reports",
  "export_reports",
  "view_branches",
];

/**
 * What an auditor may be *granted*, which is deliberately wider than what an
 * auditor *gets*.
 *
 * Everything in `AUDITOR_PERMS` (their defaults) plus `view_shams_mis`. The gap
 * is the point: an auditor has no Shams MIS access by default, and an
 * administrator can grant it to one individual through the existing per-user
 * permission list — no hardcoded user ids, no second mechanism. Any key here but
 * not in `AUDITOR_PERMS` behaves that way.
 *
 * Must stay byte-identical to `_auditor_safe` in `has_permission()`; the
 * defaults live in `_auditor_defaults`. `npm run check:permissions` compares
 * both pairs.
 */
const AUDITOR_SAFE_READ_PERMS: PermKey[] = [
  "view_orders",
  "view_complaints",
  "view_dashboard",
  "view_team_analytics",
  "view_all_agents",
  "view_call_center",
  "view_invoice_analytics",
  "view_reports",
  "export_reports",
  "view_branches",
  "view_shams_mis",
  "view_telesales",
];

/**
 * Supervisor: everything except the destructive and owner-level surfaces.
 *
 * Holds `manage_users` (create and edit users), `admin_access` (branch/system
 * settings) and `view_reports`, so it is close to an administrator. It is held
 * back on exactly three things:
 *
 *   - `delete_orders` / `delete_complaints` are absent -> cannot delete records.
 *   - Deleting a *user* is not permission-gated at all; `adminDeleteUser` requires
 *     `is_administrator` (owner/admin), so Supervisor can never reach it.
 *   - The Yeastar page and its server functions gate on `is_administrator` too,
 *     which Supervisor is not -> no PBX access.
 *
 * Because Supervisor can manage users, role assignment is additionally capped by
 * the rank ladder in `roles.ts`: a Supervisor cannot mint or touch an
 * admin/owner, which is what stops `manage_users` becoming self-promotion.
 *
 * `edit_all_orders` is what grants order reassignment -- prevent_order_reassignment
 * only permits changing agent_id/team for callers holding it.
 *
 * Must stay byte-identical to the `supervisor` branch of `has_permission()`
 * (20260725001000_supervisor_scope_and_retire_call_center.sql). The SQL is
 * authoritative; this mirror is what the UI renders from.
 */
const SUPERVISOR_ALLOWED_PERMS: PermKey[] = [
  "view_orders",
  "create_orders",
  "edit_orders",
  "edit_all_orders",
  "view_complaints",
  "create_complaints",
  "edit_complaints",
  "edit_all_complaints",
  "resolve_complaints",
  "resolve_all_complaints",
  "view_dashboard",
  "view_team_analytics",
  "view_all_agents",
  "view_call_center",
  "verify_own_orders",
  "verify_all_orders",
  "view_invoice_analytics",
  "view_branches",
  "export_reports",
  "view_reports",
  "manage_users",
  "admin_access",
  "view_shams_mis",
  "view_telesales",
  "work_telesales",
  "manage_telesales",
];

const SUPERVISOR_DEFAULT_PERMS: PermKey[] = [
  "view_orders",
  "create_orders",
  "edit_orders",
  "edit_all_orders",
  "view_complaints",
  "create_complaints",
  "edit_complaints",
  "edit_all_complaints",
  "resolve_complaints",
  "resolve_all_complaints",
  "view_dashboard",
  "view_team_analytics",
  "view_all_agents",
  "view_call_center",
  "verify_own_orders",
  "verify_all_orders",
  "view_invoice_analytics",
  "view_branches",
  "export_reports",
  "view_reports",
  "manage_users",
  "admin_access",
  "view_shams_mis",
  "view_telesales",
  "work_telesales",
  "manage_telesales",
];

const ROLE_ALLOWED_PERMS: Record<Exclude<AppRole, "admin" | "owner">, PermKey[]> = {
  supervisor: SUPERVISOR_ALLOWED_PERMS,
  customer_care: [
    "view_orders",
    "create_orders",
    "edit_orders",
    "view_complaints",
    "create_complaints",
    "edit_complaints",
    "resolve_complaints",
    "view_dashboard",
    "view_team_analytics",
    "verify_own_orders",
    "view_invoice_analytics",
    "view_branches",
    "export_reports",
    "view_shams_mis",
    "view_telesales",
  ],
  telesales: [
    "view_orders",
    "create_orders",
    "edit_orders",
    "view_dashboard",
    "view_team_analytics",
    "verify_own_orders",
    "view_invoice_analytics",
    "view_branches",
    "export_reports",
    "view_shams_mis",
    "view_telesales",
    "work_telesales",
  ],
  auditor: AUDITOR_SAFE_READ_PERMS,
};

const ROLE_DEFAULTS: Record<AppRole, PermKey[]> = {
  owner: ALL_PERMISSIONS.map((p) => p.key),
  admin: ALL_PERMISSIONS.map((p) => p.key),
  supervisor: SUPERVISOR_DEFAULT_PERMS,
  customer_care: [
    "view_orders",
    "create_orders",
    "edit_orders",
    "view_complaints",
    "create_complaints",
    "edit_complaints",
    "resolve_complaints",
    "view_dashboard",
    "view_team_analytics",
    "verify_own_orders",
    "view_branches",
    "view_shams_mis",
  ],
  telesales: [
    "view_orders",
    "create_orders",
    "edit_orders",
    "view_dashboard",
    "verify_own_orders",
    "view_branches",
    "view_shams_mis",
    "view_telesales",
    "work_telesales",
  ],
  auditor: AUDITOR_PERMS,
};

export function hasPerm(
  role: AppRole | null,
  permissions: string[] | null | undefined,
  perm: PermKey,
): boolean {
  if (!role) return false;
  if (isAdministrator(role)) return true;
  if (role === "auditor") {
    if (!AUDITOR_SAFE_READ_PERMS.includes(perm)) return false;
    if (permissions && permissions.length > 0) return permissions.includes(perm);
    return AUDITOR_PERMS.includes(perm);
  }
  const nonAdminRole = role as Exclude<AppRole, "admin" | "owner">;
  // Deny-by-default for any role with no entry in the tables above — a value the
  // database still carries but the app layer no longer knows (the retired
  // `call_center`, or a role added to the enum before it is wired up here).
  // Indexing straight into these Records used to throw a TypeError on
  // `undefined.includes(...)`, which took the whole page down instead of simply
  // refusing the permission. `supervisor` hit exactly that before it was wired in.
  const allowed = ROLE_ALLOWED_PERMS[nonAdminRole];
  const defaults = ROLE_DEFAULTS[role];
  if (!allowed || !defaults) return false;
  if (permissions && permissions.length > 0)
    return allowed.includes(perm) && permissions.includes(perm);
  return defaults.includes(perm);
}

export function defaultPermsForRole(role: AppRole): PermKey[] {
  return ROLE_DEFAULTS[role];
}

/**
 * Shared client gate for the Call Center Analytics feature. Grants access when
 * the user holds any of {@link CALL_CENTER_VIEW_PERMISSIONS}; administrators
 * pass via hasPerm's admin short-circuit. This is the single definition used by
 * both the route (_app.call-center.tsx) and the sidebar (_app.tsx); the server
 * functions mirror it against the same permission list.
 */
export function canViewCallCenter(
  role: AppRole | null,
  permissions: string[] | null | undefined,
): boolean {
  return CALL_CENTER_VIEW_PERMISSIONS.some((perm) => hasPerm(role, permissions, perm));
}

/**
 * Per-page gate for the Calls module. Layers the team-agent confinement in
 * `calls-access.ts` on top of the shared Call Center view permission, so a
 * Telesales agent sees exactly one Calls page and a Customer Care agent exactly
 * one other. Administrator-only and owner-only pages keep their own extra gate
 * at the call site.
 */
export function canViewCallsPage(
  role: AppRole | null,
  permissions: string[] | null | undefined,
  page: CallsPage,
): boolean {
  if (!canViewCallCenter(role, permissions)) return false;
  return callsPageAllowedForRole(role, page);
}

/**
 * The order the permission editor renders its sections in.
 *
 * A group missing from this list is a group whose permissions are **not
 * rendered at all** — `PermissionEditor` iterates this array and filters
 * `ALL_PERMISSIONS` by it, so anything unlisted is silently unreachable in the
 * UI. "CRM" was missing, which meant the three `*_telesales` keys could not be
 * granted or withdrawn through Rules by anyone: the only way a role got CRM
 * access was the hardcoded default. Adding it here is what makes
 * `ROLE_ALLOWED_PERMS` mean something for Customer Care and Auditor, both of
 * which already list `view_telesales` as grantable.
 *
 * Ordered to mirror the sidebar, where the CRM sits above Shams MIS.
 */
export const PERMISSION_GROUPS: PermissionGroup[] = [
  "Orders",
  "Complaints",
  "Dashboard",
  "Invoice Verification",
  "Branches",
  "CRM",
  "Shams MIS",
  "Administration",
];
