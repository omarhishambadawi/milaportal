import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { passwordSchema } from "@/lib/password-policy";

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

    console.log("[authz] password changed by self", { userId: context.userId });
    return { ok: true as const };
  });
