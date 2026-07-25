import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { APP_ROLES, canActOnRole, canAssignRole, isRetiredRole, roleHasAgentCode } from "@/lib/roles";
import { AVATAR_BUCKET, AVATAR_SIGNED_TTL, avatarObjectPath } from "@/lib/avatar";
import { passwordSchema } from "@/lib/password-policy";

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
  .inputValidator((d: { email: string; password: string; fullName: string; agentCode?: string; role: RoleValue }) =>
    z
      .object({
        email: z.string().email(),
        // Same policy as the self-service change and the reset flow, so a
        // password an admin sets cannot be weaker than one a user may choose.
        password: passwordSchema,
        fullName: z.string().min(1).max(120),
        agentCode: z.string().max(40).optional(),
        role: RoleEnum,
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
    return { id: newUserId };
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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.userId);
    const { error } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: data.userId, role: data.role });
    if (error) throw new Error(error.message);
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
    return { ok: true };
  });


export const adminSetPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string; password: string }) =>
    z.object({ userId: z.string().uuid(), password: passwordSchema }).parse(d),
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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      password: data.password,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminListUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Supervisor manages users, so it must be able to read the list.
    await assertCanManageUsers(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: profiles, error } = await supabaseAdmin
      .from("profiles" as any)
      .select("id,full_name,agent_code,active,permissions,created_at,yeastar_ext,avatar_url")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const { data: roles } = await supabaseAdmin.from("user_roles").select("user_id,role");
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    const emails = new Map(list.users.map((u: any) => [u.id, u.email]));
    const roleMap = new Map((roles ?? []).map((r: any) => [r.user_id, r.role]));
    const rows = (profiles ?? []).map((p: any) => ({
      ...p,
      email: emails.get(p.id) ?? "",
      role: roleMap.get(p.id) ?? null,
    }));
    // Profiles store only the object path. Resolve each to a short-lived signed
    // URL here (service_role signs any path — owner-scoped storage RLS would
    // block an admin from signing another user's avatar client-side). Legacy
    // long-lived URLs are re-signed short-lived via their extracted path too.
    await Promise.all(
      rows.map(async (r: any) => {
        const path = avatarObjectPath(r.avatar_url);
        if (!path) return;
        const { data: signed } = await supabaseAdmin.storage
          .from(AVATAR_BUCKET)
          .createSignedUrl(path, AVATAR_SIGNED_TTL);
        r.avatar_url = signed?.signedUrl ?? null;
      }),
    );
    return rows;
  });
