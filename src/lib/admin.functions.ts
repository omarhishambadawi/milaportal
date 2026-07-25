import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { APP_ROLES, canActOnRole, canAssignRole, isRetiredRole, roleHasAgentCode } from "@/lib/roles";
import { AVATAR_BUCKET, AVATAR_SIGNED_TTL, avatarObjectPath } from "@/lib/avatar";
import {
  DEFAULT_TEMP_PASSWORD_TTL_HOURS,
  TEMP_PASSWORD_TTL_OPTIONS,
  passwordSchema,
  temporaryPasswordDeadline,
  type TempPasswordTtlHours,
} from "@/lib/password-policy";
import { AUDIT_ACTIONS, logAdminAction, targetSnapshot } from "@/lib/audit.server";

/** Accepts only the offered TTLs, so the deadline cannot be widened by a
 *  hand-rolled request. The timestamp itself is always computed server-side. */
const TtlEnum = z.union([z.literal(TEMP_PASSWORD_TTL_OPTIONS[0]), z.literal(TEMP_PASSWORD_TTL_OPTIONS[1])]);

// Derived from APP_ROLES so a role added to the enum cannot be silently
// rejected at this boundary. `supervisor` was missing here even though the
// database enum, has_permission() and the client permission table all had it,
// which made the role impossible to assign through adminCreateUser/adminSetRole.
// Retired values (call_center) are absent from APP_ROLES and so are rejected here
// before any handler runs.
const RoleEnum = z.enum(APP_ROLES);

/** Single source of truth for role values crossing the API boundary.
 *  Derived from RoleEnum so adding a role cannot leave a stale union behind. */
type RoleValue = z.infer<typeof RoleEnum>;

/**
 * Owner protection, actor half.
 *
 * The DB triggers (20260721001200) enforce the invariants -- never zero owners,
 * an owner can't be deactivated or deleted -- but every privileged write here
 * runs through supabaseAdmin (service_role) where auth.uid() is NULL, so the
 * database cannot tell WHO is acting. These helpers supply that half: only an
 * owner may act on another owner. Without this an ordinary admin could reset
 * the Owner's password and take over the account.
 */
async function isOwner(supabase: any, userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_owner", { _user_id: userId });
  if (error) {
    console.error("[authz] is_owner RPC error", { userId, error: error.message });
    throw new Error("Forbidden: authorization check failed");
  }
  return !!data;
}

/** Refuse when the target is an Owner and the caller is not one. */
async function assertMayActOnTarget(supabase: any, callerId: string, targetId: string, action: string) {
  if (!(await isOwner(supabase, targetId))) return;
  if (await isOwner(supabase, callerId)) return;
  console.warn("[authz] non-owner attempted to act on Owner", { callerId, targetId, action });
  throw new Error(`Forbidden: only an Owner may ${action} an Owner account`);
}

async function assertAdmin(supabase: any, userId: string) {
  // Owner and admin have identical administrative privileges.
  const { data, error } = await supabase.rpc("is_administrator", { _user_id: userId });
  if (error) {
    console.error("[authz] is_administrator RPC error", { userId, error: error.message });
    throw new Error("Forbidden: authorization check failed");
  }
  if (!data) {
    const { data: roleRow } = await supabase
      .from("user_roles").select("role").eq("user_id", userId).maybeSingle();
    console.warn("[authz] non-administrator access attempt", { userId, role: roleRow?.role ?? null });
    throw new Error("Forbidden: administrator access required (owner or admin)");
  }
  console.log("[authz] administrator access granted", { userId });
}

/**
 * Authoritative role read, for authorization decisions only.
 *
 * Uses service_role deliberately: RLS on user_roles restricts what a caller may
 * read about other users, and an authorization check that can be starved of the
 * target's role by a policy would misjudge it (target role => null => treated as
 * an unknown role). Reading past RLS here is what makes the comparison sound.
 */
async function getRole(userId: string): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("user_roles").select("role").eq("user_id", userId).maybeSingle();
  if (error) {
    console.error("[authz] role lookup failed", { userId, error: error.message });
    throw new Error("Forbidden: authorization check failed");
  }
  return (data?.role as string | undefined) ?? null;
}

/**
 * Gate for the user-administration surface.
 *
 * Replaces the previous blanket `assertAdmin` on the create/edit/list functions.
 * Supervisor now holds `manage_users`, so administration is no longer synonymous
 * with being an administrator — but `is_administrator` remains the gate for the
 * destructive operations (see `adminDeleteUser`).
 *
 * Deliberately routed through has_permission() rather than a role comparison, so
 * this check and the database agree by construction and an administrator can
 * revoke manage_users from an individual Supervisor.
 */
async function assertCanManageUsers(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("has_permission", {
    _user_id: userId,
    _permission: "manage_users",
  });
  if (error) {
    console.error("[authz] has_permission RPC error", { userId, error: error.message });
    throw new Error("Forbidden: authorization check failed");
  }
  if (!data) {
    console.warn("[authz] user-management access attempt without manage_users", { userId });
    throw new Error("Forbidden: user management access required");
  }
}

/**
 * The authorization ceiling: refuse when the caller may not administer this target.
 *
 * This is what stops `manage_users` from being a privilege-escalation path. A
 * Supervisor can create and edit users, so without this they could reassign their
 * own role — or a confederate's — to admin, or reset an admin's password and sign
 * in as them.
 *
 * Who may administer whom is declared in ROLE_ASSIGNABLE_BY (src/lib/roles.ts).
 * Note the rule is not a simple ladder: an admin may administer another admin,
 * but a Supervisor may NOT administer another Supervisor — a Supervisor is
 * confined to agents and auditors.
 */
async function assertMayAdministerTarget(callerId: string, targetId: string, action: string) {
  const [callerRole, targetRole] = await Promise.all([getRole(callerId), getRole(targetId)]);
  if (canActOnRole(callerRole, targetRole)) return;
  console.warn("[authz] refused action on target outside caller's authority", {
    callerId, callerRole, targetId, targetRole, action,
  });
  throw new Error(`Forbidden: you are not permitted to ${action} this account`);
}

/** Refuse when the caller may not hand out `role`. */
async function assertMayAssignRole(callerId: string, role: string, action: string) {
  if (isRetiredRole(role)) {
    throw new Error("The Call Center role has been retired; assign Customer Care instead");
  }
  const callerRole = await getRole(callerId);
  if (canAssignRole(callerRole, role)) return;
  console.warn("[authz] refused role assignment outside caller's authority", { callerId, callerRole, role, action });
  throw new Error(`Forbidden: you may not ${action} the ${role} role`);
}

export const adminCreateUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email: string; password: string; fullName: string; agentCode?: string; role: RoleValue; temporary?: boolean; expiresInHours?: TempPasswordTtlHours }) =>
    z
      .object({
        email: z.string().email(),
        // Same policy as the self-service change and the reset flow, so a
        // password an admin sets cannot be weaker than one a user may choose.
        password: passwordSchema,
        fullName: z.string().min(1).max(120),
        agentCode: z.string().max(40).optional(),
        role: RoleEnum,
        // The password an admin types at creation is the same handover credential
        // as one typed into the reset dialog — two people know it — so it defaults
        // to temporary as well, and the new user replaces it at first sign-in.
        temporary: z.boolean().optional().default(true),
        expiresInHours: TtlEnum.optional().default(DEFAULT_TEMP_PASSWORD_TTL_HOURS),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageUsers(context.supabase, context.userId);
    if (data.role === "owner" && !(await isOwner(context.supabase, context.userId))) {
      throw new Error("Forbidden: only an Owner may create an Owner account");
    }
    // Rank ceiling: a Supervisor may create agents and auditors, never an
    // admin/owner. Without this, manage_users would let them mint an admin.
    await assertMayAssignRole(context.userId, data.role, "assign");
    // Agent Code belongs to agent roles only.
    if (data.agentCode && !roleHasAgentCode(data.role)) {
      throw new Error("Only Customer Care and Telesales accounts may have an Agent Code");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // [H3] Do NOT pass role via user_metadata — the handle_new_user trigger
    // ignores it and always writes the default (customer_care). Elevated
    // roles are granted server-side, after creation, via user_roles.
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { full_name: data.fullName, agent_code: data.agentCode },
    });
    if (error) throw new Error(error.message);
    const newUserId = created.user?.id;
    if (newUserId && data.role !== "customer_care") {
      await supabaseAdmin.from("user_roles").delete().eq("user_id", newUserId);
      const { error: roleErr } = await supabaseAdmin
        .from("user_roles")
        .insert({ user_id: newUserId, role: data.role });
      if (roleErr) throw new Error(roleErr.message);
    }
    // handle_new_user() creates the profile row with the column default (false),
    // so the flag is set here rather than passed through user_metadata — that
    // trigger deliberately ignores client-supplied metadata beyond name/code.
    if (newUserId && data.temporary) {
      const { error: flagErr } = await supabaseAdmin
        .from("profiles")
        .update({
          must_change_password: true,
          must_change_password_expires_at: temporaryPasswordDeadline(data.expiresInHours),
        } as any)
        .eq("id", newUserId);
      if (flagErr) throw new Error(flagErr.message);
    }
    await logAdminAction({
      actorId: context.userId,
      targetUserId: newUserId ?? null,
      action: AUDIT_ACTIONS.userCreated,
      details: {
        targetName: data.fullName,
        targetEmail: data.email,
        role: data.role,
        temporaryPassword: data.temporary,
        expiresInHours: data.temporary ? data.expiresInHours : null,
      },
    });
    return { id: newUserId, temporary: data.temporary };
  });


export const adminSetActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string; active: boolean }) =>
    z.object({ userId: z.string().uuid(), active: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageUsers(context.supabase, context.userId);
    // An Owner can never be deactivated, by anyone -- including another Owner.
    // Mirrors the protect_owner_profile trigger.
    if (!data.active && (await isOwner(context.supabase, data.userId))) {
      throw new Error("Owner accounts cannot be deactivated");
    }
    // Deactivating an account is a denial-of-service on its holder; a Supervisor
    // must not be able to lock out an administrator.
    await assertMayAdministerTarget(context.userId, data.userId, "deactivate");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ active: data.active })
      .eq("id", data.userId);
    if (error) throw new Error(error.message);
    await logAdminAction({
      actorId: context.userId,
      targetUserId: data.userId,
      action: data.active ? AUDIT_ACTIONS.userActivated : AUDIT_ACTIONS.userDeactivated,
      details: await targetSnapshot(data.userId),
    });
    return { ok: true };
  });

/**
 * Re-authenticate the caller.
 *
 * Used to gate the single most dangerous role change — granting Owner. Every
 * other role change is deliberately left un-gated, per the product decision;
 * adding a password prompt to routine edits trains people to type their password
 * without reading the dialog, which makes the prompt that *does* matter weaker.
 *
 * Verified server-side for the same reason as the self-service password change:
 * a confirmation the browser could skip protects nothing.
 */
async function assertPasswordConfirmed(context: { userId: string; claims: unknown }, password: string) {
  const claimEmail = (context.claims as { email?: unknown } | null)?.email;
  let email = typeof claimEmail === "string" && claimEmail ? claimEmail : null;
  const { getUserEmail, verifyPassword } = await import("@/lib/password.server");
  if (!email) email = await getUserEmail(context.userId);
  if (!email) throw new Error("Could not verify your account");
  if (!(await verifyPassword(email, password))) {
    console.warn("[authz] failed password confirmation on Owner transfer", { callerId: context.userId });
    throw new Error("Password confirmation failed");
  }
}

export const adminSetRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string; role: RoleValue; confirmPassword?: string }) =>
    z
      .object({
        userId: z.string().uuid(),
        role: RoleEnum,
        // Required only when granting Owner; see the handler.
        confirmPassword: z.string().min(1).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageUsers(context.supabase, context.userId);
    // An Owner's role is immutable: "Cannot have role changed". Only another
    // Owner may promote someone TO owner. The protect_last_owner trigger is the
    // backstop that guarantees at least one Owner always remains.
    await assertMayActOnTarget(context.supabase, context.userId, data.userId, "change the role of");
    if (await isOwner(context.supabase, data.userId)) {
      throw new Error("Owner accounts cannot have their role changed");
    }
    if (data.role === "owner" && !(await isOwner(context.supabase, context.userId))) {
      throw new Error("Forbidden: only an Owner may grant the Owner role");
    }
    // Granting Owner ADDS an Owner; it is not a transfer. The acting Owner keeps
    // their role, and any number of Owners may coexist, all with identical
    // privileges and protections (is_owner() is a per-user EXISTS, and
    // has_permission()/is_administrator() short-circuit for every one of them).
    //
    // It is nonetheless irreversible in practice -- an Owner cannot afterwards be
    // demoted, deactivated or deleted -- so it requires the acting Owner to
    // re-enter their password. Enforced here, not in the dialog, so a caller that
    // omits the field is refused rather than silently succeeding. All other role
    // changes need no confirmation.
    if (data.role === "owner") {
      if (!data.confirmPassword) {
        throw new Error("Granting the Owner role requires your password");
      }
      await assertPasswordConfirmed(context, data.confirmPassword);
    }
    // The two halves of the escalation guard: the caller must outrank the target
    // AND must be allowed to hand out the requested role. Checking only the
    // former would let a Supervisor promote an agent to admin; only the latter
    // would let them demote an admin.
    await assertMayAdministerTarget(context.userId, data.userId, "change the role of");
    await assertMayAssignRole(context.userId, data.role, "grant");
    const previousRole = await getRole(data.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.userId);
    const { error } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: data.userId, role: data.role });
    if (error) throw new Error(error.message);
    // Granting Owner gets its own action rather than being buried among ordinary
    // role changes: it is the one irreversible grant on the platform, and an
    // investigator should be able to list every occurrence with one predicate.
    await logAdminAction({
      actorId: context.userId,
      targetUserId: data.userId,
      action: data.role === "owner" ? AUDIT_ACTIONS.ownerGranted : AUDIT_ACTIONS.userRoleChanged,
      details: { ...(await targetSnapshot(data.userId)), from: previousRole, to: data.role },
    });
    return { ok: true };
  });

export const adminUpdateProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string; fullName: string; agentCode?: string; yeastarExt?: string | null; permissions?: string[] }) =>
    z
      .object({
        userId: z.string().uuid(),
        fullName: z.string().min(1).max(120),
        agentCode: z.string().max(40).optional().nullable(),
        yeastarExt: z.string().max(20).optional().nullable(),
        permissions: z.array(z.string()).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageUsers(context.supabase, context.userId);
    // Keeps a non-Owner admin from rewriting the Owner's profile or permissions.
    await assertMayActOnTarget(context.supabase, context.userId, data.userId, "modify");
    // This function can write `permissions`, so it is an escalation surface: a
    // Supervisor editing an admin could otherwise hand themselves anything. Note
    // the per-role `_allowed` ceiling in has_permission() already prevents a
    // stored permission outside the target's role from ever evaluating true — this
    // is the second, explicit line of defence rather than the only one.
    await assertMayAdministerTarget(context.userId, data.userId, "modify");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Agent Code is meaningful only for the agent roles; clear it for everyone
    // else rather than persisting a value the UI will not show.
    const targetRole = await getRole(data.userId);
    const agentCode = roleHasAgentCode(targetRole) ? (data.agentCode ?? null) : null;
    const patch: any = { full_name: data.fullName, agent_code: agentCode };
    if (data.permissions) patch.permissions = data.permissions;
    if (data.yeastarExt !== undefined) {
      const v = (data.yeastarExt ?? "").trim();
      patch.yeastar_ext = v.length > 0 ? v : null;
    }
    const { error } = await supabaseAdmin
      .from("profiles")
      .update(patch)
      .eq("id", data.userId);
    if (error) throw new Error(error.message);
    await logAdminAction({
      actorId: context.userId,
      targetUserId: data.userId,
      action: AUDIT_ACTIONS.userProfileUpdated,
      details: {
        ...(await targetSnapshot(data.userId)),
        fullName: data.fullName,
        agentCode,
        yeastarExt: patch.yeastar_ext,
        // The interesting half of this event: permissions are an authorization
        // surface, so the granted set is recorded rather than just "edited".
        permissions: data.permissions ?? null,
      },
    });
    return { ok: true };
  });


export const adminSetPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string; password: string; temporary?: boolean; expiresInHours?: TempPasswordTtlHours }) =>
    z
      .object({
        userId: z.string().uuid(),
        password: passwordSchema,
        // Marks the password as a handover credential: the holder must replace it
        // before they can use the app. Defaults to true — an admin-set password is
        // a password two people know, and treating that as permanent is the unsafe
        // default. Opting out is deliberate (the dialog offers a toggle).
        temporary: z.boolean().optional().default(true),
        expiresInHours: TtlEnum.optional().default(DEFAULT_TEMP_PASSWORD_TTL_HOURS),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageUsers(context.supabase, context.userId);
    // Resetting a password is account takeover: without this an ordinary admin
    // could set the Owner's password and sign in as the Owner, defeating every
    // other Owner protection.
    await assertMayActOnTarget(context.supabase, context.userId, data.userId, "reset the password of");
    // Same reasoning one rung down: a Supervisor resetting an admin's password
    // would be a takeover of that admin.
    await assertMayAdministerTarget(context.userId, data.userId, "reset the password of");
    // Nobody may hand themselves a temporary password: it is meaningless (you
    // already know your own password) and it would let a caller strand their own
    // session behind the forced-change gate. Self-service changes go through
    // changeMyPassword, which demands the current password.
    if (data.userId === context.userId) {
      throw new Error("Use the password section of your profile to change your own password");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      password: data.password,
    });
    if (error) throw new Error(error.message);
    // Order matters: the flag is written only after the password actually
    // changed, so a failed reset never leaves someone locked behind a
    // forced-change screen for a password that was never issued.
    //
    // A permanent reset clears the deadline as well as the flag — leaving a stale
    // timestamp behind would read, under the encoding in 20260725003000, as an
    // account whose credential had been rotated away.
    const expiresAt = data.temporary ? temporaryPasswordDeadline(data.expiresInHours) : null;
    const { error: flagError } = await supabaseAdmin
      .from("profiles")
      .update({
        must_change_password: data.temporary,
        must_change_password_expires_at: expiresAt,
      } as any)
      .eq("id", data.userId);
    if (flagError) throw new Error(flagError.message);
    await logAdminAction({
      actorId: context.userId,
      targetUserId: data.userId,
      action: AUDIT_ACTIONS.passwordSetByAdmin,
      details: {
        ...(await targetSnapshot(data.userId)),
        temporary: data.temporary,
        expiresAt,
        expiresInHours: data.temporary ? data.expiresInHours : null,
      },
    });
    return { ok: true, temporary: data.temporary, expiresAt };
  });

/**
 * Send the account holder a password-recovery email.
 *
 * The alternative to a temporary password, and the better default when the user
 * is reachable: nothing is changed, no credential is spoken aloud or pasted into
 * a chat, and the new password is known only to them. The temporary-password path
 * stays for the cases this cannot serve — a wrong or dead mailbox, or a handover
 * that has to happen while the admin is on the phone with them.
 *
 * Behind exactly the same authorization ceiling as `adminSetPassword`, because it
 * reaches the same outcome by another route: whoever receives that email can set
 * the account's password. Without the ceiling a Supervisor could mail themselves
 * a recovery link for an admin account whose mailbox they control.
 */
export const adminSendPasswordReset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string }) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertCanManageUsers(context.supabase, context.userId);
    await assertMayActOnTarget(context.supabase, context.userId, data.userId, "send a password reset for");
    await assertMayAdministerTarget(context.userId, data.userId, "send a password reset for");
    const { getUserEmail, sendPasswordResetEmail } = await import("@/lib/password.server");
    // The address is read from auth.users rather than accepted from the caller,
    // so the link can only ever go to the account's own mailbox.
    const email = await getUserEmail(data.userId);
    if (!email) throw new Error("That account has no email address on file");
    await sendPasswordResetEmail(email);
    await logAdminAction({
      actorId: context.userId,
      targetUserId: data.userId,
      action: AUDIT_ACTIONS.passwordResetEmailSent,
      details: { ...(await targetSnapshot(data.userId)), sentTo: email },
    });
    return { ok: true, email };
  });

export const adminDeleteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string }) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    // Deliberately still `assertAdmin`, NOT assertCanManageUsers: deleting a user
    // is the one part of user administration Supervisor must never reach ("Cannot
    // delete any user"). Because Supervisor is not an administrator, keeping this
    // gate as-is is what implements that — there is no separate delete permission
    // to forget to withhold.
    await assertAdmin(context.supabase, context.userId);
    if (data.userId === context.userId) throw new Error("You cannot delete your own account");
    // Owner accounts are undeletable outright. Mirrors protect_owner_profile,
    // which also blocks the profiles cascade from auth.users deletion.
    if (await isOwner(context.supabase, data.userId)) {
      throw new Error("Owner accounts cannot be deleted");
    }
    // Snapshot before the account exists no longer — afterwards there is nothing
    // left to look up, and "deleted <uuid>" is not an audit record.
    const snapshot = await targetSnapshot(data.userId);
    const deletedRole = await getRole(data.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.userId);
    if (error) throw new Error(error.message);
    await logAdminAction({
      actorId: context.userId,
      targetUserId: data.userId,
      action: AUDIT_ACTIONS.userDeleted,
      details: { ...snapshot, role: deletedRole },
    });
    return { ok: true };
  });

/** Auth admin page size. 1000 is the API maximum. */
const AUTH_USERS_PAGE_SIZE = 1000;

/**
 * Every auth user's email, keyed by id.
 *
 * Paginated rather than a single `perPage: 1000` call: that call silently
 * returned only the first page, so past the thousandth account the users table
 * would render blank emails — and email is what the search box matches on, so
 * those rows also became unsearchable. Pages are fetched until one comes back
 * short, which is the documented end-of-list signal.
 */
async function listAuthEmails(supabaseAdmin: any): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  for (let page = 1; ; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page, perPage: AUTH_USERS_PAGE_SIZE,
    });
    if (error) throw new Error(error.message);
    const users = data?.users ?? [];
    for (const u of users) if (u.email) emails.set(u.id, u.email);
    if (users.length < AUTH_USERS_PAGE_SIZE) return emails;
  }
}

export const adminListUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Supervisor manages users, so it must be able to read the list.
    await assertCanManageUsers(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // The three reads are independent — profiles, roles and auth emails — so they
    // run concurrently. Previously they were three sequential awaits, which cost
    // the sum of the round trips on every load of the page.
    const [profilesRes, rolesRes, emails] = await Promise.all([
      supabaseAdmin
        .from("profiles" as any)
        .select("id,full_name,agent_code,active,permissions,created_at,yeastar_ext,avatar_url,must_change_password,must_change_password_expires_at")
        .order("created_at", { ascending: false }),
      supabaseAdmin.from("user_roles").select("user_id,role"),
      listAuthEmails(supabaseAdmin),
    ]);
    if (profilesRes.error) throw new Error(profilesRes.error.message);
    const roleMap = new Map((rolesRes.data ?? []).map((r: any) => [r.user_id, r.role]));
    const rows = (profilesRes.data ?? []).map((p: any) => ({
      ...p,
      email: emails.get(p.id) ?? "",
      role: roleMap.get(p.id) ?? null,
    }));
    // Profiles store only the object path. Resolve each to a short-lived signed
    // URL here (service_role signs any path — owner-scoped storage RLS would
    // block an admin from signing another user's avatar client-side). Legacy
    // long-lived URLs are re-signed short-lived via their extracted path too.
    //
    // One batched `createSignedUrls` call rather than one request per avatar:
    // the previous per-row loop issued N concurrent storage requests on every
    // load, which on a few hundred accounts is the dominant cost of this
    // function and is what made the page slow to appear.
    const signable = rows
      .map((r: any) => ({ row: r, path: avatarObjectPath(r.avatar_url) }))
      .filter((e): e is { row: any; path: string } => !!e.path);
    if (signable.length > 0) {
      const { data: signed } = await supabaseAdmin.storage
        .from(AVATAR_BUCKET)
        .createSignedUrls(signable.map((e) => e.path), AVATAR_SIGNED_TTL);
      // Results come back in request order; an individual entry can still carry
      // its own error (a deleted object), in which case the row simply loses its
      // avatar and falls back to initials rather than failing the whole list.
      const byPath = new Map((signed ?? []).map((s: any) => [s.path, s.signedUrl ?? null]));
      for (const { row, path } of signable) row.avatar_url = byPath.get(path) ?? null;
    }
    return rows;
  });
