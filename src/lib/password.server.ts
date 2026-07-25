/**
 * Server-only password verification.
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
export async function verifyPassword(email: string, password: string): Promise<boolean> {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Password verification is unavailable: Supabase is not configured");
  }

  const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) return false;
  return !!data?.user;
}
