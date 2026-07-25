import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { passwordSchema, temporaryPasswordState } from "@/lib/password-policy";
import { AUDIT_ACTIONS, logAdminAction } from "@/lib/audit.server";

/**
 * Update the authenticated user's own profile.
 * Only full_name and avatar_url are writable by the user.
 * The prevent_profile_escalation trigger blocks any attempt to change
 * agent_code/active/permissions/id from a non-admin session.
 *
 * `avatar_url` stores only the storage object path (not a URL); short-lived
 * signed URLs are minted on demand at display time.
 */
export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { fullName?: string; avatarPath?: string | null }) =>
    z
      .object({
        fullName: z.string().min(1).max(120).optional(),
        avatarPath: z.string().min(1).max(255).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const patch: { full_name?: string; avatar_url?: string | null } = {};
    if (data.fullName !== undefined) patch.full_name = data.fullName;
    if (data.avatarPath !== undefined) {
      // A user may only point their avatar at an object in their own folder.
      if (data.avatarPath !== null && data.avatarPath.split("/")[0] !== context.userId) {
        throw new Error("Invalid avatar path");
      }
      patch.avatar_url = data.avatarPath;
    }
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await context.supabase
      .from("profiles")
      .update(patch)
      .eq("id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Change the authenticated user's own password.
 *
 * Available to every signed-in user — it only ever acts on `context.userId`, so
 * there is no target parameter to tamper with and no privilege check to get
 * wrong. Admin-initiated resets of *other* accounts stay in
 * `admin.functions.ts`, behind the Owner-protection guards.
 *
 * The current password is verified HERE rather than in the browser. A session
 * alone is enough for `supabase.auth.updateUser({ password })`, so a check that
 * lived only in the form could be skipped entirely — and the reason to demand
 * the current password is precisely to stop whoever holds a stolen or unattended
 * session from taking the account over. Enforcing it server-side is what makes
 * the prompt meaningful.
 */
export const changeMyPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { currentPassword: string; newPassword: string }) =>
    z
      .object({
        // No policy check on the current password: it was set under whatever
        // rules applied at the time, and rejecting it here would lock users out
        // of the very form that lets them fix it.
        currentPassword: z.string().min(1, "Enter your current password"),
        newPassword: passwordSchema,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    if (data.currentPassword === data.newPassword) {
      throw new Error("New password must be different from your current password");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { getUserEmail, verifyPassword } = await import("@/lib/password.server");

    // The JWT normally carries the email; fall back to an admin lookup so the
    // flow still works for tokens issued without that claim.
    const claimEmail = (context.claims as { email?: unknown } | null)?.email;
    let email = typeof claimEmail === "string" && claimEmail ? claimEmail : null;
    if (!email) email = await getUserEmail(context.userId);
    if (!email) throw new Error("Could not verify your account");

    if (!(await verifyPassword(email, data.currentPassword))) {
      // Deliberately not distinguishing "wrong password" from any other
      // verification failure in the message shown to the caller.
      console.warn("[authz] failed current-password check on self-service change", {
        userId: context.userId,
      });
      throw new Error("Current password is incorrect");
    }

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(context.userId, {
      password: data.newPassword,
    });
    if (updateError) throw new Error(updateError.message);

    // The account now holds a password only its owner knows, so the
    // administrator-issued flag no longer applies. Cleared through service_role:
    // `authenticated` has no UPDATE grant on the column (20260725002000), which
    // is what stops a user clearing the flag without actually changing anything.
    await clearMustChangePassword(context.userId);

    await logAdminAction({
      actorId: context.userId,
      targetUserId: context.userId,
      action: AUDIT_ACTIONS.passwordChangedSelf,
      details: { email },
    });
    return { ok: true as const };
  });

/** Drop the administrator-issued marker and its deadline. Shared by the two ways
 *  a user replaces an issued password: the self-service form and the emailed
 *  recovery link. */
async function clearMustChangePassword(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ must_change_password: false, must_change_password_expires_at: null } as any)
    .eq("id", userId);
  if (error) throw new Error(error.message);
}

/**
 * Clear the forced-change marker after a recovery-link password reset.
 *
 * The recovery flow sets the password through `supabase.auth.updateUser()` in the
 * browser — possession of the emailed token is the proof of identity there, and
 * there is no current password to submit — so it cannot go through
 * `changeMyPassword`, and the flag would otherwise survive the very reset that
 * was supposed to satisfy it, trapping the user on the forced-change screen.
 *
 * Being callable without actually changing a password is acceptable, and worth
 * being explicit about: the flag is a workflow gate, not a security boundary.
 * Anyone who can call this already holds a valid session for the account, which
 * means they already know the current password (or hold a recovery token for it)
 * — clearing the flag grants them nothing they did not already have. The
 * boundary that matters, "who may set this account's password", is enforced in
 * `changeMyPassword` and `adminSetPassword`, and is untouched by this.
 */
export const markPasswordChanged = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await clearMustChangePassword(context.userId);
    await logAdminAction({
      actorId: context.userId,
      targetUserId: context.userId,
      action: AUDIT_ACTIONS.passwordChangedViaRecovery,
    });
    return { ok: true as const };
  });

/**
 * Retire an administrator-issued password that has passed its deadline.
 *
 * What makes the expiry more than a rendering rule: the credential is replaced
 * with a random value nobody holds, so a temporary password that was leaked —
 * read off a sticky note, forwarded in a chat thread — stops being usable rather
 * than merely stopping being welcome.
 *
 * Safety properties, in order of how badly each would hurt if wrong:
 *
 *   * It only ever acts on `context.userId`. There is no target parameter, so it
 *     cannot be pointed at another account.
 *   * The expiry decision is made HERE, from the stored columns, never from an
 *     argument. A client that lies about being expired changes nothing.
 *   * It refuses unless the account is genuinely in the expired state, so it can
 *     never destroy a password the user chose themselves.
 *
 * The deadline is then nulled while `must_change_password` stays true — the
 * encoding for "rotated away, recoverable only by email" (see 20260725003000).
 * That also makes the call idempotent: a second invocation finds no deadline,
 * sees the credential is already gone, and does nothing.
 */
export const expireTemporaryPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: profile, error } = await supabaseAdmin
      .from("profiles")
      .select("must_change_password,must_change_password_expires_at")
      .eq("id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const fields = profile as {
      must_change_password?: boolean;
      must_change_password_expires_at?: string | null;
    } | null;

    // Already rotated (no deadline left) or not expired at all — nothing to do.
    if (!fields?.must_change_password || !fields.must_change_password_expires_at) {
      return { rotated: false as const };
    }
    if (temporaryPasswordState(fields) !== "expired") {
      return { rotated: false as const };
    }

    // 48 hex characters: far beyond anything guessable, and never shown to
    // anyone. The account is recoverable only through the emailed link from here.
    const random = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
    const { error: pwError } = await supabaseAdmin.auth.admin.updateUserById(context.userId, {
      password: random,
    });
    if (pwError) throw new Error(pwError.message);

    const { error: flagError } = await supabaseAdmin
      .from("profiles")
      .update({ must_change_password_expires_at: null } as any)
      .eq("id", context.userId);
    if (flagError) throw new Error(flagError.message);

    await logAdminAction({
      actorId: null,
      targetUserId: context.userId,
      action: AUDIT_ACTIONS.temporaryPasswordExpired,
      details: { expiredAt: fields.must_change_password_expires_at },
    });
    console.warn("[authz] temporary password expired and was rotated", { userId: context.userId });
    return { rotated: true as const };
  });
