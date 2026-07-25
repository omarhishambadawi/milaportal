/**
 * Server-only password verification and recovery-email dispatch.
 *
 * Supabase Auth stores bcrypt hashes, so a password can never be read back — the
 * only way to confirm "this is the caller's current password" is to attempt an
 * authentication with it. That is what this does, on a throwaway client.
 *
 * Why this has to run on the server: `supabase.auth.updateUser({ password })`
 * only needs a valid session, so a current-password prompt enforced in the
 * browser is trivially bypassable. Since the point of that prompt is to stop
 * someone holding a hijacked or unattended session from taking the account over,
 * the check is worthless unless the *server* refuses the change. Callers must
 * therefore verify here before setting a new password.
 */
import { createClient } from "@supabase/supabase-js";

/**
 * True when `password` is the current password for `email`.
 *
 * The client is created per call with `persistSession: false`, so the session
 * minted by a successful sign-in is never written anywhere and is discarded with
 * the client when the request ends. We deliberately do NOT call `signOut()`
 * afterwards: supabase-js defaults that to a *global* scope, which would revoke
 * every one of the user's sessions on every password check and sign them out of
 * their own browser mid-flow.
 *
 * Returns false on bad credentials rather than throwing, so callers can map it
 * to a specific, non-enumerating error message.
 */
/**
 * The sign-in email for a user id, read through service_role.
 *
 * Needed because `verifyPassword` authenticates by email, but the callers only
 * hold a user id. The JWT usually carries the email, so callers should prefer
 * that and fall back to this for tokens issued without the claim.
 */
export async function getUserEmail(userId: string): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error) return null;
  return data?.user?.email ?? null;
}

export async function verifyPassword(email: string, password: string): Promise<boolean> {
  const client = anonClient("Password verification");
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) return false;
  return !!data?.user;
}

/** Throwaway anon-key client: no session is ever persisted from these calls. */
function anonClient(what: string) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error(`${what} is unavailable: Supabase is not configured`);
  }
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
}

/**
 * The origin the recovery link should point back at.
 *
 * Derived from the incoming request — never from a client-supplied value. A
 * caller-controlled `redirectTo` is an open-redirect in an email the *victim*
 * receives and trusts, which is the worst possible place to have one. Prefers
 * the proxy-forwarded host (the app runs behind Cloudflare Workers, so
 * `request.url` is the internal origin), mirroring `reportOrigin` in
 * security-headers.ts, and falls back to SITE_URL for any context without a
 * request. Supabase independently rejects redirect targets outside the project's
 * configured allow-list, so this is the first of two checks, not the only one.
 */
function requestOrigin(request: Request | undefined): string | null {
  const host = request?.headers.get("x-forwarded-host") ?? request?.headers.get("host");
  if (host) {
    const proto = request?.headers.get("x-forwarded-proto") ?? "https";
    return `${proto}://${host}`;
  }
  if (request) {
    try {
      return new URL(request.url).origin;
    } catch {
      /* non-absolute URL — fall through to the configured site URL */
    }
  }
  const configured = process.env.SITE_URL ?? process.env.VITE_SITE_URL;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      /* malformed env value — treat as absent */
    }
  }
  return null;
}

/**
 * Send Supabase's built-in password-recovery email to `email`.
 *
 * Uses the anon key rather than `auth.admin.generateLink`, because generateLink
 * only *returns* a link — it sends nothing, and the platform has no mail
 * transport of its own to hand that link to. `resetPasswordForEmail` goes
 * through the same mailer, template and rate limits as the "Forgot password?"
 * link on the sign-in page, so the email an admin triggers is byte-identical to
 * the one a user triggers, and lands on the same /reset-password route.
 *
 * The password is NOT changed by this: the account keeps working until the user
 * follows the link. That is the difference from a temporary password, and it is
 * why both actions exist.
 */
export async function sendPasswordResetEmail(email: string): Promise<void> {
  const { getRequest } = await import("@tanstack/react-start/server");
  let request: Request | undefined;
  try {
    request = getRequest();
  } catch {
    /* no request context — fall back to SITE_URL */
  }
  const origin = requestOrigin(request);
  if (!origin) {
    throw new Error("Cannot send a reset email: the site URL could not be determined");
  }

  const client = anonClient("Sending a password reset email");
  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/reset-password`,
  });
  if (error) throw new Error(error.message);
}
