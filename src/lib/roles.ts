/**
 * Single source of truth for the `app_role` enum in the application layer.
 *
 * The database already owns the authoritative definition (the `public.app_role`
 * type plus the per-role rules inside `has_permission()`). What this file fixes
 * is the *application* side, which previously restated the role list in five
 * unconnected places — a Zod enum, a TypeScript union, a label map, a tone map,
 * and two hand-written `<SelectItem>` lists. When `supervisor` was added to the
 * database (20260721001000 / 20260721001100) the union and the permission table
 * were updated but the other five sites were not, so the role existed, carried a
 * full permission set, and could never be assigned to anyone.
 *
 * Everything role-shaped in the app layer now derives from `APP_ROLES`. Adding a
 * role means adding one entry here plus its label and tone; TypeScript then fails
 * on anything left incomplete, because both maps are exhaustive `Record<AppRole, …>`.
 *
 * This file intentionally holds NO permission logic. Which permissions a role may
 * hold lives in `src/lib/permissions.ts` (mirroring `has_permission()` in SQL).
 */

/**
 * Every role in `public.app_role`, ordered by descending privilege.
 *
 * Order drives the role-filter dropdown in user management. It does NOT imply
 * any hierarchy in code — authorization is per-permission, never by index.
 */
export const APP_ROLES = [
  "owner",
  "admin",
  "supervisor",
  "customer_care",
  "telesales",
  "auditor",
] as const;

export type AppRole = (typeof APP_ROLES)[number];

/**
 * The retired `call_center` role.
 *
 * The role was removed from the platform; the `view_call_center` *permission* and
 * the Call Center Analytics page are unrelated and stay. Postgres cannot drop a
 * value from an enum without recreating the type, so `call_center` still exists
 * in `public.app_role` as an orphan: no user holds it (the removal migration
 * reassigns them), `has_permission()` no longer has a branch for it, and the
 * server rejects any attempt to assign it. This constant exists so that
 * rejection has one name instead of a scattered string literal.
 */
export const RETIRED_ROLES = ["call_center"] as const;

export function isRetiredRole(value: unknown): boolean {
  return typeof value === "string" && (RETIRED_ROLES as readonly string[]).includes(value);
}

/**
 * Roles an administrator may pick in the create/edit user dialogs.
 *
 * `owner` is deliberately excluded: ownership transfers through `adminSetRole`
 * under the Owner-only checks in `admin.functions.ts` and the `protect_last_owner`
 * trigger, never through a casual dropdown. The server still accepts `owner` in
 * `RoleEnum` so an Owner can grant it deliberately — this list governs the UI only.
 */
export const ASSIGNABLE_ROLES = [
  "admin",
  "supervisor",
  "customer_care",
  "telesales",
  "auditor",
] as const satisfies readonly AppRole[];

/** Human-readable name. Exhaustive: a new role will not typecheck without one. */
export const ROLE_LABEL: Record<AppRole, string> = {
  owner: "Owner",
  admin: "Admin",
  supervisor: "Supervisor",
  customer_care: "Customer Care",
  telesales: "Telesales",
  auditor: "Auditor",
};

/**
 * Which roles each role may hand out — and, equivalently, whose accounts it may
 * administer. This is the authorization ladder, written out rather than computed.
 *
 * It exists because Supervisor holds `manage_users`. Without a cap, "create and
 * edit users" includes role assignment, so a Supervisor could promote themselves
 * (or a confederate) to admin, or reset an admin's password and sign in as them.
 *
 * An explicit table rather than numeric ranks, because the rule is deliberately
 * NOT uniform: an admin may administer another admin (long-standing behaviour),
 * but a Supervisor may NOT administer another Supervisor. Rank arithmetic cannot
 * express that without a special case, and a security predicate carrying a
 * silent exception is exactly the kind of thing that rots. Being an exhaustive
 * `Record<AppRole, …>` also means adding a role fails to typecheck until someone
 * decides who may grant it.
 *
 * Read one row as: "a <key> may create, promote to, and administer holders of
 * <values>".
 *
 * This governs WHO may be administered — never WHAT a role can do. Feature access
 * stays per-permission via `has_permission()` / `hasPerm()`, so appearing high in
 * this table never implies a capability that was not granted.
 */
export const ROLE_ASSIGNABLE_BY: Record<AppRole, readonly AppRole[]> = {
  // Owner is unrestricted, and is the only source of Owner.
  owner: ["owner", "admin", "supervisor", "customer_care", "telesales", "auditor"],
  // Admin may do everything except mint or touch an Owner.
  admin: ["admin", "supervisor", "customer_care", "telesales", "auditor"],
  // Supervisor manages the shop floor only: agents and auditors. Explicitly NOT
  // supervisor/admin/owner — a Supervisor can neither clone itself nor reach any
  // administrator.
  supervisor: ["customer_care", "telesales", "auditor"],
  // Agents and auditors administer nobody.
  customer_care: [],
  telesales: [],
  auditor: [],
};

/** Roles `actorRole` may administer or grant; empty for anyone who may not. */
function assignableBy(actorRole: string | null | undefined): readonly AppRole[] {
  return isAppRole(actorRole) ? ROLE_ASSIGNABLE_BY[actorRole] : [];
}

/**
 * May an actor holding `actorRole` administer a user holding `targetRole`?
 *
 * "Administer" covers editing the profile, toggling active, resetting the
 * password and changing the role. Owner carries additional dedicated checks and
 * DB triggers on top of this; this is the general rule beneath them.
 */
export function canActOnRole(
  actorRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  const allowed = assignableBy(actorRole);
  if (allowed.length === 0) return false;
  // A user stranded on an unknown or retired role (the orphaned `call_center`)
  // must stay repairable, or they could never be moved back to a live role.
  // Anyone who may administer agents may administer them.
  if (!isAppRole(targetRole)) return allowed.includes("customer_care");
  return allowed.includes(targetRole);
}

/** May an actor holding `actorRole` grant `targetRole` to someone? */
export function canAssignRole(
  actorRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  // Retired values are not assignable by anyone, including the Owner.
  if (!isAppRole(targetRole)) return false;
  return assignableBy(actorRole).includes(targetRole);
}

/**
 * Longer label used where the dropdown benefits from a hint about the role's
 * scope. Falls back to `ROLE_LABEL` for roles that need no qualifier.
 */
export const ROLE_OPTION_LABEL: Record<AppRole, string> = {
  ...ROLE_LABEL,
  supervisor: "Supervisor (no deletes, no Yeastar)",
  auditor: "Auditor (read-only)",
};

/** Badge classes. Exhaustive: a new role will not typecheck without one. */
export const ROLE_TONE: Record<AppRole, string> = {
  owner: "bg-primary/10 text-primary border-primary/30",
  admin: "bg-secondary/15 text-secondary-foreground border-secondary/40",
  supervisor: "bg-amber-500/10 text-[var(--badge-amber)] border-amber-500/30",
  customer_care: "bg-blue-500/10 text-[var(--badge-blue)] border-blue-500/30",
  telesales: "bg-emerald-500/10 text-[var(--badge-emerald)] border-emerald-500/30",
  auditor: "bg-muted text-muted-foreground border-border",
};

/**
 * Roles that carry an Agent Code.
 *
 * Only the two agent roles do. Owner, Admin, Supervisor and Auditor are not
 * agents: they take no orders, so an agent code on them is meaningless and was
 * previously rendered as an empty field and accepted by the create/edit forms.
 */
export const AGENT_CODE_ROLES = [
  "customer_care",
  "telesales",
] as const satisfies readonly AppRole[];

export function roleHasAgentCode(role: string | null | undefined): boolean {
  return isAppRole(role) && (AGENT_CODE_ROLES as readonly string[]).includes(role);
}

/** Narrowing guard for values arriving from the database or an API boundary. */
export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}

/** Label for a possibly-unknown role value, without throwing on stale data. */
export function roleLabel(role: string | null | undefined): string {
  return isAppRole(role) ? ROLE_LABEL[role] : "—";
}

/** Badge classes for a possibly-unknown role value; empty string when unknown. */
export function roleTone(role: string | null | undefined): string {
  return isAppRole(role) ? ROLE_TONE[role] : "";
}
